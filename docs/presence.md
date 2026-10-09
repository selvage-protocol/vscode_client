# Presence

In the editor a peer is a coloured caret, a selection fill, a tick in the overview ruler, and
their initials on a badge in the gutter and on the Explorer row of the file they are in. A peer's
colour comes from their id, so both clients paint the same person the same way, and
`Selvage: List the room's participants` turns a colour back into a name and a role. The same
roster is a `Selvage: Participants` view beside the Explorer: one row per peer, with go-to and
follow on the row, and clicking a peer lands where they are.

Following keeps landing where a peer is as they move, until something ends it; going to someone
lands there once. The status bar carries the session and the room, opens the people list when it
is selected, has its own control that copies the invite, and holds the follow with the control
that stops it.

A name drawn over the text can break. `selvage.cursorLabel: "floating"` writes declarations into a
field documented as one CSS declaration, which is undocumented editor behaviour: it can change in a
release with no change to the API, and nothing in the suite can see a pixel. It covers the line
above the caret and cannot leave the editor's top edge. `chip` uses documented decoration fields
only and covers the text it sits against. Either way a drawn name is clipped at 24 code points,
with the whole name still in the caret's hover.

One badge per row, which is the decoration API's limit. A file several peers are in answers with
their count and claims no colour; the hover names everyone.
