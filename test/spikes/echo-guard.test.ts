/**
 * Spike 2 (§7 risk 2): the CRDT ↔ buffer echo, and whether a boolean guard survives the
 * timing.
 *
 * VS Code gives no way to tell who caused a text change: `WorkspaceEdit` carries no
 * author and `TextDocumentChangeEvent` has only `reason: Undo | Redo | undefined`. Every
 * extension therefore suppresses the event its own `applyEdit` produced, and the study's
 * §2.5 says the guard window is the likeliest source of "an edit vanished" bugs. This
 * models the buffer API — an edit that dispatches a change event a tick or two later, as
 * a coalesced event does — and measures what each guard does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';

/** A minimal delta, as a position-based change event would carry. */
interface Delta {
  start: number;
  removed: number;
  inserted: string;
}

/** The smallest prefix/suffix diff: what a change event's range really is. */
function delta(from: string, to: string): Delta {
  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) {
    start += 1;
  }
  let endFrom = from.length;
  let endTo = to.length;
  while (
    endFrom > start &&
    endTo > start &&
    from[endFrom - 1] === to[endTo - 1]
  ) {
    endFrom -= 1;
    endTo -= 1;
  }
  return {
    start,
    removed: endFrom - start,
    inserted: to.slice(start, endTo),
  };
}

/**
 * A stand-in for a text buffer. A user's keystroke dispatches synchronously, as VS Code
 * does; an edit this adapter applied itself dispatches after `eventDelayTicks` turns, which
 * is how a coalesced or queued change event arrives after the code that caused it returned.
 */
class FakeBuffer {
  text: string;
  private readonly listeners: ((change: Delta, fromAdapter: boolean) => void)[] = [];
  eventDelayTicks = 1;

  constructor(text: string) {
    this.text = text;
  }

  onChange(listener: (change: Delta, fromAdapter: boolean) => void): void {
    this.listeners.push(listener);
  }

  /** A user's edit: the change event is dispatched before this call returns. */
  userEdit(next: string): void {
    const change = delta(this.text, next);
    const fromAdapter = this.applying;
    this.text = next;
    this.dispatch(change, fromAdapter);
  }

  /** `applyEdit` returning: the text changes now, the event lands later. */
  applyEdit(next: string): void {
    const change = delta(this.text, next);
    this.text = next;
    this.applying = true;
    const ticks = this.eventDelayTicks;
    const land = (left: number): void => {
      if (left <= 0) {
        this.dispatch(change, true);
        return;
      }
      setTimeout(() => {
        land(left - 1);
      }, 0);
    };
    land(ticks);
    this.applying = false;
  }

  /** Lets the queued change events land. */
  async settle(turns = 6): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private applying = false;

  private dispatch(change: Delta, fromAdapter: boolean): void {
    for (const listener of [...this.listeners]) {
      listener(change, fromAdapter);
    }
  }
}

type Strategy = 'flag-immediate' | 'flag-macrotask' | 'content-compare';

const LOCAL = Symbol('local');
const REMOTE = Symbol('remote');

/** An adapter that mirrors one CRDT text into one buffer, under one guard strategy. */
class Mirror {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly buffer: FakeBuffer;
  echoes = 0;
  private readonly strategy: Strategy;
  private guard = false;

  constructor(strategy: Strategy, seed: string) {
    this.strategy = strategy;
    this.text = this.doc.getText('src/main.rs');
    this.text.insert(0, seed);
    this.buffer = new FakeBuffer(seed);
    this.text.observe((_event, transaction) => {
      if (transaction.origin === LOCAL) {
        return;
      }
      this.applyToBuffer();
    });
    this.buffer.onChange((change, fromAdapter) => {
      this.onBufferChange(change, fromAdapter);
    });
  }

  /** CRDT → buffer, the direction that must not echo back. */
  private applyToBuffer(): void {
    const next = this.text.toString();
    if (next === this.buffer.text) {
      return;
    }
    if (this.strategy === 'content-compare') {
      // Nothing to arm: the compare below is the guard.
      this.buffer.applyEdit(next);
      return;
    }
    this.guard = true;
    this.buffer.applyEdit(next);
    if (this.strategy === 'flag-immediate') {
      // What `await applyEdit(); guard = false;` leaves behind: the flag is already down
      // before a coalesced event lands.
      this.guard = false;
    } else {
      setTimeout(() => {
        this.guard = false;
      }, 0);
    }
  }

  /** buffer → CRDT: only a change the user made may be written into the CRDT. */
  private onBufferChange(change: Delta, fromAdapter: boolean): void {
    if (this.strategy === 'content-compare') {
      if (this.buffer.text === this.text.toString()) {
        return;
      }
    } else if (this.guard) {
      if (fromAdapter) {
        this.echoes += 1;
      }
      return;
    }
    this.guard = false;
    this.doc.transact(() => {
      if (change.removed > 0) {
        this.text.delete(change.start, change.removed);
      }
      if (change.inserted !== '') {
        this.text.insert(change.start, change.inserted);
      }
    }, LOCAL);
  }

  /** A remote edit, as it arrives over the wire: applied with a remote origin. */
  applyRemoteEdit(mutate: (text: Y.Text) => void): void {
    this.doc.transact(() => {
      mutate(this.text);
    }, REMOTE);
  }
}

/** Runs one (strategy, event delay) experiment and reports what happened. */
async function experiment(
  strategy: Strategy,
  eventDelayTicks: number,
): Promise<{ echoes: number; text: string; converged: boolean }> {
  const mirror = new Mirror(strategy, 'base\n');
  mirror.buffer.eventDelayTicks = eventDelayTicks;
  // A remote peer inserts at the top: the observer drives the buffer, whose change event
  // comes back as if it were a user's.
  mirror.applyRemoteEdit((text) => {
    text.insert(0, 'REMOTE\n');
  });
  await mirror.buffer.settle(3);
  const text = mirror.text.toString();
  return {
    echoes: mirror.echoes,
    text,
    converged: text === 'REMOTE\nbase\n' && mirror.buffer.text === text,
  };
}

test('spike 2: a boolean guard cleared too early duplicates the remote edit', async () => {
  const immediate = await experiment('flag-immediate', 1);
  console.log(
    `[spike 2] guard cleared with the applyEdit promise, event 1 turn late: ` +
      `text ${JSON.stringify(immediate.text)}, buffer agrees ${immediate.converged}`,
  );

  const macrotask = await experiment('flag-macrotask', 1);
  console.log(
    `[spike 2] guard cleared on the next macrotask, event 1 turn late: ` +
      `text ${JSON.stringify(macrotask.text)}, buffer agrees ${macrotask.converged}`,
  );

  // An event delayed by more turns than the guard waits: the macrotask guard misses it too.
  const late = await experiment('flag-macrotask', 3);
  console.log(
    `[spike 2] guard cleared on the next macrotask, event 3 turns late: ` +
      `text ${JSON.stringify(late.text)}, buffer agrees ${late.converged}`,
  );

  const compared = await experiment('content-compare', 3);
  console.log(
    `[spike 2] content comparison, event 3 turns late: ` +
      `text ${JSON.stringify(compared.text)}, buffer agrees ${compared.converged}`,
  );

  assert.equal(immediate.text, 'REMOTE\nREMOTE\nbase\n', 'the echo doubled the paste');
  assert.equal(macrotask.converged, true, 'one turn is inside the macrotask window');
  assert.equal(
    late.text,
    'REMOTE\nREMOTE\nbase\n',
    'an event later than the guard defeats a time-based guard',
  );
  assert.equal(compared.converged, true, 'comparing content is not a timing bet');
});

test('spike 2: a user edit inside the guard window is lost, not duplicated', async () => {
  const mirror = new Mirror('flag-macrotask', 'base\n');
  mirror.applyRemoteEdit((text) => {
    text.insert(0, 'REMOTE\n');
  });
  // The user types before the guard is cleared: their keystroke is swallowed as if it were
  // the echo, and the buffer and the CRDT drift apart with nothing to notice it.
  mirror.buffer.userEdit('REMOTE\nbase\ntyped\n');
  await mirror.buffer.settle(3);
  const lost = {
    crdt: mirror.text.toString(),
    buffer: mirror.buffer.text,
  };
  console.log(
    `[spike 2] a keystroke inside the guard window: CRDT ${JSON.stringify(lost.crdt)}, ` +
      `buffer ${JSON.stringify(lost.buffer)} — divergent, silently`,
  );
  assert.notEqual(lost.crdt, lost.buffer);

  // The same keystroke with a content comparison: the buffer and the CRDT still differ, so
  // the change is written, and the two agree again.
  const compared = new Mirror('content-compare', 'base\n');
  compared.applyRemoteEdit((text) => {
    text.insert(0, 'REMOTE\n');
  });
  compared.buffer.userEdit('REMOTE\nbase\ntyped\n');
  await compared.buffer.settle(3);
  console.log(
    `[spike 2] the same keystroke with a content comparison: ` +
      `CRDT ${JSON.stringify(compared.text.toString())}, buffer ${JSON.stringify(compared.buffer.text)}`,
  );
  assert.equal(compared.text.toString(), compared.buffer.text);
  assert.ok(compared.text.toString().endsWith('typed\n'));
});

test('spike 2: applying a remote update must not be re-broadcast', async () => {
  // The other half of the loop: the engine broadcasts `doc.on('update')` for local edits
  // only, which is what keeps a peer from re-sending what it just received.
  const doc = new Y.Doc();
  const text = doc.getText('src/main.rs');
  const engineOrigin = Symbol('engine');
  const sent: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === engineOrigin) {
      return;
    }
    sent.push(update);
  });

  const peer = new Y.Doc();
  const peerUpdate = Y.encodeStateAsUpdate(
    (() => {
      const other = new Y.Doc();
      other.getText('src/main.rs').insert(0, 'from a peer\n');
      return other;
    })(),
  );
  Y.applyUpdate(doc, peerUpdate, engineOrigin);
  assert.equal(text.toString(), 'from a peer\n');
  assert.equal(sent.length, 0, 'a remote update is not echoed to the room');

  text.insert(0, 'local\n');
  assert.equal(sent.length, 1, 'a local edit is broadcast once');
  assert.equal(peer.getText('src/main.rs').toString(), '');

  // The guard is on the transaction's origin, which no timing can change.
  Y.applyUpdate(doc, peerUpdate, engineOrigin);
  assert.equal(sent.length, 1);
});
