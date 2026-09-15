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
import { virtualUri } from '../src/bridge/virtual.ts';
import type { EngineEvent, EngineEventListener } from '../src/engine/events.ts';
import { waitFor } from './helpers/wait.ts';
import * as vscodeLoader from './helpers/vscode-loader.ts';

// The adapter is loaded directly rather than through the built bundle, so `vscode` has to be
// answered for the ESM resolver too.
registerHooks(vscodeLoader);
const { WorkspaceEditor } = await import('../src/adapter/documents.ts');

const ROOM = 'r-dropped-edit';
const PATH = 'src/main.rs';

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
  const uriString = virtualUri(ROOM, PATH);
  const question = uriString.indexOf('?');
  const document = {
    uri: {
      scheme: 'selvage',
      path: uriString.slice(uriString.indexOf('/'), question),
      query: uriString.slice(question + 1),
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
  const editor = new WorkspaceEditor({
    role: 'guest',
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
  };

  stub.registered.applyEditImpl = async (edit) => {
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
    if (!(await answer(window))) {
      return false;
    }
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
    return true;
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
