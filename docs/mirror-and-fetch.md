# Mirror and fetch

The room is a folder on disk in both windows. A host shares the `file:` documents it has open
under its workspace folder, and that folder is the grant: a guest can list it, open any of its
files, and read one the host never opened, on request. The listing follows the host's folder, so a
file a build, a branch switch or another terminal creates or removes reaches the room without
anybody asking.

What the listing leaves out is decided twice. Once by name: dependency and build trees
(`node_modules`, `target`, `vendor`, `build`), secret files and credential stores (`.env`, `.ssh`,
a private key), and a name that declares a binary format a document cannot carry. Once by the
folder's own ignore files: `<folder>/.git/info/exclude`, then every `.gitignore` at or below the
folder, with the last matching pattern deciding. Their patterns follow `gitignore(5)`, with one
divergence: a `?` and a bracket class count characters, as `fnmatch(3)` documents, where git
counts UTF-8 bytes. Both halves bind the read a peer asks for as well as the listing: a guest that
guesses an ignored path that exists is refused the same silent `not-granted` an excluded name
gets, and a path that does not exist is refused `missing` like any other absent path, which says
nothing about the ignore rule either.

The listing is bounded as well: `PROTOCOL.md` §13.3 holds one to 100 000 paths and to 4 MiB of
their UTF-8 bytes, and a folder past either bound is shared in part. There is nothing a peer
could do about it, so the host is the one told when it binds and a guest is not told at all.

The folder is the bound on what a host reads. In a folder of this machine, a file a guest asks for
is resolved one component at a time: each component is opened inside the descriptor of the one
before it where the platform publishes a name for a directory that is already open — Linux, under
`/proc/self/fd` — and its bytes come from the descriptor whose type and size were read, so a
component a symbolic link replaces between the listing and the read is refused rather than followed
out of the folder. Where the platform publishes no such name each component is instead resolved by
name and checked before the step that uses it, and a component that is a symbolic link by the time
that step resolves it is followed: that window is the residual there, and it is the shape macOS and
Windows have — the more so on Windows, which has no `O_NOFOLLOW` either, so a leaf swapped between
its own check and its read is followed as well. Planting either takes a concurrent local writer.
What neither descent can see is a mount point, which the file system reports as an ordinary
directory and which takes `CAP_SYS_ADMIN` to plant. A folder shared from inside a repository does
not honor a `.gitignore` above it, and neither git's user-wide ignore (`core.excludesFile`) nor any
other rule outside the folder is read, because those are rules of the person at the machine rather
than of the project being shared. A file the host itself opens is the host's own act: the
name-based excludes bind it and the folder's ignore files do not.

A guest's window holds the room as a real directory under the extension's global storage, so the
trees, search and language servers a person already runs work on the room's files. A tool that
reads content sees only what has been fetched, so a project-wide search is partial until the paths
it covers have been. The join reloads the window onto that directory, replacing whatever tree was
there, and leaving deletes it again. `Selvage: Download a file from the room` is how content that
nobody has opened yet arrives in it, and how a whole project is published to the other side.

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
