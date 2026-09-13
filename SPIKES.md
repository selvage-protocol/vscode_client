# Pre-adapter spikes

The three experiments `docs/studies/vscode-plugin.md` §7 lists as *"the ones I would settle
before writing the adapter, because each one changes the wire shape or the module boundary
if it fails"*. They are tests, not prose: `npm run test:spikes` runs them, and every number
quoted below is a line that run prints.

```
$ npm run test:spikes
✔ spike 1: absolute offsets drift under a concurrent edit; relative positions do not
✔ spike 1: offsets are UTF-16 code units, not code points and not bytes
✔ spike 2: a boolean guard cleared too early duplicates the remote edit
✔ spike 2: a user edit inside the guard window is lost, not duplicated
✔ spike 2: applying a remote update must not be re-broadcast
✔ spike 3: with no policy, a CRLF replica and an LF replica fight over one CRDT
✔ spike 3: LF in the CRDT and the document's EOL restored on render converge
✔ spike 3: a trailing-newline invariant in the sync layer is a loop
ℹ tests 8
ℹ pass 8
```

Source: `test/spikes/cursor-drift.test.ts`, `test/spikes/echo-guard.test.ts`,
`test/spikes/eol.test.ts`.

---

## Spike 1 — does a cursor survive a concurrent edit, and in what unit?

**Question (§7 #1).** The awareness state carries `{ anchor, head }` as integers
(`spec/PROTOCOL.md` §8.1), `DESIGN.md` §4.3 asks for CRDT-relative positions, §12.4 of the
spec records the gap as *known*, and the unit is not stated anywhere.

**Experiment.** Two `Y.Doc`s exchanging y-protocols frames, the way the server relays them;
Ada publishes her caret in a `message_type = 1` awareness frame; Bob inserts 157 characters
at offset 0; Ada merges Bob's update and the caret is resolved again.

**Measured.**

```
[spike 1] absolute offsets, 157-character insert at 0: anchor 19 now selects "/ " (expected "le"); drift = 157 = the insert length
[spike 1] the same selection as a relative position lands on "le" at index 176 (the absolute offset would have said 19)
[spike 1] "😀x": Y.Text length 3, string length 3, code points 2, UTF-16 code units 3, UTF-8 bytes 5
```

**Findings.**

1. **Absolute offsets are not positions.** The drift equals the length of the insert, so a
   paste above a peer's caret moves their cursor by the size of the paste — for a 157
   character insert the caret ends up in the middle of a comment. A relative position made
   before the change resolves to the same two characters, at index `19 + 157`, on both
   replicas, and survives being shipped as JSON inside the awareness state. Nothing on the
   wire has to change: `§8.1` makes the state opaque and this is a shape *inside* it.
2. **The unit is UTF-16 code units.** For `"😀x"`, `Y.Text.length` is 3 — the emoji is a
   surrogate pair — while the code points are 2 and the UTF-8 bytes are 5. Index 1 is the
   low surrogate, not `x`. That is VS Code's unit (`TextDocument.offsetAt`) and yjs's, so
   this engine and its adapter agree, and an offset in code points or bytes is a silent
   off-by-one per emoji. A selection inside a surrogate pair is a state a peer must
   tolerate rather than reject.
3. **The Rust client disagreed, and that was the real finding.** `yrs` 0.27.4's
   `Doc::new()` defaults to `OffsetKind::Bytes`
   (`~/.cargo/registry/src/*/yrs-0.27.4/src/doc.rs`), `impl/crates/client/src/engine.rs`
   takes that default, and `impl/crates/client/src/presence.rs` renders the resulting
   `u32` as a selection — verified, and already recorded as finding **B** in
   `docs/studies/awareness-and-reconnect.md`. On non-ASCII text the two clients therefore
   name *different* positions for the same cursor: the opposite of what an earlier version
   of this spike asserted from "the Rust client carries `u32` offsets", which says nothing
   about the unit those integers are counted in. The engine's unit was never the open question —
   VS Code and yjs are both UTF-16. **The Rust client has since been moved to match:**
   `impl/crates/client/src/engine.rs` constructs the document with `OffsetKind::Utf16`, and
   `impl/crates/harness/tests/offsets.rs` covers a non-BMP character that byte offsets would break.
   Both clients agree again, and `spec/PROTOCOL.md` §8.1 states the unit normatively.

**Decision for this engine — made, and implemented.** This was the one item the spike
could not settle on its own: a wire shape is a spec decision, not an engine one. `spec/PROTOCOL.md`
§8.1 has since made it. **A selection is two CRDT anchors and no index reaches the wire.**
Each endpoint is a yjs `RelativePosition` as JSON: one scope — `item`, or `tname` for a
position with no element to name — plus `assoc`. The engine conforms:

- `engine.setSelection(path, { anchor, head })` still takes editor **offsets** and anchors
  them, so the adapter seam goes on speaking the unit the editor speaks (UTF-16 code units);
- `engine.resolveSelection(path, selection)` resolves a peer's anchors against this replica,
  and yields `undefined` — *no selection* — when either endpoint does not resolve. No
  clamping and no offset fallback: §8.1 forbids manufacturing a position;
- resolution is **deferred**, not part of applying the awareness update, because awareness
  and sync frames travel on independent queues. A state whose document has not arrived is
  kept and resolves on a later call rather than being discarded.

One thing §8.1 says that yjs does not do natively: it carries **exactly one** non-null
scope, while `Y.createRelativePositionFromTypeIndex` sets `tname` *and* `item` together for
a root type — `tname` names the scope, `item` the element inside it. This engine emits
`item` alone where there is one, which resolves identically, and verifies the branch it
resolved into is the `Y.Text` for `path`. A strict receiver reading §8.1 literally rejects
the shape yjs produces unedited, which is worth a spec clarification.

---

## Spike 2 — can the CRDT ↔ buffer echo be stopped, and does a boolean guard survive?

**Question (§7 #2, §2.3, §2.5).** VS Code gives no way to tell who caused a text change:
`WorkspaceEdit` has no author, and `TextDocumentChangeEvent` carries only
`reason: Undo | Redo | undefined`. Every extension suppresses the event its own `applyEdit`
produced; the study calls the guard window *"the single most likely source of 'an edit
vanished' bugs"*.

**Experiment.** A stand-in for the buffer API with the timing that matters: a user's
keystroke dispatches its change event synchronously, while an edit the adapter applied
itself (`applyEdit`) dispatches after a configurable number of turns — which is how a
coalesced or queued event arrives after the code that caused it returned. Three guard
strategies: a boolean flag cleared as soon as `applyEdit` returns, the same flag cleared on
the next macrotask, and a content comparison (the buffer's text against the CRDT's). A
remote peer's insert drives the CRDT→buffer direction and the resulting change event comes
back as if the user had made it.

**Measured.**

```
[spike 2] guard cleared with the applyEdit promise, event 1 turn late: text "REMOTE\nREMOTE\nbase\n", buffer agrees false
[spike 2] guard cleared on the next macrotask, event 1 turn late: text "REMOTE\nbase\n", buffer agrees true
[spike 2] guard cleared on the next macrotask, event 3 turns late: text "REMOTE\nREMOTE\nbase\n", buffer agrees false
[spike 2] content comparison, event 3 turns late: text "REMOTE\nbase\n", buffer agrees true
[spike 2] a keystroke inside the guard window: CRDT "REMOTE\nbase\n", buffer "REMOTE\nbase\ntyped\n" — divergent, silently
[spike 2] the same keystroke with a content comparison: CRDT "REMOTE\nbase\ntyped\n", buffer "REMOTE\nbase\ntyped\n"
```

**Findings.**

1. **The flag is a bet on timing, and it loses both ways.** Cleared with the promise, a
   coalesced event lands after it and the remote line is inserted into the CRDT a second
   time (`REMOTE` appears twice). Cleared on the next macrotask it survives one turn and is
   still defeated by an event three turns later. A user's keystroke arriving *inside* the
   guard window is the mirror failure: it is swallowed as if it were the echo, and the
   buffer and the CRDT diverge with nothing to notice it — the "edit vanished" bug.
2. **Comparing content is not a timing bet.** The buffer either matches the CRDT or it does
   not, so no delay changes the answer: the echo is skipped and the user's keystroke is
   applied. It costs one string comparison per change event, and it needs the CRDT's text
   for that document, which the engine has (`engine.text(path)`).
3. **The other direction of the loop is free, and it is structural.** The `Y.Doc` update
   event fires with a transaction *origin*; the engine applies peer updates under its own
   origin and broadcasts only what is not that origin, so a peer's update is never
   re-broadcast, at any timing (`[spike 2] applying a remote update must not be re-broadcast`
   asserts the count stays at one).

**Decision for this engine.** The engine takes the structural half and leaves the timing half
to the adapter, which is where it belongs:

- **CRDT → buffer**: the engine observes each open document's `Y.Text` individually and emits
  `documentChanged { path }` only for changes that did not come from the adapter's own
  transaction (`LOCAL_ORIGIN`). A cursor move does not emit it at all — an awareness frame is
  not text (`test/engine.test.ts`, *"only the document that changed is reported"*).
- **buffer → CRDT**: an adapter must not use a bare flag. It compares the buffer's text with
  `engine.text(path)` before writing, and keeps a debounced reconcile as the backstop for the
  case the comparison cannot see (a divergence introduced by another extension). This is the
  adapter's contract; the engine cannot enforce it, and `README.md` states it.
- The engine's `insert`/`delete` are deliberately *deltas*, not whole-buffer writes, so an
  adapter that does reconcile cannot collapse undo granularity or reset folding (§2.2).

---

## Spike 3 — EOL and the trailing newline

**Question (§7 #3, §2.6).** Neither `DESIGN.md` nor `PROTOCOL.md` mentions line endings. OCT
needs a ~380-line normalisation class, Teamtype has an ADR about Vim's EOL behaviour, and the
study calls mixed EOLs *"a convergence bug on mixed platforms"*.

**Experiment.** Two replicas whose editors enforce their own line endings (CRLF and LF) sync
through one CRDT, first with no policy and then with the policy *LF in the CRDT, the
document's EOL restored on render*. Then the trailing-newline invariant, applied by both
sides as a formatter would.

**Measured.**

```
[spike 3] no policy: writes 1/2; the CRDT ended up "line one\nline two\n" (LF wrote last), the CRLF editor still shows "line one\r\nline two\r\n"
[spike 3] no policy: Ada's caret at offset 10 — her buffer says "line two", the CRDT says "ine two\n"
[spike 3] LF in the CRDT: CRDT "line one\nline two\n", Ada's buffer "line one\r\nline two\r\n", Bob's "line one\nline two\n"
[spike 3] LF in the CRDT: Bob's offset 9 is "line two" in the CRDT and "line two" in his buffer
[spike 3] LF in the CRDT: Ada's own offset for the same character is 10 (CRDT offset 9); the difference is one byte per CRLF line
[spike 3] trailing newline: two adapters each ensuring one newline: CRDT "no trailing newline\n"
[spike 3] trailing newline: with no invariant, CRDT "no trailing newline" on both sides: "no trailing newline"
```

**Findings.**

1. **Two editors with different EOLs rewrite each other's CRDT, forever.** Each buffer is a
   change the other replica has to follow; the CRDT's line endings end up being whoever wrote
   last, and the other client's offsets then address the wrong byte (`ine two\n` for a caret
   that should be on `line two`). This is a loop, not a one-off: nothing converges it.
2. **LF-only in the CRDT plus a per-document EOL in the adapter converges and keeps both
   documents looking the way the user expects.** The CRDT is `line one\nline two\n` whichever
   client wrote it; the CRLF editor still sees CRLF. The price is explicit and small: an
   adapter that publishes *offsets* must convert between its buffer and the CRDT — the
   difference is one byte per preceding line ending — which is the second reason to move
   selections to CRDT-relative positions (spike 1).
3. **An invariant the sync layer does not have is a loop.** Two adapters each "ensuring" a
   trailing newline is idempotent only because the second one sees the first's result in this
   exact ordering; the general shape — a formatter that edits on change — is the format-on-save
   feedback loop the study flags in §2.4. With no invariant anywhere, `no trailing newline`
   stays `no trailing newline` on both replicas.

**Decision for this engine.** The engine normalises nothing and enforces nothing: a `Y.Text`
holds exactly the bytes the adapter put there, so no client can impose a policy on another.
The policy is the adapter's, stated in `README.md`:

- write LF into the CRDT (`text.replace(/\r\n/g, '\n')` on the way in), remember the
  document's EOL, and restore it when rendering — never write the restored text back;
- no trailing-newline invariant in the sync layer; if the editor wants one, it owns it in one
  place and must not treat its own application of it as a local edit.

Both policies are per-document state, so neither changes the wire. They do change what a
*second* client must do to interoperate with a first, so they belong in `PROTOCOL.md` as a
statement about document content (an extension note, not a new field).

---

## Cross-cutting findings

- **`y-protocols` starts its own clock.** `new Awareness(doc)` installs a 15 s/30 s
  `setInterval`. Spike 1 hung the test runner for five minutes because of it, and it is also
  why `SelvageEngine` stops it (`clearInterval(this.awareness._checkInterval)`) and drives
  renewal and expiry from the server's advertised `keepalive` (spec §8.2). Without that, a
  client substitutes its own numbers and disagrees with its peers about when a cursor is
  stale. The engine's own tests compress the window (20 ms/80 ms) to test it in ~100 ms.
- **A frame's kind is in its type, not in whether it decodes as UTF-8.** The first version of
  the transport tried to read every frame as text and treat binary as a fallback; `ws` hands
  a binary frame over as a `Buffer`, which decodes as UTF-8 perfectly well, so every
  y-protocols frame was silently misrouted and documents never synced. The engine's tests
  caught it on the first run (`test/engine.test.ts`, convergence).
- **Reconnection is a new connection, and a host has to carry its room into it.** A host
  learns the room id and token from the `room.created` reply, not from its connect options,
  so a reconnecting host that reuses its options **mints a second empty room**. Spec §9.1
  describes the reclaim path as "the same path an ordinary join takes"; it is only the same
  path if the engine remembers the room and token it was seated with, which `SelvageEngine`
  now does (`test/reconnect.test.ts`, *"a host that dropped reclaims its room rather than
  minting a second one"*).
