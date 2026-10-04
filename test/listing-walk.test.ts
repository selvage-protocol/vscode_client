/**
 * The listing walk's own tests: the rule in `src/bridge/listing-walk.ts`, read through a seam a
 * test hands it rather than through an editor's file system.
 *
 * What is pinned here is the accounting and the bounds: one node charged per directory read and
 * per shareability check, a name dropped for free, a bound recorded only where a file the walk
 * would have named did not fit, one budget across every root, and a directory that cannot be
 * listed skipped rather than reported as a cut. `test/serve.test.ts` drives the same rule
 * through this client's own seam, end to end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_GRANT_LISTING_BYTES,
  MAX_GRANT_NODES,
  MAX_GRANT_PATHS,
  walkListing,
} from '../src/bridge/index.ts';
import type { IgnoreSource, ListingWalkSource, WalkEntry } from '../src/bridge/index.ts';

/** One entry of the fake tree, in the three shapes the seam reduces a file system's types to. */
const file = (name: string): WalkEntry => ({ name, kind: 'file' });
const folder = (name: string): WalkEntry => ({ name, kind: 'directory' });
const other = (name: string): WalkEntry => ({ name, kind: 'other' });

/** One directory the fake answers for. A directory whose value is `undefined` cannot be listed. */
interface FakeDirectory {
  readonly entries: readonly WalkEntry[];
  /** The files this host will carry in a document. Every one of them by default. */
  readonly carries?: (name: string) => boolean;
}

/**
 * A tree a walk can read: one map entry per directory, keyed by the path the walk's own descent
 * builds — `''` is the root, and a child of `a` is `a/b` — so a key that is absent is a directory
 * the walk cannot reach and a key mapped to `undefined` is one it can reach but not list.
 *
 * Every `entries` call is recorded, which is how a test counts a read rather than reading the
 * code, and `rootIgnore`/`ignoreAt` are the text of the ignore files the directories hold. That
 * root exclude is handed back only when the entries the walk read hold a `.git` directory, the
 * way the real seam's is: which entries those are is the driver's half of the contract.
 */
class FakeTree implements ListingWalkSource<string> {
  /** Every directory the walk asked for, in order, with repeats. */
  readonly reads: string[] = [];
  /**
   * The host the walk gates against, case-sensitive unless a test names another one: the suite's
   * own runner is Linux, so a test that is not about a platform reads the names it always did.
   */
  readonly platform: string;
  private readonly dirs: Map<string, FakeDirectory | undefined>;
  private readonly rootIgnore: string | undefined;
  private readonly ignoreAt: Map<string, string>;

  constructor(
    dirs: Record<string, FakeDirectory | undefined>,
    options: { platform?: string; rootIgnore?: string; ignoreAt?: Record<string, string> } = {},
  ) {
    this.platform = options.platform ?? 'linux';
    this.dirs = new Map(Object.entries(dirs));
    this.rootIgnore = options.rootIgnore;
    this.ignoreAt = new Map(Object.entries(options.ignoreAt ?? {}));
  }

  async entries(dir: string): Promise<readonly WalkEntry[] | undefined> {
    this.reads.push(dir);
    return this.dirs.get(dir)?.entries;
  }

  async ignoreText(dir: string): Promise<string | undefined> {
    return this.ignoreAt.get(dir);
  }

  async shareable(dir: string, name: string): Promise<boolean> {
    const carries = this.dirs.get(dir)?.carries;
    return carries === undefined || carries(name);
  }

  async child(dir: string, name: string): Promise<string | undefined> {
    const below = dir === '' ? name : `${dir}/${name}`;
    return this.dirs.has(below) ? below : undefined;
  }

  async rootIgnores(_dir: string, entries: readonly WalkEntry[]): Promise<readonly IgnoreSource[]> {
    const git = entries.some((entry) => entry.name === '.git' && entry.kind === 'directory');
    return this.rootIgnore === undefined || !git ? [] : [{ dir: '', text: this.rootIgnore }];
  }
}

/** The one folder a walk over this file's trees is handed. */
const ROOT = [{ dir: '', name: 'workspace' }];

/** The UTF-8 bytes of a listing's paths, counted here rather than by the code under test. */
function listedBytes(paths: readonly string[]): number {
  const encoder = new TextEncoder();
  return paths.reduce((total, path) => total + encoder.encode(path).length, 0);
}

test('a front of never-listed assets lists nothing of them and does not starve the walk', async () => {
  // A tree rich in assets and poor in sources: every one of these names is dropped by the name
  // alone — a binary format a room cannot carry — so the walk spends nothing on them. Charging
  // for each entry would spend the whole budget before the first shareable file and publish a
  // listing that names none of them.
  const assets = Array.from({ length: MAX_GRANT_NODES }, (_, index) => file(`a-${index}.png`));
  const sources = Array.from({ length: 5 }, (_, index) => file(`z-${index}.md`));
  const tree = new FakeTree({ '': { entries: [...assets, ...sources] } });

  const walked = await walkListing(tree, ROOT);
  assert.equal(walked.paths.length, 5, `assets starved the walk: ${walked.paths.length} listed`);
  assert.equal(walked.cut, undefined, 'a complete listing was reported as cut');
});

test('a folder of six thousand shareable files is listed whole', async () => {
  // Under every bound, so nothing here is about a cut: this is the shape a walk is for, and the
  // whole of it has to survive the descent and the accounting.
  const dirs: Record<string, FakeDirectory | undefined> = {};
  const expected: string[] = [];
  const groups = Array.from({ length: 6 }, (_, group) => folder(`g${group}`));
  for (let group = 0; group < groups.length; group += 1) {
    const entries = Array.from({ length: 1000 }, (_, index) => file(`f-${index}.md`));
    dirs[`g${group}`] = { entries };
    for (const entry of entries) {
      expected.push(`g${group}/${entry.name}`);
    }
  }
  dirs[''] = { entries: groups };
  const tree = new FakeTree(dirs);

  const walked = await walkListing(tree, ROOT);
  assert.equal(walked.cut, undefined, 'a folder under every bound was reported as cut');
  assert.equal(walked.paths.length, 6000, `the listing is short: ${walked.paths.length} listed`);
  assert.deepEqual(walked.paths, [...expected].sort(), 'the listing is not every shareable file');
  assert.deepEqual(walked.entered, groups.map((entry) => entry.name), 'a folder was not entered');
});

test('a walk stops at the path count one listing carries, and says which bound it was', async () => {
  // One more than a listing carries, all of them shareable and in memory: the bound is crossed
  // without a hundred thousand files on a disk.
  const entries = Array.from({ length: MAX_GRANT_PATHS + 1 }, (_, index) => file(`f-${index}.md`));
  const tree = new FakeTree({ '': { entries } });

  const walked = await walkListing(tree, ROOT);
  assert.equal(walked.cut, 'paths', 'the walk read past the ceiling in silence');
  assert.equal(walked.paths.length, MAX_GRANT_PATHS, 'the listing is not one ceiling wide');
  assert.equal(new Set(walked.paths).size, walked.paths.length, 'the same path was listed twice');
});

test('two folders are prefixed with their own names, and share one budget', async () => {
  // A session that shares two folders: two `src/main.rs` would otherwise be one room path, so
  // every path carries its folder's name. The budget is one, not one per folder, so a first
  // folder that fills the listing stops the second from publishing anything.
  const first = Array.from({ length: MAX_GRANT_PATHS }, (_, index) =>
    file(`f-${String(index).padStart(6, '0')}.md`),
  );
  const tree = new FakeTree({ '': { entries: first }, second: { entries: [file('only.md')] } });

  const walked = await walkListing(tree, [
    { dir: '', name: 'alpha' },
    { dir: 'second', name: 'beta' },
  ]);
  assert.equal(walked.cut, 'paths', 'the walk crossed the boundary between the two folders');
  assert.equal(walked.paths.length, MAX_GRANT_PATHS, 'the listing is not one ceiling wide');
  for (const path of walked.paths) {
    assert.ok(path.startsWith('alpha/'), `${path} is not prefixed with its folder`);
  }
  assert.ok(!walked.paths.includes('beta/only.md'), 'the second folder spent a budget of its own');
});

test('a walk stops when the paths it lists reach the byte bound, and says which bound it was', async () => {
  // 2000 names of 2100 UTF-8 bytes each: more than the 4 MiB a listing carries, in fewer files
  // than the count bound, so the byte bound is the one that binds. A character outside ASCII is
  // deliberate — the count is UTF-8 bytes and not UTF-16 code units.
  const long = 'あ'.repeat(700);
  const seeded = 2000;
  const entries = Array.from({ length: seeded }, (_, index) => file(`${index}-${long}.md`));
  const tree = new FakeTree({ '': { entries } });

  const walked = await walkListing(tree, ROOT);
  assert.equal(walked.cut, 'bytes', 'the walk read past the byte bound in silence');
  assert.ok(walked.paths.length > 0, 'the byte bound stopped the walk at the first path');
  assert.ok(walked.paths.length < seeded, 'every path was listed');
  const bytes = listedBytes(walked.paths);
  assert.ok(bytes <= MAX_GRANT_LISTING_BYTES, `the listing is over the bound: ${bytes}`);
  assert.ok(
    bytes + listedBytes([`0-${long}.md`]) > MAX_GRANT_LISTING_BYTES,
    `the walk stopped well short of the bound: ${bytes}`,
  );
});

test('a walk stops when its budget is spent, and says so rather than listing nothing', async () => {
  // The budget pays for the shareability check every candidate costs, so a folder of files too
  // large to share spends it without naming one. Two small files sort first and are listed; the
  // bound that stops the walk is the budget and not the listing.
  const spent = Array.from({ length: MAX_GRANT_NODES + 1 }, (_, index) => file(`b-${index}.md`));
  const tree = new FakeTree({
    '': { entries: [file('a-granted-too.md'), file('a-granted.md'), ...spent], carries: (name) => !name.startsWith('b-') },
  });

  const walked = await walkListing(tree, ROOT);
  assert.deepEqual(walked.paths, ['a-granted-too.md', 'a-granted.md'], 'the walk listed the wrong paths');
  assert.equal(walked.cut, 'budget', 'the walk gave up in silence');
});

test('a walk that named every shareable file reports no cut', async () => {
  // Exactly a listing's worth of shareable paths, and one plain file too large to share after
  // them. The listing holds every file this walk would name, so it is short of nothing and there
  // is no cut to report. A bound read off a candidate the walk then declines — one checked before
  // the file is asked about — would say the listing was cut.
  const entries = Array.from({ length: MAX_GRANT_PATHS }, (_, index) => file(`f-${index}.md`));
  entries.push(file('z-large.md'));
  const tree = new FakeTree({
    '': { entries, carries: (name) => name !== 'z-large.md' },
  });

  const walked = await walkListing(tree, ROOT);
  assert.equal(walked.cut, undefined, 'a complete listing was reported as cut');
  assert.equal(walked.paths.length, MAX_GRANT_PATHS, 'a shareable path is missing from the listing');
  assert.ok(walked.paths.includes('f-0.md'), 'the listing holds something else');
});

test('a file the walk would not name does not trip the byte bound either', async () => {
  // The same shape at the byte bound, and cheap enough to reach without a hundred thousand files:
  // 1026 paths of 4086 UTF-8 bytes fill all but a couple of thousand of the 4 MiB a listing
  // carries, and the file that follows them is one no listing names. The candidate's own path
  // would not have fitted either — 4192236 + 3500 is over the bound — so a bound decided on the
  // candidate rather than on what is published reports a cut here.
  const long = `p${'あ'.repeat(1360)}`;
  assert.equal(new TextEncoder().encode(long).length, 4081);
  const entries = Array.from({ length: 1026 }, (_, index) => file(`${String(index).padStart(4, '0')}-${long}`));
  const tooLong = `z${'a'.repeat(3499)}`;
  entries.push(file(tooLong));
  const tree = new FakeTree({ '': { entries, carries: (name) => name !== tooLong } });

  const walked = await walkListing(tree, ROOT);
  assert.equal(walked.cut, undefined, 'a complete listing was reported as cut');
  assert.equal(walked.paths.length, 1026, `the listing is short: ${walked.paths.length} listed`);
  assert.ok(
    listedBytes(walked.paths) + 3500 > MAX_GRANT_LISTING_BYTES,
    'the candidate no longer reaches past the bound, so the test proves nothing',
  );
});

test('a directory this host cannot list is skipped, and is not a cut', async () => {
  // A directory the window can reach but not read — permissions, a provider that refuses — is one
  // this host cannot share, and a listing is not a promise. Nothing about it is said to the
  // session, and it is not the bound that stopped the walk either.
  const tree = new FakeTree({
    '': { entries: [file('a.md'), folder('locked'), file('z.md')] },
    locked: undefined,
  });

  const walked = await walkListing(tree, ROOT);
  assert.deepEqual(walked.paths, ['a.md', 'z.md'], 'an unreadable directory changed the listing');
  assert.equal(walked.cut, undefined, 'an unreadable directory was reported as a cut');
  assert.ok(tree.reads.includes('locked'), 'the walk never tried to enter the directory');
  assert.deepEqual(walked.entered, ['locked'], 'a directory the walk entered was not reported');
});

test('an entry a listing cannot carry is neither named nor descended into', async () => {
  // A link, a socket and every other type a listing has no room for: the adapter reduces each to
  // `other`, and the walk reads nothing for one, lists nothing for one, and reaches nothing
  // behind one. The directory named by `link` is never read.
  const tree = new FakeTree({
    '': { entries: [other('link'), other('socket.md'), file('a.md')] },
    link: { entries: [file('hidden.md')] },
  });

  const walked = await walkListing(tree, ROOT);
  assert.deepEqual(walked.paths, ['a.md'], 'an entry a listing cannot carry was named');
  assert.deepEqual(walked.entered, [], 'an entry a listing cannot carry was entered');
  assert.deepEqual(tree.reads, [''], 'the walk read behind an entry it cannot carry');
});

test('the entries of a directory are visited in name order', async () => {
  // Which paths survive a cut cannot depend on the file system's own order, so the walk sorts
  // each directory's entries by name before it descends.
  const tree = new FakeTree({
    '': { entries: [folder('zeta'), folder('alpha'), folder('mid')] },
    zeta: { entries: [] },
    alpha: { entries: [] },
    mid: { entries: [] },
  });

  const walked = await walkListing(tree, ROOT);
  assert.deepEqual(tree.reads, ['', 'alpha', 'mid', 'zeta'], 'the walk read a directory out of order');
  assert.deepEqual(walked.entered, ['alpha', 'mid', 'zeta'], 'the walk entered a directory out of order');
});

test('a shared root is listed once, and its own sources come from the entries it was read with', async () => {
  // The root's repository exclude is read from the entries the walk already holds — the fake
  // refuses to hand one back unless those entries hold a `.git` directory — so the root is
  // listed once rather than twice.
  const tree = new FakeTree(
    {
      '': { entries: [file('.gitignore'), folder('.git'), file('a.md')] },
      '.git': { entries: [folder('info')] },
      '.git/info': { entries: [file('exclude')] },
    },
    { rootIgnore: 'a.md\n' },
  );

  const walked = await walkListing(tree, ROOT);
  assert.deepEqual(walked.paths, ['.gitignore'], 'the repository exclude did not govern the root');
  const roots = tree.reads.filter((dir) => dir === '');
  assert.equal(roots.length, 1, `the root was listed ${roots.length} times`);
  assert.deepEqual(tree.reads, [''], 'the walk read a directory besides the root');
});

test('a root exclude is the floor under the .gitignore of the directory it governs', async () => {
  // The ignore sources arrive lowest precedence first, and the last matching pattern decides: a
  // name the repository excludes can be re-included by a `.gitignore` below it, which is the order
  // `git status` reads them in and the reason the two are threaded rather than merged.
  const tree = new FakeTree(
    { '': { entries: [file('.gitignore'), folder('.git'), file('notes.tmp'), file('kept.md')] } },
    { rootIgnore: 'notes.tmp\n', ignoreAt: { '': '!notes.tmp\n' } },
  );

  const walked = await walkListing(tree, ROOT);
  assert.deepEqual(walked.paths, ['.gitignore', 'kept.md', 'notes.tmp'], 'the later source did not decide');
});

test('the platform a source names is the one the two name gates read', async () => {
  // The name gates fold case only where the host's file system does, so the platform decides the
  // listing: a `Build/` is an excluded directory on one host and an ordinary one on another, and a
  // `release/` pattern in a `.gitignore` is read the same way. The walk takes that platform off
  // the seam and reads no global, so a host that cannot know its platform says so explicitly and
  // is not mistaken for the machine the suite happens to run on.
  const tree = (platform: string): FakeTree =>
    new FakeTree(
      {
        '': { entries: [folder('Build'), folder('Release'), file('.gitignore')] },
        Build: { entries: [file('out.txt')] },
        Release: { entries: [file('notes.md')] },
      },
      { platform, ignoreAt: { '': 'release/\n' } },
    );

  const folding = await walkListing(tree('darwin'), ROOT);
  assert.deepEqual(folding.entered, [], 'a case-folding host entered what it excludes');
  assert.deepEqual(folding.paths, ['.gitignore'], 'a case-folding host listed an excluded name');

  const exact = await walkListing(tree('linux'), ROOT);
  assert.deepEqual(exact.entered, ['Build', 'Release'], 'a case-sensitive host dropped an ordinary directory');
  assert.deepEqual(
    exact.paths,
    ['.gitignore', 'Build/out.txt', 'Release/notes.md'],
    'a case-sensitive host listed the wrong names',
  );
});
