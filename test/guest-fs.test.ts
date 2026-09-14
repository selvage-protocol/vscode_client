/**
 * The guest's `FileSystemProvider`, without an editor.
 *
 * `test/boundary.test.ts` makes sure this module imports `vscode` and could be tested `only`
 * by reading it; what is worth more than that is its contract, which is about what it refuses
 * as much as what it serves: a URI from another scheme, a URI naming no room, a URI whose path
 * the room has received nothing for — each is a document this client must not invent. The
 * provider is exercised through the built extension, loaded with the editor API stubbed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBundle } from './helpers/bundle.ts';
import type { GuestFiles, UriLike } from './helpers/bundle.ts';
import { virtualUri } from '../src/bridge/index.ts';

const ROOM = 'r-0aF1';

/** The components an editor would hand the provider for a URI string. */
function uri(uriString: string): UriLike {
  const at = uriString.indexOf('?');
  const scheme = uriString.slice(0, uriString.indexOf(':'));
  return {
    scheme,
    path: uriString.slice(uriString.indexOf(':') + 1, at === -1 ? undefined : at),
    query: at === -1 ? '' : uriString.slice(at + 1),
    toString: () => uriString,
  };
}

/** The provider the extension registered when it activated. */
function provider(): GuestFiles {
  const bundle = loadBundle();
  bundle.activate({ subscriptions: [] });
  const files = bundle.registered.files;
  assert.ok(files !== undefined, 'activating registered no file system provider');
  bundle.deactivate();
  return files;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('a guest document reads what the session holds for it', () => {
  const files = provider();
  files.use({ roomId: ROOM, text: (path) => (path === 'src/main.rs' ? 'from the room\n' : '') });

  const document = uri(virtualUri(ROOM, 'src/main.rs'));
  assert.equal(decode(files.readFile(document)), 'from the room\n');
  assert.equal(files.stat(document).size, 'from the room\n'.length);
  assert.equal(files.stat(document).type, 1, 'a guest document is a file');

  // A path the replica has received nothing for is not a 404: the room may still fill it,
  // and an empty buffer is what a document with no content looks like.
  assert.equal(decode(files.readFile(uri(virtualUri(ROOM, 'src/new.rs')))), '');
});

test('the provider refuses a document it cannot name', () => {
  const files = provider();
  files.use({ roomId: ROOM, text: () => 'anything' });

  for (const bad of [
    // Another scheme is another provider's business.
    uri('file:///tmp/a.ts'),
    // No room: an invite that lost its query is not a document.
    uri('selvage:/src/main.rs'),
    // A different room: a real room, but not one this provider is serving, and it must not be
    // served this one's text.
    uri('selvage:/src/main.rs?room=another'),
  ]) {
    assert.throws(() => files.readFile(bad), /not found/, `served ${bad.toString()}`);
    assert.throws(() => files.stat(bad), /not found/, `statted ${bad.toString()}`);
  }
});

test('a guest document is editable and its save writes nothing', () => {
  const files = provider();
  const document = uri(virtualUri(ROOM, 'src/main.rs'));
  files.use({ roomId: ROOM, text: () => "the room's text\n" });

  // The shared buffer is the truth and a guest has no file to write: a save is a no-op that
  // resolves, which is what clears the editor's dirty marker. The content does not move.
  files.writeFile(document, new TextEncoder().encode('edited\n'));
  assert.equal(decode(files.readFile(document)), "the room's text\n");
});

test('there is no file tree, and nothing is created, renamed or deleted', () => {
  const files = provider();
  const document = uri(virtualUri(ROOM, 'src/main.rs'));

  assert.deepEqual(files.readDirectory(), []);
  assert.throws(() => files.createDirectory(document), /no permissions/);
  assert.throws(() => files.delete(document), /no permissions/);
  assert.throws(() => files.rename(document), /no permissions/);
  assert.equal(typeof files.watch(document).dispose, 'function');
});

test('a document outlives the session that produced it', () => {
  const files = provider();
  const document = uri(virtualUri(ROOM, 'src/main.rs'));
  files.use({ roomId: ROOM, text: () => 'while the room is live\n' });
  assert.equal(decode(files.readFile(document)), 'while the room is live\n');

  // The room ended: the session keeps what the tabs were showing, so a document the user is
  // looking at does not turn into an error.
  files.freeze([[document.toString(), 'what the room had\n']]);
  assert.equal(decode(files.readFile(document)), 'what the room had\n');

  // A document that was never opened is still nothing, and a new session takes over.
  assert.throws(() => files.readFile(uri(virtualUri(ROOM, 'src/other.rs'))), /not found/);
  files.use({ roomId: ROOM, text: () => 'a second session\n' });
  assert.equal(decode(files.readFile(document)), 'a second session\n');
});
