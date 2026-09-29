# Mirror and fetch

The room is a folder on disk in both windows. A host shares the `file:` documents it has open
under its workspace folder, and that folder is the grant: a guest can list it, open any of its
files, and read one the host never opened, on request. The listing follows the host's folder, so a
file a build, a branch switch or another terminal creates or removes reaches the room without
anybody asking.

What the listing leaves out is decided twice. Once by name: dependency and build trees
(`node_modules`, `target`, `vendor`, `build`), secret files and credential stores (`.env`, `.ssh`,
a private key), and a name that declares a binary format a document cannot carry. Once by the
folder's own ignore files, read the way git reads them: `<folder>/.git/info/exclude`, then every
`.gitignore` at or below the folder, with the last matching pattern deciding. Both halves bind the
read a peer asks for as well as the listing, so a guest that guesses an ignored path is told
nothing about it.

The folder is the bound on what a host reads. A folder shared from inside a repository does not
honor a `.gitignore` above it, and neither git's user-wide ignore (`core.excludesFile`) nor any
other rule outside the folder is read, because those are rules of the person at the machine rather
than of the project being shared. A file the host itself opens is the host's own act: the
name-based excludes bind it and the folder's ignore files do not.

A guest's window holds the room as a real directory under the extension's global storage, so the
trees, search and language servers a person already runs work on the room's files. The join
reloads the window onto that directory, replacing whatever tree was there, and leaving deletes it
again. `Selvage: Download a file from the room` is how content that nobody has opened yet arrives
in it, and how a whole project is published to the other side.

A file the host deletes or moves out of the folder leaves the room for a guest too. A guest
document open on it closes, its hold is released and its file goes from the directory, with
`<path> is no longer in the room, so it was closed`. A document with unsaved changes keeps its
tab and its file instead of asking to save or discard them, but it stops being shared:
`<path> is no longer in the room; your unsaved copy is kept but no longer shared`. Either way the
path is not offered again until a listing names it, even while another participant still has it
open. A listing that names nothing, which a dropped connection can produce for a moment, closes
nothing: it waits one listing window and yields to the listing that follows. A host keeps its own
tab.

A document the room changes is saved once the room settles, because the host's working copy is
the room's truth.
