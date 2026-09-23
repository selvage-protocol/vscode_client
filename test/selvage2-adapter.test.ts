/**
 * The extension as the third adapter of a `selvage/2` room: the version a host mints at, the
 * version a link makes a join speak, the fragment that carries the room's two keys through the
 * page link a host copies, and the read-only documents `§13.4`'s `viewer` gets.
 *
 * Everything here is the built extension with the editor API stubbed, over the fake server —
 * which seats a version-2 connection when it is told to, and relays the sealed frames it cannot
 * read. What that covers is the adapter's own decisions; `test/relay-selvaged.test.ts` and
 * `test/selvage2-selvaged.test.ts` are the same paths over a real `selvaged`.
 *
 * A version is not visible in any reply, so each "which version did this speak" case is read
 * from the hello the server recorded (`FakeServer.hellos`) rather than inferred: a room that
 * seats at all is a room whose hello was accepted, and the recorded string is the evidence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { nodeCrypto } from '../src/node/crypto.ts';
import { encodeKey, mintSessionKey } from '../src/engine/sealed.ts';
import type { SessionKeypair } from '../src/engine/sealed.ts';
import { RelaySession } from '../src/engine/relay.ts';
import { baseOf } from './helpers/base.ts';
import {
  BUNDLE,
  ROOT,
  landStashedJoin,
  loadBundle,
  testStoragePath,
  waitForMirrorFiles,
} from './helpers/bundle.ts';
import type { LoadedExtension } from './helpers/bundle.ts';
import { FakeServer } from './helpers/fake-server.ts';
import { waitFor } from './helpers/wait.ts';

/** The version string, spelled as the wire spells it. */
const V2 = 'selvage/2';
const V1 = 'selvage/1';

/** The bundle's pure invite helpers, and the two surfaces the viewer case drives. */
interface AdapterExports {
  wireVersionOf(invite: string): string;
  hostsVersion2(configured: unknown): boolean;
  fragmentOf(invite: string): string;
  fragmentKeys(fragment: string): { roomKey?: string; hostKey?: string };
  wireInviteFor(invite: string): string;
  buildPageLink(
    serverBase: string,
    room: string,
    token: string,
    keys?: { roomKey?: string; hostKey?: string },
  ): string;
  parsePageLink(text: string):
    | { room: string; token: string; origin: string; fragment: string; roomKey?: string; hostKey?: string }
    | undefined;
  HostKeyStore: new (state: Memento, seed: Uint8Array) => {
    load(): { hostSeed: Uint8Array; issued: number } | undefined;
    save(persisted: { hostSeed: Uint8Array; issued: number }): void;
  };
  Session: new (engine: unknown, options?: { mirror?: unknown; invite?: string }) => {
    role(): string;
    dispose(options?: { keepMirror?: boolean }): void;
  };
}

/** The memento the store is handed, as `globalState` is: `get`, `update` and nothing else. */
interface Memento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

/**
 * The bundle's own exports, for the cases that are about one function or one class rather than
 * about a window: `loadBundle` hands back the activated extension and the stub, and these are
 * what the same module exports under them. The `vscode` specifier is answered by the stub for
 * this call only, as `loadBundle` does for its own.
 */
function adapterExports(): AdapterExports {
  const require = createRequire(import.meta.url);
  const stub = resolve(ROOT, 'test', 'helpers', 'vscode-stub.cjs');
  const Module = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string;
  };
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = (...args: unknown[]): string =>
    args[0] === 'vscode' ? stub : resolveFilename(...args);
  try {
    return require(BUNDLE) as AdapterExports;
  } finally {
    Module._resolveFilename = resolveFilename;
  }
}

/** The bundle, activated with its own storage, with everything it recorded cleared. */
function activated(t: TestContext): { bundle: LoadedExtension; storage: string; adapter: AdapterExports } {
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
  return { bundle, storage, adapter: bundle as unknown as AdapterExports };
}

/**
 * A second live window: a new module, so its session state starts empty while the first
 * window's does not. Command dispatch reaches the latest registration, so the first window's
 * commands are done being used once this one activates.
 */
function freshActivated(t: TestContext): {
  bundle: LoadedExtension;
  storage: string;
  adapter: AdapterExports;
} {
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve(BUNDLE)];
  return activated(t);
}

/** A room's page link, as a host's clipboard carries it, with the two keys of `§5.1` split out. */
function keysOf(link: string): { room: string; token: string; roomKey?: string; hostKey?: string } {
  const url = new URL(link);
  const room = url.searchParams.get('room') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const keys = new Map(
    url.hash
      .replace(/^#/, '')
      .split('&')
      .map((part) => [part.split('=')[0] ?? '', part.split('=').slice(1).join('=')]),
  );
  return {
    room,
    token,
    ...(keys.get('k') === undefined ? {} : { roomKey: keys.get('k') as string }),
    ...(keys.get('h') === undefined ? {} : { hostKey: keys.get('h') as string }),
  };
}

// --- what a version is decided by ------------------------------------------------

test('the version an invite asks for is the one its fragment names', () => {
  const { wireVersionOf, fragmentOf, fragmentKeys } = adapterExports();

  // `§5.1`: a fragment with both keys is a version-2 invite, and everything else is version 1.
  for (const [invite, wanted] of [
    [`ws://host/session?room=r&token=t#k=${'A'.repeat(43)}&h=${'B'.repeat(43)}`, V2],
    [`https://host/?room=r&token=t#k=${'A'.repeat(43)}&h=${'B'.repeat(43)}`, V2],
    ['https://host/?room=r&token=t', V1],
    ['ws://host/session?room=r&token=t', V1],
    ['https://host/?room=r&token=t#', V1],
    [`https://host/?room=r&token=t#k=${'A'.repeat(43)}`, V1],
    [`https://host/?room=r&token=t#h=${'B'.repeat(43)}`, V1],
    ['https://host/?room=r&token=t#debug=1', V1],
    // A fragment that names the two keys in the other order is still a version-2 invite: what
    // `§5.1` fixes is the names, and the order a host writes them in is its business.
    [`https://host/?room=r&token=t#h=${'B'.repeat(43)}&k=${'A'.repeat(43)}`, V2],
    ['', V1],
  ] as const) {
    assert.equal(wireVersionOf(invite), wanted, `${invite} was read as ${wireVersionOf(invite)}`);
  }

  assert.equal(fragmentOf('ws://host/session?room=r&token=t'), '');
  assert.equal(fragmentOf('https://host/?room=r&token=t#k=a&h=b'), '#k=a&h=b');
  assert.deepEqual(fragmentKeys('#k=a&h=b'), { roomKey: 'a', hostKey: 'b' });
  assert.deepEqual(fragmentKeys('k=a'), { roomKey: 'a' });
  assert.deepEqual(fragmentKeys('#h=b&unknown=c'), { hostKey: 'b' });
  assert.deepEqual(fragmentKeys(''), {});
});

test('a host mints at version 1 unless its own setting says version 2', () => {
  const { hostsVersion2 } = adapterExports();
  // Unset, and anything that is not version 2, is `selvage/1`: `selvaged --serve-version-2` is
  // not the server's default yet, and a client that minted version 2 by default would fail
  // against every released server.
  for (const configured of [undefined, null, '', 'selvage/1', '1', 'true', 1, true, 'selvage']) {
    assert.equal(hostsVersion2(configured), false, `${String(configured)} asked for version 2`);
  }
  for (const configured of [V2, '2', 2]) {
    assert.equal(hostsVersion2(configured), true, `${String(configured)} did not ask for version 2`);
  }
});

test('the wire URL an invite joins on never carries the fragment', () => {
  const { wireInviteFor } = adapterExports();
  const fragment = `#k=${'A'.repeat(43)}&h=${'B'.repeat(43)}`;
  const wire = `ws://host:8080/session?room=r-1&token=tok`;

  // §5.1: the fragment is the one part of a link a user agent never sends. A version-1 engine
  // reads the whole of what it is handed as a query, so a fragment left on glues into the token.
  assert.equal(wireInviteFor(`${wire}${fragment}`), wire);
  assert.equal(wireInviteFor(wire), wire);
  // The page form resolves to the same wire URL, its fragment stripped with the rest. The page's
  // own scheme is what the socket speaks: an `https://` page is a `wss://` server.
  assert.equal(wireInviteFor(`https://host:8080/?room=r-1&token=tok${fragment}`), `wss://host:8080/session?room=r-1&token=tok`);
  assert.equal(wireInviteFor('https://host:8080/?room=r-1&token=tok'), `wss://host:8080/session?room=r-1&token=tok`);
  assert.equal(wireInviteFor('http://host:8080/?room=r-1&token=tok'), wire);
  // An unknown parameter stays ignored, and the base is the engine's own reading of one.
  assert.equal(
    wireInviteFor('http://host:8080/?room=r-1&token=tok&server=ws%3A%2F%2Fother%3A8080'),
    wire,
  );
  for (const invite of [`${wire}${fragment}`, `https://host:8080/?room=r-1&token=tok${fragment}`]) {
    assert.ok(!wireInviteFor(invite).includes('#'), `${invite} kept its fragment`);
  }
});

test('the page link a host copies is the same room, token and two keys as its wire invite', () => {
  const { buildPageLink, parsePageLink } = adapterExports();
  const keys = { roomKey: 'A'.repeat(43), hostKey: 'B'.repeat(43) };

  const link = buildPageLink('wss://edit.example', 'r-1', 'tok', keys);
  assert.equal(link, `https://edit.example/?room=r-1&token=tok#k=${keys.roomKey}&h=${keys.hostKey}`);
  // The round trip is the property, not the shape: what a host writes back is what a guest
  // reads out again, two keys and all.
  assert.deepEqual(parsePageLink(link), {
    room: 'r-1',
    token: 'tok',
    origin: 'https://edit.example',
    fragment: `#k=${keys.roomKey}&h=${keys.hostKey}`,
    roomKey: keys.roomKey,
    hostKey: keys.hostKey,
  });

  // A `selvage/1` host holds no keys and copies the link it always did.
  assert.equal(buildPageLink('wss://edit.example', 'r-1', 'tok'), 'https://edit.example/?room=r-1&token=tok');
  assert.equal(buildPageLink('wss://edit.example', 'r-1', 'tok', {}), 'https://edit.example/?room=r-1&token=tok');
  // One key is still written: `§5.1` asks for both, and what a link carries is not this
  // builder's to refuse — the version it names is decided by the names, and the keys themselves
  // are checked where they are used.
  assert.equal(
    buildPageLink('wss://edit.example', 'r-1', 'tok', { roomKey: keys.roomKey }),
    `https://edit.example/?room=r-1&token=tok#k=${keys.roomKey}`,
  );
});

// --- what a host mints, and what a link makes a join speak -------------------------

/** The page link a host copied, as a click on its status bar would leave it. */
async function copiedInvite(bundle: LoadedExtension): Promise<string> {
  void bundle.stub.commands.executeCommand('selvage.copyInvite');
  return await waitFor<string>('the host to hand its invite on', () => {
    const clipboard = bundle.stub.registered.clipboard;
    return /^https?:\/\//.test(clipboard) ? clipboard : false;
  });
}

/** A bundle hosting on the fake server at whatever version its setting names. */
async function hosted(
  t: TestContext,
  options: { wireVersion?: string; share?: string } = {},
): Promise<{ bundle: LoadedExtension; server: FakeServer; invite: string }> {
  const server = await FakeServer.start({ serveVersion2: true });
  t.after(async () => {
    await server.stop();
  });
  const { bundle } = activated(t);
  if (options.wireVersion !== undefined) {
    bundle.stub.configure({ wireVersion: options.wireVersion });
  }
  bundle.stub.put('README.md', 'the readme\n');
  if (options.share !== undefined) {
    bundle.stub.put(PATH, options.share);
  }
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  return { bundle, server, invite: await copiedInvite(bundle) };
}

test('a host with no setting mints a version-1 room and hands on a fragment-less link', async (t) => {
  const { server, invite } = await hosted(t);
  // Unset is `selvage/1`, which is what every published client speaks: `selvaged
  // --serve-version-2` is not the server's default yet, and a default of version 2 would fail
  // against every released server.
  assert.deepEqual(server.hellos, [V1], 'a room with no setting is not a version-1 room');
  assert.equal(
    keysOf(invite).roomKey,
    undefined,
    'a version-1 host handed on a fragment it cannot have',
  );
  assert.equal(keysOf(invite).hostKey, undefined);
});

test('a host at selvage/2 mints a version-2 room and hands on the keys in its fragment', async (t) => {
  const { server, invite } = await hosted(t, { wireVersion: V2 });
  assert.deepEqual(server.hellos, [V2], 'the setting did not reach the wire');
  // `§5.1`: the fragment is `k` then `h`, each 32 bytes in base64url without padding, and the
  // page link carries it — a version-2 room has no token-only way in. The link is the same
  // room and the same token as the host's own wire invite, with the fragment on it.
  assert.match(
    invite,
    /\?room=[^&]+&token=[^#]+#[k]=[A-Za-z0-9_-]{43}&h=[A-Za-z0-9_-]{43}$/,
    `the copied link carries no fragment: ${invite}`,
  );
  const keys = keysOf(invite);
  assert.ok(keys.roomKey !== undefined && keys.hostKey !== undefined);
  assert.notEqual(keys.token, '');
  assert.equal(new URL(invite).origin, server.httpBase);
});

test('the page link says the version the fragment names, for the guest as well as the host', async (t) => {
  const { server, invite } = await hosted(t, { wireVersion: V2 });
  const room = keysOf(invite).room;

  // A link without the fragment is a `selvage/1` invite: it joins no version-2 room, and it is
  // not refused either — it is a join that speaks the version every released server seats.
  const token = keysOf(invite).token ?? '';
  const legacy = `http://${new URL(invite).host}/?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`;
  assert.equal(keysOf(legacy).roomKey, undefined);

  // The guest, in its own window. The join reloads onto the room's mirror, and the listing it
  // lands on there is the property that matters: a version-2 room's tree is sealed under the
  // key the fragment carries, so a mirror holding it is a fragment that reached the engine.
  const guest = freshActivated(t);
  await guest.bundle.stub.commands.executeCommand('selvage.join', {
    invite,
    displayName: 'Bob',
  });
  await landStashedJoin(guest.bundle, guest.storage, room, 'Bob');
  await waitForMirrorFiles(guest.storage, room, ['README.md']);
  assert.deepEqual(
    server.hellos,
    [V2, V2],
    `the guest did not speak the version the link named: ${JSON.stringify(server.hellos)}`,
  );
});

test('a fragment-less invite joins a version-1 room as a version-1 connection', async (t) => {
  const { server, invite } = await hosted(t);
  const room = keysOf(invite).room;

  const guest = freshActivated(t);
  await guest.bundle.stub.commands.executeCommand('selvage.join', {
    invite,
    displayName: 'Bob',
  });
  await landStashedJoin(guest.bundle, guest.storage, room, 'Bob');
  await waitForMirrorFiles(guest.storage, room, ['README.md']);
  assert.deepEqual(
    server.hellos,
    [V1, V1],
    `a fragment-less link joined at the wrong version: ${JSON.stringify(server.hellos)}`,
  );
});

test('a version-1 wire invite with a stray hash on it still joins its room', async (t) => {
  const { server, invite } = await hosted(t);
  const room = keysOf(invite).room;
  const token = keysOf(invite).token ?? '';
  // A chat client that appends an anchor, or a paste that kept one: `§5.1` defines no fragment
  // for a version-1 invite, and what a version-1 engine reads is the whole of what it is handed
  // as a query — so a fragment left on would glue into the token and the join would be refused,
  // as a token that is not the room's.
  const wire = `${server.wsBase}/session?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}#debug=1`;

  const guest = freshActivated(t);
  await guest.bundle.stub.commands.executeCommand('selvage.join', {
    invite: wire,
    displayName: 'Bob',
  });
  await landStashedJoin(guest.bundle, guest.storage, room, 'Bob');
  await waitForMirrorFiles(guest.storage, room, ['README.md']);
  assert.deepEqual(server.hellos, [V1, V1], `the stray hash cost the join its version`);
});

test('a version-2 host serves the path the room holds, as it does in a version-1 room', async (t) => {
  const seed = "the host's own copy of a file, read for a peer\n";
  const { invite } = await hosted(t, { wireVersion: V2, share: seed });
  // The second peer is the engine, and it is what reads the served text back: the window is the
  // side that has to notice the hold and read its own working copy for it.
  const guest = await RelaySession.join({ invite, displayName: 'Bob' });
  t.after(() => {
    guest.disconnect();
  });
  await waitFor('the guest to apply the host\'s listing', () => {
    const paths = [...guest.listing()];
    return paths.includes(PATH) ? paths : false;
  });
  // `§13.1`'s step 4: nothing the guest holds counts until a state commits its key.
  await waitFor(
    "the host's state to commit the guest's key",
    () => guest.appliedRole() ?? false,
    { timeoutMs: 15_000, describe: () => guest.sessionInfo().peers },
  );

  guest.open(PATH);
  const served = await waitFor(
    'the host to serve the path the guest holds',
    () => {
      const text = guest.text(PATH);
      return text === seed ? text : false;
    },
    { timeoutMs: 15_000, describe: () => guest.text(PATH) },
  );
  assert.equal(served, seed);
});

// --- §7.1's store ------------------------------------------------------------------

test("a host's key and its issued series are kept where §7.1 asks for them", async (t) => {
  const server = await FakeServer.start({ serveVersion2: true });
  t.after(async () => {
    await server.stop();
  });
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  // The store is read through the state this test owns: the extension host's own memory is what
  // `globalState` is, and what was written to it is the evidence.
  const written = new Map<string, unknown>();
  const memento: Memento = {
    get: <T>(key: string): T | undefined => (written.has(key) ? (written.get(key) as T) : undefined),
    update: (key: string, value: unknown): Promise<void> => {
      written.set(key, value);
      return Promise.resolve();
    },
  };
  bundle.stub.configure({ wireVersion: V2 });
  bundle.activate({
    subscriptions: [],
    globalState: { ...memento, setKeysForSync: () => undefined },
    globalStorageUri: bundle.stub.Uri.file(storage),
  });
  t.after(() => {
    bundle.deactivate();
  });
  bundle.stub.put('README.md', 'the readme\n');
  await bundle.stub.commands.executeCommand('selvage.host', {
    serverUrl: server.wsBase,
    displayName: 'Ada',
  });
  const invite = await copiedInvite(bundle);

  const records = [...written.entries()].filter(([key]) => key.startsWith('selvage.hostKey.'));
  assert.equal(records.length, 1, `the host kept ${records.length} records: ${[...written.keys()].join(', ')}`);
  const [key, value] = records[0] as [string, { seed: string; issued: number }];
  assert.equal(typeof value.seed, 'string');
  assert.ok(Number.isInteger(value.issued) && value.issued >= 1, `issued is ${String(value.issued)}`);

  // The stored seed is the key that signed the state the guest would verify: the `h` of the
  // very invite this host handed on is that seed's public half, and the record is filed under
  // it — so a record is this room's series and no other room's.
  const seed = Buffer.from(value.seed.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  assert.equal(seed.length, 32, 'the stored seed is not a 32-byte key');
  const host = (await mintSessionKey(nodeCrypto, new Uint8Array(seed))) as SessionKeypair;
  assert.equal(keysOf(invite).hostKey, encodeKey(host.public));
  assert.equal(key, `selvage.hostKey.${encodeKey(new Uint8Array(seed))}`);
});

test('the store continues a series for the seed it holds and ignores another host’s', () => {
  const { HostKeyStore } = adapterExports();
  const written = new Map<string, unknown>();
  const memento: Memento = {
    get: <T>(key: string): T | undefined => (written.has(key) ? (written.get(key) as T) : undefined),
    update: (key: string, value: unknown): Promise<void> => {
      written.set(key, value);
      return Promise.resolve();
    },
  };
  const seed = new Uint8Array(32).fill(7);
  const other = new Uint8Array(32).fill(9);

  const store = new HostKeyStore(memento, seed);
  assert.equal(store.load(), undefined, 'a store with nothing written read a host out of nothing');
  const persisted = { hostSeed: seed, issued: 4 };
  store.save(persisted);
  const loaded = store.load();
  assert.ok(loaded !== undefined, 'the series a host saved is not the one it reads back');
  assert.deepEqual([...loaded.hostSeed], [...seed]);
  assert.equal(loaded.issued, 4);
  // Another host's record is not this host's series: the key is the seed `§7.1` signs with.
  assert.equal(new HostKeyStore(memento, other).load(), undefined);
  // And a record that is not a key at all is not a series, whatever put it there.
  memento.update(`selvage.hostKey.${encodeKey(seed)}`, { seed: 'not a key', issued: 3 });
  assert.equal(store.load(), undefined);
});

// --- §13.9: a viewer's documents are read-only --------------------------------------

/** The mirror root the seated viewer resolves its documents under; nothing is written there. */
const MIRROR_ROOT = '/mirror';
const PATH = 'src/main.rs';

/** A position in a document, as an editor reports one. */
interface StubPosition {
  line: number;
  character: number;
}

/** The line and character an offset falls at, counted against the text it is read as. */
function positionIn(text: string, offset: number): StubPosition {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length - 1, character: offset - lastNewline - 1 };
}

/** The offset a position names, counted against the text it is read as. */
function offsetIn(text: string, position: StubPosition): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    offset += (lines[line] ?? '').length + 1;
  }
  return offset + position.character;
}

/** One room document, as the editor's own stand-in: its text is a variable. */
interface StandInDocument {
  uri: {
    scheme: string;
    path: string;
    fsPath: string;
    query: string;
    toString(): string;
  };
  eol: number;
  isDirty: boolean;
  getText(): string;
  positionAt(offset: number): StubPosition;
  offsetAt(position: StubPosition): number;
  save(): Promise<boolean>;
}

/**
 * A session driven by hand: a stand-in engine whose role the test moves, and a stand-in mirror.
 *
 * The role a `selvage/2` room gives a connection arrives with an applied state, which is what
 * makes this a test of the adapter rather than of a join: what the extension does when the role
 * it reads becomes `viewer` is the whole of what is under test, and the room behind it is the
 * stub's.
 *
 * `room` is the replica's text, which is LF-only; `eol` is the document's own, so a CRLF
 * document is one holding the same text rendered. The door a test can hold shut is `hold`: an
 * apply the adapter issues is left unanswered until `release`, which drains every held apply in
 * the order it was asked for; `releaseLast` settles only the newest, which is what an editor
 * that resolves two `applyEdit` promises out of order does. `refuseMoved` makes the editor
 * refuse a range whose document moved under it, as a version stamp does.
 */
function viewerSession(
  t: TestContext,
  room = "the room's own text",
  eol = 1,
): {
  bundle: LoadedExtension;
  session: { role(): string; dispose(): void };
  text(): string;
  room(): string;
  type(next: string): void;
  inserts: Array<{ path: string; text: string }>;
  /** Every delete that reached the bridge, which is how a viewer's edit would mutate the replica. */
  deletes: Array<{ path: string; index: number; length: number }>;
  setRole(role: string): void;
  /** The room's text moving without a keystroke: what the bridge is told to reconcile. */
  roomMoved(next: string): void;
  /** Leaves every apply the adapter issues unanswered until {@link release}. */
  hold(): void;
  /** Settles every held apply, in the order the adapter asked for them. */
  release(): void;
  /** Settles the newest held apply, leaving the older ones in flight. */
  releaseLast(): void;
  /** Makes the editor refuse a range whose document moved under it, as a version stamp does. */
  refuseMoved(): void;
  /** Whether the adapter is waiting on an apply it issued. */
  waiting(): boolean;
  /** How many applies the adapter is waiting on. */
  pending(): number;
  /** How many applies the adapter has asked the editor for. */
  applyCount(): number;
  /** Everything the window was shown as an error. */
  errors(): string[];
} {
  const bundle = loadBundle();
  bundle.stub.reset();
  bundle.stub.configure({ openOnJoin: false });
  const adapter = adapterExports();

  let held = eol === 1 ? room : room.replaceAll('\n', '\r\n');
  // The room's replica, which is not the buffer: a keystroke moves the buffer first and the
  // replica only when the bridge publishes it, which is the whole of what a refused edit turns
  // on.
  let replica = room;
  const document: StandInDocument = {
    uri: {
      scheme: 'file',
      path: `${MIRROR_ROOT}/${PATH}`,
      fsPath: `${MIRROR_ROOT}/${PATH}`,
      query: '',
      toString: () => `file://${MIRROR_ROOT}/${PATH}`,
    },
    eol,
    isDirty: false,
    getText: () => held,
    positionAt: (offset: number) => positionIn(held, offset),
    offsetAt: (position: StubPosition) => offsetIn(held, position),
    save: () => Promise.resolve(true),
  };
  // Every change the adapter offers the editor is applied to the stand-in, as the editor's own
  // model would; a change the editor refuses is `applyEdit` answering `false`. An apply the test
  // is holding is answered only when it says so, so a change event can arrive while the apply
  // that caused it is still in flight — which is when an editor delivers it.
  const queued: Array<{ edit: unknown; at: string; settle: () => void }> = [];
  let holding = false;
  let refuseIfMoved = false;
  let asks = 0;
  const apply = (edit: unknown): void => {
    const edits =
      (edit as { edits: Array<{ range: { start: StubPosition; end: StubPosition }; text: string }> })
        .edits;
    for (const change of edits) {
      const start = offsetIn(held, change.range.start);
      const end = offsetIn(held, change.range.end);
      held = `${held.slice(0, start)}${change.text}${held.slice(end)}`;
    }
  };
  bundle.stub.registered.applyEditImpl = (edit: unknown) => {
    asks += 1;
    if (holding) {
      const at = held;
      return new Promise<boolean>((settle) => {
        queued.push({
          edit,
          at,
          settle: () => {
            // A real editor stamps a workspace edit with the version its ranges were computed
            // against and refuses one whose document has moved since.
            if (refuseIfMoved && held !== at) {
              settle(false);
              return;
            }
            apply(edit);
            settle(true);
          },
        });
      });
    }
    apply(edit);
    return Promise.resolve(true);
  };
  bundle.stub.registered.textDocuments.push(document);

  const inserts: Array<{ path: string; text: string }> = [];
  const deletes: Array<{ path: string; index: number; length: number }> = [];
  const listeners = new Set<
    (event: { type: string; peers: unknown[]; path?: string }) => void
  >();
  let role = 'guest';
  const engine = {
    session: () => ({
      roomId: 'r-viewer',
      role,
      peer: { peer_id: 'p-1', display_name: 'Bob', role },
      peers: [],
      documents: [PATH],
      capabilities: [],
      keepalive: { ping_interval_ms: 30000, awareness_renew_ms: 300, awareness_expire_ms: 900 },
      baseUrl: baseOf('ws://127.0.0.1:1'),
    }),
    text: (_path: string) => replica,
    has: (_path: string) => true,
    open: async (_path: string) => undefined,
    close: async (_path: string) => undefined,
    insert: (path: string, index: number, text: string) => {
      inserts.push({ path, text });
      replica = `${replica.slice(0, index)}${text}${replica.slice(index)}`;
    },
    delete: (path: string, index: number, length: number) => {
      deletes.push({ path, index, length });
      replica = `${replica.slice(0, index)}${replica.slice(index + length)}`;
    },
    setSelection: (_path: string, _selection: unknown) => undefined,
    setAwareness: (_state: unknown) => undefined,
    presence: () => [],
    resolveSelection: () => undefined,
    on: (listener: (event: { type: string; peers: unknown[] }) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    peers: () => [],
    documents: () => [PATH],
    grantedPaths: () => [PATH],
    grant: async (_paths: readonly string[]) => undefined,
    rename: async (_name: string) => undefined,
    disconnect: async () => undefined,
    inviteUrl: () => undefined,
  };
  const mirror = {
    room: 'r-viewer',
    window: 'w-1',
    root: MIRROR_ROOT,
    uri: bundle.stub.Uri.file(MIRROR_ROOT),
    materialise: () => ({ mirrored: [], refused: [] }),
    republish: () => ({ mirrored: [], refused: [], removed: [] }),
    clearInvite: () => undefined,
    remove: () => undefined,
  };
  const session = new adapter.Session(engine, { mirror, invite: 'https://host/?room=r-viewer&token=t' });
  t.after(() => {
    session.dispose();
  });
  return {
    bundle,
    session,
    text: () => held,
    room: () => replica,
    type: (next: string) => {
      held = next;
      bundle.stub.fire('changeTextDocument', { document });
    },
    inserts,
    deletes,
    setRole: (next: string) => {
      role = next;
      // The engine's own event for a state that relabels this connection: `§13.4`'s role is
      // read off the session, and this is the moment a window re-reads it.
      for (const listener of listeners) {
        listener({ type: 'peersChanged', peers: [] });
      }
    },
    roomMoved: (next: string) => {
      replica = next;
      for (const listener of listeners) {
        listener({ type: 'documentChanged', path: PATH, peers: [] });
      }
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      while (queued.length > 0) {
        queued.shift()?.settle();
      }
    },
    releaseLast: () => {
      queued.pop()?.settle();
    },
    refuseMoved: () => {
      refuseIfMoved = true;
    },
    waiting: () => queued.length > 0,
    pending: () => queued.length,
    applyCount: () => asks,
    errors: () => bundle.stub.registered.errors,
  };
}

test("a viewer's document refuses a local edit, and the room says so once", (t) => {
  const window = viewerSession(t);
  assert.equal(window.session.role(), 'guest');

  // A guest's keystroke is the room's: it is published, and the buffer keeps it.
  window.type('the room\'s own text and mine');
  assert.deepEqual(window.inserts, [{ path: PATH, text: ' and mine' }]);
  assert.equal(window.text(), 'the room\'s own text and mine');
  assert.equal(window.room(), 'the room\'s own text and mine');

  // The state arrives and seats this connection as a viewer (§13.4).
  window.setRole('viewer');
  const said = window.bundle.stub.registered.warnings.filter((message) =>
    message.includes('you are a viewer in this room'),
  );
  assert.deepEqual(said, [
    'Selvage: you are a viewer in this room, so its documents are read-only.',
  ]);

  // §13.9: the edit is not the room's and is not presented as if it were — the room's text goes
  // back, and nothing is published.
  const room = window.room();
  const published = window.inserts.length;
  window.type(`${room} and a keystroke the room never receives`);
  assert.equal(window.text(), room, "the viewer's buffer kept the keystroke");
  assert.equal(window.room(), room, "the room heard a viewer's edit");
  assert.equal(window.inserts.length, published, 'a viewer published content');
  assert.equal(
    window.bundle.stub.registered.warnings.filter((message) =>
      message.includes('you are a viewer in this room'),
    ).length,
    1,
    'the room was told twice',
  );
});

test("a viewer's keystroke lands while its own put-back is still in flight", async (t) => {
  const window = viewerSession(t);
  window.setRole('viewer');
  const room = window.room();

  // The first keystroke is refused and the room's text is put back, with that apply held open.
  window.hold();
  window.type(`${room} and mine`);
  assert.equal(window.waiting(), true, 'the adapter never asked the editor to put the text back');

  // A second keystroke arrives in that window. The apply in flight is for this path, but it
  // asked for the room's text, which is not what the buffer holds now: this is still a
  // keystroke, and it is the bridge that must not hear it.
  window.type(`${room} and mine more`);
  assert.deepEqual(window.inserts, [], "a viewer's keystroke reached the bridge");
  assert.equal(window.room(), room, "the room's replica took a viewer's edit");

  window.release();
  await waitFor('the put-back to land', () => window.text() === room);
  assert.equal(window.text(), room, 'the buffer kept text the room never received');
});

test("a change the bridge applied is not a viewer's keystroke", async (t) => {
  const window = viewerSession(t);
  window.setRole('viewer');
  const room = window.room();
  const landed = `${room}, from the room`;
  const moved = `${landed} and on`;

  // The room's text arrives and the bridge asks the editor for it; the apply is left in flight,
  // so the change event below is one an editor delivers inside that window.
  window.hold();
  window.roomMoved(landed);
  // The room moves on again before the editor reports the change the first apply asked for, so
  // the buffer holds what that apply asked for and not what the replica holds now.
  window.roomMoved(moved);
  window.type(landed);
  assert.equal(
    window.applyCount(),
    1,
    "the bridge's own apply was taken for a keystroke and put back",
  );
  assert.deepEqual(window.inserts, [], "a viewer's document published content");

  // And the room's own text is what the buffer ends on, not the text of the apply the adapter
  // would have mistaken for an edit.
  window.release();
  await waitFor('the room\'s own text to land', () => window.text() === moved);
});

test("a viewer's keystroke in a CRLF document keeps the document's line endings", (t) => {
  const window = viewerSession(t, 'one\ntwo\n', 2);
  window.setRole('viewer');
  assert.equal(window.text(), 'one\r\ntwo\r\n', 'the stand-in did not hold the rendered room text');

  window.type('one\r\ntwo\r\nmine');
  assert.equal(
    window.text(),
    'one\r\ntwo\r\n',
    "the put-back rewrote the document's line endings",
  );
  assert.deepEqual(window.inserts, [], 'a viewer published content');
});

test('a put-back the editor refuses is reported', async (t) => {
  const window = viewerSession(t);
  window.setRole('viewer');
  const room = window.room();
  window.bundle.stub.registered.applyEditImpl = () => Promise.resolve(false);

  window.type(`${room} and mine`);
  await waitFor(
    'the refused put-back to be reported',
    () => window.bundle.stub.registered.errors.some((message) => message.includes(PATH)),
    { describe: () => window.bundle.stub.registered.errors },
  );
  assert.deepEqual(window.inserts, [], 'a viewer published content');
});

/**
 * Lets the promise chain the editor's settle began run to its end. The `applyEdit` reactions are
 * microtasks, and a timer callback cannot run before every microtask queued ahead of it, so one
 * macrotask boundary is enough to observe a settle that has no visible effect of its own.
 */
function settled(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

test("a viewer's undo is refused once the room has moved past its put-back", async (t) => {
  const window = viewerSession(t);
  window.setRole('viewer');
  const room = window.room();
  const moved = `${room}, from the room`;

  // The refused keystroke's put-back is left in flight.
  window.hold();
  window.type(`${room} and mine`);
  assert.equal(window.waiting(), true, 'the put-back was not issued');

  // The room moves on: the bridge reconciles it as its own apply, behind the put-back.
  window.roomMoved(moved);

  // The editor settles the bridge's newer apply first, leaving the put-back in flight. The
  // bridge then has no flight of its own for this path, while the put-back's target — the room's
  // *old* text — is still what an arriving change event can carry.
  window.releaseLast();
  await settled();

  // The viewer undoes the keystroke: the buffer returns to exactly what the put-back asked for.
  // It is a keystroke, not the room's edit, so it must not reach the bridge, where it would be
  // diffed against the room's newest text and delete the room's own change from the replica.
  window.type(room);
  assert.deepEqual(window.inserts, [], "a viewer's undo reached the bridge as an insert");
  assert.deepEqual(window.deletes, [], "a viewer's undo reached the bridge as a delete");
  assert.equal(window.room(), moved, "the replica took a viewer's undo");

  // And the put-back the undo itself provoked converges the buffer on the room's newest text.
  window.releaseLast();
  await waitFor("the room's newest text to land", () => window.text() === moved);
});
