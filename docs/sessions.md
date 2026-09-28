# Sessions at `selvage/2`

This window drives the sealed wire. What is left for the adapter is a listing and the role the
room's state gives this connection. The socket wiring is
[`src/engine/relay.ts`](../src/engine/relay.ts) and the adapter's vocabulary is
[`src/bridge/peer-engine.ts`](../src/bridge/peer-engine.ts); the crypto seam is the engine's
default, WebCrypto, which the extension host has globally.

What a person does:

- A host sets nothing. The room is minted sealed, and its listing, its roles and its content are
  sealed under the keys the invite's fragment carries. A `/meta` that cannot be read at all decides
  nothing: the connection is attempted, and the handshake reports the truth. The address, the
  folder and the invite are unchanged.
- A join sets nothing either: paste the link. The invite carries the room key and the host key on
  its fragment, and a client that cannot read them cannot join the room at all; a link whose
  fragment names one key and not the other is refused locally, by name of the missing one.
- Copying the invite is unchanged, and it now carries the fragment: the page link this window
  hands on is the same room, token and two keys as the connection's own wire invite. The wire URL
  the socket is handed never contains a `#`.
- Everything else — the [mirror](mirror-and-fetch.md), the grant tree,
  [participants](presence.md), follow and jump, the fetch command, the save policy, the reconnect
  messaging — is the same code over the same bridge, so it works in a version-2 room without being
  told which version it is in.

A viewer's documents are read-only. A `selvage/2` room's state assigns roles (`§13.4`), and a
connection seated as `viewer` gets the room's documents with their edits refused: `§13.9` has a
viewer publish no content, so a buffer that accepted a keystroke would show text the room never
receives. The editor has no per-document read-only flag an extension can set, so the edit is put
back — the room's text returns and the attempt is said once, in the sentence both clients use.
This client declares `guest` and has no command to ask for the other role: what a host does with
the state is a later phase's, and a client that could ask to be a viewer would be inventing a
request the protocol does not have.

The host key lives for the session. A `§7.1` host signs its states with a key this window mints
when it mints the room, and holds in memory: the key, and the `issued` series that goes with it,
are gone when the session is. A returning host is what would keep them, and this client runs no
resume (`§9.1`), so there is nothing to read back today — and a private signing seed is a secret,
which is why the store that does land with a resume will be `context.secrets` and not the window's
`globalState`. The engine's `HostStore` is the seam such a store is handed in through, and it
stays open for a client that has a series to continue. §13.11's per-receiver caps are
unimplemented, as they are in the reference client.

What this slice does not do. The relay runs no resume: a dropped socket ends its session rather
than re-helloing, so `§9.1`'s host return is not wired either.

§7.1's host-side corpus vectors are not here — [`test/host.test.ts`](../test/host.test.ts) is what
pins the producer, and the peer corpus still drives the receiver's half — and §13.11's
per-receiver caps are not implemented (how many keys and marks §13.3 allows a client to keep, and
how many paths and bytes of paths it will hold).

Five things §7.1 and §13 leave open, each decided where it is read rather than filled in silently:

- The label a key gets when the roster names no free seat. §7.1 obliges a host to commit every
  announcement it accepts and forbids withholding one for want of a label, and it also says at most
  one key per seat. An announcement that outruns its `peer.joined` is where the two meet: the roster
  names only the host's own seat, the commitment is what the peer cannot do without, so the label is
  the half that gives way — two keys carry that seat, and the key already there keeps its
  commitment. `label()` and `commit()` state it.
- What the host's own session does after it publishes a closing. §13.10 says what a receiver does
  with one; §7.1 says only that a host that has left publishes nothing. Here the session that
  published it ends the way a receiver's does — `ending = 'closing'`, and nothing more published
  from it — because a room declared over is not one to write content into.
- What a `peer.joined` obliges of a host. §7.1 has a host publish a state on one, and the re-send
  of a state already held is stated as a *peer*'s rule. This host re-sends the state it holds when
  nothing in its listing or its `peers` has changed; a joiner that holds none applies it exactly
  as it applies a new edition, and every peer at that edition refuses it `stale_issued`.
- §7.1's *MUST NOT hold two host sessions for one room at a time*. Nothing here enforces it across
  processes: two connections that share a host key and a counter series publish one edition twice,
  and §13.3's rule for two publications at one edition is what a receiver does with that.
- When a returning host writes above an edition it learned from a re-sent state. §7.1's list of
  obligations does not include applying a state, and §9.1's resume is a state published above the
  room's. This host learns the room's edition from the state a peer re-sends it and writes above it
  at its next state — the next change to its listing or its `peers`, the next seat, or the next
  announcement it accepts — not on the state it just applied. It never re-sends the state it holds
  over an edition it has verified, because every peer refuses a frame at or below the edition it
  already carries.
