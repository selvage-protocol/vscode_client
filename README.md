# Selvage client for VS Code — the engine

The `selvage/1` **sync engine** for the Selvage VS Code client: WebSocket transport, the JSON
session envelope, the handshake, room join by invite URL, document sync and awareness over
`y-protocols` with an in-process `yjs`. It is the half of `DESIGN.md` §6 that knows about
CRDTs and sockets and nothing about editors.

**`src/engine/` does not import `vscode`, and a test enforces it** (`test/boundary.test.ts`).
The adapter — documents, decorations, the `FileSystemProvider`, commands — is a later change
and attaches at the interface described below. `package.json` is here so the engine can be
built and tested on its own; the extension manifest arrives with the adapter.

## Running it

Requirements, as found on this host:

| Tool | Version here | Notes |
|---|---|---|
| Node | `v26.8.1` (`/etc/profiles/per-user/user/bin/node`) | **≥ 22.18** is required: the tests are `.ts` run directly by `node --test`, which needs type stripping |
| npm | `11.19.0` | `npm ci` reaches the registry (verified: `npm view yjs version` → `13.6.32`) |
| nix | `2.34.8` | only for building `selvaged` out of `impl/` |

A fresh clone needs `npm ci` (9 packages, ~35 MB, no native builds) and, for the
real-server test, a `selvaged` binary:

```console
$ npm ci --no-audit --no-fund
added 9 packages in 1s

$ nix develop ./impl --command sh -c 'cd impl && cargo build -p selvaged'
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 15.08s
```

Two notes on that build. `cargo` is **not** on the ambient `PATH`, so it has to come from the
devshell (`nix-shell -p cargo rustc --run …` also works) — and `nix develop ./impl` runs its
command with the *repository root* as the working directory, not `impl/`, hence the `cd`.
The flake **does resolve from a linked worktree** (`git worktree add …`): the shellHook
installs its git hooks into the *shared* checkout's hooks directory and writes
`.pre-commit-config.yaml` into the worktree (already ignored by the root `.gitignore`).
CI should not depend on the hooks.

Then:

```console
$ npm test                    # everything: 49 tests, of which 4 need the Rust build
$ npm run test:engine         # wire layer + engine + reconnect, no Rust build needed
$ npm run test:spikes         # the three pre-adapter experiments
$ npm run test:selvaged       # the conformance gate, needs impl/target/*/selvaged
$ npm run typecheck           # tsc --noEmit, strict, erasableSyntaxOnly
```

`test:selvaged` finds the binary at `impl/target/{debug,release}/selvaged`, or wherever
`SELVAGED_BIN` points. A missing binary **fails** the test with the command that builds it
rather than skipping: the point of that suite is the real server. The rest of the suite runs
against a fake `selvaged` (`test/helpers/fake-server.ts`) that implements the handshake, the
document-set semantics, the grace period and payload-opaque relay — it exists for the faults
the real server will not produce on demand (a dropped socket, a hostile `x.` event, `/meta`
naming a version this client cannot speak), not as a substitute for it. It **shares
`src/engine/envelope.ts` with the engine**, so it can never catch a constant that disagrees
with the spec: both sides would be wrong the same way. Only `test:selvaged` can.

## Modules

| File | What it is |
|---|---|
| `src/engine/envelope.ts` | the `selvage/1` JSON shapes, the name vocabulary, §10 compatibility, §11 error and close codes |
| `src/engine/urls.ts` | room and token in the connection URL (§5.1): build, parse, percent-encode; the invite URL *is* the WebSocket URL |
| `src/engine/transport.ts` | the WebSocket seam: text frames are the envelope, binary frames are y-protocols, and a factory can replace the socket |
| `src/engine/meta.ts` | `GET /meta`: advisory when unreachable, decisive when it names an incompatible version |
| `src/engine/sync.ts` | y-protocols framing (§7, §8): SyncStep1/Update/Awareness, a frame as a stream of messages |
| `src/engine/presence.ts` | the awareness state's shape, and the join from `awareness_client_id` to `PeerInfo` (§8.4) |
| `src/engine/events.ts` | the nine `EngineEvent`s, mirroring `impl/crates/client/src/editor.rs` |
| `src/engine/engine.ts` | `SelvageEngine`: handshake, request/response correlation, the sync handshake, awareness renewal and expiry, reconnect |
| `src/engine/index.ts` | the public surface — import from here |

Threading: everything is one event loop and synchronous. Frames are written as they are
produced, and events are delivered to listeners in the order frames arrived, so an adapter
reacts to `documentChanged` instead of polling. There is no worker, no native module and no
second process: `DESIGN.md` §6 has VS Code embed both halves, and the module seam is what
keeps a sidecar a later *move* rather than a rewrite.

Two bounds, and what each one covers. `connect()` is bounded by `handshakeTimeoutMs` (10 s by
default), which covers the upgrade *and* the handshake: if it expires the socket is closed and
the attempt rejects. `open()` and `close()` are bounded by `requestTimeoutMs` (10 s by
default), because the bound belongs to the client and not to the wire — a server that holds the
socket up and never answers fails the caller with `EngineClosedError` instead of leaving it
pending. Neither bound guesses: an unanswered `doc.open` records no hold, and both methods are
idempotent, so re-asking is how the caller settles what the server did. A request issued with
no seated connection to carry it is refused at once rather than queued for the next connection,
where it would be replayed under an id that connection had already reissued.

A reconnect announces itself last: the engine re-opens the documents this client still holds
*before* it emits `documentsChanged` and `peersChanged`, so an adapter that opens a document
in answer to those events is ordered after the engine's own re-opens instead of racing them.

## Where the adapter attaches

```ts
import { SelvageEngine } from './engine/index.ts';

// Mint a room (the host) — the reply carries the token, so inviteUrl() is the share.
const host = await SelvageEngine.host('ws://127.0.0.1:8080', 'Ada');
const invite = host.inviteUrl();               // ws://…/session?room=…&token=…

// Join the room the link names — the link itself, not a room id worked out of it.
const guest = await SelvageEngine.join(invite, 'Bob');

host.on((event) => {
  switch (event.type) {
    case 'documentChanged': /* reconcile event.path with host.text(event.path) */
    case 'documentsChanged': /* the room's open-document set */
    case 'peersChanged': /* membership, including awareness_client_id */
    case 'presenceChanged': /* remote cursors, each with its peer attributed */
    case 'hostDetached': /* grace countdown, event.graceMs */
    case 'hostAttached': /* the host came back */
    case 'roomGone': /* the session is over; do not retry */
    case 'sessionError': /* a fault the server could not attach to a request */
    case 'disconnected': /* the connection ended, or reconnection gave up */
  }
});
```

| Adapter need | Engine call |
|---|---|
| open / close a document | `await engine.open(path)` / `engine.close(path)` (the server's open-document set is the truth; the reply resolves when it accepted) |
| read a document | `engine.text(path)`, or `engine.getText(path)` for the `Y.Text` itself |
| apply a local edit | `engine.insert(path, index, text)` / `engine.delete(path, index, length)` — deltas, not whole-buffer writes |
| publish a caret | `engine.setSelection(path, { anchor, head })` — editor offsets, converted to the anchors the wire carries; or `engine.setAwareness(state)` with any shape |
| build one anchor | `engine.anchorAt(path, index, assoc)` — for a state assembled by hand |
| read remote cursors | `engine.presence()` — `{ clientId, peer, state }`, so `presence.peer?.display_name` is who it is |
| resolve a remote caret | `engine.resolveSelection(path, selection)` → offsets, or `undefined` while an endpoint does not resolve |
| membership | `engine.peers()`, `engine.session()` |
| convergence checks | `engine.stateVector()`, `engine.documents()`, `engine.openDocuments()` |
| concurrency in tests | `engine.pauseOutbound(true)` — held frames make two edits genuinely concurrent |

Three contracts the adapter has to keep, each settled by a spike (`SPIKES.md`):

1. **Do not use a bare echo flag.** Compare the buffer's text against `engine.text(path)`
   before writing a change event back into the CRDT: a flag loses or duplicates edits
   depending on when the coalesced event lands. CRDT → buffer needs no guard at all, because
   `documentChanged` fires only for changes that did not come from the adapter.
2. **Write LF into the CRDT** (`buffer.replace(/\r\n/g, '\n')`), remember the document's EOL,
   and restore it when rendering — never write the rendered text back. Two editors with
   different line endings otherwise rewrite each other forever.
3. **Do not impose a trailing-newline invariant in the sync layer.** Content is content; if
   the editor wants the invariant, it owns it in one place.

**A selection on the wire is two CRDT anchors, never offsets** (`spec/PROTOCOL.md` §8.1).
Each endpoint is a yjs `RelativePosition` as JSON — a scope (`tname`, the document path),
an optional `item` naming an element inside it, and `assoc` — and no index is carried, so a
peer's caret survives a paste above it instead of drifting by the length of that paste.

Offsets stop at the editor-adapter seam, where they are UTF-16 code units, the unit
`Y.Text` indices and VS Code's `offsetAt` both count. `setSelection` takes offsets and
anchors them; `resolveSelection` turns a peer's anchors back into offsets against this
replica. Resolution is **deferred**: awareness and sync travel on independent queues, so a
state whose document has not arrived yet is kept and resolves on a later call, and an
endpoint that does not resolve means *no selection* — never a clamp or an offset fallback.

## Tests

| File | What it covers |
|---|---|
| `test/envelope.test.ts` | version compatibility (same-major, minor decisive only at 0.x), error/close codes, URL round-trips, permissive envelope parsing |
| `test/engine.test.ts` | mint/join by invite URL, refusals by code, `/meta` fail-fast, the open-document set's hold semantics, request correlation, convergence, presence attribution and expiry, the room lifecycle, hostile frames |
| `test/reconnect.test.ts` | §9.1: a dropped guest re-hellos and re-opens; a dropped host *reclaims its room* rather than minting a new one; a destroyed room is terminal |
| `test/selvaged.test.ts` | the gate, against the real `selvaged`: two engines, concurrent edits, text + state-vector convergence, presence both ways, a late joiner, a guest that disconnects and joins again (a fresh `join()`, not the reconnect path), close semantics |
| `test/spikes/` | the three §7 experiments, as measurements (`SPIKES.md`) |
| `test/boundary.test.ts` | no `vscode` import, no undeclared dependency, the public surface exists |

`npm test` runs them all: **49 tests, 0 failures**, of which 4 need a built `selvaged`
and run against nothing else. Waits are bounded polls of a real predicate that report the
state they observed on failure (`test/helpers/wait.ts`), not `sleep`-and-hope. The one
assertion that used to sample an asynchronous count is the abandoned-connection count in
`test/reconnect.test.ts`, which now waits for it.

The seam check is two halves. `test/boundary.test.ts` scans the engine's source for
`vscode`, `vscode-*` and `@types/vscode` specifiers — static or dynamic, in either quote
style — which is what catches an `import type`, erased before Node ever runs it. `npm run
typecheck` is the other half, and `ci.yml` runs it before `test:fast`; `test:fast` itself
does not compile.

## Not here

`src/adapter/`, the extension manifest, presence rendering, packaging and publication
(`DESIGN.md` §11). Also deliberately absent: a `y-websocket` provider (Selvage's envelope is
not y-websocket's), any host-filesystem read, read-only guests (§12.3), per-user undo, and
`terminal/1`.
