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
| nix | `2.34.8` | `nix develop` gives the Node above, `nix flake check` runs the server-free half in a sandbox, and `nix develop ../reference_server` builds `selvaged` out of the sibling checkout, which the four server-backed tests need |

```console
$ npm ci --no-audit --no-fund          # 12 packages, ~47 MB, no native builds
$ npm run build                        # → dist/extension.js, 438 kB, and dist/package.json
$ npm run typecheck                    # tsc --noEmit, strict, erasableSyntaxOnly
$ npm run test:fast                    # builds, then 146 tests, no server, no editor
$ npm test                             # 150 tests: the same plus 4 against a real selvaged
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

`SELVAGE_SELVAGED` is also the seam the flake stops at. `nix flake check` runs the server-free
half (`typecheck` and `test:fast`) in a sandbox, and `nix develop` gives the same Node — but a
check cannot build a sibling checkout, so the four server-backed tests stay a local run: build
`selvaged`, point `SELVAGE_SELVAGED` at it, run `npm run test:selvaged`.

This repository's own flake has no git hooks: the shell that installs them is
`../reference_server`'s, and it writes them into whatever repository it is started in.

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
5. **Window two** — the room's document opens by itself as `selvage:/<path>?room=<room id>`,
   editable; both windows now type into the same text and see each other's caret as a bar in
   the peer's colour, with their selection tinted. Hovering a caret names the peer; nothing is
   drawn over the text unless `selvage.cursorLabel` asks for it. With several documents in the
   room only the first opens; run *Selvage: Open a document from the room* to reach any of the
   others.
6. `Selvage: Leave session` on either side. Closing window one — the host — ends the room
   after the server's grace period, and window two is told.

Set `selvage.serverUrl` and `selvage.displayName` in settings to stop being asked. There is
**no default server**: a baked-in endpoint would be one someone else chose.

## Commands

Seven, the same seven the Neovim client has with `:SelvageHost`, `:SelvageJoin`,
`:SelvageDisplayName`, `:SelvageOpen`, `:SelvageCopyInvite`, `:SelvageLeave` and
`:SelvagePeers`. Only the presentation differs: an editor command is a palette entry here and a
`:command` there.

| | |
|---|---|
| `Selvage: Host a session` | Mint a room on a server and share this window's documents. Asks for the server address and the name. |
| `Selvage: Join a session from an invite link` | Join the room the invite link names, pre-filled from the clipboard when the clipboard holds one. |
| `Selvage: Set the name other participants see` | Report the name in force, and set the one the next host or join will use. |
| `Selvage: Open a document from the room` | Put one of the room's documents in an editor. Only a guest has virtual documents to open; a host's open files are the room's. |
| `Selvage: Copy the invite link` | Put the invite on the clipboard. Only the connection that minted the room has one. |
| `Selvage: Leave session` | Leave the session. Leaving as the host ends the room for everyone after the server's grace period. |
| `Selvage: List the room's participants` | List everyone else in the room — each one's colour, name, role and the document they are in. |

The name other participants see is resolved when a session starts, in this order:
`selvage.displayName`, then a question pre-filled with the login name. **It is bounded at 32
UTF-16 code units** — the protocol's unit, so an emoji costs two — and a longer name is
*refused* wherever it comes from, never shortened, because a name must be the one its owner
chose: the setting is checked before it is sent, the question refuses an answer as it is typed
and says how many units it used, and the command refuses to write one. A settings file the
editor will not write — one a configuration manager owns and leaves read-only — is reported
rather than left to look as though the name had changed. The name travels in the
`host`/`join` handshake and nothing carries it afterwards, so a change made while a session is
live applies to the next host or join, not the current one; `Selvage: Set the name other
participants see` says so when it sets it.

`Selvage: List the room's participants` is the key to the carets. A peer is drawn as a bar in
their own colour with their name in the caret's hover, and this is where a colour is turned back
into a person. It lists every peer the room names, including one in a document this window does
not hold — a colour is derived from a peer id, so it is known before the caret is drawn. The
colour is not chosen here: it is `peerColour(peer_id)` from `src/bridge/cursors.ts`, the same
value the caret bar, the selection fill, the overview-ruler tick and the hover are built from, so
the list cannot disagree with what it explains. The list is drawn as a quick pick with a
coloured dot per row, because `QuickPickItem.iconPath` is the only field an editor renders a
colour from — and nothing in this repository can see that dot.

## Packaging it

The extension is not published to the Marketplace; installing a built `.vsix` is the path for
anyone who is not developing it from a checkout.

```console
$ npm run package                      # → selvage-client-<version>.vsix in the repo root
$ code --install-extension selvage-client-<version>.vsix
```

`npm run package` runs `vsce package` (`@vscode/vsce`, a `devDependency`), which first runs
`vscode:prepublish` — the same `npm run build` used everywhere else — so the `.vsix` always
carries a fresh `dist/extension.js`. `vsce package -o <path>` sends the file somewhere other
than the repo root, which is otherwise where an un-suffixed `vsce package` writes it.

`dist/extension.js` bundles everything the extension needs — the engine, the bridge, `ws`,
`yjs`, `y-protocols` — because `scripts/build.mjs` leaves only `vscode` external
(`.vscodeignore`); the `.vsix` therefore has no `node_modules/`, `src/`, or `test/` in it,
only `dist/`, the manifest, and the two licence files. `vsce package` warns that it found no
`LICENSE`/`LICENSE.md`/`LICENSE.txt` — the project's dual `LICENSE-MIT`/`LICENSE-APACHE` naming
(matching `reference_server` and `specification`) is not one of the names it looks for; both
files ship in the `.vsix` regardless.

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
| `src/bridge/editing.ts` | LF in the replica, the document's own line endings on render, the smallest change between two texts that never cuts a surrogate pair, and the content comparison that stands in for an echo guard |
| `src/bridge/bridge.ts` | `SessionBridge`: seeding, both directions of the buffer/replica loop, the save policy, the `EditorHost` interface an adapter implements |
| `src/bridge/cursors.ts` | the remote-cursor model, and the palette a peer's colour is derived from |
| `src/bridge/virtual.ts` | the guest's `selvage:` URIs: build, parse, refuse |
| `src/adapter/extension.ts` | `activate`, the seven commands, the status bar, the window's listeners |
| `src/adapter/documents.ts` | `WorkspaceEditor`: which documents are shared, `applyEdit`, save, line endings |
| `src/adapter/guest-fs.ts` | the `selvage:` `FileSystemProvider`: the replica's text in, writes out |
| `src/adapter/decorations.ts` | remote carets, selections and the overview-ruler lane; the name label when one is opted into |
| `src/adapter/labels.ts` | what a peer's name is drawn as: nothing by default, the floating box and the documented chip as opt-ins, the bound on a drawn name, and the declarations the box rides |
| `src/adapter/display-name.ts` | the protocol's bound on a display name, the count in UTF-16 code units, and the question that asks for one |

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

The points `docs/studies/vscode-plugin.md` §9 leaves open, and what this client does about each:

- **A host shares the `file:` documents open under its workspace folder**, on open and for
  those already open when the session starts; that folder is the grant. A guest shares nothing
  from disk — only the `selvage:` documents the room gave it. There are no exclude globs in
  v1: what a host shares is what it has open, which is visible in its own window.
- **A guest opens the room's first document as it joins**, once and with no input: joining a
  room that already has files should land in the work, not in a quick-pick. Only the first — a
  host with five files open must not open five editors — and *Open a document from the room*
  still lists every path. The adapter opens nothing later in the session, so it never pulls
  focus from a document the user is editing.
- **Hosting while already hosting copies the invite**, the same thing *Copy the invite link*
  does, rather than telling the user to run it; no second room is minted. A guest that runs
  *Host*, or anyone that runs *Join* while in a session, is asked to confirm leaving first —
  leaving a hosted room ends it for everyone in it — and nothing happens if they decline.
- **Reconnection is the engine's; the adapter reports it.** `PROTOCOL.md` §9.1's bounded
  backoff lives in `SelvageEngine`, and the window is told when the host detaches and comes
  back, when the room is gone and when the connection ends. A session whose connection is
  finished is ended rather than left half-alive: the message says why, and nothing retries
  behind the user's back.
- **`GET /meta` is checked before the first connect** (the engine's default). An unreachable
  `/meta` decides nothing; one that names a version this client cannot speak fails the command
  with a message instead of opening a session that half works.
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
  `DESIGN.md` §4.2 has no file tree. The quick-pick in *Open a document from the room* is the
  only place a room path is named, and it offers the room's own open-document set — a guest
  never types a path, so it cannot mistype the host's workspace-folder prefix.
- **Colour is derived from the peer id** (FNV-1a over a fixed palette), so two clients paint a
  peer alike instead of agreeing only by join order. *Selvage: List the room's participants*
  prints that same colour beside each peer — the value is `peerColour(peer_id)`, the one the
  caret bar, the selection fill and the overview-ruler tick are built from, so the key cannot
  disagree with what it explains. It is drawn as a quick pick with a coloured dot per row,
  because `QuickPickItem.iconPath` is the only field an editor renders a colour from; nothing in
  this repository can see the dot, only the URI.
- **The name other participants see is set by a command as well as a setting.** *Selvage: Set the
  name other participants see* reports the name in force — the live session's, else the setting's
  — and writes `selvage.displayName` at the global scope, which is the analogue of the Neovim
  client's `vim.g.selvage_display_name`; a workspace is not a place a person's name belongs. The
  name travels in the `host`/`join` handshake and nothing carries it afterwards, so the command
  says that a session already live keeps the name it started with. **A name is at most 32 UTF-16
  code units and an over-long one is refused, never shortened**: the setting is checked before it
  is sent, the question refuses an answer while it is typed and says how many units it used, and
  reaching for a shorter name is the question that then appears, pre-filled with the one that was
  refused. The count is `String.prototype.length` — an emoji costs two — and not the code-point
  count `[...name].length` would give. The write is what makes the name the next session's, so a
  settings file that will not take it — one a configuration manager owns and leaves read-only —
  is reported rather than swallowed.
- **A peer is drawn as a caret and a selection, and their name is not drawn over the
  document** (`selvage.cursorLabel`, default `none`). The caret is a two-pixel bar on the left
  edge of the peer's position in their colour, the selection a quarter-alpha fill of the same
  colour, and the overview ruler carries a tick of it on the right. The name is available
  without covering anything: the caret's `hoverMessage` reads "name · role", and the status
  bar's tooltip lists *In the room: …*. The glyph margin was considered and dropped — a
  `gutterIconPath` is an image, the API has no colour for the margin, and the overview ruler
  already carries the colour to the same lane.
- **A drawn name is bounded.** The decoration API measures nothing, so any width in a label is
  a guess; a name is peer-controlled and unbounded, so a guess is not enough. `boundedLabel`
  clips a drawn name to 24 code points with a trailing ellipsis — by code point, so a name
  holding an astral character is never cut through a surrogate pair. The clip is only on what
  is *drawn*: the caret's hover and the status bar always carry the whole name.
- **`selvage.cursorLabel: "floating"` is an explicit opt-in** — a small box in the peer's
  colour above their caret, out of the line's flow. The decoration API has no position, layer
  or overlay, so the box is drawn by writing declarations — `position: absolute; top: -1.3em;
  pointer-events: none; …` — into a field documented as *one CSS declaration*, which the editor
  substitutes into the rule it generates. **That is undocumented behaviour**, taken deliberately
  rather than smuggled in as ordinary styling: it was read out of a shipped editor, it can
  change in a release with no change to the API or the protocol, and nothing in the suite can see
  a pixel — `test/labels.test.ts` pins the option object, and the rendering itself has only been
  looked at by eye (VS Code 1.137.0). It covers the line above the caret: the vertical offset is
  a constant against a line height the extension cannot read, so `editor.lineHeight: 34` moves
  the box inside the caret's own line instead; it cannot leave the editor's top edge, so on one
  of the first visible lines it is cut off; two peers at one offset draw two boxes on top of each
  other; and as a pseudo-element it is invisible to screen readers.
- **`selvage.cursorLabel: "chip"` is the documented opt-in** — the same clipped name inside the
  line behind a coloured border, in documented fields only. It covers the text it sits against,
  which is why it is not the default either.
- **The invite is a `ws://` URL and stays one.** Joining is a paste-the-link command; there is
  no `vscode://` wrapper, because that would be a convention the protocol does not have.
- **A change the editor refuses is recomputed, not replayed**: `applyEdit` answering `false`
  asks the bridge to work the change out again against the buffer's current text.
- **A change never ends inside a character.** Two astral characters that share a surrogate
  half — any two emoji — leave the difference between the halves, and a change cut there is
  half a character in `text`: an edit no editor can make, and a `\ud83d` escape a strict JSON
  decoder refuses, which is how a front-end that cannot read the line leaves the apply
  unanswered for ever. `diff` widens its range to whole characters instead, which costs at
  most one UTF-16 code unit at each end of it.
- **Undo is not made CRDT-aware.** A remote edit lands on the buffer's undo stack, so `Ctrl+Z`
  can undo a peer's edit; the resulting change event is published like any other and the room
  reconverges. Per-user undo is explicitly out of scope (`docs/studies/vscode-plugin.md` §2.2).
- **Format-on-save is not fought.** A formatter's edit is an ordinary change event and is
  published; with peers running formatters this can echo (`SPIKES.md`, spike 3), so turn
  format-on-type off while collaborating.
- **The adapter ↔ engine transport stays a module interface, not a wire protocol.**
  `DESIGN.md` §4.4 makes one optional; the study's §6 puts both halves in one process behind a
  hard seam, which is what `src/bridge/` is. Its `EditorHost` — six methods, no editor in
  scope — is the shape a transport would have to carry, and no format is invented until
  something needs one.

## Tests

| File | What it covers |
|---|---|
| `test/envelope.test.ts` | version compatibility (same-major, minor decisive only at 0.x), error/close codes, URL round-trips, permissive envelope parsing |
| `test/engine.test.ts` | mint/join by invite URL, refusals by code, `/meta` fail-fast, the open-document set's hold semantics, request correlation, convergence, presence attribution and expiry, the room lifecycle, hostile frames |
| `test/crossing.test.ts` | an anchor produced by real `yjs` resolves through this engine; the fixture is vendored under `test/fixtures/`, or read from the `specification` checkout named by `SELVAGE_VECTORS` |
| `test/reconnect.test.ts` | §9.1: a dropped guest re-hellos and re-opens; a dropped host *reclaims its room* rather than minting a new one; a destroyed room is terminal |
| `test/editing.test.ts` | the document policy alone: LF in the replica, the minimal diff, the echo comparison, the `selvage:` URI, the peer palette |
| `test/bridge.test.ts` | the adapter's half against the fake server and a fake editor: seeding, both directions of the loop, a keystroke inside the apply window, the CRLF offset mapping, the save policy, holds, a refused `doc.open`, a late guest, cursors, lifecycle order |
| `test/manifest.test.ts` | the built bundle loads, activating it registers exactly the commands the manifest contributes, every declared setting is read, the cursor label's default draws nothing, `@types/vscode` fits `engines.vscode` |
| `test/commands.test.ts` | the command flows through the built extension and a fake `selvaged`: hosting while hosting copies the invite and mints nothing, a guest opens the room's first document itself, the open command offers the room's own list, the leave-first questions, the display name reported, set, refused over the bound and never sent, the participant list and its colours |
| `test/display-name.test.ts` | the display-name bound: the count in UTF-16 code units — an astral character costs two, which is where `[...name].length` would be wrong — the refusal naming both counts, and the option object the question is built from |
| `test/labels.test.ts` | the label decision: no name by default, a drawn name clipped to the bound (by code point), and the exact option object each opt-in produces — the pixels are not covered by anything |
| `test/guest-fs.test.ts` | the guest's `FileSystemProvider` through the built extension: what it serves from the session, what it refuses to name, that a save writes nothing, and that a document outlives the room that produced it |
| `test/boundary.test.ts` | no `vscode` import outside `src/adapter/`, no undeclared dependency, every editor-independent module reachable from a test, the public surface |
| `test/selvaged.test.ts` | the gate, against the real `selvaged`: two engines, concurrent edits, text + state-vector convergence, presence both ways, a late joiner, a guest that disconnects and joins again, close semantics |
| `test/spikes/` | the three §7 experiments, as measurements (`SPIKES.md`) |

**137 tests, 0 failures**: 133 server-free and 4 that need a built `selvaged`. Waits are bounded
polls of a real predicate that report the state they observed on failure
(`test/helpers/wait.ts`), not `sleep`-and-hope.

The seam check is two halves. `test/boundary.test.ts` scans the sources for `vscode`,
`vscode-*` and `@types/vscode` specifiers — static or dynamic, in either quote style — which is
what catches an `import type`, erased before Node ever runs it. `npm run typecheck` is the
other half, and `ci.yml` runs it before `test:fast`.

## The two-instance proof (`test/e2e/`)

Everything above stubs the editor or runs one process. `test/e2e/run.ts` does neither: it
starts a real `selvaged`, downloads a real VS Code build, and launches **two independent, real
Extension Development Host processes** (`@vscode/test-electron`, headless under Xvfb) with the
real built extension loaded — one hosting a real file, one joining by invite, both editing
concurrently — and asserts their documents converge. Left running, it also cuts the guest's
connection through a small relay and checks it reconnects and re-converges.

Run it with `scripts/e2e/run-two-instance.sh` from the repository root. It has heavier
prerequisites than everything else here — a network, Xvfb, an internet download the first time,
and `nix` to work out the shared-library path a VS Code build downloaded outside `nix` needs on
NixOS — so it is a manual verification step, not part of `npm test`/`test:fast`, and not wired
into `ci.yml`.

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
