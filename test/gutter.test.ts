/**
 * The gutter badge, pinned.
 *
 * A remote peer's name is shown in the glyph margin as a small coloured image: the initials of
 * their display name over their caret colour. The pixels are not covered by any test here — the
 * only check on how the badge looks is a person opening a real editor — but everything the
 * editor is told to draw is. The pure part — the initials, the SVG, the data URI — is pinned
 * directly; the decoration type the extension builds from them is pinned through the built
 * bundle with the editor API stubbed, because that is where `Uri.parse` and the gutter fields
 * live.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import {
  ANONYMOUS_INITIALS,
  BADGE_OPTIONS,
  INITIALS_LIMIT,
  badgeDataUri,
  badgeSvg,
  initials,
  onePerLine,
} from '../src/adapter/gutter.ts';
import { peerColour, virtualUri } from '../src/bridge/index.ts';
import { SelvageEngine } from '../src/engine/index.ts';
import { loadBundle } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';

const OPTIONS = { client: 'selvage-vscode-test/0.1.0', meta: 'skip' } as const;
const PATH = 'workspace/README.md';
const COLOUR = '#e06c75';

/** True when `text` holds a surrogate unit without its other half. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('the initials are the first two code points, or the anonymous bullet', () => {
  assert.equal(initials('Ada Lovelace'), 'Ad');
  assert.equal(initials('A'), 'A');
  assert.equal(initials('Adaline'), 'Ad');
  assert.equal(initials(''), ANONYMOUS_INITIALS);
  assert.equal(ANONYMOUS_INITIALS, '\u2022');
});

test('the initials never cut through a surrogate pair', () => {
  // The cap is code points, not UTF-16 units: a name that begins with an astral character is
  // taken whole, and a lone surrogate — text no editor can draw — never reaches the SVG.
  assert.equal(initials('\u{1F600}ada'), '\u{1F600}a');
  assert.equal([...initials('\u{1F600}ada')].length, INITIALS_LIMIT);
  assert.equal(initials('\u{1F600}'), '\u{1F600}');
  assert.equal(initials('\u{1F600}\u{1F600}x'), '\u{1F600}\u{1F600}');
  for (const name of ['\u{1F600}ada', '\u{1F600}', '', 'Ada']) {
    assert.ok(!hasLoneSurrogate(initials(name)), `initials(${JSON.stringify(name)}) left half a pair`);
  }
});

test('the badge is a rounded colour-filled rectangle with bold black initials', () => {
  const svg = badgeSvg('Ad', COLOUR);
  assert.ok(svg.startsWith('<svg '), 'the badge is not an SVG');
  assert.ok(svg.includes(`fill="${COLOUR}"`), 'the rectangle is not the peer colour');
  assert.ok(svg.includes('rx="3"'), 'the rectangle is not rounded');
  assert.ok(svg.includes('stroke="#000000"'), 'the rectangle has no black stroke');
  assert.ok(svg.includes('font-weight="bold"'), 'the initials are not bold');
  assert.ok(svg.includes('fill="#000000"'), 'the initials are not black');
  assert.ok(svg.includes('>Ad</text>'), 'the initials are not in the SVG');
});

test('the data URI is the base64 of the SVG', () => {
  const prefix = 'data:image/svg+xml;base64,';
  const uri = badgeDataUri('Ad', COLOUR);
  assert.ok(uri.startsWith(prefix), `the badge is not a base64 data URI: ${uri}`);
  // The image is the SVG itself, base64-encoded — not a file path.
  assert.equal(
    Buffer.from(uri.slice(prefix.length), 'base64').toString('utf8'),
    badgeSvg('Ad', COLOUR),
  );
  // The badge is scaled into the one-line glyph square, never allowed to grow into the text.
  assert.equal(BADGE_OPTIONS.gutterIconSize, 'contain');
  // Nothing a URI parser or a CSS `url()` could choke on survives unencoded.
  assert.ok(!uri.slice(prefix.length).includes('#'));
});

test('the SVG escapes a name that would otherwise close the text element', () => {
  // The name is peer-controlled; a `<` in it must not become markup.
  const svg = badgeSvg('<&', COLOUR);
  assert.ok(svg.includes('&lt;&amp;'), `the initials were not escaped: ${svg}`);
  assert.ok(!svg.includes('>&<'), 'a raw angle bracket reached the SVG');
});

test('one badge is chosen per line, deterministically', () => {
  // Glyph-margin icons on a line share a lane and draw over one another, so two peers on one
  // line must yield one badge. The lowest peer id wins, so the same line draws the same badge
  // every time, whatever order the cursors arrive in.
  const shared = [
    { peerId: 'p-b', label: 'Bob', colour: '#111111' },
    { peerId: 'p-a', label: 'Ada', colour: '#222222' },
  ];
  const one = onePerLine(shared, () => 0);
  assert.equal(one.size, 1, 'a line with two peers produced more than one badge');
  assert.equal(one.get(0)?.peerId, 'p-a');
  assert.equal(onePerLine([...shared].reverse(), () => 0).get(0)?.peerId, 'p-a');

  // Two lines keep a badge each.
  const split = onePerLine(shared, (cursor) => (cursor.peerId === 'p-a' ? 0 : 3));
  assert.deepEqual([...split.keys()].sort((a, b) => a - b), [0, 3]);
  assert.equal(split.get(0)?.peerId, 'p-a');
  assert.equal(split.get(3)?.peerId, 'p-b');
});

// -- the decoration type, through the built extension ---------------------------

interface StubUri {
  scheme: string;
  path: string;
  query: string;
  toString(): string;
}

interface StubDocument {
  uri: StubUri;
  eol: number;
  isDirty: boolean;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  offsetAt(position: unknown): unknown;
  save(): Promise<boolean>;
}

interface StubEditor {
  document: StubDocument;
  /** Every `setDecorations` call this editor received, in order. */
  drawn: Array<{ type: { options: Record<string, unknown> }; options: unknown[] }>;
  setDecorations(type: { options: Record<string, unknown> }, options: unknown[]): void;
}

interface Decoration {
  options: Record<string, unknown>;
  handle: { options: Record<string, unknown> };
}

/** A server with a room, minted by a host engine, and its invite. */
async function room(
  t: TestContext,
  paths: string[],
): Promise<{ server: FakeServer; host: SelvageEngine; invite: string }> {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const host = await SelvageEngine.host(server.wsBase, 'Ada', OPTIONS);
  t.after(async () => {
    await host.disconnect();
  });
  for (const path of paths) {
    await host.open(path);
  }
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');
  return { server, host, invite };
}

/** The bundle, activated, with its recorded state cleared. */
function activated(t: TestContext): LoadedExtension {
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [] });
  t.after(() => {
    bundle.deactivate();
  });
  return bundle;
}

/** A guest seated in `bundle`, waiting for the room to name it. */
async function seat(t: TestContext, invite: string): Promise<LoadedExtension> {
  const bundle = activated(t);
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
  await waitFor('the guest to be seated', () =>
    bundle.stub.registered.information.some((message) => message.includes('joined room'))
      ? true
      : false,
  );
  return bundle;
}

/**
 * An editor on the room's virtual document, as the extension sees one: registered when the
 * editor reports it open, then visible. Returns the editor so a test can look at what was
 * drawn on it.
 */
function installEditor(
  bundle: LoadedExtension,
  roomId: string,
  path: string,
  text: string,
): StubEditor {
  const uriString = virtualUri(roomId, path);
  const question = uriString.indexOf('?');
  const document: StubDocument = {
    uri: {
      scheme: 'selvage',
      path: uriString.slice(uriString.indexOf('/'), question),
      query: uriString.slice(question + 1),
      toString: () => uriString,
    },
    eol: 1,
    isDirty: false,
    getText: () => text,
    positionAt(offset: number) {
      const before = text.slice(0, offset);
      return { line: before.split('\n').length - 1, character: offset - before.lastIndexOf('\n') - 1 };
    },
    offsetAt: (position) => position,
    save: () => Promise.resolve(true),
  };
  const editor: StubEditor = {
    document,
    drawn: [],
    setDecorations(type, options) {
      this.drawn.push({ type, options });
    },
  };
  bundle.stub.fire('openTextDocument', document);
  (bundle.stub.window.visibleTextEditors as StubEditor[]).push(editor);
  return editor;
}

/** The recorded decoration types whose options carry `field`. */
function typesWith(bundle: LoadedExtension, field: string): Decoration[] {
  return (bundle.stub.registered.decorations as unknown as Decoration[]).filter(
    (entry) => field in entry.options,
  );
}

test('the badge is a base64 SVG in the glyph margin, applied at the caret line', async (t) => {
  const { host, invite } = await room(t, [PATH]);
  host.insert(PATH, 0, 'hello\n');
  const bundle = await seat(t, invite);
  // Published after the guest is seated: awareness reaches later arrivals only as it changes.
  // Offset 6 is the empty line after "hello\n", so the badge line is not always 0.
  host.setSelection(PATH, { anchor: 6, head: 6 });
  const editor = installEditor(bundle, host.session().roomId, PATH, 'hello\n');

  const badge = await waitFor('the gutter badge to be drawn', () => {
    bundle.stub.fire('visibleEditors');
    return typesWith(bundle, 'gutterIconPath')[0] ?? false;
  });

  const icon = badge.options.gutterIconPath as { toString(): string };
  assert.equal(typeof icon.toString, 'function', 'gutterIconPath is not a Uri');
  const prefix = 'data:image/svg+xml;base64,';
  assert.ok(icon.toString().startsWith(prefix), `gutterIconPath is not a data URI: ${icon.toString()}`);
  assert.equal(badge.options.gutterIconSize, 'contain');

  // The image is the peer's own colour and their initials — the same badge the pure tests pin.
  const svg = Buffer.from(icon.toString().slice(prefix.length), 'base64').toString('utf8');
  const colour = peerColour(host.session().peer.peer_id);
  assert.ok(svg.includes(`fill="${colour}"`), `the badge is not the peer's colour: ${svg}`);
  assert.ok(svg.includes('>Ad</text>'), `the badge does not show the initials: ${svg}`);

  // One deterministic render of the cached type, so the count is not the poll history.
  editor.drawn.length = 0;
  bundle.stub.fire('visibleEditors');
  const applied = editor.drawn.filter((entry) => entry.type === badge.handle);
  assert.equal(applied.length, 1, 'the badge type was not applied exactly once');
  const ranges = applied.flatMap((entry) => entry.options);
  assert.equal(ranges.length, 1, 'the badge was not applied exactly once');
  // Applied at the caret's line, zero-width, so it never lands inside the text.
  const option = ranges[0] as { range: { start: { line: number; character: number } } };
  assert.deepEqual(option.range.start, { line: 1, character: 0 });
});

/** Every caret `hoverMessage` the editor was handed, oldest draw first. */
function hoverLabels(editor: StubEditor): string[] {
  return editor.drawn
    .flatMap((entry) => entry.options as Array<{ hoverMessage?: unknown }>)
    .map((options) => options.hoverMessage)
    .filter((label): label is string => typeof label === 'string');
}

/** The SVG behind the newest non-empty gutter badge the editor was handed. */
function drawnBadgeSvg(editor: StubEditor): string {
  const prefix = 'data:image/svg+xml;base64,';
  for (let index = editor.drawn.length - 1; index >= 0; index -= 1) {
    const entry = editor.drawn[index];
    const icon = entry.type.options.gutterIconPath as { toString(): string } | undefined;
    if (icon !== undefined && entry.options.length > 0) {
      return Buffer.from(icon.toString().slice(prefix.length), 'base64').toString('utf8');
    }
  }
  return '';
}

test('a peer that renames itself re-labels its caret and its badge', async (t) => {
  const { host, invite } = await room(t, [PATH]);
  host.insert(PATH, 0, 'hello\n');
  const bundle = await seat(t, invite);
  host.setSelection(PATH, { anchor: 0, head: 0 });
  const editor = installEditor(bundle, host.session().roomId, PATH, 'hello\n');

  // The host's caret is drawn under its first name, its hover and its badge alike.
  await waitFor('the caret to be drawn', () => {
    bundle.stub.fire('visibleEditors');
    return hoverLabels(editor).find((label) => label.startsWith('Ada ')) ?? false;
  });
  assert.equal(hoverLabels(editor).find((label) => label.startsWith('Ada ')), 'Ada · host');
  assert.ok(
    drawnBadgeSvg(editor).includes('>Ad</text>'),
    'the badge does not show the first initials',
  );

  // The host renames mid-session. Nothing in the adapter names a peer itself; the caret
  // and the badge follow `peersChanged`, and that is what this pins.
  await host.rename('Grace Hopper');
  const relabelled = await waitFor('the caret to be relabelled', () => {
    bundle.stub.fire('visibleEditors');
    return hoverLabels(editor).find((label) => label.startsWith('Grace Hopper ')) ?? false;
  });
  assert.equal(relabelled, 'Grace Hopper · host');
  await waitFor('the badge to show the new initials', () => {
    bundle.stub.fire('visibleEditors');
    return drawnBadgeSvg(editor).includes('>Gr</text>') ? true : false;
  });
});
