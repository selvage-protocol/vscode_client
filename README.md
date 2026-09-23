# Selvage for VS Code

A VS Code extension for the [Selvage `selvage/1` session protocol](https://github.com/selvage-protocol/specification):
share a folder with someone and edit the same files at the same time. It is for two people
working in one checkout, one of whom starts a `selvaged` to hold the room.

## Get started

You need:

- VS Code 1.85 or newer. The manifest pins `engines.vscode` at `^1.85.0`.
- A `selvaged` to connect to. The host starts one and notes the address it prints; the guest needs
  just the invite link.
- Node 22.18 or newer, if you build or test the extension from a checkout: the tests are `.ts`
  files run directly by `node --test`, which needs type stripping.

### Install

Install it from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=selvage-protocol.selvage-client),
or search the Extensions view for Selvage:

```console
$ code --install-extension selvage-protocol.selvage-client
```

You can install a `.vsix` instead: the one attached to a
[GitHub Release](https://github.com/selvage-protocol/vscode_client/releases), or one you build:

```console
$ npm ci --no-audit --no-fund          # 325 packages, ~180 MB
$ npm run package                      # → selvage-client-<version>.vsix in the repo root
$ code --install-extension selvage-client-<version>.vsix
```

`.github/workflows/release.yml` packages the extension, attaches the `.vsix` to the GitHub Release
and publishes it to the Marketplace as `selvage-protocol.selvage-client`; the owner triggers a
release from that workflow. `npm run package` runs `vsce package`, which runs the `npm run build`
used everywhere else first, so the `.vsix` always carries a fresh `dist/extension.js`.
`scripts/build.mjs` leaves only `vscode` external, so that one file bundles the engine, the bridge,
`ws`, `yjs` and `y-protocols`; there is no `node_modules/` in the `.vsix`. `vsce package -o <path>`
writes it somewhere other than the repo root.

### Run it from a checkout

```console
$ code --extensionDevelopmentPath="$PWD" path/to/folder
```

Pressing `F5` does the same through `.vscode/launch.json`, which builds `dist/` first. That file
has two configurations, `Selvage (first window)` and `Selvage (second window)`, each with its own
`--user-data-dir` under `.tmp/`, because a session needs two windows that do not share state.
Launch the first, then start the second from the same window you launched the first from.

### A first session

1. Start `selvaged` and note the address it prints. For a server on this machine that is
   `ws://127.0.0.1:8080`; for a server behind TLS, its host alone is enough.
2. In the window whose folder you want to share, run `Selvage: Host a session` from the command
   palette (`F1`). It asks for the server address and for a display name, once each, and puts the
   invite link on your clipboard as the room opens.
3. Send that link to the other person.
4. They run `Selvage: Join a session from an invite link` and paste it, and give a display name.
   Joining reloads their window onto the room's folder, so whatever tree the window held is
   replaced by the room's files. The invite and the name cross the reload, so neither is asked
   for twice.
5. The room's first document opens by itself as a real file under the room's folder, and both
   windows type into the same text. Each sees the other's caret as a bar in the peer's colour,
   with their selection tinted; hovering a caret names the peer. Nothing is drawn over the text
   unless `selvage.cursorLabel` asks for it.

Open a file inside the shared folder to share it: it is shared as soon as it is open. With
several documents in the room only the first opens for a guest, so run
`Selvage: Open a document from the room` to reach the others, and set `selvage.openOnJoin` to
`false` to be shown nothing by a join.

`Selvage: Leave the session` leaves on either side. Closing the host's window ends the room after
the server's grace period, and the guest is told.

### Settings

Set `selvage.serverUrl` and `selvage.displayName` to stop being asked for them.

| Setting | Default | What it does |
|---|---|---|
| `selvage.serverUrl` | unset | The WebSocket address to host on, given in full or as a bare host (which means `wss://<host>`). Setting it means hosting never asks, and it outranks the last server used. |
| `selvage.displayName` | unset | The name other participants see. A change while a session is live renames this connection at once. |
| `selvage.autoSave` | `true` | Save a document the room changed, once the room has settled on it. |
| `selvage.openOnJoin` | `true` | Put the room's first document in an editor for a guest. |
| `selvage.cursorLabel` | `"none"` | Whether a peer's name is drawn over the document at their caret: `none`, `floating` or `chip`. |
| `selvage.wireVersion` | `"auto"` | The wire version this window is pinned to when it hosts: `"selvage/2"` for the encrypted wire, `"selvage/1"` for a room the server can read. `auto` is not a pin, and it is the default: the window takes what the server's `/meta` says it seats, and refuses rather than falls back where that is no `selvage/2`. A join is unaffected — it speaks the version the invite link names. |

The server is resolved in this order: an address given to the command programmatically (the
palette takes none), then `selvage.serverUrl`, then the last server used. The first two answer
silently, so hosting asks only in a window that has neither, and that one question starts from the
demo server `ws://100.64.0.3:8080`. A host that reused the last server names it in the room-open
notice, with a `Change the server` button that asks the same question again for the next host. A
host on the setting or on an explicit address gets no such button; that address is changed where
it was set.

A server address is typed in the command's argument, the box's answer, the `selvage.serverUrl`
setting, or a remembered address, and all four read it the same way: a bare host means the
published shape, `wss://<host>`, because the room is dialled over TLS. The `/session` path every
Selvage server answers belongs to the engine, which appends it to whatever base it is given, so a
base that already ends in `/session` has that suffix removed before the engine appends its own;
any other path is kept, because a server behind a prefix was named on purpose.

`Selvage: Change the server` reports the address the next host will use and offers the same box
to change it, without hosting first. While `selvage.serverUrl` is configured that setting
outranks the remembered address, so the command says so and changes nothing. Either way the write
reaches the next host only, and never a room already open.

A display name is resolved when a session starts, in this order: `selvage.displayName`, then the
remembered answer, then a question pre-filled with the login name. It is bounded at 32 UTF-16 code
units, so an emoji costs two, and a longer name is refused wherever it came from.
`Selvage: Set the name other participants see` reports the name in force and changes it; the write
goes to the global scope.

## What it does

The room is a folder on disk in both windows. A host shares the `file:` documents it has open
under its workspace folder, and that folder is the grant: a guest can list it, open any of its
files, and read one the host never opened, on request. The listing follows the host's folder, so a
file a build, a branch switch or another terminal creates or removes reaches the room without
anybody asking.

A guest's window holds the room as a real directory under the extension's global storage, so the
trees, search and language servers a person already runs work on the room's files. The join
reloads the window onto that directory, replacing whatever tree was there, and leaving deletes it
again. `Selvage: Download a file from the room` is how content that nobody has opened yet arrives
in it, and how a whole project is published to the other side.

In the editor a peer is a coloured caret, a selection fill, a tick in the overview ruler, and
their initials on a badge in the gutter and on the Explorer row of the file they are in. A peer's
colour comes from their id, so both clients paint the same person the same way, and
`Selvage: List the room's participants` turns a colour back into a name and a role. The same
roster is a `Selvage: Participants` view beside the Explorer: one row per peer, with go-to and
follow on the row, and clicking a peer lands where they are.

Following keeps landing where a peer is as they move, until something ends it; going to someone
lands there once. The status bar carries the session and the room, copies the invite when it is
selected, and holds the follow with the control that stops it. A document the room changes is
saved once the room settles, because the host's working copy is the room's truth.

## Commands

Twelve, the same twelve the Neovim client has as `:SelvageHost`, `:SelvageJoin`,
`:SelvageDisplayName`, `:SelvageChangeServer`, `:SelvageOpen`, `:SelvageFetch`,
`:SelvageCopyInvite`, `:SelvageLeave`, `:SelvagePeers`, `:SelvageGoTo`, `:SelvageFollow` and
`:SelvageStopFollowing`. The presentation is the editor's: an editor command is a palette entry
here and a `:command` there, so going to or following a participant is a palette pick here and a
completing command there.

| | |
|---|---|
| `Selvage: Host a session` | Mint a room on a server and share this window's folder. Asks for the server address only when no argument, setting or remembered address names one (a bare host is completed to `wss://<host>` either way), and for the name once. Running it while already hosting copies the invite instead of minting a second room. Refused in a window with no folder open: a room is a grant of that folder, so it would have nothing to share. The notice that follows carries the invite's next step and a `Copy again` button; a copy the editor refused, or a connection given no invite, is named in it. |
| `Selvage: Join a session from an invite link` | Join the room an invite link names, replacing this window's folder with the room's mirror. Accepts the page link a host copies, whose origin is the server the room lives on; a `ws://` link joins as it stands, which is how a room whose server serves no page is handed on. A link that cannot join (a truncated paste, half a query) is refused before the name is asked and before the window reloads, in words that leave the link's token out. A window holding a folder of its own is asked before the reload takes it, and that folder stays on disk either way. A refusal says what happened in ordinary words; the room's own `no such room: <id>` and `invalid room token` never reach the person. |
| `Selvage: Set the name other participants see` | Report the name in force, and set it. A change while a session is live renames it at once; the next host or join carries the same name. |
| `Selvage: Change the server` | Report the server the next host uses, and set it, without hosting first. |
| `Selvage: Open a document from the room` | Put one of the room's documents in an editor. A guest opens its mirror file; a host's open files are the room's. |
| `Selvage: Download a file from the room` | Hold one listed path, or a directory of them, in the room so every peer receives it, filling the mirror. Refused while hosting: your files are already on your disk. |
| `Selvage: Copy the invite link` | Put the session's invite on the clipboard. A session the server gave no invite to says so, and a clipboard the editor refuses says why. A host copies the page its own server serves, carrying the room and its token, so one address decides both the page a guest opens and the socket they join on. A guest hands on the link it joined by, as it stood; the invite is the permission, so the token it joined with is the guest's to pass on. |
| `Selvage: Leave the session` | Leave the session. Leaving as the host ends the room for everyone after the server's grace period. |
| `Selvage: List the room's participants` | List everyone else in the room, with each one's colour, name, role and the document they are in. Drawn as a quick pick with a coloured dot per row, because `QuickPickItem.iconPath` is the only field an editor renders a colour from. |
| `Selvage: Go to a participant` | Land where a participant is: their document, their caret. A document this window does not hold opens through the room first. |
| `Selvage: Follow a participant` | Keep landing where a participant is as they move, until something stops it. The status bar shows who is followed in their caret colour and stops the follow when selected; a local edit of a shared document ends it, and a remote one does not. |
| `Selvage: Stop following` | Stop following. Says so when no one is followed. |

## What is not here

The whole client runs in the extension host: the sync engine and the CRDT live next to the editor on
one event loop. There is no worker, no native module and no second process.

- Nothing is created, renamed or deleted on the wire (`PROTOCOL.md` §12), and a guest holds the
  same right to edit as the host (§12.3). A window holds one session, and a host reads its own
  filesystem only for a granted path a peer asked for.
- There is no `y-websocket` provider, because Selvage has its own envelope, and no `terminal/1`.
- There are no exclude globs. A host shares live the documents it has open, so what is on offer is
  visible in its own window, and any other file under the shared folder a guest reaches is read on
  request. A file a room asks for is checked before it is read, and only when the grant would
  publish it and every directory on the way is a plain directory of the shared folder, never a
  link out of it. The window between that check and the read is a stated residual:
  `vscode.workspace.fs` exposes no `realpath`, so a link swapped in after the walk is read on the
  peer's behalf.
- A change made while the connection is down is not republished when it comes back. The room keeps
  the listing it held across the host's disconnect grace and a re-seated host is sent it again, so
  the two agree; the room learns of the change at the next filesystem event or not at all. A
  folder the editor accepts a watcher for and then never delivers an event for has no error
  channel, so it leaves the listing as of session start and nothing says so.
- A document the room holds without listing it has no file here, so it cannot be opened the way
  the Neovim client opens it. A save to a path the room does not list is written, since the editor
  cannot refuse a save, and reported afterwards; the Neovim client refuses it upfront.
- Leaving deletes the mirror from the window. A document the room holds stays open and readable
  when the listing stops naming it, because a hold is released with `doc.close` and not by the
  listing.
- The resume a marker asks for waits for a trusted window. A folder can start this extension with
  nothing but a `.selvage-mirror.json` in it, and VS Code does not condition a `workspaceContains`
  activation on workspace trust, which is the only way back in after the reload that puts the
  room's folder in the window. In an untrusted window the extension starts, registers its commands
  and stops there; the triage a marker asks for runs once you trust the workspace. Every command
  is your own act and works in a window you have not trusted, which is why the manifest claims
  `limited` untrusted support.
- A name drawn over the text can break. `selvage.cursorLabel: "floating"` writes declarations into
  a field documented as one CSS declaration, which is undocumented editor behaviour: it can change
  in a release with no change to the API, and nothing in the suite can see a pixel. It covers the
  line above the caret and cannot leave the editor's top edge. `chip` uses documented decoration
  fields only and covers the text it sits against. Either way a drawn name is clipped at 24 code
  points, with the whole name still in the caret's hover.
- One badge per row, which is the decoration API's limit. A file several peers are in answers with
  their count and claims no colour; the hover names everyone.
- Undo is shared. A remote edit lands on the buffer's undo stack, so `Ctrl+Z` can undo a peer's
  edit; that change is published like any other and the room reconverges.
- Format-on-save is published like any other change, so with peers running formatters a session
  can echo (`SPIKES.md`, spike 3). Turn format-on-type off while collaborating.

## How it is built

| Layer | What it is | What it needs to be tested |
|---|---|---|
| `src/engine/` | transport, envelope, handshake, sync, awareness, presence, reconnect, and `selvage/2`'s sealed frame, peer session, host and socket wiring | a socket |
| `src/bridge/` | the adapter's editor-independent half: seeding, the echo guard, the EOL policy, the save policy, cursor attribution, and the `selvage/2` session seen as an engine | a replica and an editor interface |
| `src/adapter/` | the `vscode` half: documents, `applyEdit`, the mirror, decorations, commands, status | an editor |
| `src/node/` | the Node half of the crypto seam the engine asks a caller for (HKDF-SHA256, SHA-256, AES-256-GCM and Ed25519 over `node:crypto`) | nothing of its own |

The first two layers never import `vscode`, and they are the copy the other two clients carry:
`nvim_client/vendor/{engine,bridge}` and `web_client/src/{engine,bridge}` are taken from here and
refreshed by each repository's own sync script (`nvim_client/scripts/sync-engine.sh`,
`web_client`'s `npm run sync-engine`). A change to the wire or to the document policy belongs in
this repository and reaches the others by copying. `test/boundary.test.ts` enforces the rule that
no `vscode` import is allowed outside `src/adapter/`, along with three others: no undeclared
dependency, every module of the editor-independent half reachable from a test, and every module
in `src/adapter/` one that imports `vscode`.

`connect()` is bounded by `handshakeTimeoutMs` (10 s by default), which covers both the upgrade
and the handshake. `open()` and `close()` are bounded by `requestTimeoutMs` (10 s by default): a
server can hold the socket up and never answer, and the caller then fails with
`EngineClosedError`.

`src/adapter/extension.ts` is `activate`, the twelve commands, the status bar and the window's
listeners; `documents.ts` decides which documents are shared; `mirror.ts` is the room's mirror on
disk; `decorations.ts`, `labels.ts` and `gutter.ts` draw a peer; `display-name.ts` holds the
protocol's bound on a name and the question that asks for one.

### `selvage/2` in the engine

The engine speaks both versions end to end. Which one a room is depends on what the server
seats and on the `selvage.wireVersion` pin: an unpinned host on a server that seats `selvage/2`
mints it, a pin is honoured where the server seats it and refused where it does not, and a join
speaks the version its invite names. `selvage/2`'s session layer sits beside `selvage/1` rather
than instead of it, with the peer's half in `peer.ts` and the host's in `host.ts`:

| Module | What it is |
|---|---|
| `src/engine/crypto.ts` | the crypto seam a `selvage/2` frame needs — HKDF-SHA256, SHA-256, AES-256-GCM and Ed25519 — as an interface the caller supplies |
| `src/engine/sealed.ts` | `CANONICAL.md` §6.1's bytes: the envelope's layout, the key schedule, the canonical key encoding, the four sealed payloads, and the ten-step read with the reason each step reports |
| `src/engine/peer.ts` | `PROTOCOL.md` §13: the invite's fragment and its local refusal, the session keypair and its announcement, the order of operations at a join, verify-before-apply, attribution by the key that verified and the role the applied state gives it, a `viewer`'s content refused, the holds and their lease, the two windows that end a session, and §13.10's lifecycle |
| `src/engine/host.ts` | `PROTOCOL.md` §7.1's producer half: the host key, the room state it seals and signs, the rule for each state that goes out — at mint, on a change to the listing or to `peers`, on every `peer.joined` and `peer.left`, on every announcement accepted — the publish-rate window, the seat label a newly committed key is given, and the `issued` series kept with the key |
| `src/engine/crypto-web.ts` | that seam over WebCrypto (`globalThis.crypto`), which a page, Node and the extension host all have; it is the default a caller that supplies none gets |
| `src/engine/relay.ts` | the socket wiring those four were written to be handed: `session.hello` at `selvage/2`, the seat from `room.created`/`room.joined`, the invite minted with its fragment, the session's clock on a timer of its own, and every frame the session produced written to the socket. It is in the engine because the three clients drive the same wiring — the socket and the crypto are both seams, and what is left is `PROTOCOL.md` §5's handshake, which is the same for a page, a companion and an extension host |
| `src/bridge/peer-engine.ts` | `Engine` over a seated relay: the room's listing as the grant, §13.7's holds as the room's open set, §8's awareness in both directions, §13.8's host window as the adapter's own two events, and the §13.10 endings in the bridge's vocabulary |
| `src/node/crypto.ts` | that seam over Node's `crypto`, which is what this client and the corpus subject use |

Every rule in those three modules is `PROTOCOL.md` §13's, §7.1's or `CANONICAL.md` §6.1's, and each is
pinned twice: `test/sealed.test.ts` and `test/peer.test.ts` build their own frames from constants
and run without a sibling checkout, and `test/peer-corpus.test.ts` replays the peer corpus — it
seals each frame vector's recipe with this engine's `seal` and checks the bytes against the
vector's own `hex`, reads every frame through `Reader`, and drives the six decision vectors
through a subject.

That subject is `test/helpers/selvage-subject.ts`: the engine behind
`specification/runner/subject.py`'s line protocol, so the corpus's own runner drives this client
with

```console
$ python3 specification/runner/run_peer.py --subject "node test/helpers/selvage-subject.ts"
```

The crypto primitives are a seam and not an import because the engine is also the code the browser
client drives, and a page has no `node:crypto` — nor a synchronous one, since WebCrypto is
asynchronous. `src/node/` is outside the two directories the other clients copy for the same
reason: it is the Node half.

`test/host.test.ts` is §7.1's producer half on its own: every clock it passes in is a number and
every frame it builds comes from constants, so it is about the rules rather than about how long a
machine took. Each host guard is pinned twice over, by the rule's own test and by that test going
red under the mutation that removes the guard (`HOST_MUTATIONS`), which is what `mutate` is for.

**The editor surface, 2026-09-23.** The four methods the adapter needed are here, each a rule the
version already states rather than a new decision: `remove`, the deletion half of `insert`
(`§13.5`), without which the bridge's own `publish` silently dropped every deletion; a public
**`setAwareness`/`setSelection`** that publishes a local awareness frame (`§8.1`, `§13.9`), with
**`presence()`** to read every peer's anchors back against this replica (`§8.4`); the **role of
this connection's own key** (`§13.4`), which is what tells a `viewer` its editor is read-only; and
`resolveSelection`, `release(path)`, `has`, `rolesBySeat`, `namedHostSeat` and `hostAwayGraceMs`
for the rest of what an adapter reads. `Role` names `viewer` now, because the state can assign it.

Two decisions that surface changed with them, and both are the honest consequence of an
asynchronous seam. **A local edit lands in the replica before `insert`/`remove` return their
promise** — an adapter reads the replica back between two keystrokes, and one that had to wait for
a seal would compute the same keystroke twice — so an offset outside the document is now thrown
rather than rejected. And **an awareness state handed in is a frame a moment later**: `whenIdle()`
is what a caller drains after, because otherwise a caret goes out at the next renewal window.

### Sessions at `selvage/2`

This window drives both versions. `src/adapter/extension.ts` picks one per session — the version
the server's `/meta` says it seats, or the `selvage.wireVersion` pin when the setting names one,
or the fragment of the link a join was handed — and what is left for the adapter is a listing and
the role the room's state gives this connection. The socket wiring is `src/engine/relay.ts` and
the adapter's vocabulary is `src/bridge/peer-engine.ts`; the crypto seam is the engine's default,
WebCrypto, which the extension host has globally.

What a person does:

- **Host.** Nothing to set. A server that seats `selvage/2` gets an encrypted room, because a
  client that can speak that version mints it; `selvage.wireVersion: "selvage/1"` is how a room the
  server can read is asked for deliberately. A server whose `/meta` answers with no `selvage/2` is
  refused before a socket is opened — this client does not fall back to the readable wire — while a
  `/meta` that cannot be read at all is not that answer: the connection is attempted and the
  handshake reports the truth. The address, the folder and the invite are unchanged.
- **Join.** Nothing: paste the link. A `selvage/2` invite carries the room key and the host key on
  its fragment, and a client that cannot read them cannot join the room at all, so the link is the
  version the join speaks. A link with no fragment is a `selvage/1` join, as it always was.
- **Copy the invite.** Unchanged, and it now carries the fragment: the page link this window hands
  on is the same room, token and two keys as the connection's own wire invite. The wire URL the
  socket is handed never contains a `#`.
- **Everything else** — the mirror, the grant tree, participants, follow and jump, the fetch
  command, the save policy, the reconnect messaging — is the same code over the same bridge, so it
  works in a version-2 room without being told which version it is in.

**A viewer's documents are read-only.** A `selvage/2` room's state assigns roles (`§13.4`), and a
connection seated as `viewer` gets the room's documents with their edits refused: `§13.9` has a
viewer publish no content, so a buffer that accepted a keystroke would show text the room never
receives. The editor has no per-document read-only flag an extension can set, so the edit is put
back — the room's text returns and the attempt is said once, in the sentence both clients use.
This client declares `guest` and has no command to ask for the other role: what a host does with
the state is a later phase's, and a client that could ask to be a viewer would be inventing a
request the protocol does not have.

**The host key lives for the session.** A `§7.1` host signs its states with a key this window
mints when it mints the room, and holds in memory: the key, and the `issued` series that goes
with it, are gone when the session is. A returning host is what would keep them, and this client
runs no resume (`§9.1`), so there is nothing to read back today — and a private signing seed is
a secret, which is why the store that does land with a resume will be `context.secrets` and not
the window's `globalState`. The engine's `HostStore` is the seam such a store is handed in
through, and it stays open for a client that has a series to continue. §13.11's per-receiver caps
are unimplemented, as they are in the reference client.

What this slice does not do. The relay runs no resume: a dropped socket ends its session rather
than re-helloing, so `§9.1`'s host return is not wired either.

§7.1's **host-side corpus vectors** are not here — `test/host.test.ts` is what pins the producer,
and the peer corpus still drives the receiver's half — and §13.11's per-receiver caps are not
implemented (how many keys and marks §13.3 allows a client to keep, and how many paths and bytes
of paths it will hold).

Five things §7.1 and §13 leave open, each decided where it is read rather than filled in silently:

- **The label a key gets when the roster names no free seat.** §7.1 obliges a host to commit every
  announcement it accepts and forbids withholding one for want of a label, and it also says at most
  one key per seat. An announcement that outruns its `peer.joined` is where the two meet: the roster
  names only the host's own seat, the commitment is what the peer cannot do without, so the label is
  the half that gives way — two keys carry that seat, and the key already there keeps its
  commitment. `label()` and `commit()` state it.
- **What the host's own session does after it publishes a closing.** §13.10 says what a receiver
  does with one; §7.1 says only that a host that has left publishes nothing. Here the session that
  published it ends the way a receiver's does — `ending = 'closing'`, and nothing more published
  from it — because a room declared over is not one to write content into.
- **What a `peer.joined` obliges of a host.** §7.1 has a host publish a state on one, and the
  re-send of a state already held is stated as a *peer*'s rule. This host re-sends the state it
  holds when nothing in its listing or its `peers` has changed; a joiner that holds none applies
  it exactly as it applies a new edition, and every peer at that edition refuses it `stale_issued`.
- **§7.1's *MUST NOT hold two host sessions for one room at a time*.** Nothing here enforces it
  across processes: two connections that share a host key and a counter series publish one edition
  twice, and §13.3's rule for two publications at one edition is what a receiver does with that.
- **When a returning host writes above an edition it learned from a re-sent state.** §7.1's list of
  obligations does not include applying a state, and §9.1's resume is a state published above the
  room's. This host learns the room's edition from the state a peer re-sends it and writes above it
  at its next state — the next change to its listing or its `peers`, the next seat, or the next
  announcement it accepts — not on the state it just applied. It never re-sends the state it holds
  over an edition it has verified, because every peer refuses a frame at or below the edition it
  already carries.

## Checks

```console
$ npm run build                        # → dist/extension.js
$ npm run typecheck                    # tsc --noEmit, strict, erasableSyntaxOnly
$ npm run test:fast                    # builds, then the server-free suite
$ npm test                             # builds, then the same plus four against a real selvaged
$ npm run test:relay-selvaged          # a selvage/2 host and guest over a real selvaged
$ npm run test:peer-corpus             # the peer corpus, against this engine's own subject
$ npm run test:interop                 # interop with a real Rust client, over both wire versions
$ scripts/ci-local.sh all              # actionlint over the workflows, then the client job
```

`scripts/ci-local.sh all` is the gate before a push and runs the same commands as
`.github/workflows/ci.yml`. `all` is `lint` plus `client`: `lint` needs `nix`; `client` is
`npm ci`, `typecheck`, `build` and `test:fast`. CI runs the server-free suite only, because the
four tests in `test/selvaged.test.ts` need a built `selvaged` from the sibling `reference_server`
checkout, which the workflow does not have. `test:peer-corpus` needs the sibling `specification`
checkout for the same reason, and `SELVAGE_SPECIFICATION` names another one; `npm test` runs it
along with `test/interop.test.ts` and `test/interop-v2.test.ts`, which need the sibling
`reference_server` and an `interop_peer` built from it — the version-2 file needs one that
speaks `selvage/2`, which is `SELVAGE_INTEROP_PEER`'s other use.

```console
$ nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvaged'
```

`test:selvaged` finds that binary at `../reference_server/target/{debug,release}/selvaged`, or
wherever `SELVAGE_SELVAGED` points. A missing binary fails the test, which prints the command that
builds it. `cargo` is not on the ambient `PATH`, and `nix develop ../reference_server` runs its
command with the current directory, hence the `cd`. That flake's shellHook installs Rust git hooks
into this checkout; they are harmless and ignored, and CI does not use them. `nix flake check`
runs the server-free half in a sandbox, where a check cannot build a sibling checkout.

The suite runs against a fake `selvaged` (`test/helpers/fake-server.ts`) for the faults the real
server will not produce on demand (a dropped socket, a hostile `x.` event, `/meta` naming a
version this client cannot speak). Waits are bounded polls of a real predicate that report the
state they observed on failure (`test/helpers/wait.ts`). `test/manifest.test.ts` loads the built
bundle and activates it against a stub `vscode`, which is how CI checks the manifest without an
editor.

`test/e2e/run.ts` builds the most: it starts a real `selvaged`, resolves a pinned VS Code build
(`1.137.0` by default; set `SELVAGE_E2E_VSCODE_VERSION` to move it) and launches two real
Extension Development Host processes, headless under Xvfb, one hosting and one joining by invite
through a window reload, and asserts their documents converge. It has heavier prerequisites than
everything else here (a network, Xvfb, an internet download the first time, and `nix` for the
shared-library path a VS Code build downloaded outside `nix` needs on NixOS), so it is a manual
verification step: run `scripts/e2e/run-two-instance.sh` from the repository root.

## Licence

The client is `MIT OR Apache-2.0`, at your option: [`LICENSE-MIT`](LICENSE-MIT) and
[`LICENSE-APACHE`](LICENSE-APACHE). The cross-library anchor fixture under `test/fixtures/` is
vendored from the [`specification`](https://github.com/selvage-protocol/specification) repository,
whose material is `CC-BY-4.0`.
