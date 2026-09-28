# Mirror and fetch

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
