/**
 * The `selvage:` address: the room path a URI names, and the file system a document at one is
 * served by.
 *
 * The address exists for a path the room holds and its listing does not name (`held.ts`): the
 * mirror is the listing's shape on disk, so such a path has no file, and the document is the
 * room's own — read from the replica, written back through the ordinary document path rather
 * than through a file. The provider is therefore the one thing a test can drive without an
 * editor, and what it refuses is as much a part of the address as what it serves: a URI can be
 * typed, pasted or restored from a window's own state, so a path its session does not offer is
 * refused before it can take a hold the room should not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import type * as vscode from 'vscode';

import * as vscodeLoader from './helpers/vscode-loader.ts';

// The adapter module loaded directly, with the editor API stubbed for its `Uri.parse`.
registerHooks(vscodeLoader);
const { HELD_SCHEME, HeldDocuments, heldRoomPath, heldRoomUri } =
  await import('../src/adapter/held.ts');

const stub = createRequire(import.meta.url)('./helpers/vscode-stub.cjs') as {
  Uri: { parse(value: string): vscode.Uri };
  FileType: { File: number };
};

/** A room stand-in: the text it holds, and the paths it offers at this address. */
interface FakeRoom {
  text: string;
  holds: readonly string[];
  listed: readonly string[];
}

/** That room as the provider's own view of a session, read live rather than copied. */
function roomOf(room: FakeRoom): {
  text(path: string): string;
  heldWithoutFile(path: string): boolean;
} {
  return {
    text: () => room.text,
    heldWithoutFile: (path: string) => room.holds.includes(path) && !room.listed.includes(path),
  };
}

function providerOver(room: FakeRoom): InstanceType<typeof HeldDocuments> {
  return new HeldDocuments(() => roomOf(room));
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test('a `selvage:` URI names the room path it carries, whatever the path holds', () => {
  const paths = [
    'a.md',
    'notes/guide/intro.md',
    'a b.md',
    'weird#name?.md',
    'pct%20.md',
    '\u00fcn\u00efcode/\u4e2d\u6587.md',
    '.hidden/deep/down.txt',
  ];
  const seen = new Set<string>();
  for (const path of paths) {
    const uri = heldRoomUri(path);
    assert.equal(uri.scheme, HELD_SCHEME);
    assert.equal(heldRoomPath(uri), path, `${path} came back as something else`);
    seen.add(uri.toString());
  }
  assert.equal(seen.size, paths.length, 'two room paths share one address');
});

test('a `selvage:` URI that names no room path names nothing', () => {
  assert.equal(heldRoomPath(stub.Uri.parse('file:/a.md')), undefined);
  assert.equal(heldRoomPath(stub.Uri.parse('selvage:')), undefined);
  assert.equal(heldRoomPath(stub.Uri.parse('selvage:/')), undefined);
});

test('the provider serves the room text, live, and a file the editor may write', () => {
  const room: FakeRoom = { text: 'the room wrote this\n', holds: ['kept.md'], listed: [] };
  const files = providerOver(room);
  const uri = heldRoomUri('kept.md');
  assert.equal(textOf(files.readFile(uri)), 'the room wrote this\n');
  assert.equal(files.stat(uri).type, stub.FileType.File);
  assert.equal(files.stat(uri).size, Buffer.byteLength('the room wrote this\n', 'utf8'));
  // The room is read, never copied: text that arrives after the document was opened is what the
  // next read answers with, exactly as a mirror file's content follows the room.
  room.text = 'and this later\n';
  assert.equal(textOf(files.readFile(uri)), 'and this later\n');
  assert.equal(files.stat(uri).size, Buffer.byteLength('and this later\n', 'utf8'));
  // A write is accepted — the buffer is the room's own document, and an editor refuses to type
  // into a file system that cannot write — and keeps nothing: there is no file at this address
  // to hold a second copy of the room's text.
  files.writeFile(uri, new TextEncoder().encode('typed here\n'), { create: false, overwrite: true });
  assert.equal(textOf(files.readFile(uri)), 'and this later\n');
  assert.equal(room.text, 'and this later\n');
});

test('the provider refuses a `selvage:` URI its room does not offer', () => {
  const files = providerOver({ text: 'held\n', holds: ['held.md'], listed: [] });
  const elsewhere = heldRoomUri('elsewhere.md');
  assert.throws(() => files.readFile(elsewhere), /not found/);
  assert.throws(() => files.stat(elsewhere), /not found/);
  assert.throws(() => files.writeFile(elsewhere, new Uint8Array(), { create: false, overwrite: true }), /not found/);
  // The read is the whole of the guard, and it is what keeps the room honest: a document at an
  // address the room never offered would take a hold the room should not have.
  assert.equal(textOf(files.readFile(heldRoomUri('held.md'))), 'held\n');
  // A path the listing names is the mirror's file, never an address here.
  const listed = providerOver({ text: 'listed\n', holds: ['listed.md'], listed: ['listed.md'] });
  assert.throws(() => listed.readFile(heldRoomUri('listed.md')), /not found/);
  // No session at all: nothing is addressed, so nothing is served.
  const bare = new HeldDocuments(() => undefined);
  assert.throws(() => bare.readFile(heldRoomUri('held.md')), /not found/);
  assert.throws(() => bare.stat(heldRoomUri('held.md')), /not found/);
});

test('the provider refuses the operations a room document has no answer for', () => {
  const files = providerOver({ text: '', holds: ['kept.md'], listed: [] });
  const uri = heldRoomUri('kept.md');
  assert.throws(() => files.readDirectory(uri), /not a directory/);
  assert.throws(() => files.createDirectory(uri), /no permissions/);
  assert.throws(() => files.delete(uri, { recursive: false }), /no permissions/);
  assert.throws(() => files.rename(uri, heldRoomUri('moved.md'), { overwrite: false }), /no permissions/);
  // Nothing watches the file system: the room's changes reach the buffer through the bridge,
  // and a change event here would have the editor re-read under a buffer that is the room's.
  files.watch(uri, { recursive: false, excludes: [] }).dispose();
  files.dispose();
});
