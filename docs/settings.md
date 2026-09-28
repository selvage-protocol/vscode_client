# Settings

The [settings table](../README.md) lists the five settings and their defaults. What follows is how
the server address and the display name are resolved.

The server is resolved in this order: an address given to the command programmatically (the
palette takes none), then `selvage.serverUrl`, then the last server used. The first two answer
silently, so hosting asks only in a window that has neither, and that one question starts from the
demo server `selvage-demo.dontblameme.dev` — a domain on its own, which the one completion reads as
`wss://selvage-demo.dontblameme.dev`. A host that reused the last server names it in the room-open
notice, with a `Change the server` button that asks the same question again for the next host. A
host on the setting or on an explicit address gets no such button; that address is changed where
it was set.

A server address is typed in the command's argument, the box's answer, the `selvage.serverUrl`
setting, or a remembered address, and all four read it the same way: a bare host means the
published shape, `wss://<host>`, because the room is dialled over TLS. The `/session` path every
Selvage server answers belongs to the engine, which appends it to whatever base it is given, so a
base that already ends in `/session` has that suffix removed before the engine appends its own;
any other path is kept, because a server behind a prefix was named on purpose. An invite link is
not a server address: its query and fragment are the room, its token and its key, so a link
pasted wherever an address is asked for is refused and nothing is remembered.

`Selvage: Change the server` reports the address the next host will use and offers the same box
to change it, without hosting first. While `selvage.serverUrl` is configured that setting
outranks the remembered address, so the command says so and changes nothing. Either way the write
reaches the next host only, and never a room already open.

A display name is resolved when a session starts, in this order: `selvage.displayName`, then the
remembered answer, then a question pre-filled with the login name. It is bounded at 32 UTF-16 code
units, so an emoji costs two, and a longer name is refused wherever it came from.
`Selvage: Set the name other participants see` reports the name in force and changes it; the
write goes to the global scope.
