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
$ npm test                    # everything: 40 tests, ~1 s
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
naming a version this client cannot speak), not as a substitute for it.

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
| publish a caret | `engine.setSelection(path, { anchor, head })`, or `engine.setAwareness(state)` with any shape |
| read remote cursors | `engine.presence()` — `{ clientId, peer, state }`, so `presence.peer?.display_name` is who it is |
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

Presence offsets are UTF-16 code units (`anchor`/`head`), which is what `Y.Text` indices, VS
Code's `offsetAt` and `yrs`'s default all use. They are **not** CRDT-relative positions:
`DESIGN.md` §4.3 asks for those and `spec/PROTOCOL.md` §12.4 records the gap. An adapter that
wants a cursor which survives a concurrent paste can compute relative positions from
`engine.getText(path)` and publish them inside its own `setAwareness` state — the awareness
state is opaque on the wire (§8.1), so that is a shape change, not a protocol one. Making it
the *specified* shape is a spec decision, and the first one this work raises.

## Tests

| File | What it covers |
|---|---|
| `test/envelope.test.ts` | version compatibility (same-major, minor decisive only at 0.x), error/close codes, URL round-trips, permissive envelope parsing |
| `test/engine.test.ts` | mint/join by invite URL, refusals by code, `/meta` fail-fast, the open-document set's hold semantics, request correlation, convergence, presence attribution and expiry, the room lifecycle, hostile frames |
| `test/reconnect.test.ts` | §9.1: a dropped guest re-hellos and re-opens; a dropped host *reclaims its room* rather than minting a new one; a destroyed room is terminal |
| `test/selvaged.test.ts` | the gate, against the real `selvaged`: two engines, concurrent edits, text + state-vector convergence, presence both ways, a late joiner, a rejoining guest, close semantics |
| `test/spikes/` | the three §7 experiments, as measurements (`SPIKES.md`) |
| `test/boundary.test.ts` | no `vscode` import, no undeclared dependency, the public surface exists |

`npm test` runs them all: **40 tests, 0 failures, ~1 s**, of which 4 run against the real
server. Nothing sleeps and hopes: every wait is a bounded poll of a real predicate that
reports the state it observed when it fails (`test/helpers/wait.ts`).

## Not here

`src/adapter/`, the extension manifest, presence rendering, packaging and publication
(`DESIGN.md` §11). Also deliberately absent: a `y-websocket` provider (Selvage's envelope is
not y-websocket's), any host-filesystem read, read-only guests (§12.3), per-user undo, and
`terminal/1`.
