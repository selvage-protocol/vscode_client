# What is not here

The whole client runs in the extension host: the sync engine and the CRDT live next to the editor on
one event loop. There is no worker, no native module and no second process.

- Nothing is created, renamed or deleted on the wire (`PROTOCOL.md` §12), and a guest holds the
  same right to edit as the host (§12.3). A window holds one session, and a host reads its own
  filesystem only for a granted path a peer asked for.
- There is no `y-websocket` provider, because Selvage has its own envelope, and no `terminal/1`.
- No ignore rule above the shared folder decides anything, and a host's own window is not bound
  by one at all. What a host offers is its folder minus three things: the names it never shares
  (dependency and build trees, secret files and credential stores, a name that declares a binary
  format), what the folder's own ignore files leave out — `<folder>/.git/info/exclude` and every
  `.gitignore` at or below the folder, read the way git reads them — and a document over the size a
  session carries. Nothing above the folder is read, so a folder shared from inside a repository
  (`~/proj/src` with `~/proj/.gitignore`) does not honor the rules above it, which is a real
  difference from `git status`; neither is git's user-wide ignore (`core.excludesFile`), which is a
  rule of the person at the machine rather than of the project. A file the host opens in its own
  window is the host's own act: the name-based secrecy excludes bind it, and the folder's ignore
  files do not.
- A host shares live the documents it has open, so what is on offer is visible in its own window,
  and any other file under the shared folder a guest reaches is read on request. A file a room asks
  for is checked before it is read, and only when the grant would publish it and every directory on
  the way is a plain directory of the shared folder, never a link out of it. The window between
  that check and the read is a stated residual: `vscode.workspace.fs` exposes no `realpath`, so a
  link swapped in after the walk is read on the peer's behalf — and an ignore file behind it is,
  which is the same window read a moment earlier.
- A change made while the connection is down is not republished when it comes back. The room keeps
  the listing it held across the host's disconnect grace and a re-seated host is sent it again, so
  the two agree; the room learns of the change at the next filesystem event or not at all. A
  folder the editor accepts a watcher for and then never delivers an event for has no error
  channel, so it leaves the listing as of session start and nothing says so.
- A document the room holds without listing it has no file here, so it cannot be opened the way
  the Neovim client opens it. A save to a path the room does not list is written, since the editor
  cannot refuse a save, and reported afterwards; the Neovim client refuses it upfront.
- Leaving deletes the mirror from the window.
- The resume a marker asks for waits for a trusted window, except in the room's own folder. A
  folder can start this extension with nothing but a `.selvage-mirror.json` in it, and VS Code
  does not condition a `workspaceContains` activation on workspace trust, which is the only way
  back in after the reload that puts the room's folder in the window. In an untrusted window the
  extension starts, registers its commands and stops there; the triage a marker asks for runs once
  you trust the workspace. The exception is a window opened on a mirror under this extension's own
  storage, which no repository can put there: that is the join's own reload, and it lands without
  trust. You do not need to trust the room's folder to join, and leaving it in Restricted Mode is
  the safer choice, because the room's files are its host's. Every command is your own act and
  works in a window you have not trusted, which is why the manifest claims `limited` untrusted
  support.
- A guest does not take the room's workspace configuration. Anything under a `.vscode` directory
  and any `.code-workspace` file is left out of the mirror and never shared from it, because the
  mirror is the window's workspace folder and VS Code would apply those files (settings, tasks,
  launch configurations) rather than just show them. The host's own copies are unaffected, and the
  guest is told once per session which ones were left out.
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
  can echo ([`SPIKES.md`](../SPIKES.md), spike 3). Turn format-on-type off while collaborating.
