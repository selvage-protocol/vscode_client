/**
 * The Participants view's rows and file badges, without an editor.
 *
 * Slice 1: `describeParticipants` turns membership + presence into rows that name the peer and
 * the file they are in, and `badgeFiles` marks the room files peers are in with the initials
 * those peers are drawn by. Both are pure, so these tests import `src/bridge/` directly.
 * Wiring (registration, refresh, actions) is slice 2, through the built bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PEER_PALETTE, peerColour } from '../src/bridge/cursors.ts';
import { initials } from '../src/bridge/initials.ts';
import {
  badgeFiles,
  describeParticipants,
  peerColourId,
  viewRows,
} from '../src/bridge/participants.ts';
import type { RosterRow } from '../src/bridge/participants.ts';

const ADA = { peerId: 'p-aaa', displayName: 'Ada', role: 'host', path: 'src/a.rs' };
const BO = { peerId: 'p-bbb', displayName: 'Bo', role: 'guest', path: 'src/b.rs' };

test('a row names the peer, the file they are in, and their marker colour', () => {
  const [row] = describeParticipants([ADA], undefined);
  assert.equal(row?.label, 'Ada');
  assert.equal(row?.colour, peerColour('p-aaa'));
  assert.equal(row?.description, 'src/a.rs', 'the row does not say which file the peer is in');
  assert.ok(row?.tooltip.includes('src/a.rs'), 'the hover lost the file');
  assert.ok(row?.tooltip.includes('host'), 'the hover lost the role');
});

test('a shared name disambiguates by the shortest unique peer-id prefix', () => {
  const rows = describeParticipants(
    [
      { peerId: 'p-3d334f', displayName: 'Ada', role: 'guest', path: 'src/a.rs' },
      { peerId: 'p-a91c02', displayName: 'Ada', role: 'guest', path: 'src/b.rs' },
    ],
    undefined,
  );
  assert.deepEqual(
    rows.map((row) => row.label).sort(),
    ['Ada (p-3)', 'Ada (p-a)'].sort(),
  );
});

test('the followed peer keeps their file, offers the stop, and says so in the hover', () => {
  const rows = describeParticipants([ADA, BO], 'p-bbb');
  const bo = rows.find((row) => row.peerId === 'p-bbb');
  assert.equal(bo?.description, 'src/b.rs', 'the follow state displaced the file');
  assert.equal(bo?.contextValue, 'selvageParticipantFollowing');
  assert.ok(bo?.tooltip.includes('following'), 'nothing says this row is the followed one');
  assert.equal(rows.find((row) => row.peerId === 'p-aaa')?.contextValue, 'selvageParticipant');
});

test('a peer in no document reads as away, with no navigation', () => {
  const [row] = describeParticipants(
    [{ peerId: 'p-ccc', displayName: '', role: 'guest' }],
    undefined,
  );
  assert.equal(row?.label, 'p-ccc', 'a blank name falls back to the id, as the caret label does');
  assert.equal(row?.description, 'not in a file yet');
  assert.equal(row?.contextValue, 'selvageParticipantAway');
  assert.equal(row?.canNavigate, false);
});

test('one peer in a file badges their initials, in the colour their caret wears', () => {
  assert.deepEqual(
    badgeFiles([{ uri: 'file:///room/src/a.rs', peers: [{ peerId: 'p-aaa', label: 'Ada' }] }]),
    [
      {
        uri: 'file:///room/src/a.rs',
        badge: 'Ad',
        colourId: peerColourId('p-aaa'),
        tooltip: 'Ada is here',
      },
    ],
  );
});

test('the badge is the initials the glyph margin draws: two code points, astral-safe', () => {
  const label = '\u{1F600}ada';
  const [one] = badgeFiles([{ uri: 'u', peers: [{ peerId: 'p-1', label }] }]);
  assert.equal(one?.badge, '\u{1F600}a');
  assert.equal(one?.badge, initials(label), 'the file badge and the gutter badge disagree');
  const [anonymous] = badgeFiles([{ uri: 'u', peers: [{ peerId: 'p-2', label: '' }] }]);
  assert.equal(anonymous?.badge, initials(''), 'a name with no letters lost its bullet');
});

test('several peers in a file badge the count, name them all in the hover, and claim no colour', () => {
  const [badge] = badgeFiles([
    {
      uri: 'file:///room/src/a.rs',
      peers: [
        { peerId: 'p-bbb', label: 'Bo' },
        { peerId: 'p-aaa', label: 'Ada' },
      ],
    },
  ]);
  assert.equal(badge?.badge, '2', 'a shared file answered with one peer\u2019s initials');
  assert.equal(badge?.colourId, undefined, 'one colour claimed a file two peers are in');
  assert.equal(badge?.tooltip, 'Ada, Bo are here');
});

test('a file nobody is in wears nothing', () => {
  assert.deepEqual(badgeFiles([{ uri: 'file:///room/src/a.rs', peers: [] }]), []);
});

test('every palette entry is a theme colour whose default is that entry', () => {
  // A file decoration's colour is a `ThemeColor`, which takes a theme colour's id and never an
  // arbitrary hex — so the palette is contributed as theme colours and a badge names one. The
  // two halves are one decision, so they are pinned to each other here rather than separately.
  const manifest = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')) as {
    contributes?: {
      colors?: Array<{ id: string; description?: string; defaults?: Record<string, string> }>;
    };
  };
  const colours = manifest.contributes?.colors ?? [];
  assert.deepEqual(
    colours.map((entry) => entry.id),
    PEER_PALETTE.map((_, index) => `selvage.peer.${index}`),
    'the manifest contributes a colour set that is not the peer palette',
  );
  for (const [index, colour] of PEER_PALETTE.entries()) {
    const entry = colours[index];
    for (const theme of ['light', 'dark', 'highContrast']) {
      assert.equal(
        entry?.defaults?.[theme],
        colour,
        `selvage.peer.${index} is not palette entry ${index} on a ${theme} theme`,
      );
    }
    assert.ok(
      (entry?.description ?? '').trim() !== '',
      `selvage.peer.${index} has no description`,
    );
  }
  for (const peerId of ['p-aaa', 'p-bbb', 'p-ccc', 'p-3d334f']) {
    assert.equal(
      peerColourId(peerId),
      `selvage.peer.${PEER_PALETTE.indexOf(peerColour(peerId) as (typeof PEER_PALETTE)[number])}`,
      `${peerId}'s badge colour is not the colour their caret wears`,
    );
  }
});

test('the view lists peers, or which note stands in when there is nothing to list', () => {
  const ada = { peerId: 'p-aaa', displayName: 'Ada', role: 'host', path: 'src/a.rs' };
  const peered: RosterRow[] = viewRows({ entries: [ada], followingPeerId: undefined });
  assert.equal(peered.length, 1);
  assert.equal((peered[0] as { kind: string }).kind, 'peer');
  assert.deepEqual(viewRows({ entries: [], followingPeerId: undefined }), [{ kind: 'empty' }]);
  assert.deepEqual(viewRows(undefined), [{ kind: 'nosession' }]);
});

/**
 * Slice 2: wiring, through the built bundle with a fake server in the room.
 *
 * A row in the view is a `TreeItem` carrying the peer id, which is structurally
 * the argument the three existing commands already take — so a view action calls
 * straight through to the landing, the follow and the stop below.
 */

import type { TestContext } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { SelvageEngine } from '../src/engine/engine.ts';
import { sessionUrl } from '../src/engine/urls.ts';
import { landStashedJoin, loadBundle, mirrorWindowDir, testStoragePath } from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { options } from './helpers/session.ts';
import { waitFor } from './helpers/wait.ts';

const HERE = resolve(import.meta.dirname, '..');
const PATH_A = 'src/a.rs';
const TEXT_A = 'aaa\nbbb\nccc\n';

interface RoomSeat {
  bundle: LoadedExtension;
  server: FakeServer;
  host: SelvageEngine;
  invite: string;
  hostId: string;
  roomFile(path: string): string;
}

/** A room with text in one path, and the bundle joined to it as `Bob`. */
async function seat(t: TestContext): Promise<RoomSeat> {
  const server = await FakeServer.start();
  const host = await SelvageEngine.host(
    server.wsBase,
    'Ada',
    options({ baseUrl: server.wsBase, displayName: 'Ada', reconnect: false }),
  );
  await host.open(PATH_A);
  host.insert(PATH_A, 0, TEXT_A);
  const invite = host.inviteUrl();
  assert.ok(invite !== undefined, 'the host was given no invite link');
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  t.after(async () => {
    await host.disconnect();
    await server.stop();
  });
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob'});
  await landStashedJoin(bundle, storage, host.session().roomId, 'Bob');
  const mirrorRoot = mirrorWindowDir(storage, host.session().roomId);
  return {
    bundle,
    server,
    host,
    invite,
    hostId: host.session().peer.peer_id,
    roomFile: (path: string) => `file://${mirrorRoot}/${path}`,
  };
}

/** Another engine in the room, named `name`, with its caret at `at` in `path`. */
async function peerIn(
  t: TestContext,
  seat_: RoomSeat,
  name: string,
  at: number,
): Promise<SelvageEngine> {
  const peer = await SelvageEngine.join(
    seat_.invite,
    name,
    options({ baseUrl: seat_.server.wsBase, displayName: name, reconnect: false }),
  );
  t.after(async () => {
    await peer.disconnect();
  });
  await peer.open(PATH_A);
  await waitFor(`the peer replica to hold ${PATH_A}`, () =>
    (peer.text(PATH_A) === TEXT_A ? true : false),
  );
  peer.setSelection(PATH_A, { anchor: at, head: at });
  return peer;
}

/** The view's provider, as activation registered it. */
function participantsProvider(bundle: LoadedExtension): {
  getChildren(element?: unknown): unknown[];
  getTreeItem(element: unknown): unknown;
  onDidChangeTreeData(handler: (element: unknown) => void): { dispose(): void };
} {
  const found = (bundle.stub.registered as unknown as {
    treeDataProviders: Array<{ viewId: string; provider: unknown }>;
  }).treeDataProviders.find((entry) => entry.viewId === 'selvage.participants');
  assert.ok(found !== undefined, 'activation registered no selvage.participants view');
  return found.provider as {
    getChildren(element?: unknown): unknown[];
    getTreeItem(element: unknown): unknown;
    onDidChangeTreeData(handler: (element: unknown) => void): { dispose(): void };
  };
}

/** The file-badge provider, as activation registered it. */
function decorationsProvider(bundle: LoadedExtension): {
  provideFileDecoration(uri: unknown): unknown;
  onDidChangeFileDecorations(handler: (uri: unknown) => void): { dispose(): void };
} {
  const providers = (bundle.stub.registered as unknown as {
    fileDecorationProviders: unknown[];
  }).fileDecorationProviders;
  assert.equal(providers.length, 1, 'activation registered no file-badge provider');
  return providers[0] as {
    provideFileDecoration(uri: unknown): unknown;
    onDidChangeFileDecorations(handler: (uri: unknown) => void): { dispose(): void };
  };
}

interface RowNode {
  peerId?: string;
  label?: string;
  description?: string;
  /**
   * The row's hover. The adapter builds it with `MarkdownString().appendText`, so the room's
   * words are plain text rather than markdown a stranger supplied; `markdown` reads it back.
   */
  tooltip?: { value?: string };
  contextValue?: string;
  command?: { command: string; arguments?: unknown[] };
}

/** A row's hover, as the editor receives it: the markdown string the adapter built. */
function markdown(node: RowNode): string {
  return String(node.tooltip?.value ?? '');
}

/**
 * A row's hover as the room's own words. The adapter escapes markdown metacharacters
 * (`appendText`), so a path's `.` and a bracket in a name read back with a backslash in
 * front of them; this is the text a peer's name and path appear as.
 */
function words(node: RowNode): string {
  return markdown(node).replace(/\\(.)/g, '$1');
}

/** A file row's decoration, as the editor would read it: the badge, its hover and its colour. */
interface BadgeNode {
  badge: string;
  tooltip: string;
  color?: { id: string };
}

function viewNodes(bundle: LoadedExtension): RowNode[] {
  const children = participantsProvider(bundle).getChildren();
  assert.ok(Array.isArray(children), 'the view lists rows, not a single answer');
  return children as RowNode[];
}

test('rows for the view are peers, or the one pinned note when there is nothing to list', () => {
  const ada = { peerId: 'p-aaa', displayName: 'Ada', role: 'host', path: 'src/a.rs' };
  const peered: RosterRow[] = viewRows({ entries: [ada], followingPeerId: undefined });
  assert.equal(peered.length, 1);
  assert.equal((peered[0] as { kind: string }).kind, 'peer');
  const require = createRequire(import.meta.url);
  const Module = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string;
  };
  const resolveModule = Module._resolveFilename;
  const stub = resolve(HERE, 'test', 'helpers', 'vscode-stub.cjs');
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? stub : resolveModule(...args);
  let exported: unknown;
  try {
    exported = (require(resolve(HERE, 'dist', 'extension.js')) as { resolveViewRows: unknown })
      .resolveViewRows;
  } finally {
    Module._resolveFilename = resolveModule;
  }
  assert.equal(typeof exported, 'function', 'the bundle exports no view-row resolver');
  const words = exported as (rows: RosterRow[]) => Array<{
    kind: string;
    label?: string;
    command?: string;
  }>;
  assert.deepEqual(words(viewRows({ entries: [], followingPeerId: undefined })), [
    {
      kind: 'note',
      label: 'Selvage: you\'re the only one here — copy the invite link.',
      command: 'selvage.copyInvite',
    },
  ]);
  // No session is no row: the view is empty, which is when the editor draws the welcome the
  // manifest contributes for it. A row here would stand in front of that welcome forever.
  assert.deepEqual(words(viewRows(undefined)), []);
  assert.deepEqual(words(peered).length, 1);
});

test('the view is empty outside a session, where the welcome stands', async (t) => {
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });
  assert.deepEqual(
    (viewNodes(bundle)).map((node) => node.label),
    [],
    'a row of its own would hide the welcome the manifest contributes',
  );
  const seat_ = await seat(t);
  const ada = await waitFor('Ada to list in the view', () => {
    const nodes = viewNodes(seat_.bundle);
    return nodes.length === 1 && nodes[0]?.peerId !== undefined ? nodes : false;
  });
  assert.equal(ada[0]?.label, 'Ada');
});

test('rows render on fabricated presence, naming the file each peer is in', async (t) => {
  const seat_ = await seat(t);
  await peerIn(t, seat_, 'Cy', 5);
  const nodes = await waitFor('Cy to list with their file known', () => {
    const current = viewNodes(seat_.bundle);
    const cy = current.find((node) => node.label === 'Cy');
    return words(cy ?? {}).includes(PATH_A) ? current : false;
  });
  const cy = nodes.find((node) => node.label === 'Cy');
  assert.equal(cy?.description, PATH_A, 'the row does not name the file the peer is in');
  assert.equal(cy?.contextValue, 'selvageParticipant');
  for (const node of nodes) {
    assert.ok(!node.label?.includes('.rs'), 'a path leaked into a row label');
  }
  const ada = nodes.find((node) => node.label === 'Ada');
  assert.equal(ada?.description, 'not in a file yet', 'the host published no caret');
});

test('a peer’s name is plain text in the hover, never markdown to render', async (t) => {
  // A display name is bounded at 32 code units and may otherwise be anything, so this is a
  // legal name. The workbench converts a string `TreeItem.tooltip` to a markdown string and
  // renders it, which would make the name an image request from a stranger; the adapter
  // escapes it to text the way the caret hover beside it already does.
  const seat_ = await seat(t);
  const hostile = '![](http://attacker/l.png)';
  await peerIn(t, seat_, hostile, 5);
  const nodes = await waitFor('the hostile name to list', () => {
    const current = viewNodes(seat_.bundle);
    return current.some((node) => node.label?.startsWith('!')) ? current : false;
  });
  const row = nodes.find((node) => node.label?.startsWith('!'));
  assert.ok(row !== undefined, 'the hostile name is not in the view');
  assert.equal(
    typeof row.tooltip,
    'object',
    `the hover is a string the workbench renders as markdown: ${String(row.tooltip)}`,
  );
  const hover = markdown(row);
  assert.ok(
    hover.includes('\\!\\[\\]\\(http://attacker/l\\.png\\)'),
    `the hover is not the name as plain text: ${hover}`,
  );
  assert.equal(hover.includes('!['), false, `the hover still carries markdown image syntax: ${hover}`);
});

test('a peer in a document is one click away, and a peer in none is not', async (t) => {
  const seat_ = await seat(t);
  const cy = await peerIn(t, seat_, 'Cy', 5);
  const nodes = await waitFor('Cy to list with their file known', () => {
    const current = viewNodes(seat_.bundle);
    const row = current.find((node) => node.label === 'Cy');
    return row?.description === PATH_A ? current : false;
  });
  const cyRow = nodes.find((node) => node.label === 'Cy');
  assert.equal(cyRow?.command?.command, 'selvage.goToParticipant', 'clicking the row does nothing');
  assert.deepEqual(
    cyRow?.command?.arguments,
    [{ peerId: cy.session().peer.peer_id }],
    'the click does not name the peer the row is about',
  );
  const ada = nodes.find((node) => node.label === 'Ada');
  assert.equal(
    ada?.command,
    undefined,
    'a peer in no document was given a click that could not land',
  );
});

test('a rename updates the row in place, and a leave removes it without rebuilding the rest', async (t) => {
  const seat_ = await seat(t);
  const cy = await peerIn(t, seat_, 'Cy', 5);
  await waitFor('Cy to list with their file known', () => {
    const current = viewNodes(seat_.bundle);
    return current.some((node) => words(node).includes(PATH_A)) ? true : false;
  });
  const provider = participantsProvider(seat_.bundle);
  const fired: unknown[] = [];
  provider.onDidChangeTreeData((element) => {
    fired.push(element);
  });
  const before = viewNodes(seat_.bundle);
  const adaBefore = before.find((node) => node.label === 'Ada');
  await cy.rename('Cy2');
  await waitFor('the rename to reach the row', () => {
    const current = viewNodes(seat_.bundle);
    return current.some((node) => node.label === 'Cy2') ? true : false;
  });
  const after = viewNodes(seat_.bundle);
  assert.equal(
    after.find((node) => node.label === 'Ada'),
    adaBefore,
    'a rename rebuilt rows it had no business touching',
  );
  assert.ok(
    fired.length > 0 && fired.every((element) => element !== undefined),
    'a rename refreshed the whole tree instead of the changed row',
  );
  fired.length = 0;
  const cyBefore = after.find((node) => node.label === 'Cy2');
  await cy.disconnect();
  await waitFor('Cy to leave the view', () => {
    const current = viewNodes(seat_.bundle);
    return current.length === 1 && current[0]?.label === 'Ada' ? true : false;
  });
  const remaining = viewNodes(seat_.bundle);
  assert.equal(remaining.find((node) => node.label === 'Ada'), adaBefore);
  assert.ok(
    fired.some((element) => element === undefined),
    'a leave never refreshed the tree it removed the row from',
  );
  assert.ok(cyBefore !== undefined && !remaining.includes(cyBefore));
});

test('a row action calls through to go, follow and stop', async (t) => {
  const seat_ = await seat(t);
  const { bundle } = seat_;
  // A held document, as the editor would stage it: the landing moves a caret the test
  // can read, rather than opening anything.
  const uri = bundle.stub.Uri.parse(seat_.roomFile(PATH_A));
  const document = {
    uri,
    eol: 1,
    isDirty: false,
    getText: () => TEXT_A,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    offsetAt: (position: number | { character: number }) =>
      (typeof position === 'number' ? position : position.character) as number,
    save: () => Promise.resolve(true),
  };
  const editor = {
    document,
    selection: { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } },
    revealed: [] as Array<{ range: unknown; kind: unknown }>,
    setDecorations: () => undefined,
    revealRange(range: unknown, kind: unknown) {
      (this as { revealed: Array<{ range: unknown; kind: unknown }> }).revealed.push({ range, kind });
    },
  };
  bundle.stub.window.activeTextEditor = editor;
  bundle.stub.window.visibleTextEditors = [editor];
  bundle.stub.fire('openTextDocument', document);
  seat_.host.setSelection(PATH_A, { anchor: 5, head: 5 });
  const adaRow = await waitFor('Ada to list with their file known', () => {
    const current = viewNodes(bundle);
    const ada = current.find((node) => node.label === 'Ada');
    return words(ada ?? {}).includes(PATH_A) ? ada : false;
  });
  editor.selection = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } };
  await bundle.stub.commands.executeCommand('selvage.goToParticipant', adaRow);
  await waitFor('the row go-to to land at the host caret', () => {
    const active = (editor.selection as { active: { character: number } }).active;
    return active.character === 5 ? true : false;
  });
  // The row's own click, as the TreeItem carries it: the same landing, reached the way a
  // single click on the row reaches it rather than the way the palette's row action does.
  assert.equal(adaRow.command?.command, 'selvage.goToParticipant', 'the row is not clickable');
  editor.selection = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } };
  await bundle.stub.commands.executeCommand(
    adaRow.command.command,
    ...(adaRow.command.arguments ?? []),
  );
  await waitFor('a click on the row to land at the host caret', () => {
    const active = (editor.selection as { active: { character: number } }).active;
    return active.character === 5 ? true : false;
  });
  await bundle.stub.commands.executeCommand('selvage.followParticipant', adaRow);
  await waitFor('the row follow to raise the indicator', () =>
    bundle.stub.registered.statusBarItems.some(
      (item) =>
        item.command === 'selvage.stopFollowing' &&
        (item as { disposed?: boolean }).disposed !== true &&
        item.text.includes('Ada'),
    )
      ? true
      : false,
  );
  await bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the stop to take the indicator down', () =>
    bundle.stub.registered.statusBarItems.every(
      (item) =>
        item.command !== 'selvage.stopFollowing' ||
        (item as { disposed?: boolean }).disposed === true,
    )
      ? true
      : false,
  );
});

test('a peer file wears their initials in their colour until they leave', async (t) => {
  const seat_ = await seat(t);
  const cy = await peerIn(t, seat_, 'Cy', 5);
  const badges = decorationsProvider(seat_.bundle);
  const uri = seat_.bundle.stub.Uri.parse(seat_.roomFile(PATH_A));
  const badge = await waitFor('the peer file to badge', () => {
    const current = badges.provideFileDecoration(uri) as BadgeNode | undefined;
    return current?.badge === 'Cy' ? current : false;
  });
  assert.equal(badge.tooltip, 'Cy is here');
  assert.equal(
    badge.color?.id,
    peerColourId(cy.session().peer.peer_id),
    'the badge is not drawn in the colour the peer\u2019s caret wears',
  );
  const fired: unknown[] = [];
  badges.onDidChangeFileDecorations((changed) => {
    fired.push(String(changed));
  });
  await cy.disconnect();
  await waitFor('the badge to lift when they leave', () =>
    (badges.provideFileDecoration(uri) as unknown) === undefined ? true : false,
  );
  assert.ok(
    fired.some((changed) => String(changed).endsWith(PATH_A)),
    'the badge lifted without telling the tree which file changed',
  );
});

test('a second peer in the file turns the badge into a count and drops the colour', async (t) => {
  const seat_ = await seat(t);
  await peerIn(t, seat_, 'Cy', 5);
  const badges = decorationsProvider(seat_.bundle);
  const uri = seat_.bundle.stub.Uri.parse(seat_.roomFile(PATH_A));
  const before = await waitFor('the file to wear one peer\u2019s badge', () => {
    const current = badges.provideFileDecoration(uri) as BadgeNode | undefined;
    return current?.badge === 'Cy' ? current : false;
  });
  assert.ok(before.color !== undefined, 'the single-peer badge claimed no colour');
  const fired: string[] = [];
  badges.onDidChangeFileDecorations((changed) => {
    fired.push(String(changed));
  });
  await peerIn(t, seat_, 'Bo', 6);
  const after = await waitFor('the shared file to badge the count', () => {
    const current = badges.provideFileDecoration(uri) as BadgeNode | undefined;
    return current?.badge === '2' ? current : false;
  });
  assert.equal(after.color, undefined, 'one peer\u2019s colour claimed a file two peers are in');
  assert.ok(after.tooltip.includes('Bo') && after.tooltip.endsWith('are here'));
  assert.ok(
    fired.some((changed) => changed.endsWith(PATH_A)),
    'the badge changed without telling the tree which file changed',
  );
});

test('two peers sharing a name badge their file with the count, not one dot', async (t) => {
  const seat_ = await seat(t);
  await peerIn(t, seat_, 'Cy', 5);
  await peerIn(t, seat_, 'Cy', 6);
  const badges = decorationsProvider(seat_.bundle);
  const uri = seat_.bundle.stub.Uri.parse(seat_.roomFile(PATH_A));
  const badge = await waitFor('the shared file to badge the count', () => {
    const current = badges.provideFileDecoration(uri) as { badge?: string } | undefined;
    return current?.badge === '2' ? (current as { badge: string; tooltip: string }) : false;
  });
  assert.ok(
    badge.tooltip.includes('Cy (') && badge.tooltip.endsWith('are here'),
    `two Adas collapsed into one name: ${badge.tooltip}`,
  );
});
/** The bundle's pure helpers, read off the built bundle like the invite tests do. */
function bundleExports(): {
  parsePageLink: (text: string) => { room: string; token: string; server?: string } | undefined;
} {
  const require = createRequire(import.meta.url);
  const Module = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string;
  };
  const resolveModule = Module._resolveFilename;
  const stub = resolve(HERE, 'test', 'helpers', 'vscode-stub.cjs');
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? stub : resolveModule(...args);
  try {
    return require(resolve(HERE, 'dist', 'extension.js')) as {
      parsePageLink: (text: string) => { room: string; token: string; server?: string } | undefined;
    };
  } finally {
    Module._resolveFilename = resolveModule;
  }
}

test('a presence path outside the grant badges nothing, nowhere', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  bundle.activate({
    subscriptions: [],
    globalState: bundle.stub.globalState,
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host room to open', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open'))
      ? true
      : false,
  );
  await bundle.stub.commands.executeCommand('selvage.copyInvite');
  const page = bundleExports().parsePageLink(bundle.stub.registered.clipboard);
  assert.ok(page !== undefined, 'the host copied no invite link');
  const wire = sessionUrl(page.server ?? server.wsBase, page.room, page.token);
  const mallory = await SelvageEngine.join(
    wire,
    'Mallory',
    options({ baseUrl: server.wsBase, displayName: 'Mallory', reconnect: false }),
  );
  t.after(async () => {
    await mallory.disconnect();
  });
  const badges = decorationsProvider(bundle);
  const fired: string[] = [];
  badges.onDidChangeFileDecorations((changed) => {
    fired.push(String(changed));
  });
  // A peer names its presence path, so it can name one outside the room: the row
  // still says what presence said, but no file anywhere wears a badge for it.
  mallory.setSelection('../evil', { anchor: 0, head: 0 });
  await waitFor('the hostile path to reach the view', () =>
    viewNodes(bundle).some((node) => words(node).includes('evil')) ? true : false,
  );
  const folder = bundle.stub.Uri.parse('file:///workspace');
  const escaped = bundle.stub.Uri.joinPath(folder, '..', 'evil');
  assert.equal(
    badges.provideFileDecoration(escaped) as unknown,
    undefined,
    'a presence path escaped the room onto a real file row',
  );
  assert.ok(
    fired.every((changed) => !changed.endsWith('/evil')),
    'a presence path escaped the room onto a real file row',
  );
});


test('hosting an empty room retires the welcome row at once', async (t) => {
  const server = await FakeServer.start();
  t.after(async () => {
    await server.stop();
  });
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });
  assert.deepEqual(
    viewNodes(bundle).map((node) => node.label),
    [],
    'the session-less view has rows of its own',
  );
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  await waitFor('the host room to open', () =>
    bundle.stub.registered.information.some((message) => message.includes('is open'))
      ? true
      : false,
  );
  assert.deepEqual(
    viewNodes(bundle).map((node) => node.label),
    ["Selvage: you're the only one here — copy the invite link."],
  );
});

test('following marks the row at once, and leaves the file it names alone', async (t) => {
  const seat_ = await seat(t);
  const { bundle } = seat_;
  const adaRow = await waitFor('Ada to list', () => {
    const current = viewNodes(bundle);
    return current.length === 1 && current[0]?.peerId !== undefined ? current[0] : false;
  });
  assert.equal(adaRow.description, 'not in a file yet', 'the row lost what it said about Ada');
  await bundle.stub.commands.executeCommand('selvage.followParticipant', adaRow);
  await waitFor('the follow to mark the row', () =>
    viewNodes(bundle).find((node) => node.peerId === adaRow.peerId)?.contextValue ===
    'selvageParticipantFollowing'
      ? true
      : false,
  );
  const followed = viewNodes(bundle).find((node) => node.peerId === adaRow.peerId);
  assert.equal(followed?.label, '$(eye) Ada', 'the followed row is not marked as the one followed');
  assert.equal(
    followed?.description,
    'not in a file yet',
    'the follow state displaced what the row says about where Ada is',
  );
  await bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the stop to unmark the row', () =>
    viewNodes(bundle).find((node) => node.peerId === adaRow.peerId)?.contextValue ===
    'selvageParticipantAway'
      ? true
      : false,
  );
  assert.equal(
    viewNodes(bundle).find((node) => node.peerId === adaRow.peerId)?.label,
    'Ada',
    'the eye glyph survived the stop',
  );
});

test('a window with no session is invited to host, and the extension carries its own mark', () => {
  // The one surface a stranger meets before any session exists. It is the view's welcome, which
  // the editor draws only while the view has no rows at all — the page `describeParticipants`
  // and `resolveViewRows` leave empty outside a session.
  const manifest = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')) as {
    icon?: string;
    contributes?: {
      commands?: Array<{ command: string; title: string }>;
      viewsWelcome?: Array<{ view: string; contents: string; when?: string }>;
    };
  };
  const welcome = (manifest.contributes?.viewsWelcome ?? []).find(
    (entry) => entry.view === 'selvage.participants',
  );
  assert.ok(welcome !== undefined, 'the view has no welcome for a window with no session');
  assert.ok(
    welcome.contents.includes('Share a folder with a friend'),
    'the welcome does not say what hosting a session is for',
  );
  // The button is the command's own title rather than a second phrase for it: a person who
  // clicks it lands on the palette entry of the same name.
  const titles = new Map((manifest.contributes?.commands ?? []).map((c) => [c.command, c.title]));
  for (const command of ['selvage.host', 'selvage.join']) {
    const title = titles.get(command);
    assert.ok(title !== undefined, `${command} is not a contributed command`);
    assert.ok(
      welcome.contents.includes(`[${title}](command:${command})`),
      `the welcome offers no ${command} link under its own title`,
    );
  }
  // An icon path is a promise about a file in the package: assert the file is there, so a
  // rename cannot leave the Extensions view pointing at nothing.
  assert.ok(manifest.icon !== undefined, 'the extension contributes no icon');
  assert.ok(
    existsSync(resolve(HERE, manifest.icon)),
    `the manifest's icon names no file: ${manifest.icon}`,
  );
});

test('the manifest contributes the view, with the same actions on the row as buttons', () => {
  const manifest = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')) as {
    contributes?: {
      commands?: Array<{ command: string; icon?: string }>;
      views?: { explorer?: Array<{ id: string; name?: string }> };
      menus?: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    };
  };
  const contributed = manifest.contributes ?? {};
  assert.ok(
    (contributed.views?.explorer ?? []).some(
      (view) => view.id === 'selvage.participants' && view.name === 'Selvage: Participants',
    ),
    'the manifest contributes no Selvage: Participants view',
  );
  const menus = contributed.menus?.['view/item/context'] ?? [];
  const commands = contributed.commands ?? [];
  const ids = new Set(commands.map((entry) => entry.command));
  const viewMenus = menus.filter((entry) => (entry.when ?? '').includes('selvage.participants'));
  // Two groups, one per peer action: the row's own buttons (`inline`) and the menu an
  // item's context menu opens. Anything else would be an action a user cannot reach.
  const inGroup = (name: string): string[] =>
    viewMenus
      .filter((entry) => (entry.group ?? '').split('@')[0] === name)
      .map((entry) => entry.command)
      .sort();
  const actions = ['selvage.followParticipant', 'selvage.goToParticipant', 'selvage.stopFollowing'].sort();
  assert.deepEqual(inGroup('inline'), actions, 'the peer rows carry no per-peer buttons');
  assert.deepEqual(inGroup('1_selvage'), actions, 'the peer rows lost their menu actions');
  assert.deepEqual(
    [...new Set(viewMenus.map((entry) => entry.command))].sort(),
    actions,
    'a view action the palette cannot reach, or a contributed one that is not a command',
  );
  const titleMenus = (contributed.menus?.['view/title'] ?? []).filter((entry) =>
    (entry.when ?? '').includes('selvage.participants'),
  );
  assert.deepEqual(
    titleMenus.map((entry) => entry.command),
    ['selvage.stopFollowing', 'selvage.copyInvite'],
    'the view menu reaches past the commands the palette has',
  );
  assert.equal(
    titleMenus.find((entry) => entry.command === 'selvage.stopFollowing')?.when,
    'view == selvage.participants && selvage.following',
    'the follow-stop title button is not gated on the follow context key',
  );
  for (const entry of viewMenus) {
    assert.ok(ids.has(entry.command), `${entry.command} is no contributed command`);
  }
  const whenOf = (command: string, group: string): string => {
    const entry = viewMenus.find(
      (item) => item.command === command && (item.group ?? '').split('@')[0] === group,
    );
    assert.ok(entry !== undefined, `${command} has no ${group} row action`);
    return entry.when ?? '';
  };
  const WHEN: Record<string, string> = {
    'selvage.goToParticipant':
      'view == selvage.participants && (viewItem == selvageParticipant || viewItem == selvageParticipantFollowing)',
    'selvage.followParticipant': 'view == selvage.participants && viewItem == selvageParticipant',
    'selvage.stopFollowing':
      'view == selvage.participants && viewItem == selvageParticipantFollowing',
  };
  for (const command of Object.keys(WHEN)) {
    assert.equal(whenOf(command, 'inline'), WHEN[command], `${command}'s button shows on the wrong rows`);
    assert.equal(
      whenOf(command, '1_selvage'),
      WHEN[command],
      `${command}'s menu action shows on the wrong rows`,
    );
  }
  // A tree row renders a command's button from its icon: a command with none is a button
  // with no glyph, so the three the row carries name one apiece.
  const icons = new Map(commands.map((entry) => [entry.command, entry.icon]));
  assert.equal(icons.get('selvage.goToParticipant'), '$(go-to-file)');
  assert.equal(icons.get('selvage.followParticipant'), '$(eye)');
  assert.equal(icons.get('selvage.stopFollowing'), '$(eye-closed)');
});
