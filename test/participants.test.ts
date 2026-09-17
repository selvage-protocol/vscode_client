/**
 * The Participants view's rows and file badges, without an editor.
 *
 * Slice 1: `describeParticipants` turns membership + presence into rows that keep
 * name + state + actions only — no path text on the row, per the owner refinement —
 * and `badgeFiles` marks the room files peers are in. Both are pure, so these tests
 * import `src/adapter/participants.ts` directly. Wiring (registration, refresh,
 * actions) is slice 2, through the built bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { peerColour } from '../src/bridge/cursors.ts';
import {
  badgeFiles,
  describeParticipants,
  viewRows,
} from '../src/bridge/participants.ts';
import type { RosterRow } from '../src/bridge/participants.ts';

const ADA = { peerId: 'p-aaa', displayName: 'Ada', role: 'host', path: 'src/a.rs' };
const BO = { peerId: 'p-bbb', displayName: 'Bo', role: 'guest', path: 'src/b.rs' };

test('a row names the peer and carries their marker colour, with no path on it', () => {
  const [row] = describeParticipants([ADA], undefined);
  assert.equal(row?.label, 'Ada');
  assert.equal(row?.colour, peerColour('p-aaa'));
  assert.equal(row?.description, '');
  assert.ok(row?.tooltip.includes('src/a.rs'), 'the path survives in the hover, not on the row');
  assert.ok(!JSON.stringify([row?.label, row?.description]).includes('src/a.rs'));
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

test('the followed peer reads Following and stops showing follow', () => {
  const rows = describeParticipants([ADA, BO], 'p-bbb');
  assert.equal(rows.find((row) => row.peerId === 'p-bbb')?.description, 'Following');
  assert.equal(
    rows.find((row) => row.peerId === 'p-bbb')?.contextValue,
    'selvageParticipantFollowing',
  );
  assert.equal(rows.find((row) => row.peerId === 'p-aaa')?.contextValue, 'selvageParticipant');
});

test('a peer in no document reads as away, with no navigation', () => {
  const [row] = describeParticipants(
    [{ peerId: 'p-ccc', displayName: '', role: 'guest' }],
    undefined,
  );
  assert.equal(row?.label, 'p-ccc', 'a blank name falls back to the id, as the caret label does');
  assert.equal(row?.description, 'No open document');
  assert.equal(row?.contextValue, 'selvageParticipantAway');
  assert.equal(row?.canNavigate, false);
});

test('one peer in a file badges it; several badge the count, with names in the hover', () => {
  assert.deepEqual(badgeFiles([{ uri: 'file:///room/src/a.rs', names: ['Ada'] }]), [
    { uri: 'file:///room/src/a.rs', badge: '●', tooltip: 'Ada is here' },
  ]);
  assert.deepEqual(
    badgeFiles([{ uri: 'file:///room/src/a.rs', names: ['Bo', 'Ada'] }]),
    [{ uri: 'file:///room/src/a.rs', badge: '2', tooltip: 'Ada, Bo are here' }],
  );
  assert.deepEqual(badgeFiles([{ uri: 'file:///room/src/a.rs', names: [] }]), []);
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
import { readFileSync } from 'node:fs';
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
  await bundle.stub.commands.executeCommand('selvage.join', { invite, displayName: 'Bob' });
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
  tooltip?: string;
  contextValue?: string;
  command?: { command: string };
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
  assert.deepEqual(words(viewRows(undefined)), [
    { kind: 'note', label: 'Selvage: join a session first.' },
  ]);
  assert.deepEqual(words(peered).length, 1);
});

test('activation shows the join-first row outside a session, and peers once seated', async (t) => {
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.activate({ subscriptions: [], globalState: bundle.stub.globalState });
  t.after(() => {
    bundle.deactivate();
  });
  assert.deepEqual(
    (viewNodes(bundle)).map((node) => node.label),
    ['Selvage: join a session first.'],
  );
  const seat_ = await seat(t);
  const ada = await waitFor('Ada to list in the view', () => {
    const nodes = viewNodes(seat_.bundle);
    return nodes.length === 1 && nodes[0]?.peerId !== undefined ? nodes : false;
  });
  assert.equal(ada[0]?.label, 'Ada');
});

test('rows render on fabricated presence, with no path text on the row', async (t) => {
  const seat_ = await seat(t);
  await peerIn(t, seat_, 'Cy', 5);
  const nodes = await waitFor('Cy to list with their file known', () => {
    const current = viewNodes(seat_.bundle);
    const cy = current.find((node) => node.label === 'Cy');
    return cy?.tooltip?.includes(PATH_A) ? current : false;
  });
  const cy = nodes.find((node) => node.label === 'Cy');
  assert.equal(cy?.description, '');
  assert.equal(cy?.contextValue, 'selvageParticipant');
  for (const node of nodes) {
    assert.ok(!node.label?.includes('.rs'), 'a path leaked into a row label');
    assert.ok(!node.description?.includes('.rs'), 'a path leaked into a row description');
  }
  const ada = nodes.find((node) => node.label === 'Ada');
  assert.equal(ada?.description, 'No open document', 'the host published no caret');
});

test('a rename updates the row in place, and a leave removes it without rebuilding the rest', async (t) => {
  const seat_ = await seat(t);
  const cy = await peerIn(t, seat_, 'Cy', 5);
  await waitFor('Cy to list with their file known', () => {
    const current = viewNodes(seat_.bundle);
    return current.some((node) => node.tooltip?.includes(PATH_A)) ? true : false;
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
    return ada?.tooltip?.includes(PATH_A) ? ada : false;
  });
  editor.selection = { anchor: { line: 0, character: 0 }, active: { line: 0, character: 0 } };
  await bundle.stub.commands.executeCommand('selvage.goToParticipant', adaRow);
  await waitFor('the row go-to to land at the host caret', () => {
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

test('a peer file wears their badge until they leave', async (t) => {
  const seat_ = await seat(t);
  const cy = await peerIn(t, seat_, 'Cy', 5);
  const badges = decorationsProvider(seat_.bundle);
  const uri = seat_.bundle.stub.Uri.parse(seat_.roomFile(PATH_A));
  await waitFor('the peer file to badge', () => {
    const badge = badges.provideFileDecoration(uri) as { badge?: string } | undefined;
    return badge?.badge === '●' ? true : false;
  });
  const badge = badges.provideFileDecoration(uri) as { badge: string; tooltip: string };
  assert.equal(badge.tooltip, 'Cy is here');
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
    viewNodes(bundle).some((node) => node.tooltip?.includes('evil')) ? true : false,
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


test('hosting an empty room retires the join-first row at once', async (t) => {
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
    ['Selvage: join a session first.'],
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

test('following and stopping mark the row at once, with no frame to wait for', async (t) => {
  const seat_ = await seat(t);
  const { bundle } = seat_;
  const adaRow = await waitFor('Ada to list', () => {
    const current = viewNodes(bundle);
    return current.length === 1 && current[0]?.peerId !== undefined ? current[0] : false;
  });
  await bundle.stub.commands.executeCommand('selvage.followParticipant', adaRow);
  await waitFor('the follow to mark the row', () =>
    viewNodes(bundle).find((node) => node.label === 'Ada')?.description === 'Following'
      ? true
      : false,
  );
  await bundle.stub.commands.executeCommand('selvage.stopFollowing');
  await waitFor('the stop to unmark the row', () =>
    viewNodes(bundle).find((node) => node.label === 'Ada')?.description !== 'Following'
      ? true
      : false,
  );
});

test('the manifest contributes the view, with actions on the commands it already has', () => {
  const manifest = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8')) as {
    contributes?: {
      commands?: Array<{ command: string }>;
      views?: { explorer?: Array<{ id: string; name?: string }> };
      menus?: Record<string, Array<{ command: string; when?: string }>>;
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
  const ids = new Set((contributed.commands ?? []).map((entry) => entry.command));
  const viewMenus = menus.filter((entry) => (entry.when ?? '').includes('selvage.participants'));
  assert.deepEqual(
    viewMenus.map((entry) => entry.command).sort(),
    ['selvage.followParticipant', 'selvage.goToParticipant', 'selvage.stopFollowing'],
    'a view action the palette cannot reach, or a contributed one that is not a command',
  );
  const titleMenus = (contributed.menus?.['view/title'] ?? []).filter((entry) =>
    (entry.when ?? '').includes('selvage.participants'),
  );
  assert.deepEqual(
    titleMenus.map((entry) => entry.command),
    ['selvage.copyInvite'],
    'the view menu reaches past the commands the palette has',
  );
  for (const entry of viewMenus) {
    assert.ok(ids.has(entry.command), `${entry.command} is no contributed command`);
  }
  const whenOf = (command: string): string => {
    const entry = viewMenus.find((item) => item.command === command);
    assert.ok(entry !== undefined, `${command} has no row action`);
    return entry.when ?? '';
  };
  assert.equal(
    whenOf('selvage.goToParticipant'),
    'view == selvage.participants && (viewItem == selvageParticipant || viewItem == selvageParticipantFollowing)',
  );
  assert.equal(
    whenOf('selvage.followParticipant'),
    'view == selvage.participants && viewItem == selvageParticipant',
  );
  assert.equal(
    whenOf('selvage.stopFollowing'),
    'view == selvage.participants && viewItem == selvageParticipantFollowing',
  );
});
