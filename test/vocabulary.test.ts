/**
 * The vocabulary this client shares with the Neovim one, pinned.
 *
 * The two clients are different editors, not different products: the same intent is the same
 * English sentence in both, and only the presentation around it — the `Selvage: … .` wrapper, the
 * buttons, the modal, the quick pick — is the editor's own business (`AGENTS.md` §4, `DESIGN.md`
 * §4.3). A sentence that drifts on one side and not the other is what this file exists to stop.
 *
 * Pinned here is the vocabulary itself: the palette titles the manifest contributes, and every
 * sentence this client can put in front of a user. Which sentence is shown at *which* moment, at
 * which level, with which buttons, is `test/commands.test.ts`'s, which drives the built extension.
 * It covers every moment a stubbed editor can reach; four report kinds it cannot stage
 * (`applyRefused`, `divergence`, `saveFailed`, `disconnected`, and the throw from `showTextDocument`
 * behind an unopenable room path) reach the user only through the sentence list below — the stub's
 * guest document *is* the replica, so a document an editor refuses to change cannot hold text that
 * differs from the room's.
 *
 * Two sentences reach a user through a wildcard rather than a literal of their own: the
 * display-name refusals, which the adapter wraps as `Selvage: ${refusal}`. The scan below can
 * only pin the wildcard, so they are pinned by asking the module that writes them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { displayNameRefusal } from '../src/adapter/display-name.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ADAPTER = resolve(ROOT, 'src', 'adapter');

/**
 * The canonical English phrase for each intent, as the manifest's palette title. Both clients
 * carry these words, and a command id may not change without the handlers and the status bar
 * changing with it.
 */
const TITLES: Record<string, string> = {
  'selvage.host': 'Host a session',
  'selvage.join': 'Join a session from an invite link',
  'selvage.copyInvite': 'Copy the invite link',
  'selvage.openDocument': 'Open a document from the room',
  'selvage.fetch': 'Fetch a path from the room',
  'selvage.leave': 'Leave the session',
  'selvage.displayName': 'Set the name other participants see',
  'selvage.peers': "List the room's participants",
  'selvage.goToParticipant': 'Go to a participant',
  'selvage.followParticipant': 'Follow a participant',
  'selvage.stopFollowing': 'Stop following',
};

/**
 * Every sentence this client can show, as the source literal it is written as, with each `${…}`
 * collapsed to `${}` so the pin is on the words and not on the expressions that fill them. A
 * sentence whose holes move, or a moment whose words change, breaks this list and has to be
 * changed here deliberately. A sentence said at two moments — an empty session and an empty room
 * both say `join a session first` — is listed once: what is pinned is the words, not how often
 * they are said.
 */
const SENTENCES = [
  // Joining and hosting.
  '`Selvage: room ${} is open; copy the invite link to let someone join.`',
  '`Selvage: you are already hosting room ${}; the invite link is on the clipboard.`',
  '`Selvage: you are hosting room ${}; joining another session ends this room for everyone.`',
  '`Selvage: you are in room ${}; joining another session leaves it.`',
  '`Selvage: you are in room ${}; hosting a session means leaving it first.`',
  '`Selvage: joined room ${}; opening ${}${}.`',
  '`Selvage: fetching ${}…`',
  '`Selvage: ${} is still empty: the host has not sent its text yet. Selvage: Fetch a path from the room tries again.`',
  '`Selvage: joined room ${}. Selvage: Open a document from the room lists every path.`',
  '`Selvage: could not host on ${} (${}); is the server running at that address?`',
  '`Selvage: could not join the session (${}); check the link is complete and the server is running.`',
  '`Selvage: joined room ${}; the room has no open documents yet.`',
  '`Selvage: ${} is hosting again.`',
  '`Selvage: the host left the room; it closes in ${} unless they come back.`',
  '`Selvage: the room is gone (${}).`',
  "'Selvage: the connection ended and the session is over; it could not be re-established.'",
  // The invite, and the room's documents.
  "'Selvage: the invite link is on the clipboard.'",
  "'Selvage: there is no invite link: only the connection that opened the room has one.'",
  "'Selvage: join a session first.'",
  "'Selvage: the room has no open documents yet.'",
  "'Selvage: you are hosting, so the files you open are the ones the room has.'",
  '`Selvage: could not open ${} from the room: ${}`',
  '`Selvage: no shared document matches "${}".`',
  // Fetching a listed path's content (`selvage.fetch`, the `:SelvageFetch` twin).
  "'Selvage: you are hosting, so the files a mirror would hold are already on your disk.'",
  "'Selvage: the room lists no files to fetch.'",
  '`Selvage: no file the room lists matches "${}".`',
  '`Selvage: fetching opens ${} in the room, so every peer receives it.`',
  "'Selvage: fetching opens them in the room, so every peer receives them.'",
  "'Selvage: fetched the files.'",
  '`Selvage: could not fetch ${} from the room: ${}`',
  '`Selvage: fetch all ${} listed files into the mirror? Each is held in the room so every peer receives it, and the mirror holds whatever arrives.`',
  '`Selvage: fetching all ${} listed files at once would hold every one in the room; fetch a file or a directory instead (at most ${} at once).`',
  '`Selvage: ${} files under ${} is more than one fetch holds (at most ${} at once); name a narrower directory.`',
  // The mirror's refusals: what the room cannot do, said where the client is present.
  '`Selvage: ${} is not in the room, so it is not shared; the mirror holds the room\'s files and is removed when the session ends.`',
  '`Selvage: ${} is not in the room, so the save is not shared; copy it out of the mirror to keep it.`',
  '`Selvage: ${} of the room\'s files could not be mirrored, starting with ${}.`',
  '`Selvage: could not open the room\'s folder in this window (${}); join again.`',
  '`Selvage: removed room ${}\'s leftover files from the last session; they were the room\'s text, not unsaved work.`',
  '`Selvage: could not join room ${}: the editor gave this window no storage for the room\'s files.`',
  "'Selvage: not in a session.'",
  "'Selvage: left the session.'",
  '`Selvage: room ${}`',
  // The display name.
  "'Selvage: no display name is set yet.'",
  '`Selvage: the name others see is "${}".`',
  '`Selvage: display name set to "${}".`',
  '`Selvage: ${}`',
  '`Selvage: could not write the "selvage.displayName" setting, so the name was not changed (${}).`',
  // What the room's own reports say.
  "`Selvage: ${} was out of step with the room; the room's copy has been put back.`",
  "`Selvage: the editor would not apply the room's change to ${}; the file may be read-only.`",
  '`Selvage: could not save ${}; the file on disk is behind the room.`',
  '`Selvage: could not save ${}; the file on disk is behind the room (${}).`',
  '`Selvage: ${} (${})`',
  // The list of participants.
  "'Selvage: no other participants yet.'",
  "`Selvage: you're the only one here — copy the invite link.`",
  // Going to a participant, and following one. Start and an asked-for stop live in the
  // status item: the indicator going up and down is the whole announcement, so there is
  // no toast for those. A stop the user did not ask for — a local edit, a go-to — says so.
  "'Selvage: not following anyone.'",
  '`Selvage: ${} left the room, so following stopped.`',
  '`Selvage: Stopped following ${}.`',
  '`Selvage: nothing to go to: ${} is not in a document.`',
  '`Selvage: nothing to follow: ${} is not in a document.`',
  "`Selvage: nothing to go to: ${}'s caret does not resolve here.`",
];

/**
 * The two sentences a display name can be refused with. They are written without the `Selvage: `
 * prefix, because the adapter wraps them, so the scan above sees only the wildcard.
 */
const REFUSALS = [
  'a name is needed.',
  'this name is 33 UTF-16 code units and the limit is 32; a name is refused rather than shortened.',
];

/** Every `Selvage: …` string literal in a source, `${…}` collapsed. */
function sentencesIn(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    // A sentence quoted in a comment is documentation; nothing can show it to a user.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      continue;
    }
    for (const match of line.matchAll(/`Selvage: [^`]*`|'Selvage: [^']*'/g)) {
      found.push(match[0].replaceAll(/\$\{[^}]*\}/g, '${}'));
    }
  }
  return found;
}

test('the manifest gives every command the shared phrase, under an unchanged id', () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
    contributes?: { commands?: Array<{ command: string; title: string }> };
  };
  const contributed = manifest.contributes?.commands ?? [];
  const titles: Record<string, string> = {};
  for (const entry of contributed) {
    titles[entry.command] = entry.title;
  }
  assert.deepEqual(
    titles,
    TITLES,
    'a command id, or the phrase both clients name it by, has changed',
  );
});

test('every sentence this client can show is the shared one', () => {
  const found: string[] = [];
  for (const name of readdirSync(ADAPTER).filter((entry) => entry.endsWith('.ts'))) {
    found.push(...sentencesIn(readFileSync(resolve(ADAPTER, name), 'utf8')));
  }
  assert.ok(found.length > 0, 'no sentence in src/adapter/ is written as a `Selvage: …` literal');
  assert.deepEqual(
    [...new Set(found)].sort(),
    [...new Set(SENTENCES)].sort(),
    'the sentences a window can show are not the ones the two clients agreed on',
  );
});

test('a display name is refused in the words both clients use', () => {
  assert.deepEqual(
    [displayNameRefusal(''), displayNameRefusal('a'.repeat(33))],
    REFUSALS,
    'a refusal a user can be shown is not the shared one',
  );
});
