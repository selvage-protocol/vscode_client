# How it is built

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

## `selvage/2` in the engine

The engine speaks the sealed wire end to end: one version, one code path. A host that can mint
does so, because there is nothing to choose and nothing to fall back to, and a join speaks what
its invite's fragment carries. The session layer's peer half is `peer.ts` and the host's is
`host.ts`:

| Module | What it is |
|---|---|
| `src/engine/crypto.ts` | the crypto seam a `selvage/2` frame needs (HKDF-SHA256, SHA-256, AES-256-GCM and Ed25519) as an interface the caller supplies |
| `src/engine/sealed.ts` | `CANONICAL.md` §6.1's bytes: the envelope's layout, the key schedule, the canonical key encoding, the four sealed payloads, and the ten-step read with the reason each step reports |
| `src/engine/peer.ts` | `PROTOCOL.md` §13: the invite's fragment and its local refusal, the session keypair and its announcement, the order of operations at a join, verify-before-apply, attribution by the key that verified and the role the applied state gives it, a `viewer`'s content refused, the holds and their lease, the two windows that end a session, and §13.10's lifecycle |
| `src/engine/host.ts` | `PROTOCOL.md` §7.1's producer half: the host key, the room state it seals and signs, the rule for each state that goes out (at mint, on a change to the listing or to `peers`, on every `peer.joined` and `peer.left`, on every announcement accepted), the publish-rate window, the seat label a newly committed key is given, and the `issued` series kept with the key |
| `src/engine/crypto-web.ts` | that seam over WebCrypto (`globalThis.crypto`), which a page, Node and the extension host all have; it is the default a caller that supplies none gets |
| `src/engine/relay.ts` | the socket wiring those four were written to be handed: `session.hello` at `selvage/2`, the seat from `room.created`/`room.joined`, the invite minted with its fragment, the session's clock on a timer of its own, and every frame the session produced written to the socket. It is in the engine because the three clients drive the same wiring, where the socket and the crypto are both seams, so what is left is `PROTOCOL.md` §5's handshake, which is the same for a page, a companion and an extension host |
| `src/bridge/peer-engine.ts` | `Engine` over a seated relay: the room's listing as the grant, §13.7's holds as the room's open set, §8's awareness in both directions, §13.8's host window as the adapter's own two events, and the §13.10 endings in the bridge's vocabulary |
| `src/node/crypto.ts` | that seam over Node's `crypto`, which is what this client and the corpus subject use |

Every rule in those three modules is `PROTOCOL.md` §13's, §7.1's or `CANONICAL.md` §6.1's, and each is
pinned twice: `test/sealed.test.ts` and `test/peer.test.ts` build their own frames from constants
and run without a sibling checkout, and `test/peer-corpus.test.ts` replays the peer corpus: it
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
client drives, and a page has no `node:crypto` and no synchronous one either, since WebCrypto is
asynchronous. `src/node/` is outside the two directories the other clients copy for the same
reason: it is the Node half.

`test/host.test.ts` is §7.1's producer half on its own: every clock it passes in is a number and
every frame it builds comes from constants, so it is about the rules rather than about how long a
machine took. Each host guard is pinned twice over, by the rule's own test and by that test going
red under the mutation that removes the guard (`HOST_MUTATIONS`), which is what `mutate` is for.

The editor surface, 2026-09-23. The four methods the adapter needed are here, each a rule the
version already states rather than a new decision: `remove`, the deletion half of `insert`
(`§13.5`), without which the bridge's own `publish` silently dropped every deletion; a public
`setAwareness`/`setSelection` that publishes a local awareness frame (`§8.1`, `§13.9`), with
`presence()` to read every peer's anchors back against this replica (`§8.4`); the role of this
connection's own key (`§13.4`), which is what tells a `viewer` its editor is read-only; and
`resolveSelection`, `release(path)`, `has`, `rolesBySeat`, `namedHostSeat` and `hostAwayGraceMs`
for the rest of what an adapter reads. `Role` names `viewer` now, because the state can assign it.

Two decisions that surface changed with them, and both are the honest consequence of an
asynchronous seam. A local edit lands in the replica before `insert`/`remove` return their
promise, because an adapter reads the replica back between two keystrokes and one that had to
wait for a seal would compute the same keystroke twice, so an offset outside the document is now
thrown rather than rejected. And an awareness state handed in is a frame a moment later:
`whenIdle()` is what a caller drains after, because otherwise a caret goes out at the next renewal
window.
