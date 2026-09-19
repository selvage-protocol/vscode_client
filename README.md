# Selvage for VS Code

A VS Code extension for the [Selvage `selvage/1` session protocol](https://github.com/selvage-protocol/specification):
share a folder with someone and edit the same files at the same time. It is for two people who
want to work in one checkout, and one of them starts a `selvaged` to hold the room.

It is a from-scratch TypeScript client. The sync engine and the CRDT live in the extension host
next to the editor (`DESIGN.md` §6, and `docs/studies/vscode-plugin.md` §6 for why the sidecar
comes later), and the code is layered so that each layer can be tested with less than the one
below it.

## Get it working

You need:

- VS Code 1.85 or newer. The manifest pins `engines.vscode` at `^1.85.0`.
- A `selvaged` to connect to. A host starts one and notes the address it prints. A guest joins
  with the invite link the host copies and needs nothing else from the server side.
- Node 22.18 or newer if you build or test the extension from a checkout, since the tests are
  `.ts` files run directly by `node --test`, which needs type stripping.

### Install the packaged extension

The extension is not published, so a built `.vsix` is the way in for anyone who is not developing
it from a checkout:

```console
$ npm ci --no-audit --no-fund          # 325 packages, ~180 MB
$ npm run package                      # → selvage-client-<version>.vsix in the repo root
$ code --install-extension selvage-client-<version>.vsix
```

`npm run package` runs `vsce package` (`@vscode/vsce`, a `devDependency`), which first runs
`vscode:prepublish`, the same `npm run build` used everywhere else, so the `.vsix` always carries a
fresh `dist/extension.js`. `vsce package -o <path>` sends the file somewhere other than the repo
root, which is otherwise where an un-suffixed `vsce package` writes it.

`dist/extension.js` bundles everything the extension needs at runtime, which is the engine, the
bridge, `ws`, `yjs` and `y-protocols`, because `scripts/build.mjs` leaves only `vscode` external
(`.vscodeignore`). The `.vsix` therefore has no `node_modules/`, `src/` or `test/` in it, only
`dist/`, the manifest, and the two licence files. `vsce package` warns that it found no
`LICENSE`/`LICENSE.md`/`LICENSE.txt`, because the project's dual `LICENSE-MIT`/`LICENSE-APACHE`
naming (matching `reference_server` and `specification`) is not one of the names it looks for; both
files ship in the `.vsix` regardless.

### Install from a checkout

This is how the extension is normally loaded before publication. Open the checkout in VS Code and
start the Extension Development Host:

```console
$ code --extensionDevelopmentPath=$PWD <a folder to work in>
```

Pressing `F5` does the same through `.vscode/launch.json`, which builds `dist/` first
(`preLaunchTask`). That file has **two** configurations, because a collaborative session needs two
windows: `Selvage (first window)` and `Selvage (second window)`, each with its own
`--user-data-dir` under `.tmp/`, so the two extension hosts do not share state. Launch the first,
then the second from the *same* window you launched the first from, because the second debug
session starts another host.

### A first session

1. Start `selvaged`. It prints the address it is listening on.
2. In the window whose folder you want to share, run `Selvage: Host a session` (the command
   palette; `F1`) and give it that address and a display name. For a server on this machine that
   address is `ws://127.0.0.1:8080`. The status bar shows the session, and the invite link is shown
   and copied to the clipboard as the room opens.
3. Run `Selvage: Copy the invite link` for anyone who needs the link later.
4. On the other side, run `Selvage: Join a session from an invite link`, paste the link and give a
   display name. **Joining reloads that window onto the room's folder**, so whatever tree the
   window held before is replaced by the room's files. The invite and the name cross the reload,
   so there is no second question after it.
5. The room's document opens by itself as a real file under the room's folder in the Explorer, and
   both windows now type into the same text. Each sees the other's caret as a bar in the peer's
   colour, with their selection tinted; hovering a caret names the peer, and nothing is drawn over
   the text unless `selvage.cursorLabel` asks for it.

Open a file inside the workspace folder to share it: it is shared as soon as it is open, and its
path appears in the room's open-document set. With several documents in the room only the first
opens, so run `Selvage: Open a document from the room` to reach any of the others, and set
`selvage.openOnJoin` to `false` to be shown nothing by a join.

`Selvage: Leave the session` leaves on either side. Closing the host's window ends the room after
the server's grace period, and tells the guest.

### Settings and addresses

Set `selvage.serverUrl`, `selvage.webOrigin` and `selvage.displayName` in settings to stop being
asked. The server is resolved in this order: an explicit address given to the command, then the
`selvage.serverUrl` setting, then the last server used. The first of those answers silently, so
hosting asks only in a window that has none of them, and that one question starts from the demo
server `ws://100.64.0.3:8080`, a prefill rather than a commitment.

A host's `Selvage: Copy the invite link` links to the page named by `selvage.webOrigin`, which
defaults to the Pi page `https://lumi-raspberrypi.muskellunge-yo.ts.net:8443`. The setting must name
an https origin and anything else falls back to the default, so a host's copied link never carries
the room's token over cleartext. A guest copies the link it joined by, so that setting does not
touch a guest's copy.

## What it does

The room is a folder on disk in both windows. A host shares the `file:` documents it has open
under its workspace folder, and that folder is the grant: joining a guest can list it, open any of
its files, and read one the host never opened. The listing follows the host's folder, so a file a
build, a branch switch or another terminal creates or removes reaches the room without anybody
asking.

A guest's window ends up holding the room as a real directory, which is what makes an ordinary
editor setup useful on it: the trees, search and language servers a person already runs can read the
room's files. The join reloads the window onto that directory, replacing whatever tree was there,
and leaving deletes it again. `Selvage: Download a file from the room` is how content that nobody
has opened yet arrives in it, and how a whole project is published to the other side.

In the editor a peer is a coloured caret, a selection fill, a tick in the overview ruler and their
initials on a badge in the gutter and on the Explorer row of the file they are in. Colour comes
from the peer's id, so both clients paint the same person the same way, and `Selvage: List the
room's participants` turns a colour back into a name and a role. The same roster is a persistent
`Selvage: Participants` view beside the Explorer, one row per peer, where clicking a peer lands
where they are and the row carries go-to and follow.

Following keeps landing where a peer is as they move, until something ends it, and going to someone
lands there once. The status bar carries the session and the room, copies the invite when it is
selected, and holds the follow with the control that stops it. A document the room changes is saved
once the room settles, because the host's working copy is the room's truth.

## The engine it shares

| Layer | What it is | What it needs to be tested |
|---|---|---|
| `src/engine/` | transport, envelope, handshake, sync, awareness, presence, reconnect | a socket |
| `src/bridge/` | the adapter's editor-independent half: seeding, the echo guard, the EOL policy, the save policy, cursor attribution | a replica and an editor interface |
| `src/adapter/` | the `vscode` half: documents, `applyEdit`, the mirror, decorations, commands, status | an editor |

The first two layers are the ones that never import `vscode`, and they are the copy the other two
clients carry: `nvim_client/vendor/{engine,bridge}` and `web_client/src/{engine,bridge}` are taken
from here and refreshed by each repository's own sync script (`nvim_client/scripts/sync-engine.sh`,
web_client's `npm run sync-engine`). A change to the wire or to the document policy belongs in this
repository and reaches the others by copying.

No `vscode` import is allowed outside `src/adapter/`, and `test/boundary.test.ts` enforces that rule
along with three others: no undeclared dependency, every module of the editor-independent half
reachable from a test, and every module in `src/adapter/` one that imports `vscode`. A rule that
could have been tested belongs in `src/bridge/`.

Threading: everything is one event loop and synchronous. Frames are written as they are produced,
and events are delivered to listeners in the order frames arrived, so an adapter reacts to
`documentChanged` instead of polling. There is no worker, no native module and no second process.

Two bounds, and what each one covers. `connect()` is bounded by `handshakeTimeoutMs` (10 s by
default), which covers the upgrade *and* the handshake: if it expires the socket is closed and the
attempt rejects. `open()` and `close()` are bounded by `requestTimeoutMs` (10 s by default), because
the bound belongs to the client and not to the wire: a server that holds the socket up and never
answers fails the caller with `EngineClosedError` instead of leaving it pending. Neither bound
guesses: an unanswered `doc.open` records no hold, and both methods are idempotent, so re-asking is
how the caller settles what the server did.

## Commands

Eleven, the same eleven the Neovim client is specified to have with `:SelvageHost`,
`:SelvageJoin`, `:SelvageDisplayName`, `:SelvageOpen`, `:SelvageFetch`, `:SelvageCopyInvite`,
`:SelvageLeave`, `:SelvagePeers`, `:SelvageGoTo`, `:SelvageFollow` and `:SelvageStopFollowing`.
Only the presentation differs: an editor command is a palette entry here and a `:command` there, so
going to or following a participant is a palette pick here and a completing command there, while
the three intents stay one-to-one.

| | |
|---|---|
| `Selvage: Host a session` | Mint a room on a server and share this window's documents. Asks for the server address only when no argument, setting or remembered address names one; hosting again after a leave reuses the last one with no question. Asks for the name once. Refused in a window with no folder open: a room is a grant of that folder, so it would have nothing to share. The handshake is announced while it happens (`withProgress`), as the reconnect path's own indicator already was; the notice that follows carries the invite's next step and a Copy again button. |
| `Selvage: Join a session from an invite link` | Join the room named by an invite link entered by the user, replacing this window's tree with the room mirror (one reload, never a second root beside the local workspace). Accepts the https page link the host copies; a `ws://` link still joins as the advanced fallback for rooms off the page default. A link that cannot join (a truncated paste, a page link whose `&server=` is not a `ws://`/`wss://` address) is refused before the name is asked and before the window reloads, in words that never quote the link's token. A window holding a folder of its own is asked before the reload takes it, and the folder stays on disk either way. The handshake after the reload is announced while it happens. A refused join says what happened in a sentence with no room id and no wire word in it: the room's own `no such room: <id>` and `invalid room token` reach the person as ordinary words. |
| `Selvage: Set the name other participants see` | Report the name in force, and set it. A change while a session is live renames it at once; the next host or join carries the same name. |
| `Selvage: Open a document from the room` | Put one of the room's documents in an editor. A guest opens its mirror file; a host's open files are the room's. |
| `Selvage: Download a file from the room` | Hold one listed path, or a directory of them, in the room so every peer receives it, filling the mirror. Refused while hosting: the disk already holds what a mirror would. |
| `Selvage: Copy the invite link` | Put the session's invite on the clipboard. A host copies the page invite: an `https://` link opening the guest page with the room and its token (`&server=` only for rooms off the page default). A guest holds the token it joined with, and the invite is the permission, so it hands on the link it joined by, exactly as it stood: that same page link, or the `ws://` link where that is how the room was reached. |
| `Selvage: Leave the session` | Leave the session. Leaving as the host ends the room for everyone after the server's grace period. |
| `Selvage: List the room's participants` | List everyone else in the room, with each one's colour, name, role and the document they are in. |
| `Selvage: Go to a participant` | Land where a participant is: their document, their caret. A document this window does not hold opens through the room first. |
| `Selvage: Follow a participant` | Keep landing where a participant is as they move, until stopping. The status bar shows who is followed in their caret colour and stops the follow when selected; starting and an asked-for stop live in that item, with no toast, and a local edit or a go-to that ends the follow says so. Nothing is ever painted over document text. A local edit of a shared document ends it; a remote one does not. |
| `Selvage: Stop following` | Stop following. Says so when no one is followed. |

The name other participants see is resolved when a session starts, in this order:
`selvage.displayName`, then a question pre-filled with the login name. It is bounded at 32 UTF-16
code units, the protocol's unit, so an emoji costs two, and a longer name is *refused* wherever it
comes from rather than shortened, because a name must be the one its owner chose: the setting is
checked before it is sent, the question refuses an answer as it is typed and says how many units it
used, and the command refuses to write one. A settings file the editor will not write, one a
configuration manager owns and leaves read-only, is reported rather than left to look as though the
name had changed. The name travels in the `host`/`join` handshake, and a live session renames itself
when the setting changes: a write to `selvage.displayName`, by the command or by the settings UI,
sends the `session.rename`, so the room sees the new name at once and the next host or join carries
it too.

`Selvage: List the room's participants` is the key to the carets. A peer is drawn as a bar in their
own colour with their name in the caret's hover, and this is where a colour is turned back into a
person. It lists every peer the room names, including one in a document this window does not hold,
because a colour is derived from a peer id and is therefore known before the caret is drawn. The
colour is not chosen here: it is `peerColour(peer_id)` from `src/bridge/cursors.ts`, the same value
the caret bar, the selection fill, the overview-ruler tick and the hover are built from, so the list
cannot disagree with what it explains. The list is drawn as a quick pick with a coloured dot per
row, because `QuickPickItem.iconPath` is the only field an editor renders a colour from, and nothing
in this repository can see that dot.

The same roster also lives as a persistent `Selvage: Participants` view beside the explorer: one row
per peer with their colour dot, their name and the file they are in. The browser's roster leaves the
file to the badge on that file's own row, and this one says it on the row as well, so the row and
the badge name each other. Clicking a peer's row lands where they are, and each row carries the two
verbs the browser's roster has as buttons: Go to and Follow, with Stop following in the followed
peer's row in place of follow. Those three are the palette's own `selvage.goToParticipant`,
`selvage.followParticipant` and `selvage.stopFollowing`, shown on the row (`inline`) and in its
context menu alike; a peer in no document says so, carries no click, and offers neither verb,
because there is nowhere to go. The row's hover spells the whole thing out: name, role, file, and
whether this window follows them. An empty room says it is alone and offers the invite copy on
click. A window with no session leaves the view empty, which is when the editor draws the
`viewsWelcome` the manifest contributes for it: one sentence saying what hosting is for, and the
palette's own Host a session and Join a session from an invite link buttons. The view deliberately
has no row of its own there, since a row would stand in front of that welcome for good, and the
sentence a command needs before it can run (`Selvage: Join a session first.`) still belongs to those
commands.

## What the adapter decided

The points `docs/studies/vscode-plugin.md` §9 leaves open, and what this client does about each:

- A host shares the `file:` documents open under its workspace folder, on open and for those
  already open when the session starts; that folder is the grant. A guest shares the `file:`
  documents under its mirror root, the room's folder in the Explorer, and nothing outside it. There
  are no exclude globs in v1: what a host shares is what it has open, which is visible in its own
  window.
- A window with no folder open cannot host. A room is a grant of the host's folder
  (`DESIGN.md` §4.2): the grant is that folder's listing, and a host's shared documents are the
  `file:` ones under it. A window with no folder has neither, so `Selvage: Host a session` is
  refused in one sentence saying to open a folder first, before a server is dialled, a name asked
  for or a link copied, rather than minting a room that shares nothing and handing a guest a link
  that reloads their own window onto an empty folder. The check sits after the leave-and-host
  question, because leaving is what can take the folder away: a guest's window is the room's mirror,
  so the leave that precedes a host leaves it empty, and the refusal then says what the next step
  is. Closing a folder does not end a live session, which holds the folder it was invited on, and
  hosting again in a window that is already hosting copies the invite, so this refusal is reached
  only where a room really would have nothing in it.
- The room's listing follows the host's folder. A host watches the folders it was invited on,
  one watcher per folder with `**/*` under it, and republishes the room's grant when a file under
  one appears, disappears or changes, so a path a build, a branch switch or another terminal made
  or removed is in the room's listing without anybody asking. A burst becomes at most one walk of
  the folder per 250 ms rather than one per event, and one frame per interval at most: the walk that
  started last is the only one allowed to publish, so a slower walk overtaken by a newer one is
  dropped rather than sent, and a listing the room already holds is not sent. One the server has
  already refused is neither offered nor reported again while it says the same thing, so a project
  over the server's bound is reported once and not once per window. 250 ms is the Neovim client's
  interval too, so a peer sees a listing change after the same delay whichever client hosts. A
  server that answers `unknown_method` has no grant and is not a failure: the session goes on and
  the watch keeps working, while any other refusal is reported and also changes nothing. The only
  failure the watch can see is a synchronous refusal to create a watcher, which drops the whole
  watch and says so once; a watcher the editor accepts and then never delivers an event for has no
  error channel, so a folder that is silently unwatched leaves the listing as of session start and
  nothing says so. A guest publishes no listing and so watches nothing, and leaving a session or
  deactivating disposes the watchers and drops a republish that was still queued, though not one
  whose walk had already begun, which is dropped when it finishes. A change made while the
  connection is down is not re-offered on its own: the room keeps the listing it held across the
  host's disconnect grace and a re-seated host is sent it again, so the two agree, but nothing
  republishes because of the reconnection, and the room learns of a change made during the blip at
  the next filesystem event or not at all. An attempt that lands while the socket is down is
  reported in the refusal sentence (`the server refused the listing of the folder this window
  shares: the connection is down`) even though the server saw nothing, because the engine answers a
  request it has nowhere to send. A listing that shrinks releases nothing: a path leaving it leaves
  the room's grant and not the room's open-document set, so a document somebody is editing stays
  open and readable (`PROTOCOL.md` §5 against §6, and `doc.close` is how a hold is released).
- A file the room asks for is checked before it is read, and the check is not the read. A peer
  names a path and the host serves it only when the grant would publish it and every directory on
  the way is a plain directory of the shared folder, never a link out of it, and only when the leaf
  itself is a plain file under the size a session will carry. What that narrowing cannot close is
  the window between the check and the read: a link swapped into the path after the walk is read on
  the peer's behalf, and `vscode.workspace.fs` exposes no `realpath` to shut it. That window is a
  stated residual, not a guarantee, and a hostile tree the host's own tools can write to (a build, a
  branch switch) is the threat; the escape shapes around it (`..`, absolute paths, swapped segments,
  leaf links) are pinned in `test/serve.test.ts` so the bound they test is the one the code holds.
- A guest lands in the room's first document, once and with no input: joining a room that
  already has files should land in the work, not in a quick-pick, and a room that is empty at join
  still owes that landing to the guest who stays, so the first document that arrives opens, which is
  what the Neovim client does too. Only the first: a host with five files open must not open five
  editors, a document after that one is left alone because taking the window then would interrupt
  whatever the user is editing, and *Open a document from the room* still lists every path. A host
  never lands anywhere, since its own open files are the room's, and `selvage.openOnJoin`, on by
  default, turns a guest's landing off. It is the same knob the Neovim client has, as
  `vim.g.selvage_open_on_join`.
- Hosting while already hosting copies the invite, the same thing *Copy the invite link* does,
  rather than telling the user to run it, and no second room is minted. A guest that runs *Host*, or
  anyone that runs *Join* while in a session, is asked to confirm leaving first, since leaving a
  hosted room ends it for everyone in it, and nothing happens if they decline.
- Reconnection is the engine's; the adapter reports it. `PROTOCOL.md` §9.1's bounded backoff
  lives in `SelvageEngine`, and the window is told when the host detaches and comes back, when the
  room is gone and when the connection ends. A session whose connection is finished is ended rather
  than left half-alive: the message says why, and nothing retries behind the user's back.
- `GET /meta` is checked before the first connect (the engine's default). An unreachable `/meta`
  decides nothing; one that names a version this client cannot speak fails the command with a
  message instead of opening a session that half works.
- A caret is published at most once every 100 ms, and only when it has moved. The editor moves
  the caret on every keystroke of its own, so one presence frame per
  `onDidChangeTextEditorSelection` puts a frame on the wire for every character typed, which is
  91 % of the typing path's bytes. The adapter arms one flush per interval and reads the editor when
  it runs, so a burst publishes where the caret ended and the position still pending when a session
  ends is published rather than dropped; the engine drops a state that is exactly the one its peers
  already have, which is what makes a repeated clear free. That interval is the Neovim client's
  `SELECTION_INTERVAL_MS`, so the two clients lag a peer's caret alike, and §8.2's renewal is
  unaffected: it republishes the same state deliberately, with a newer clock.
- Closing a document releases this client's hold on it, so the room's set is the union of what
  its connected clients have open. A guest that opens it again re-offers the path.
- A remote edit is saved once the room settles (500 ms after the last one, one write per
  document), because the host's working copy is the room's truth and an unsaved buffer leaves the
  file on disk stale. A local edit is the user's own and is never saved for them. Setting
  `selvage.autoSave` to `false` leaves the buffer dirty and the file alone. A guest's mirror file
  holds what the room already holds, since the keystrokes went first, so its save writes the room's
  own text, and the call is also what clears the dirty marker.
- A guest's room is a real directory: `<globalStorage>/rooms/<room>/<window>/`, opened as the
  window's folder, and the join reloads the window onto it, replacing whatever tree the window held.
  The listing fills its shape with empty files; content arrives through the buffer, and leaving
  deletes the whole directory. A file the listing does not name is not shared: opening or saving one
  says so once per path, and a republished listing removes it. A document the room holds without
  listing has no file to open, so it is not openable here the way it is in Neovim; a save the room
  does not list is written, since the editor cannot refuse it, and said about afterwards, where
  Neovim refuses it upfront. A path whose leaf is a symbolic link, a directory or anything else that
  is not a regular file is refused rather than listed as mirrored, because the editor reads such a
  file through the link on open and writes the room's text through it on save, and every directory
  on the way to a leaf is read with `lstat`, so a link planted inside the mirror is not walked
  through either. Leaving deletes the room's folder from the window: the mirror was the whole tree,
  so a window left with no folder reloads to empty. With several documents in the room only the
  first opens; the quick-pick in *Open a document from the room* lists every path, and a guest never
  types one, so it cannot mistype the host's workspace-folder prefix.
- A marker resumes a room only in a window you have trusted. A folder can start this extension
  with nothing but a `.selvage-mirror.json` in it, and VS Code does not condition a
  `workspaceContains` activation on workspace trust, which is the only way back in after the reload
  that puts the room's folder in the window. So the extension starts, registers its commands, and
  stops there: the triage a marker asks for (dialling the room a leftover mirror names, moving the
  window onto it, clearing leftovers) waits for a trusted window, and runs when you trust the
  workspace afterwards. The manifest claims `limited` untrusted support for exactly that reason;
  every command is your own act and works in a window you have not trusted.
- Colour is derived from the peer id (FNV-1a over a fixed palette), so two clients paint a peer
  alike instead of agreeing only by join order. The same value reaches the Explorer through the
  eight contributed theme colours the file badge is drawn in, where the theme, not this client,
  resolves the id to a colour, and nothing in this repository can see the dot, only the URI.
- The name other participants see is set by a command as well as a setting. *Selvage: Set the
  name other participants see* reports the name in force (the live session's, else the setting's)
  and writes `selvage.displayName` at the global scope, which is the analogue of the Neovim client's
  `vim.g.selvage_display_name`; a workspace is not a place a person's name belongs. The name travels
  in the `host`/`join` handshake, and the setting's own write renames a session that is already
  live: the configuration listener sends a `session.rename` whenever the change comes from the
  editor, so the room sees the new name at once and the next host or join carries it too. A name is
  at most 32 UTF-16 code units and an over-long one is refused, never shortened: the setting is
  checked before it is sent, the question refuses an answer while it is typed and says how many
  units it used, and reaching for a shorter name is the question that then appears, pre-filled with
  the one that was refused. The count is `String.prototype.length`, so an emoji costs two, and not
  the code-point count `[...name].length` would give. The write is what makes the name the next
  session's, so a settings file that will not take it, one a configuration manager owns and leaves
  read-only, is reported rather than swallowed.
- A peer is drawn as a caret, a selection, and their initials on a badge in two places. The
  caret is a two-pixel bar on the left edge of the peer's position in their colour, the selection a
  quarter-alpha fill of the same colour, and the overview ruler carries a tick of it on the right.
  The glyph margin carries the peer's sign, the first two code points of their display name in bold
  black over their own colour, matching the Neovim client's `sign_text`, as a `gutterIconPath`
  image: a base64 `data:image/svg+xml` SVG, because the margin exposes no background colour, scaled
  into the one-line square with `gutterIconSize: 'contain'`. It is on by default and independent of
  `selvage.cursorLabel`, which is the separate, opt-in name drawn *over* the document. One badge is
  chosen per line (the lowest peer id), because glyph-margin icons on a line share a lane and draw
  over one another; the full name is never lost, since the caret's `hoverMessage` still reads
  "name · role" and the status bar still lists the room. The badge needs `editor.glyphMargin`, which
  is on by default: with it off, no badge is drawn and there is no in-line fallback.
- The same badge marks the file the peer is in, on that file's own Explorer row. A peer's
  presence names a document, so a room file with one peer in it wears their initials, the same
  letters the glyph margin draws for them, and their colour, with the name in the hover, so the tree
  and the caret name each other. The colour is a theme colour: `FileDecoration.color` takes a theme
  colour's id and never an arbitrary hex, so the eight palette entries are contributed as
  `selvage.peer.0`…`selvage.peer.7` whose dark, light and high-contrast defaults are the palette's
  own values, and `test/participants.test.ts` pins the two together rather than trusting them to
  agree. That is the one thing this client contributes to the theme, and a theme may override it;
  the ids are otherwise invisible. **One badge per row is the API's limit**, so a file several peers
  are in answers with their count and claims no colour, since picking one of them would claim the
  file for that peer, and the hover names everyone. A peer's file is badged wherever the file row
  is, which for a window holding the file means the Explorer; a badge on a URI no row holds is one
  nothing ever draws. `explorer.decorations.colors` also tints the file's name with that colour
  (VS Code's own setting, on by default); with it off the badge keeps the colour alone.
- A drawn name is bounded. The decoration API measures nothing, so any width in a label is a
  guess, and a name is peer-controlled and unbounded, so a guess is not enough. `boundedLabel` clips
  a drawn name to 24 code points with a trailing ellipsis, by code point, so a name holding an
  astral character is never cut through a surrogate pair. The clip is only on what is *drawn*: the
  caret's hover always carries the whole name, while the status bar lists the first 20 names and
  counts the rest.
- `selvage.cursorLabel: "floating"` is an explicit opt-in: a small box in the peer's colour
  above their caret, out of the line's flow. The decoration API has no position, layer or overlay,
  so the box is drawn by writing declarations (`position: absolute; top: -1.3em; pointer-events:
  none; …`) into a field documented as *one CSS declaration*, which the editor substitutes into the
  rule it generates. **That is undocumented behaviour**, taken deliberately rather than smuggled in
  as ordinary styling: it was read out of a shipped editor, it can change in a release with no
  change to the API or the protocol, and nothing in the suite can see a pixel, so
  `test/labels.test.ts` pins the option object and the rendering itself has only been looked at by
  eye (VS Code 1.137.0). It covers the line above the caret: the vertical offset is a constant
  against a line height the extension cannot read, so `editor.lineHeight: 34` moves the box inside
  the caret's own line instead; it cannot leave the editor's top edge, so on one of the first
  visible lines it is cut off; two peers at one offset draw two boxes on top of each other; and as a
  pseudo-element it is invisible to screen readers.
- `selvage.cursorLabel: "chip"` is the documented opt-in: the same clipped name inside the line
  behind a coloured border, in documented fields only. It covers the text it sits against, which is
  why it is not the default either.
- The invite a host copies is an `https://` page link, never `ws://`. Joining accepts that page
  link; a `ws://…/session?room=…&token=…` link still joins as the advanced fallback for rooms off
  the page default. There is no `vscode://` wrapper, because that would be a convention the protocol
  does not have.
- A guest can hand the invite on too. The invite is the permission, because the token is what
  the room is entered with, so the link a join was given is kept and copied as it stands: a page link
  keeps the origin the host sent it from, and a guest that reached the room over `ws://` has no
  other address for it. A host is unchanged: its copy is the page link built from the wire invite it
  minted and `selvage.webOrigin`. Only the no-session sentence still refuses, and it says what is
  true rather than which connection may hold a link. The status bar is the copy control for either
  role, so the tooltip that says so is not a lie in a guest's window.
- A change the editor refuses is recomputed, not replayed: `applyEdit` answering `false` asks
  the bridge to work the change out again against the buffer's current text.
- A change never ends inside a character. Two astral characters that share a surrogate half,
  which is any two emoji, leave the difference between the halves, and a change cut there is half a
  character in `text`: an edit no editor can make, and a `\ud83d` escape a strict JSON decoder
  refuses, which is how a front-end that cannot read the line leaves the apply unanswered for ever.
  `diff` widens its range to whole characters instead, which costs at most one UTF-16 code unit at
  each end of it.
- Undo is not made CRDT-aware. A remote edit lands on the buffer's undo stack, so `Ctrl+Z` can
  undo a peer's edit; the resulting change event is published like any other and the room
  reconverges. Per-user undo is explicitly out of scope (`docs/studies/vscode-plugin.md` §2.2).
- Format-on-save is not fought. A formatter's edit is an ordinary change event and is published;
  with peers running formatters this can echo (`SPIKES.md`, spike 3), so turn format-on-type off
  while collaborating.
- The adapter ↔ engine transport stays a module interface, not a wire protocol. `DESIGN.md`
  §4.4 makes one optional; the study's §6 puts both halves in one process behind a hard seam, which
  is what `src/bridge/` is. Its `EditorHost` (six methods, no editor in scope) is the shape a
  transport would have to carry, and no format is invented until something needs one.

## The seam

```ts
import { SelvageEngine } from './engine/index.ts';
import { SessionBridge } from './bridge/index.ts';

// Mint a room (the host): the reply carries the token, so inviteUrl() is the share.
const host = await SelvageEngine.host('ws://127.0.0.1:8080', 'Ada');
const invite = host.inviteUrl();               // ws://…/session?room=…&token=…

// Join the room the link names, giving it the link itself and no room id worked out of it.
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
| apply a local edit | `engine.insert(path, index, text)` / `engine.delete(path, index, length)`, which are deltas rather than whole-buffer writes |
| publish a caret | `engine.setSelection(path, { anchor, head })` with editor offsets, converted to the anchors the wire carries; or `engine.setAwareness(state)` with any shape |
| build one anchor | `engine.anchorAt(path, index, assoc)` for a state assembled by hand, or `undefined` when this replica has received nothing for `path` |
| read remote cursors | `engine.presence()`, which is `{ clientId, peer, state }`, so `presence.peer?.display_name` is who it is |
| resolve a remote caret | `engine.resolveSelection(path, selection)` to offsets, or `undefined` when an endpoint does not resolve or the document has not arrived |
| membership | `engine.peers()`, `engine.session()` |
| convergence checks | `engine.stateVector()`, `engine.documents()`, `engine.openDocuments()` |
| concurrency in tests | `engine.pauseOutbound(true)`: held frames make two edits genuinely concurrent |

Four contracts the adapter keeps, each settled by a spike (`SPIKES.md`):

1. Do not use a bare echo flag. Compare the buffer's text against `engine.text(path)` before
   writing a change event back into the replica: a flag loses or duplicates edits depending on when
   the coalesced event lands. The CRDT to buffer direction needs no guard at all, because
   `documentChanged` fires only for changes that did not come from the adapter.
2. Write LF into the replica (`buffer.replace(/\r\n/g, '\n')`), remember the document's EOL, and
   restore it when rendering. The rendered text is never written back. Two editors with different
   line endings otherwise rewrite each other forever. The EOL is the editor's own answer for the
   document (`TextDocument.eol`), which is CRLF for a CRLF file and the `files.eol` setting for a
   new or empty one.
3. Do not impose a trailing-newline invariant. Content is content; if the editor wants the
   invariant, it owns it in one place.
4. Seeding is the host's, once, and never over content the room already has. A `doc.open` for a
   path the replica does not hold yet is seeded from the editor's buffer; one for a path a peer has
   already edited is rendered into the buffer instead, so a stale file on disk cannot be published
   over the room.

A selection on the wire is two CRDT anchors and never offsets
([`PROTOCOL.md` §8.1](https://github.com/selvage-protocol/specification/blob/main/PROTOCOL.md)).
Each endpoint is a yjs `RelativePosition` as JSON, a scope (`tname`, the document path), an optional
`item` naming an element inside it, and `assoc`, and no index is carried, so a peer's caret survives
a paste above it instead of drifting by the length of that paste.

Offsets stop at the editor-adapter seam, where they are UTF-16 code units, the unit `Y.Text` indices
and VS Code's `offsetAt` both count. Resolution is deferred: awareness and sync travel on
independent queues, so a state whose document has not arrived yet is kept and resolves on a later
call, and an endpoint that does not resolve means no selection, with no clamp and no offset
fallback.

## Modules

| File | What it is |
|---|---|
| `src/engine/envelope.ts` | the `selvage/1` JSON shapes, the name vocabulary, §10 compatibility, §11 error and close codes |
| `src/engine/urls.ts` | room and token in the connection URL (§5.1): build, parse, percent-encode; the invite URL *is* the WebSocket URL |
| `src/engine/transport.ts` | the WebSocket seam: text frames are the envelope, binary frames are y-protocols, and a factory can replace the socket |
| `src/engine/meta.ts` | `GET /meta`: advisory when unreachable, decisive when it names an incompatible version |
| `src/engine/sync.ts` | y-protocols framing (§7, §8): SyncStep1/Update/Awareness, a frame as a stream of messages |
| `src/engine/presence.ts` | the awareness state's shape, whether two of them are the same publication, and the join from `awareness_client_id` to `PeerInfo` (§8.4) |
| `src/engine/events.ts` | the nine `EngineEvent`s, mirroring [`crates/client/src/editor.rs`](https://github.com/selvage-protocol/reference_server/blob/main/crates/client/src/editor.rs) |
| `src/engine/engine.ts` | `SelvageEngine`: handshake, request/response correlation, the sync handshake, awareness renewal and expiry, reconnect |
| `src/bridge/editing.ts` | LF in the replica, the document's own line endings on render, the smallest change between two texts that never cuts a surrogate pair, and the content comparison that stands in for an echo guard |
| `src/bridge/bridge.ts` | `SessionBridge`: seeding, both directions of the buffer/replica loop, the save policy, the `EditorHost` interface an adapter implements |
| `src/bridge/cursors.ts` | the remote-cursor model, and the palette a peer's colour is derived from |
| `src/adapter/extension.ts` | `activate`, the eleven commands, the status bar, the window's listeners |
| `src/adapter/documents.ts` | `WorkspaceEditor`: which documents are shared, `applyEdit`, save, line endings |
| `src/adapter/mirror.ts` | the room's mirror on disk: mint, materialise, republish, prune, remove |
| `src/adapter/decorations.ts` | remote carets, selections and the overview-ruler lane; the name label when one is opted into |
| `src/adapter/labels.ts` | what a peer's name is drawn as: nothing by default, the floating box and the documented chip as opt-ins, the bound on a drawn name, and the declarations the box rides |
| `src/adapter/display-name.ts` | the protocol's bound on a display name, the count in UTF-16 code units, and the question that asks for one |

## Checks

The versions this was last run with, on this host:

| Tool | Version here | Notes |
|---|---|---|
| Node | `v26.8.1` (`/etc/profiles/per-user/user/bin/node`) | **≥ 22.18** is required: the tests are `.ts` run directly by `node --test`, which needs type stripping |
| npm | `11.19.0` | `npm ci` reaches the registry |
| nix | `2.34.8` | `nix develop` gives the Node above, `nix flake check` runs the server-free half in a sandbox, and `nix develop ../reference_server` builds `selvaged` out of the sibling checkout, which the four server-backed tests need |

```console
$ npm ci --no-audit --no-fund          # 325 packages, ~180 MB
$ npm run build                        # → dist/extension.js, 546.7 kB, and dist/package.json
$ npm run typecheck                    # tsc --noEmit, strict, erasableSyntaxOnly
$ npm run test:fast                    # builds, then the server-free suite
$ npm test                             # builds, then the same plus four against a real selvaged
```

The gate before a push is this repository's own `scripts/ci-local.sh all`, which runs the same
commands as `.github/workflows/ci.yml`:

```console
$ scripts/ci-local.sh all              # actionlint over the workflows, then the client job
```

`all` is `lint` plus `client`. `lint` needs `nix`; `client` is `npm ci`, `typecheck`, `build` and
`test:fast`. CI runs the server-free suite only, because the four tests in `test/selvaged.test.ts`
need a built `selvaged` from the sibling `reference_server` checkout, which the workflow does not
have.

`test:fast` and `test` build `dist/` first, so the extension bundle under test is the current source
and not a stale one. `test/manifest.test.ts` loads it and activates it against a stub `vscode`,
which is how CI checks the manifest without an editor.

The four server-backed tests in `test/selvaged.test.ts` need a `selvaged` binary:

```console
$ nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvaged'
```

`test:selvaged` finds it at `../reference_server/target/{debug,release}/selvaged`, or wherever
`SELVAGE_SELVAGED` points. A missing binary **fails** the test with the command that builds it rather
than skipping. `cargo` is not on the ambient `PATH`, and `nix develop ../reference_server` runs its
command with the *current* directory, hence the `cd`. That flake's shellHook installs Rust git hooks
into this checkout; they are harmless and ignored, and CI does not use them.

`SELVAGE_SELVAGED` is also the seam the flake stops at. `nix flake check` runs the server-free half
(`typecheck` and `test:fast`) in a sandbox, and `nix develop` gives the same Node, but a check cannot
build a sibling checkout, so the four server-backed tests stay a local run: build `selvaged`, point
`SELVAGE_SELVAGED` at it, run `npm run test:selvaged`.

This repository's own flake has no git hooks: the shell that installs them is
`../reference_server`'s, and it writes them into whatever repository it is started in.

**439 tests, 0 failures** in `test:fast`, the suite that needs no server. Waits are bounded polls of
a real predicate that report the state they observed on failure (`test/helpers/wait.ts`), not
`sleep`-and-hope.

Most of the suite runs against a fake `selvaged` (`test/helpers/fake-server.ts`) that implements the
handshake, the document-set semantics, the grace period and the payload-opaque relay. It exists for
the faults the real server will not produce on demand (a dropped socket, a hostile `x.` event,
`/meta` naming a version this client cannot speak) and not as a substitute for the real thing. It
shares `src/engine/envelope.ts` with the engine, so it can never catch a constant that disagrees with
the spec: only `test:selvaged` can.

The seam check is two halves. `test/boundary.test.ts` scans the sources for `vscode`, `vscode-*` and
`@types/vscode` specifiers, static or dynamic, in either quote style, which is what catches an
`import type`, erased before Node ever runs it. `npm run typecheck` is the other half, and `ci.yml`
runs it before `test:fast`.

### Test files

| File | What it covers |
|---|---|
| `test/envelope.test.ts` | version compatibility (same-major, minor decisive only at 0.x), error/close codes, URL round-trips, permissive envelope parsing, the `session.rename`/`peer.renamed` shapes |
| `test/engine.test.ts` | mint/join by invite URL, refusals by code, `/meta` fail-fast, the open-document set's hold semantics, request correlation, a mid-session rename answered and announced, convergence, presence attribution and expiry, what a publish suppresses and what a renewal does not, the room lifecycle, hostile frames |
| `test/crossing.test.ts` | an anchor produced by real `yjs` resolves through this engine; the fixture is vendored under `test/fixtures/`, or read from the `specification` checkout named by `SELVAGE_VECTORS` |
| `test/reconnect.test.ts` | §9.1: a dropped guest re-hellos and re-opens; a dropped host *reclaims its room* rather than minting a new one; a destroyed room is terminal |
| `test/editing.test.ts` | the document policy alone: LF in the replica, the minimal diff, the echo comparison, the peer palette |
| `test/bridge.test.ts` | the adapter's half against the fake server and a fake editor: seeding, both directions of the loop, a keystroke inside the apply window, the CRLF offset mapping, the save policy, holds, a refused `doc.open`, a late guest, cursors, lifecycle order, and the asks a host remembers bounded to the paths the room holds open |
| `test/manifest.test.ts` | the built bundle loads, activating it registers exactly the commands the manifest contributes, every declared setting is read, the cursor label's default draws nothing, `@types/vscode` fits `engines.vscode` |
| `test/vocabulary.test.ts` | the words both clients share: the palette title each command is given, and every `Selvage: …` sentence the adapter can show |
| `test/https-invite.test.ts` | the invite a host copies is an `https://` page link: the page-link build and parse, the exact text CopyInvite copies with `ws://` never on the clipboard, joining from a pasted page link and from a `ws://` fallback, the `selvage.webOrigin` override and the non-https fallback to the default page, and a guest handing the link it joined by on unchanged |
| `test/commands.test.ts` | the command flows through the built extension and a fake `selvaged`: hosting while hosting copies the invite and mints nothing, hosting with no folder open refused, a guest lands in the room's first document, including one that arrives after the join and not with `selvage.openOnJoin` off, the invite copied by a host and by a guest (each link as it stands) and the room's own list, the open command's refusals, the fetch command's holds, every join reloading the window onto the mirror (including host-leave-join on the first attempt, with the stashed name and never a second root), leaving with its tabs and folder, unlisted files said once, the leave-first questions, leaving, a host that goes away and comes back, a room that goes, the display name reported, set as a live rename, refused over the bound before it is sent, a no-op change sending nothing, the participant list and its colours |
| `test/adapter-presence.test.ts` | presence through the built extension, counted at the other end of the room: a burst of caret events is one frame at the last position, an unmoved caret adds none, the position pending when a session ends is still published, and leaving the shared document clears the cursor |
| `test/display-name.test.ts` | the display-name bound: the count in UTF-16 code units (an astral character costs two, which is where `[...name].length` would be wrong), the refusal naming both counts, and the option object the question is built from |
| `test/labels.test.ts` | the label decision: no name by default, a drawn name clipped to the bound (by code point), and the exact option object each opt-in produces; the pixels are not covered by anything |
| `test/gutter.test.ts` | the gutter badge: the initials (by code point, astral-safe, empty → `•`), one per line with the lowest peer id winning, the SVG and its base64 data URI, the `gutterIconPath`/`'contain'` decoration type the built extension creates, and a rename re-labelling the caret and the badge |
| `test/participants.test.ts` | the roster and the view through the built bundle: the file each row names and the click a peer in a document carries, go-to/follow/stop on the row, the peer's initials and contributed colour on their file's own badge, the count when several share it, a presence path outside the grant badging nothing, a peer's markdown-shaped name left as plain text in the row's hover, and the manifest's inline row actions |
| `test/mirror.test.ts` | the mirror on disk and against a real room: the three-file shape, refused paths creating nothing, the count bound, the symlinked directory the guard does not catch, a symlinked leaf refused rather than mirrored, refused symlinked segments, no-clobber and held-file removal, the marker with its stashed invite and name, opening only our own, leave deleting the directory, and prune with adopt-first |
| `test/boundary.test.ts` | no `vscode` import outside `src/adapter/`, no undeclared dependency, every editor-independent module reachable from a test, the public surface |
| `test/selvaged.test.ts` | the gate, against the real `selvaged`: two engines, concurrent edits, text + state-vector convergence, presence both ways, a late joiner, a guest that disconnects and joins again, close semantics |
| `test/amplification.test.ts` | what one inbound binary frame may cost in replies: a frame of awareness queries is answered with nothing at all, a frame of SyncStep1 messages draws one answer, a legitimate frame is still applied and still answered, and the engine writes nothing back for a hostile frame |
| `test/spikes/` | the three §7 experiments, as measurements (`SPIKES.md`) |

### The two-instance proof (`test/e2e/`)

Everything above stubs the editor or runs one process. `test/e2e/run.ts` does neither: it starts a
real `selvaged`, resolves a pinned VS Code build (`1.137.0` by default; set
`SELVAGE_E2E_VSCODE_VERSION` to move it), and launches **two independent, real Extension Development
Host processes** (`@vscode/test-electron`, headless under Xvfb) with the real built extension loaded,
one hosting a real file and one joining by invite through a window reload, both editing concurrently,
and asserts their documents converge. The guest runs in two windows: the first joins on its own
folder and the reload tears that run down (resolving instead fails the stage); the run then opens a
second window straight onto a freshly stashed mirror in its own profile, where the activation triage
lands the join and the suite proves the window is the mirror alone before running every phase. It
also proves the room's grant end to end: the guest opens a file the host's folder holds and the host
never opened, so its content can only have been read on request. Left running, the host then makes a
file under its folder and removes another while the room is live and the guest's mirror on disk has to
gain the one and lose the other; another window joins with no folder, reloads onto the mirror, lands
there, and a further window proves the landing again from a freshly stashed mirror with no command
run at all; and it cuts the guest's connection through a small relay and checks it reconnects and
re-converges. `SELVAGE_E2E_RECONNECT=0` leaves the reconnect leg out; the watch and empty-window legs
run either way.

Run it with `scripts/e2e/run-two-instance.sh` from the repository root. It has heavier prerequisites
than everything else here (a network, Xvfb, an internet download the first time, and `nix` to work
out the shared-library path a VS Code build downloaded outside `nix` needs on NixOS), so it is a
manual verification step, not part of `npm test`/`test:fast`, and not wired into `ci.yml`.

## Not here

A sidecar or second process, and create/rename/delete on the wire (`PROTOCOL.md` §12), read-only
guests (`PROTOCOL.md` §12.3), per-user undo, host-filesystem reads beyond a granted path a peer asked
for, multi-room windows, and publication (`vsce package`, a Marketplace publisher). Also deliberately
absent: a `y-websocket` provider (Selvage's envelope is not y-websocket's), `terminal/1`, and any
server address used without asking beyond the one hosting remembered. The first host's question
prefills the demo server, and every host after it reuses the answer until an argument or the setting
names another.

## Licence

The client is `MIT OR Apache-2.0`, at your option: [`LICENSE-MIT`](LICENSE-MIT) and
[`LICENSE-APACHE`](LICENSE-APACHE). The cross-library anchor fixture under `test/fixtures/` is
vendored from the [`specification`](https://github.com/selvage-protocol/specification) repository,
whose material is `CC-BY-4.0`.
