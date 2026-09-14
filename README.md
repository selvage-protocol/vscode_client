# Selvage for VS Code

Live collaborative editing over the [Selvage `selvage/1` session protocol](https://github.com/selvage-protocol/specification):
a WebSocket transport, the JSON session envelope, room join by invite URL, `y-protocols`
document sync and awareness, and the editor integration that makes two windows edit one file.

It is a from-scratch TypeScript client. The sync engine and the CRDT live in the extension
host next to the editor — `DESIGN.md` §6, and `docs/studies/vscode-plugin.md` §6 for why the
sidecar comes later — and the code is layered so that each layer can be tested with less than
the one below it:

| Layer | What it is | What it needs to be tested |
|---|---|---|
| `src/engine/` | transport, envelope, handshake, sync, awareness, presence, reconnect | a socket |
| `src/bridge/` | the adapter's editor-independent half: seeding, the echo guard, the EOL policy, the save policy, cursor attribution | a replica and an editor interface |
| `src/adapter/` | the `vscode` half: documents, `applyEdit`, the `FileSystemProvider`, decorations, commands, status | an editor |

**No `vscode` import outside `src/adapter/`, and `test/boundary.test.ts` enforces it** — along
with "no undeclared dependency", "every module of the editor-independent half is reachable
from a test", and "every module in `src/adapter/` is one that imports `vscode`". A rule that
could have been tested belongs in `src/bridge/`.

## Running it

Requirements, as found on this host:

| Tool | Version here | Notes |
|---|---|---|
| Node | `v26.8.1` (`/etc/profiles/per-user/user/bin/node`) | **≥ 22.18** is required: the tests are `.ts` run directly by `node --test`, which needs type stripping |
| npm | `11.19.0` | `npm ci` reaches the registry |
| nix | `2.34.8` | only for building `selvaged` out of the sibling [`reference_server`](https://github.com/selvage-protocol/reference_server) checkout, which the four server-backed tests need |

```console
$ npm ci --no-audit --no-fund          # 12 packages, ~47 MB, no native builds
$ npm run build                        # → dist/extension.js, 424 kB, and dist/package.json
$ npm run typecheck                    # tsc --noEmit, strict, erasableSyntaxOnly
$ npm run test:fast                    # builds, then 99 tests, no server, no editor
$ npm test                             # 103 tests: the same plus 4 against a real selvaged
```

`test:fast` and `test` build `dist/` first, so the extension bundle under test is the current
source and not a stale one (`test/manifest.test.ts` loads it and activates it against a stub
`vscode`, which is how CI checks the manifest — and the guest's `FileSystemProvider` — without
an editor).

The four server-backed tests in `test/selvaged.test.ts` need a `selvaged` binary:

```console
$ nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvaged'
```

`test:selvaged` finds it at `../reference_server/target/{debug,release}/selvaged`, or wherever
`SELVAGE_SELVAGED` points. A missing binary **fails** the test with the command that builds it
rather than skipping. `cargo` is not on the ambient `PATH`, and `nix develop ../reference_server`
runs its command with the *current* directory, hence the `cd`. That flake's shellHook installs
Rust git hooks into this checkout; they are harmless and ignored, and CI does not use them.

Most of the suite runs against a fake `selvaged` (`test/helpers/fake-server.ts`) that
implements the handshake, the document-set semantics, the grace period and payload-opaque
relay. It exists for the faults the real server will not produce on demand — a dropped socket,
a hostile `x.` event, `/meta` naming a version this client cannot speak — not as a substitute
for the real thing. It **shares `src/engine/envelope.ts` with the engine**, so it can never
catch a constant that disagrees with the spec: only `test:selvaged` can.

## Loading it in VS Code

The extension is not published. Load it from a checkout:

```console
$ code --extensionDevelopmentPath=$PWD <a folder to work in>
```

or press **F5** in VS Code, which uses `.vscode/launch.json`. That file has **two**
configurations, because a collaborative session needs two windows: `Selvage (first window)`
and `Selvage (second window)`, each with its own `--user-data-dir` under `.tmp/`, so the two
extension hosts do not share state. Launch the first, then the second (from the *same* window
you launched the first from — the second debug session starts another host).

Then, in the two windows:

1. Run a server: `selvaged` from the sibling checkout prints the address to host on.
2. **Window one** — `Selvage: Host a session` (the command palette; `F1`). Enter the server
   address (`ws://127.0.0.1:8080`) and a display name. The invite link is shown and copied to
   the clipboard, and the status bar shows the session.
3. Open a file **inside the workspace folder** — it is shared as soon as it is open, and its
   path appears in the room's open-document set.
4. **Window two** — `Selvage: Join a session from an invite link`, paste the link (it is
   pre-filled from the clipboard when the clipboard holds one), enter a display name.
5. **Window two** — `Selvage: Open a document from the room`, pick the path. It opens as
   `selvage:/<path>?room=<room id>`, editable; both windows now type into the same text and
   see each other's cursor with a name label.
6. `Selvage: Leave session` on either side. Closing window one — the host — ends the room
   after the server's grace period, and window two is told.

Set `selvage.serverUrl` and `selvage.displayName` in settings to stop being asked. There is
**no default server**: a baked-in endpoint would be one someone else chose.

## Modules

| File | What it is |
|---|---|
| `src/engine/envelope.ts` | the `selvage/1` JSON shapes, the name vocabulary, §10 compatibility, §11 error and close codes |
| `src/engine/urls.ts` | room and token in the connection URL (§5.1): build, parse, percent-encode; the invite URL *is* the WebSocket URL |
| `src/engine/transport.ts` | the WebSocket seam: text frames are the envelope, binary frames are y-protocols, and a factory can replace the socket |
| `src/engine/meta.ts` | `GET /meta`: advisory when unreachable, decisive when it names an incompatible version |
| `src/engine/sync.ts` | y-protocols framing (§7, §8): SyncStep1/Update/Awareness, a frame as a stream of messages |
| `src/engine/presence.ts` | the awareness state's shape, and the join from `awareness_client_id` to `PeerInfo` (§8.4) |
| `src/engine/events.ts` | the nine `EngineEvent`s, mirroring [`crates/client/src/editor.rs`](https://github.com/selvage-protocol/reference_server/blob/main/crates/client/src/editor.rs) |
| `src/engine/engine.ts` | `SelvageEngine`: handshake, request/response correlation, the sync handshake, awareness renewal and expiry, reconnect |
| `src/bridge/editing.ts` | LF in the replica, the document's own line endings on render, the smallest change between two texts, and the content comparison that stands in for an echo guard |
| `src/bridge/bridge.ts` | `SessionBridge`: seeding, both directions of the buffer/replica loop, the save policy, the `EditorHost` interface an adapter implements |
| `src/bridge/cursors.ts` | the remote-cursor model, and the palette a peer's colour is derived from |
| `src/bridge/virtual.ts` | the guest's `selvage:` URIs: build, parse, refuse |
| `src/adapter/extension.ts` | `activate`, the five commands, the status bar, the window's listeners |
| `src/adapter/documents.ts` | `WorkspaceEditor`: which documents are shared, `applyEdit`, save, line endings |
| `src/adapter/guest-fs.ts` | the `selvage:` `FileSystemProvider`: the replica's text in, writes out |
| `src/adapter/decorations.ts` | remote carets, selections and name labels |

Threading: everything is one event loop and synchronous. Frames are written as they are
produced, and events are delivered to listeners in the order frames arrived, so an adapter
reacts to `documentChanged` instead of polling. There is no worker, no native module and no
second process.

Two bounds, and what each one covers. `connect()` is bounded by `handshakeTimeoutMs` (10 s by
default), which covers the upgrade *and* the handshake: if it expires the socket is closed and
the attempt rejects. `open()` and `close()` are bounded by `requestTimeoutMs` (10 s by
default), because the bound belongs to the client and not to the wire — a server that holds the
socket up and never answers fails the caller with `EngineClosedError` instead of leaving it
pending. Neither bound guesses: an unanswered `doc.open` records no hold, and both methods are
idempotent, so re-asking is how the caller settles what the server did.

## The seam

```ts
import { SelvageEngine } from './engine/index.ts';
import { SessionBridge } from './bridge/index.ts';

// Mint a room (the host) — the reply carries the token, so inviteUrl() is the share.
const host = await SelvageEngine.host('ws://127.0.0.1:8080', 'Ada');
const invite = host.inviteUrl();               // ws://…/session?room=…&token=…

// Join the room the link names — the link itself, not a room id worked out of it.
const guest = await SelvageEngine.join(invite, 'Bob');

// The editor half. Everything the bridge needs from an editor is these six methods.
const bridge = new SessionBridge({ engine: host, host: editorHost });
bridge.documentOpened('src/main.rs');   // the editor has a document in front of the user
bridge.documentChanged('src/main.rs');  // its buffer changed
bridge.documentClosed('src/main.rs');
bridge.selectionChanged('src/main.rs', { anchor: 12, head: 12 });
bridge.selectionCleared();
bridge.reconcile('src/main.rs');        // the editor refused a change; ask again
```

| Adapter need | Engine call |
|---|---|
| open / close a document | `await engine.open(path)` / `engine.close(path)` (the server's open-document set is the truth; the reply resolves when it accepted) |
| read a document | `engine.text(path)`, or `engine.getText(path)` for the `Y.Text` itself |
| apply a local edit | `engine.insert(path, index, text)` / `engine.delete(path, index, length)` — deltas, not whole-buffer writes |
| publish a caret | `engine.setSelection(path, { anchor, head })` — editor offsets, converted to the anchors the wire carries; or `engine.setAwareness(state)` with any shape |
| build one anchor | `engine.anchorAt(path, index, assoc)` — for a state assembled by hand, or `undefined` when this replica has received nothing for `path` |
| read remote cursors | `engine.presence()` — `{ clientId, peer, state }`, so `presence.peer?.display_name` is who it is |
| resolve a remote caret | `engine.resolveSelection(path, selection)` → offsets, or `undefined` when an endpoint does not resolve or the document has not arrived |
| membership | `engine.peers()`, `engine.session()` |
| convergence checks | `engine.stateVector()`, `engine.documents()`, `engine.openDocuments()` |
| concurrency in tests | `engine.pauseOutbound(true)` — held frames make two edits genuinely concurrent |

Four contracts the adapter keeps, each settled by a spike (`SPIKES.md`):

1. **Do not use a bare echo flag.** Compare the buffer's text against `engine.text(path)`
   before writing a change event back into the replica: a flag loses or duplicates edits
   depending on when the coalesced event lands. CRDT → buffer needs no guard at all, because
   `documentChanged` fires only for changes that did not come from the adapter.
2. **Write LF into the replica** (`buffer.replace(/\r\n/g, '\n')`), remember the document's
   EOL, and restore it when rendering — never write the rendered text back. Two editors with
   different line endings otherwise rewrite each other forever. The EOL is the editor's own
   answer for the document (`TextDocument.eol`), which is CRLF for a CRLF file and the
   `files.eol` setting for a new or empty one.
3. **Do not impose a trailing-newline invariant.** Content is content; if the editor wants the
   invariant, it owns it in one place.
4. **Seeding is the host's, once, and never over content the room already has.** A `doc.open`
   for a path the replica does not hold yet is seeded from the editor's buffer; one for a path
   a peer has already edited is *rendered* into the buffer instead, so a stale file on disk
   cannot be published over the room.

**A selection on the wire is two CRDT anchors, never offsets** —
[`PROTOCOL.md` §8.1](https://github.com/selvage-protocol/specification/blob/main/PROTOCOL.md).
Each endpoint is a yjs `RelativePosition` as JSON — a scope (`tname`, the document path), an
optional `item` naming an element inside it, and `assoc` — and no index is carried, so a peer's
caret survives a paste above it instead of drifting by the length of that paste.

Offsets stop at the editor-adapter seam, where they are UTF-16 code units, the unit `Y.Text`
indices and VS Code's `offsetAt` both count. Resolution is **deferred**: awareness and sync
travel on independent queues, so a state whose document has not arrived yet is kept and
resolves on a later call, and an endpoint that does not resolve means *no selection* — never a
clamp or an offset fallback.

## What the adapter decided

The points `docs/studies/vscode-plugin.md` §9 leaves open, as implemented:

- **A host shares the `file:` documents open under its workspace folder**, on open and for
  those already open when the session starts; that folder is the grant. A guest shares nothing
  from disk — only the `selvage:` documents the room gave it.
- **Closing a document releases this client's hold** on it, so the room's set is the union of
  what its connected clients have open. A guest that opens it again re-offers the path.
- **A remote edit is saved once the room settles** (500 ms after the last one, one write per
  document), because the host's working copy is the room's truth and an unsaved buffer leaves
  the file on disk stale. A local edit is the user's own and is never saved for them. Setting
  `selvage.autoSave` to `false` leaves the buffer dirty and the file alone. A guest's virtual
  document is saved too — its `writeFile` is a no-op, and the call is what clears the dirty
  marker rather than leaving a save prompt at close.
- **A guest's document is `selvage:/<path>?room=<room id>`**, behind a `FileSystemProvider`
  (a `TextDocumentContentProvider` is read-only by contract, and guests edit). Its provider
  refuses `delete`, `rename` and `createDirectory` and returns nothing from `readDirectory`:
  `DESIGN.md` §4.2 has no file tree.
- **Colour is derived from the peer id** (FNV-1a over a fixed palette), so two clients paint a
  peer alike instead of agreeing only by join order.
- **The invite is a `ws://` URL and stays one.** Joining is a paste-the-link command; there is
  no `vscode://` wrapper, because that would be a convention the protocol does not have.
- **A change the editor refuses is recomputed, not replayed**: `applyEdit` answering `false`
  asks the bridge to work the change out again against the buffer's current text.
- **Undo is not made CRDT-aware.** A remote edit lands on the buffer's undo stack, so `Ctrl+Z`
  can undo a peer's edit; the resulting change event is published like any other and the room
  reconverges. Per-user undo is explicitly out of scope (`docs/studies/vscode-plugin.md` §2.2).
- **Format-on-save is not fought.** A formatter's edit is an ordinary change event and is
  published; with peers running formatters this can echo (`SPIKES.md`, spike 3), so turn
  format-on-type off while collaborating.

## Tests

| File | What it covers |
|---|---|
| `test/envelope.test.ts` | version compatibility (same-major, minor decisive only at 0.x), error/close codes, URL round-trips, permissive envelope parsing |
| `test/engine.test.ts` | mint/join by invite URL, refusals by code, `/meta` fail-fast, the open-document set's hold semantics, request correlation, convergence, presence attribution and expiry, the room lifecycle, hostile frames |
| `test/crossing.test.ts` | an anchor produced by real `yjs` resolves through this engine; the fixture is vendored under `test/fixtures/`, or read from the `specification` checkout named by `SELVAGE_VECTORS` |
| `test/reconnect.test.ts` | §9.1: a dropped guest re-hellos and re-opens; a dropped host *reclaims its room* rather than minting a new one; a destroyed room is terminal |
| `test/editing.test.ts` | the document policy alone: LF in the replica, the minimal diff, the echo comparison, the `selvage:` URI, the peer palette |
| `test/bridge.test.ts` | the adapter's half against the fake server and a fake editor: seeding, both directions of the loop, a keystroke inside the apply window, the CRLF offset mapping, the save policy, holds, a refused `doc.open`, a late guest, cursors, lifecycle order |
| `test/manifest.test.ts` | the built bundle loads, activating it registers exactly the commands the manifest contributes, every declared setting is read, `@types/vscode` fits `engines.vscode` |
| `test/guest-fs.test.ts` | the guest's `FileSystemProvider` through the built extension: what it serves from the session, what it refuses to name, that a save writes nothing, and that a document outlives the room that produced it |
| `test/boundary.test.ts` | no `vscode` import outside `src/adapter/`, no undeclared dependency, every editor-independent module reachable from a test, the public surface |
| `test/selvaged.test.ts` | the gate, against the real `selvaged`: two engines, concurrent edits, text + state-vector convergence, presence both ways, a late joiner, a guest that disconnects and joins again, close semantics |
| `test/spikes/` | the three §7 experiments, as measurements (`SPIKES.md`) |

**103 tests, 0 failures**: 99 server-free and 4 that need a built `selvaged`. Waits are bounded
polls of a real predicate that report the state they observed on failure
(`test/helpers/wait.ts`), not `sleep`-and-hope.

The seam check is two halves. `test/boundary.test.ts` scans the sources for `vscode`,
`vscode-*` and `@types/vscode` specifiers — static or dynamic, in either quote style — which is
what catches an `import type`, erased before Node ever runs it. `npm run typecheck` is the
other half, and `ci.yml` runs it before `test:fast`.

## Not here

A sidecar or second process, a file tree and create/rename/delete, read-only guests
(`PROTOCOL.md` §12.3), per-user undo, host-filesystem reads beyond the open workspace
documents, multi-room windows, and publication (`vsce package`, a Marketplace publisher). Also
deliberately absent: a `y-websocket` provider (Selvage's envelope is not y-websocket's),
`terminal/1`, and any default server address.

## Licence

The client is `MIT OR Apache-2.0`, at your option: [`LICENSE-MIT`](LICENSE-MIT) and
[`LICENSE-APACHE`](LICENSE-APACHE). The cross-library anchor fixture under `test/fixtures/` is
vendored from the [`specification`](https://github.com/selvage-protocol/specification)
repository, whose material is `CC-BY-4.0`.
