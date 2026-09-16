/**
 * The VS Code half of the seam, over the editor stub and a stand-in engine: a change the editor
 * refuses because the document moved under it is rebuilt against the document as it now reads
 * and offered again.
 *
 * This is the data-loss bug the two-instance proof shows intermittently: a keystroke typed while
 * one of the bridge's own applies is in flight is deferred, the editor refuses the apply because
 * the keystroke moved the document's version, and the bridge's refusal path reconciles the buffer
 * back to the room — the keystroke is gone, from the buffer and from the room, with no
 * `divergence` and no `applyRefused` to say so. The Neovim client's adapter rebases a refused
 * change through the local edit it withheld and offers it again
 * (`nvim_client/companion/editor.ts`); this pins the same behaviour on this side, which is what
 * the clients' parity requires of a behaviour the protocol does not constrain.
 *
 * A refusal with no local edit behind it is still the bridge's, and still reaches the person:
 * that is what the second test holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire, registerHooks } from 'node:module';

import { SessionBridge } from '../src/bridge/bridge.ts';
import type { Engine, Report } from '../src/bridge/bridge.ts';
import { applyChange, diff } from '../src/bridge/editing.ts';

import type { EngineEvent, EngineEventListener } from '../src/engine/events.ts';
import { waitFor } from './helpers/wait.ts';
import * as vscodeLoader from './helpers/vscode-loader.ts';

// The adapter is loaded directly rather than through the built bundle, so `vscode` has to be
// answered for the ESM resolver too.
registerHooks(vscodeLoader);
const { WorkspaceEditor } = await import('../src/adapter/documents.ts');
const { MIRROR_MARKER } = await import('../src/adapter/mirror.ts');

const PATH = 'src/main.rs';
/** The mirror root the seated guest resolves its documents under. */
const MIRROR_ROOT = '/mirror';

/** A position in the document, as an editor reports one. */
interface StubPosition {
  line: number;
  character: number;
}

/** One edit inside a `WorkspaceEdit`, as the stub records it. */
type StubEdits = Array<
  | { kind: 'replace'; range: { start: StubPosition; end: StubPosition }; text: string }
  | { kind: 'insert'; position: StubPosition; text: string }
>;

/** The line and character a buffer offset falls at, as an editor reports a position. */
function positionIn(text: string, offset: number): StubPosition {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return {
    line: before.split('\n').length - 1,
    character: offset - lastNewline - 1,
  };
}

/** The buffer offset a position names, counted against the text it is read as. */
function offsetIn(text: string, position: StubPosition): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    offset += (lines[line] ?? '').length + 1;
  }
  return offset + position.character;
}

interface EditorStub {
  registered: { applyEditImpl: (edit: { edits: StubEdits }) => Promise<boolean> };
}

const stub = createRequire(import.meta.url)('./helpers/vscode-stub.cjs') as EditorStub;

/** A change offered to the document, as its own offsets. */
interface Offered {
  start: number;
  end: number;
  text: string;
}

interface Window {
  /** The document's text, as the editor holds it. */
  text(): string;
  /** A user's edit: the document moves and the editor's change event reaches the bridge. */
  type(text: string): void;
  /** The room's text. */
  room(): string;
  /** The room edited the document itself, as a peer's edit arriving does. */
  peer(change: (text: string) => string): void;
  /** Every change offered to this document, in order. */
  readonly offered: Offered[];
  readonly reports: Report[];
  /**
   * Lets every apply the bridge has issued finish, and the reconciles they lead to with them.
   * The applies are a promise chain, so one turn of the event loop drains all of it; the loop
   * is a real predicate on the applies this window has seen, not a guess at a turn count.
   */
  drain(): Promise<void>;
  /** Ends this window's bridge, so a long run does not hold every case's state at once. */
  dispose(): void;
}

/**
 * A guest window holding one document, with the editor stub answering `applyEdit` through
 * `answer`. The document stand-in is the test's own, as the adapter's other tests have it: its
 * text is a variable, and an edit the answer accepts is applied to it here, as the editor's own
 * model would.
 */
function seat(
  t: TestContext,
  initial: string,
  answer: (window: Window) => Promise<boolean>,
): Window {
  let text = initial;
  // A guest's document is a file under the mirror root: the room path is the root's
  // suffix, and nothing outside it — nor the mirror's own marker — is shared.
  const uriString = `file://${MIRROR_ROOT}/${PATH}`;
  const document = {
    uri: {
      scheme: 'file',
      path: `${MIRROR_ROOT}/${PATH}`,
      fsPath: `${MIRROR_ROOT}/${PATH}`,
      query: '',
      toString: () => uriString,
    },
    eol: 1,
    isDirty: false,
    getText: () => text,
    positionAt: (offset: number) => positionIn(text, offset),
    offsetAt: (position: StubPosition) => offsetIn(text, position),
    save: () => Promise.resolve(true),
  };

  const reports: Report[] = [];
  const offered: Offered[] = [];
  // Every `applyEdit` this window was asked for, and every one that has answered. The bridge
  // issues the next apply only from the last one's `then`, so the two being equal is the chain
  // being finished rather than merely quiet for a moment.
  let initiated = 0;
  let completed = 0;
  const editor = new WorkspaceEditor({
    role: 'guest',
    mirrorRoot: MIRROR_ROOT,
    folders: [],
    report: (report) => reports.push(report),
  });
  const room = stubRoom(initial);
  const bridge = new SessionBridge({ engine: room.engine, host: editor, autoSave: false });
  const window: Window = {
    text: () => text,
    type(value: string): void {
      text = value;
      bridge.documentChanged(PATH);
    },
    room: room.text,
    peer: room.move,
    offered,
    reports,
    drain: async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (initiated > 0 && initiated === completed) {
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `the apply chain did not drain: initiated=${initiated} completed=${completed}`,
          );
        }
      }
    },
    dispose: () => bridge.dispose(),
  };

  stub.registered.applyEditImpl = async (edit) => {
    initiated += 1;
    // The editor reads the change's positions against the document as it stands, which is the
    // whole point of the test: a change re-offered at stale offsets lands somewhere else.
    const read = (position: StubPosition): number => offsetIn(text, position);
    for (const change of edit.edits) {
      if (change.kind === 'replace') {
        offered.push({
          start: read(change.range.start),
          end: read(change.range.end),
          text: change.text,
        });
      } else {
        const at = read(change.position);
        offered.push({ start: at, end: at, text: change.text });
      }
    }
    let ok = true;
    if (!(await answer(window))) {
      ok = false;
    } else {
      for (const change of edit.edits) {
        if (change.kind === 'replace') {
          const start = read(change.range.start);
          const end = read(change.range.end);
          text = text.slice(0, start) + change.text + text.slice(end);
        } else {
          const at = read(change.position);
          text = text.slice(0, at) + change.text + text.slice(at);
        }
      }
    }
    completed += 1;
    return ok;
  };

  editor.register(document as unknown as Parameters<typeof editor.register>[0]);
  bridge.documentOpened(PATH);
  t.after(() => {
    bridge.dispose();
  });
  return window;
}

/** The room, as much of an engine as the bridge reads, with a way to say a peer changed it. */
function stubRoom(initial: string): {
  engine: Engine;
  text(): string;
  move(change: (text: string) => string): void;
} {
  let text = initial;
  const listeners = new Set<EngineEventListener>();
  const engine = {
    session: () => ({ role: 'guest' }),
    text: () => text,
    has: () => true,
    open: () => Promise.resolve(),
    close: () => Promise.resolve(),
    insert: (_path: string, index: number, value: string) => {
      text = text.slice(0, index) + value + text.slice(index);
    },
    delete: (_path: string, index: number, length: number) => {
      text = text.slice(0, index) + text.slice(index + length);
    },
    setSelection: () => undefined,
    setAwareness: () => undefined,
    presence: () => [],
    resolveSelection: () => undefined,
    on: (listener: EngineEventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    engine: engine as unknown as Engine,
    text: () => text,
    move(change: (current: string) => string): void {
      text = change(text);
      const event: EngineEvent = { type: 'documentChanged', path: PATH };
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
  };
}

test('a keystroke typed while a peer’s edit is applied is merged with it, not dropped', async (t) => {
  const window = seat(t, 'base\n', (window) => {
    if (window.offered.length === 1) {
      // The peer's change was computed against "base\n" and is being applied. The user types at
      // the start before the editor answers: the document moves under the range, and the editor
      // refuses the change because it was not computed against the text that is there now.
      window.type(`TYPED\n${window.text()}`);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  });

  window.peer((text) => `${text}REMOTE\n`);

  const room = await waitFor(
    'the room to hold the peer’s edit and the keystroke',
    () => {
      const text = window.room();
      return text === 'TYPED\nbase\nREMOTE\n' ? text : false;
    },
    {
      timeoutMs: 2000,
      describe: () => ({
        buffer: window.text(),
        room: window.room(),
        offered: window.offered,
      }),
    },
  );

  assert.equal(window.text(), room, 'the buffer and the room agree');
  // The refused range was moved by the keystroke's six code units and offered again, and the
  // change that landed is the peer's own.
  assert.deepEqual(window.offered, [
    { start: 5, end: 5, text: 'REMOTE\n' },
    { start: 11, end: 11, text: 'REMOTE\n' },
  ]);
});

test('a change the document refuses for good still reaches the bridge', async (t) => {
  const window = seat(t, 'base\n', () => Promise.resolve(false));

  window.peer((text) => `${text}REMOTE\n`);

  const refused = await waitFor(
    'the bridge to report the refusal',
    () => window.reports.find((report) => report.kind === 'applyRefused') ?? false,
    { timeoutMs: 2000, describe: () => window.reports },
  );

  assert.deepEqual(refused, { kind: 'applyRefused', path: PATH });
  assert.equal(window.text(), 'base\n', 'the document never moved');
  assert.equal(window.room(), 'base\nREMOTE\n', 'the room keeps the text the buffer cannot hold');
});

test('a document that keeps moving under a refused change is given up on, not looped over', async (t) => {
  const window = seat(t, 'base\n', (window) => {
    // Refused every time, with the document moving under each offer, so no rebase can hold.
    window.type(`${window.text()}TYPED\n`);
    return Promise.resolve(false);
  });

  window.peer((text) => `${text}REMOTE\n`);

  const refused = await waitFor(
    'the bridge to report the refusal',
    () => window.reports.find((report) => report.kind === 'applyRefused') ?? false,
    { timeoutMs: 2000, describe: () => window.reports },
  );

  assert.deepEqual(refused, { kind: 'applyRefused', path: PATH });
  // Four offers per apply — the change, then three rebased ones — and three applies before the
  // bridge stops retrying. The bound is what keeps a document that refuses every range from
  // spinning the extension host.
  assert.equal(window.offered.length, 12);
});

test('a re-offered change whose merge equals the buffer’s pre-apply text keeps the local edit', async (t) => {
  const window = seat(t, 'a\n\nb', (window) => {
    if (window.offered.length === 1) {
      // The room is deleting one of the two adjacent newlines, and the user presses Enter
      // while that change is in flight. The two edits are inverses, so the correct merge is
      // the text the buffer held before the apply — the state the bridge used to read as
      // “the change did not land”.
      window.type('a\n\n\nb');
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  });

  window.peer(() => 'a\nb');

  await waitFor(
    'the buffer and the room to hold the merge',
    () => (window.text() === 'a\n\nb' && window.room() === 'a\n\nb' ? true : false),
    {
      timeoutMs: 2000,
      describe: () => ({
        buffer: window.text(),
        room: window.room(),
        offered: window.offered,
        reports: window.reports,
      }),
    },
  );
});

test('a change given up on at the bound reaches the person instead of going quietly', async (t) => {
  const window = seat(t, 'base\n', (window) => {
    // A second writer lands a local-looking edit inside the first four offer windows and then
    // stops. Each movement buys the next rebased offer, so the adapter reaches its bound with
    // the typed text still in the buffer and hands the refusal back; the bridge’s reconcile
    // then succeeds against the current buffer and would delete that text without a word.
    if (window.offered.length <= 4) {
      window.type(`${window.text()}k${window.offered.length}\n`);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  });

  window.peer((text) => `${text}REMOTE\n`);

  const told = await waitFor(
    'the person to be told the deferred text was not kept',
    () => window.reports.find((report) => report.kind === 'divergence') ?? false,
    {
      timeoutMs: 2000,
      describe: () => ({
        buffer: window.text(),
        room: window.room(),
        offered: window.offered,
        reports: window.reports,
      }),
    },
  );

  assert.deepEqual(told, { kind: 'divergence', path: PATH });
  // The bound path still ends with the buffer holding the room's text: the local text is what
  // a reconcile works away. The report is what makes that visible rather than silent.
  assert.equal(window.text(), 'base\nREMOTE\n');
  assert.equal(window.room(), 'base\nREMOTE\n');
});

/**
 * A guest shares the mirror root and nothing else: the room path is the root's
 * suffix, and a path outside it — beside it, above it, or the mirror's own marker —
 * is not shared. Each guard names the shape it refuses.
 */
test('a guest shares the mirror root and nothing else', () => {
  const editor = new WorkspaceEditor({
    role: 'guest',
    mirrorRoot: '/mirror',
    folders: [],
    report: () => undefined,
  });
  type Document = Parameters<typeof editor.register>[0];
  const doc = (scheme: string, fsPath: string): Document =>
    ({ uri: { scheme, path: fsPath, fsPath, query: '', toString: () => `${scheme}://${fsPath}` } }) as unknown as Document;
  assert.equal(editor.register(doc('file', '/mirror/a.md')), 'a.md');
  assert.equal(editor.register(doc('file', '/mirror/notes/b.md')), 'notes/b.md');
  // Beside the root, not under it: a prefix is not containment.
  assert.equal(editor.register(doc('file', '/mirror-sibling/a.md')), undefined);
  assert.equal(editor.register(doc('file', '/other/a.md')), undefined);
  assert.equal(editor.register(doc('file', '/mirror')), undefined);
  assert.equal(editor.register(doc('file', '/mirror/../escape.md')), undefined);
  // The mirror's own marker is bookkeeping, never a document.
  assert.equal(editor.register(doc('file', `/mirror/${MIRROR_MARKER}`)), undefined);
  // No scheme from the old world names a document anymore.
  assert.equal(editor.register(doc('selvage', '/mirror/a.md')), undefined);
});

test('a guest with no mirror shares nothing', () => {
  const editor = new WorkspaceEditor({ role: 'guest', folders: [], report: () => undefined });
  const document = {
    uri: {
      scheme: 'file',
      path: '/mirror/a.md',
      fsPath: '/mirror/a.md',
      query: '',
      toString: () => 'file:///mirror/a.md',
    },
  } as unknown as Parameters<typeof editor.register>[0];
  assert.equal(editor.register(document), undefined);
});

/** A small deterministic generator, so a failure here replays from the same seed exactly. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Repeated characters make an exact textual coincidence between two edits unremarkable. */
const ALPHABET = ['a', 'b', '\n'];

function randomText(rng: () => number, max: number): string {
  const length = Math.floor(rng() * (max + 1));
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return out;
}

/** `text` with one random contiguous replacement: the shape of one local edit. */
function withOneEdit(rng: () => number, text: string): string {
  const a = Math.floor(rng() * (text.length + 1));
  const b = a + Math.floor(rng() * (text.length - a + 1));
  return applyChange(text, { start: a, end: b, text: randomText(rng, 3) });
}

/**
 * The property the refused-change re-offer has to hold: one local edit arriving inside one
 * apply window, over a local edit that does not straddle the room's change, must merge — the
 * buffer and the room end on the text that holds both edits, with neither lost nor doubled.
 *
 * The corpus is drawn with a fixed seed and a fixed count, and the run is bounded: the three
 * symbols and short strings are what make the merge that equals the pre-apply text common
 * enough for a hand-written case to miss but this to find.
 */
test('randomized: a local edit inside a refused apply is merged, not lost or doubled', async (t) => {
  const rng = mulberry32(20240815);
  const failures: string[] = [];
  let cases = 0;
  let straddles = 0;
  for (let i = 0; i < 3000; i += 1) {
    const before = randomText(rng, 14);
    const roomText = withOneEdit(rng, before);
    const current = withOneEdit(rng, before);
    if (roomText === before || current === before) {
      continue;
    }
    const change = diff(before, roomText);
    const local = diff(before, current);
    if (!(local.end <= change.start || local.start >= change.end)) {
      straddles += 1;
      continue;
    }
    cases += 1;
    const expected =
      local.end <= change.start ? applyChange(roomText, local) : applyChange(current, change);
    const window = seat(t, before, (window) => {
      if (window.offered.length === 1) {
        // The single local edit lands inside the apply window and moves the document under
        // the range, so the editor refuses it.
        window.type(current);
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    });
    window.peer(() => roomText);
    await window.drain();
    const buffer = window.text();
    const room = window.room();
    window.dispose();
    if (buffer !== expected || room !== expected) {
      failures.push(
        JSON.stringify({
          before,
          roomText,
          current,
          change,
          local,
          expected,
          buffer,
          room,
          offers: window.offered.length,
          reports: window.reports,
        }),
      );
    }
  }
  assert.ok(cases > 100, `enough cases ran: ${cases}`);
  assert.equal(
    failures.length,
    0,
    `${failures.length} of ${cases} non-straddling single local edits did not merge exactly ` +
      `(straddles=${straddles}):\n${failures.slice(0, 5).join('\n')}`
  );
});
