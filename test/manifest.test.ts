/**
 * The extension manifest, against the code it describes.
 *
 * `vsce package` would catch some of this and CI runs neither `vsce` nor an editor, so what
 * is checked here is the part a machine without VS Code can still check: the bundle the
 * manifest points at builds and loads, activating it registers exactly the commands the
 * manifest contributes, and the settings the manifest declares are settings the adapter
 * reads. `npm run test:fast` builds the bundle first, so the file under test is the current
 * source and not a stale one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { loadBundle, testStoragePath } from './helpers/bundle.ts';
import { waitFor } from './helpers/wait.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..');
const ADAPTER = resolve(ROOT, 'src', 'adapter');

interface Manifest {
  main?: string;
  engines?: { vscode?: string; node?: string };
  activationEvents?: string[];
  capabilities?: {
    untrustedWorkspaces?: { supported?: unknown; description?: unknown };
  };
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string }>;
    views?: { explorer?: Array<{ id: string; name?: string }> };
    configuration?: { properties?: Record<string, { type?: string; default?: unknown; enum?: unknown[] }> };
  };
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as Manifest;

test('the manifest points at a bundle that exists and loads', () => {
  assert.equal(manifest.main, './dist/extension.js');
  const bundle = loadBundle();
  assert.equal(typeof bundle.activate, 'function');
  assert.equal(typeof bundle.deactivate, 'function');
});

test('activating registers exactly the commands the manifest contributes', () => {
  const bundle = loadBundle();
  bundle.activate({ subscriptions: [] });
  bundle.deactivate();

  const registered = [...bundle.registered.commands].sort();
  const contributed = (manifest.contributes?.commands ?? [])
    .map((entry) => entry.command)
    .sort();
  assert.ok(contributed.length > 0, 'the manifest contributes no commands');
  assert.deepEqual(
    registered,
    contributed,
    'a command the palette cannot reach, or a contributed one that is never registered',
  );
  for (const entry of manifest.contributes?.commands ?? []) {
    assert.match(entry.command, /^selvage\./, `${entry.command} is outside the extension's namespace`);
    assert.ok(entry.title.trim() !== '', `${entry.command} has no title`);
  }

});

test('every setting the manifest declares is one the adapter reads', () => {
  const source = ['extension.ts', 'documents.ts', 'mirror.ts', 'decorations.ts']
    .map((name) => readFileSync(resolve(ADAPTER, name), 'utf8'))
    .join('\n');
  const properties = Object.keys(manifest.contributes?.configuration?.properties ?? {});
  assert.ok(properties.length > 0, 'the manifest declares no settings');
  for (const key of properties) {
    assert.match(key, /^selvage\./, `${key} is outside the extension's namespace`);
    const name = key.slice('selvage.'.length);
    assert.ok(
      source.includes(`'${name}'`),
      `no adapter module reads ${key}`,
    );
  }
});

test('the cursor label draws no name unless the user opts in', () => {
  // The contract the setting exists to keep: a window configured with nothing must not put a
  // peer-controlled string over the code. `test/labels.test.ts` pins what each value draws;
  // this pins that the shipped default is the one that draws nothing, and that the two modes
  // which do draw are reachable only by asking for them.
  const setting = manifest.contributes?.configuration?.properties?.['selvage.cursorLabel'];
  assert.ok(setting !== undefined, 'the manifest no longer declares selvage.cursorLabel');
  assert.equal(setting.default, 'none', 'the default cursor label draws a name over the document');
  assert.deepEqual(
    [...(setting.enum ?? [])].sort(),
    ['chip', 'floating', 'none'],
    'the setting no longer offers exactly the two opt-ins and the default',
  );
});

test('the manifest asks for a VS Code no older than its type definitions', () => {
  // `vsce` refuses to package when `@types/vscode` needs a newer API than `engines.vscode`
  // promises, and nothing else checks it (`validateVSCodeTypesCompatibility`).
  const engines = /^\^?(\d+)\.(\d+)/.exec(manifest.engines?.vscode ?? '');
  const types = /^(\d+)\.(\d+)/.exec(manifest.devDependencies?.['@types/vscode'] ?? '');
  assert.ok(engines !== null, `engines.vscode is not a version: ${manifest.engines?.vscode}`);
  assert.ok(types !== null, '@types/vscode is not pinned to a version');
  const promised = Number(engines[1]) * 1000 + Number(engines[2]);
  const required = Number(types[1]) * 1000 + Number(types[2]);
  assert.ok(
    required <= promised,
    `@types/vscode ${manifest.devDependencies?.['@types/vscode']} is newer than engines.vscode ${manifest.engines?.vscode}`,
  );
});

test('activation stays lazy: a command starts the extension, a mirror restores it', () => {
  // A command activation event is generated from `contributes.commands` since VS Code
  // 1.74, so the extension starts when a user runs one of its commands and not before. A
  // window opened on a mirror directory is the way back in after the reload that put the
  // room's folder there — and after a crash that left one behind.
  assert.deepEqual(manifest.activationEvents ?? [], ['workspaceContains:**/.selvage-mirror.json']);
  // That event is the one thing a folder can use to start the extension by itself, and VS
  // Code does not condition it on trust: the manifest claims the limitation rather than
  // full support, and the resume it starts waits for a trusted window (`extension.ts`).
  const trust = manifest.capabilities?.untrustedWorkspaces;
  assert.equal(trust?.supported, 'limited', 'the manifest claims the extension is untrusted-safe');
  assert.match(String(trust?.description ?? ''), /trust/i, 'the limitation is not explained');
});

/** A storage directory holding one mirror of ours, whose marker stashes `invite`. */
function staleMirror(storage: string, invite = 'not-a-link'): string {
  const room = 'r-untrusted';
  const window = 'w-untrusted';
  const dir = join(storage, 'rooms', room, window);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.selvage-mirror.json'),
    JSON.stringify({
      room,
      window,
      pid: process.pid,
      created: new Date(0).toISOString(),
      invite,
    }),
  );
  return dir;
}

/**
 * A folder can start this extension with nothing but a `.selvage-mirror.json` in it, so the
 * triage that file would otherwise trigger — dialling the room a leftover mirror names, or
 * clearing the leftover — waits for a window the person has trusted. The resume is what a
 * hostile repository must not reach; starting the extension to register commands is what no
 * `workspaceContains` event can be kept from doing.
 */
test('an untrusted workspace starts the extension without resuming a room', async (t: TestContext) => {
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  const leftover = staleMirror(storage);

  bundle.stub.isTrusted = false;
  bundle.activate({ subscriptions: [], globalStorageUri: bundle.stub.Uri.file(storage) });
  t.after(() => {
    bundle.deactivate();
  });

  // Nothing triaged: the marker's window is neither cleared nor reported. The read is the
  // assertion because the triage would have happened inside `activate`, and a test that
  // waited for it would be waiting for something that must not come.
  assert.deepEqual(bundle.stub.registered.warnings, [], 'an untrusted window triaged a mirror');
  assert.equal(existsSync(leftover), true, 'an untrusted window removed a mirror on disk');

  // The person trusts the folder: the resume runs then, which is what keeps the feature
  // rather than dropping it.
  bundle.stub.grantTrust();
  await waitFor('the triage to run once the window is trusted', () =>
    existsSync(leftover) ? false : true,
  );
  assert.equal(bundle.stub.registered.warnings.length, 1);
  assert.match(String(bundle.stub.registered.warnings[0]), /Cleaned up the files left by the last session/);
});

/**
 * The resume waits for a name and then dials a room, and the window can go away while it
 * waits: the tear-down that runs then owns nothing, so a join that lands afterwards would
 * leave a live engine and a session that nothing disposed. The port the invite names is one
 * nothing answers on, so a dial is a failure reported in words — which is what the bounded
 * wait below would find if the join ran.
 */
test('a resume the window is torn down for lands nothing', async (t: TestContext) => {
  const bundle = loadBundle();
  bundle.stub.reset();
  const storage = testStoragePath(t);
  const leftover = staleMirror(
    storage,
    'ws://127.0.0.1:1/session?room=r-torn&token=t',
  );

  // The name question is held, so the window can be torn down while it is on screen.
  let answer: (name: string | undefined) => void = () => undefined;
  const asked = new Promise<string | undefined>((resolve) => {
    answer = resolve;
  });
  bundle.stub.registered.inputReply = asked;
  bundle.activate({ subscriptions: [], globalStorageUri: bundle.stub.Uri.file(storage) });
  t.after(() => {
    bundle.deactivate();
  });

  await waitFor('the name question', () => bundle.stub.registered.inputs.length > 0);
  bundle.deactivate();
  answer('Bob');

  // The join this would have made stages its reload within a few microtasks of the name —
  // and, on a live room, dials it. The bounded wait that finds neither is the assertion, and
  // it reports what it saw.
  await assert.rejects(
    waitFor(
      'a reload or a report from a join this window must not make',
      () =>
        bundle.stub.registered.executed.some((call) => call.id === 'vscode.openFolder') ||
        bundle.stub.registered.errors.length > 0 ||
        bundle.stub.registered.information.length > 0
          ? true
          : false,
      {
        timeoutMs: 1000,
        describe: () => ({
          executed: bundle.stub.registered.executed,
          errors: bundle.stub.registered.errors,
          information: bundle.stub.registered.information,
        }),
      },
    ),
    /timed out/,
  );
  assert.deepEqual(bundle.stub.registered.information, [], 'a torn-down window joined a room');
  assert.deepEqual(
    bundle.stub.registered.statusBarItems,
    [],
    'a session was built after the window was torn down',
  );
  assert.equal(existsSync(leftover), true, 'the room\u2019s files were left for nobody');
});
