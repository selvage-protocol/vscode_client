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
  'selvage.fetch': 'Download a file from the room',
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
  // Downloading a listed path's content — the `:SelvageFetch` twin — and what a hold of
  // one costs the room.
  "'Selvage: Your files are already on your disk, so there is nothing to fetch while you host.'",
  '`Selvage: Could not fetch ${} from the room: ${}`',
  '`Selvage: No file the room lists matches "${}".`',
  '`Selvage: ${} files under ${} is more than one fetch holds (at most ${} at once); name a narrower directory.`',
  "'Selvage: The room lists no files to fetch.'",
  '`Selvage: Fetching all ${} listed files at once would hold every one in the room; fetch a file or a directory instead (at most ${} at once).`',
  '`Selvage: Fetch all ${} listed files? Everyone in the room receives them, and they are stored on your disk.`',
  '`Selvage: Fetching opens ${} in the room, so every peer receives it.`',
  "'Selvage: Fetching opens them in the room, so every peer receives them.'",
  "'Selvage: Fetched the files.'",
  '`Selvage: Fetching ${}…`',
  '`Selvage: ${} is still empty — the host has not sent its text yet. Fetch it again later.`',
  // Where a peer is, and following one.
  "'Selvage: No other participants yet.'",
  '`Selvage: Nothing to go to: ${} is not in a document.`',
  '`Selvage: Nothing to follow: ${} is not in a document.`',
  '`Selvage: Stopped following ${}.`',
  "'Selvage: Not following anyone.'",
  '`Selvage: Could not open ${} from the room: ${}`',
  '`Selvage: Nothing to go to: ${}\'s caret does not resolve here.`',
  '`Selvage: ${} left the room, so following stopped.`',
  // The room's shape on disk: what the listing could not keep in step, and what is not
  // part of the room at all.
  '`Selvage: ${} of the room\'s files could not be written to disk, starting with ${}.`',
  '`Selvage: ${} is not part of the room, so it is not shared. Save it outside the room\'s folder to keep it.`',
  '`Selvage: ${} is not part of the room, so this save was not shared. Copy it outside the room\'s folder to keep it.`',
  // What the room's own reports say.
  '`Selvage: The host left the room; it closes in ${} unless they come back.`',
  '`Selvage: ${} is hosting again.`',
  '`Selvage: The room is gone (${}).`',
  '`Selvage: The editor would not apply the room\'s change to ${}; the file may be read-only.`',
  '`Selvage: ${} was out of step with the room; the room\'s copy has been put back.`',
  '`Selvage: Could not save ${}; the file on disk is behind the room.`',
  '`Selvage: Could not save ${}; the file on disk is behind the room (${}).`',
  "'Selvage: The connection ended and the session is over; it could not be re-established.'",
  // Host and join: what each costs a room that is already live, and the window a join takes.
  '`Selvage: You are hosting this session; joining another session ends this room for everyone.`',
  '`Selvage: You are in this session; joining another session leaves it.`',
  '`Selvage: You are in this session; hosting a session means leaving it first.`',
  '`Selvage: Joining replaces this window\'s folder with the room\'s files. Your own folder stays on disk — reopen it whenever you like.`',
  // A fault the room reported, and the sentence the capacity refusal stands in for:
  // `x.room_full` on the wire is a sentence here.
  "'Selvage: The room is full — it seats no more people.'",
  // Hosting, and the invite it leaves on the clipboard.
  '`Selvage: You are already hosting this session; the invite link is on the clipboard.`',
  "'Selvage: Open a folder first — hosting shares the folder this window is open on, and a room from a window with no folder would share nothing.'",
  '`Selvage: Connecting to ${}…`',
  // Joining: the wait, the refusals, and the landing.
  '`Selvage: Could not host on ${}. ${}`',
  '`Selvage: The room is open, but the invite link could not be copied (${}).`',
  '`Selvage: The room is open. Send this link to your friend — it is on the clipboard.`',
  '`Selvage: ${}`',
  '`Selvage: Could not join the session: the editor gave this window no storage for the room\'s files.`',
  '`Selvage: Could not open the room\'s folder in this window (${}); join again.`',
  '`Selvage: Could not join the session. ${}`',
  '`Selvage: Cleaned up the files left by the last session; its invite link no longer works.`',
  '`Selvage: Cleaned up the files left by the last session.`',
  '`Selvage: Joined the room — it has no open documents yet.`',
  '`Selvage: Joined the room. The room has ${}.`',
  '`Selvage: Joined the room — opening ${}.${}`',
  // The invite, and the room's documents.
  "'Selvage: There is no invite link; host or join a room first.'",
  "'Selvage: The invite link is on the clipboard.'",
  "'Selvage: Join a session first.'",
  "'Selvage: You are the host — the files you open are the ones your guests see.'",
  "'Selvage: The room has no open documents yet.'",
  '`Selvage: No shared document matches "${}".`',
  // The display name, and the room's participants.
  "'Selvage: Not in a session.'",
  "'Selvage: Left the session.'",
  "'Selvage: No display name is set yet.'",
  '`Selvage: The name others see is "${}".`',
  '`Selvage: Could not write the "selvage.displayName" setting, so the name was not changed (${}).`',
  '`Selvage: Display name set to "${}".`',
  '`Selvage: Who is in the room`',
  // The status bar: the one Selvage surface a window always has, so its fragments are pinned
  // here with the codicon that leads them. The scan below reaches them through the same
  // optional prefix a template carries (`sentencesIn`).
  "'$(sync~spin) Selvage: reconnecting…'",
  "'$(warning) Selvage: the host is away'",
  '`$(radio-tower) Selvage: ${} — ${}`',
  '`$(person) Selvage: following ${}`',
  // The empty room's one row: the invitation to copy the link.
  '`Selvage: You\'re the only one here — copy the invite link.`',
];

/**
 * The two sentences a display name can be refused with. They are written without the `Selvage: `
 * prefix, because the adapter wraps them, so the scan above sees only the wildcard.
 */
const REFUSALS = [
  'A name is needed.',
  'This name is 33 UTF-16 code units and the limit is 32; a name is refused rather than shortened.',
];

/** Every `Selvage: …` string literal in a source, `${…}` collapsed. A status-bar fragment leads
 * with a codicon inside the same literal, so the prefix is optional rather than absent.
 */
function sentencesIn(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    // A sentence quoted in a comment is documentation; nothing can show it to a user.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      continue;
    }
    for (const match of line.matchAll(
      /`(?:\$\([^`)]*\) )?Selvage: [^`]*`|'(?:\$\([^')]*\) )?Selvage: [^']*'/g,
    )) {
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
