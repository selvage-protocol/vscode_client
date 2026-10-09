# Selvage for VS Code

A VS Code extension for the [Selvage `selvage/2` session protocol](https://github.com/selvage-protocol/specification):
share a folder with someone and edit the same files at the same time. It is for two people
working in one checkout, one of whom starts a `selvaged` to hold the room.

Hosting and joining a `selvage/2` room against a real `selvaged` works today, with the mirror, the
fetch command, the participants view and follow behind it.

## Get it working

You need:

- VS Code 1.137 or newer. The manifest pins `engines.vscode` at `^1.137.0`.
- A `selvaged` to connect to. The host starts one and notes the address it prints; the guest needs
  just the invite link.
- Node 24 or newer, if you build the extension from a checkout. `engines.node` names the
  extension host's runtime floor, and the `.vsix` you build is bundled for it.

### Install

Install it from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=selvage-protocol.selvage)
or [Open VSX](https://open-vsx.org/extension/selvage-protocol/selvage), or search the
Extensions view for Selvage:

```console
$ code --install-extension selvage-protocol.selvage
```

You can install a `.vsix` instead: the one attached to a
[GitHub Release](https://github.com/selvage-protocol/vscode_client/releases), or one you build:

```console
$ npm ci --no-audit --no-fund          # 325 packages, ~180 MB
$ npm run package                      # → selvage-<version>.vsix in the repo root
$ code --install-extension selvage-<version>.vsix
```

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

The room sees the folder minus what it should not carry: dependency and build trees (`node_modules`,
`target`, `vendor`), secret files (`.env`, `.ssh`, private keys), the names that declare a binary
format, and whatever the folder's own ignore files leave out — `.git/info/exclude` and every
`.gitignore` at or below the folder, matched by `gitignore(5)`'s rules, except that a `?` and a
bracket class count characters where git counts UTF-8 bytes. Nothing above the folder is read,
so a folder shared from inside a repository does not honor a `.gitignore` above it. A file you open
in your own window is your own act: the secrecy excludes still bind it, an ignore file does not.
[Mirror and fetch](docs/mirror-and-fetch.md) has the whole rule.

`Selvage: Leave the session` leaves on either side. Closing the host's window ends the room after
the server's grace period, and the guest is told.

### Settings

Set `selvage.serverUrl` and `selvage.displayName` to stop being asked for them.

| Setting | Default | What it does |
|---|---|---|
| `selvage.serverUrl` | unset | The server address to host on: in full, or a domain on its own — a domain alone is enough, because it means the secure server, `wss://<host>`. Setting it means hosting never asks, and it outranks the last server used. |
| `selvage.displayName` | unset | The name other participants see. A change while a session is live renames this connection at once. |
| `selvage.autoSave` | `true` | Save a document the room changed, once the room has settled on it. |
| `selvage.openOnJoin` | `true` | Put the room's first document in an editor for a guest. |
| `selvage.cursorLabel` | `"none"` | Whether a peer's name is drawn over the document at their caret: `none`, `floating` or `chip`. |

The order each setting is resolved in, and how a server address is read, is in
[settings](docs/settings.md).

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
| `Selvage: Download a file from the room` | Hold one listed path, or a directory of them, in the room, so everyone there gets its text, filling the mirror. Refused while hosting: your files are already on your disk. |
| `Selvage: Copy the invite link` | Put the session's invite on the clipboard. A session the server gave no invite to says so, and a clipboard the editor refuses says why. A host copies the page its own server serves, carrying the room and its token, so one address decides both the page a guest opens and the socket they join on. A guest hands on the link it joined by, as it stood; the invite is the permission, so the token it joined with is the guest's to pass on. |
| `Selvage: Leave the session` | Leave the session. Leaving as the host asks first, then ends the room for everyone at once. |
| `Selvage: List the room's participants` | List everyone in the room, with each one's colour, name, role and the document they are in. A row opens that person's menu: Go to and Follow or Stop following for someone else, Rename for yourself. Drawn as a quick pick with a coloured face per row, because `QuickPickItem.iconPath` is the only field an editor renders a colour from. |
| `Selvage: Go to a participant` | Land where a participant is: their document, their caret. A document this window does not hold opens through the room first. |
| `Selvage: Follow a participant` | Keep landing where a participant is as they move, until something stops it. The status bar shows who is followed in their caret colour and stops the follow when selected; a local edit of a shared document ends it, and a remote one does not. |
| `Selvage: Stop following` | Stop following. Says so when no one is followed. |

## What to expect

- **Undo is shared.** A remote edit lands on the buffer's undo stack, so `Ctrl+Z` can undo a
  peer's edit; that change is published like any other and the room reconverges.
- **A formatter that edits the document is published** like any other change, so with formatters
  running on both sides a session can echo. Turn format-on-type and format-on-save off while
  collaborating.
- **A big file is not carried.** A document over 1 MiB stays out of the room, and a request for
  one is refused with the reason.
- **A path the room holds without listing it has no file here**, so it cannot be opened from the
  room; the Neovim client holds such a document in a buffer instead.
- **Leaving deletes the mirror** from the window. Your own files are untouched: the mirror is a
  cache of the room, never a source of truth.
- **A host's dropped connection ends its session.** A guest reconnects instead, and an edit it made
  while the connection was down goes out when the new socket is seated.
- **The room's folder is its host's.** You do not need to trust it to join, and leaving it in
  Restricted Mode is the safer choice; every command works in a window you have not trusted. The
  mirror does not take the room's `.vscode` directory or its `.code-workspace` files, and a guest
  is told once per session which ones were left out.

## More

- [Mirror and fetch](docs/mirror-and-fetch.md): what the room is, the mirror a guest holds, what
  happens when a file moves out of the folder or goes, and what a guest's window does not carry.
- [Presence](docs/presence.md): a peer's caret, badge and colour, the participants view, following,
  and what a drawn peer cannot do.
- [Settings](docs/settings.md): how the server address and the display name are resolved.

## Licence

The client is `MIT OR Apache-2.0`, at your option: [`LICENSE-MIT`](LICENSE-MIT) and
[`LICENSE-APACHE`](LICENSE-APACHE). The fixtures under `test/fixtures/` — the cross-library
anchor and the specification's `schema/limits.json` — are vendored from the
[`specification`](https://github.com/selvage-protocol/specification) repository, whose material is
`CC-BY-4.0`.
