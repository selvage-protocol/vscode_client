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
  'selvage.changeServer': 'Change the server',
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
  "'Selvage: your files are already on your disk, so there is nothing to fetch while you host.'",
  '`Selvage: could not fetch ${} from the room: ${}`',
  '`Selvage: no file the room lists matches "${}".`',
  '`Selvage: ${} files under ${} is more than one fetch holds (at most ${} at once); name a narrower directory.`',
  "'Selvage: the room lists no files to fetch.'",
  '`Selvage: fetching all ${} listed files at once would hold every one in the room; fetch a file or a directory instead (at most ${} at once).`',
  '`Selvage: fetch all ${} listed files? Everyone in the room receives them, and they are stored on your disk.`',
  '`Selvage: fetching opens ${} in the room, so every peer receives it.`',
  "'Selvage: fetching opens them in the room, so every peer receives them.'",
  "'Selvage: fetched the files.'",
  '`Selvage: fetching ${}…`',
  '`Selvage: ${} is still empty — the host has not sent its text yet. Fetch it again later.`',
  // Where a peer is, and following one.
  "'Selvage: no other participants yet.'",
  '`Selvage: nothing to go to: ${} is not in a document.`',
  '`Selvage: nothing to follow: ${} is not in a document.`',
  '`Selvage: stopped following ${}.`',
  "'Selvage: not following anyone.'",
  '`Selvage: could not open ${} from the room: ${}`',
  '`Selvage: nothing to go to: ${}\'s caret does not resolve here.`',
  '`Selvage: ${} left the room, so following stopped.`',
  // The room's shape on disk: what the listing could not keep in step, and what is not
  // part of the room at all.
  '`Selvage: ${} of the room\'s files could not be written to disk, starting with ${}.`',
  '`Selvage: ${} is not part of the room, so it is not shared. Save it outside the room\'s folder to keep it.`',
  '`Selvage: ${} is not part of the room, so this save was not shared. Copy it outside the room\'s folder to keep it.`',
  // What the room's own reports say. The host-detached and host-reclaimed sentences are
  // full sentences shown without the wrapper; they are pinned by `PLAIN_SENTENCES` below.
  '`Selvage: the room is gone (${}).`',
  '`Selvage: the editor would not apply the room\'s change to ${}; the file may be read-only.`',
  '`Selvage: ${} was out of step with the room; the room\'s copy has been put back.`',
  '`Selvage: could not save ${}; the file on disk is behind the room.`',
  '`Selvage: could not save ${}; the file on disk is behind the room (${}).`',
  "'Selvage: the connection ended and the session is over; it could not be re-established.'",
  // Host and join: what each costs a room that is already live, and the window a join takes.
  '`Selvage: you are hosting this session; joining another session ends this room for everyone.`',
  '`Selvage: you are in this session; joining another session leaves it.`',
  '`Selvage: you are in this session; hosting a session means leaving it first.`',
  '`Selvage: joining replaces this window\'s folder with the room\'s files. Your own folder stays on disk — reopen it whenever you like.`',
  // A fault the room reported, and the sentence the capacity refusal stands in for:
  // `x.room_full` on the wire is a sentence here.
  "'Selvage: the room is full — it seats no more people.'",
  // Hosting, and the invite it leaves on the clipboard.
  '`Selvage: you are already hosting this session; the invite link is on the clipboard.`',
  '`Selvage: you are already hosting this session, but the invite link could not be copied (${}).`',
  "'Selvage: you are already hosting this session, but this connection holds no invite link to send.'",
  "'Selvage: open a folder first — hosting shares the folder this window is open on, and a room from a window with no folder would share nothing.'",
  '`Selvage: connecting to ${}…`',
  // Joining: the wait, the refusals, and the landing.
  '`Selvage: could not host on ${}. ${}`',
  '`Selvage: the room is open, but the invite link could not be copied (${}).`',
  "'Selvage: the room is open, but this connection holds no invite link to send.'",
  '`Selvage: the room is open on ${}. Send this link to your friend — it is on the clipboard.`',
  "'Selvage: the room is open. Send this link to your friend — it is on the clipboard.'",
  '`Selvage: will host on ${} next. Leave this session and host again to move there.`',
  "'Selvage: no server is remembered yet; the next host asks.'",
  '`Selvage: the next host uses ${}.`',
  '`Selvage: the "selvage.serverUrl" setting fixes the server at ${}; change it in Settings to use a different one.`',
  '`Selvage: ${}`',
  '`Selvage: could not join the session: the editor gave this window no storage for the room\'s files.`',
  '`Selvage: could not open the room\'s folder in this window (${}); join again.`',
  '`Selvage: could not join the session. ${}`',
  '`Selvage: cleaned up the files left by the last session; its invite link no longer works.`',
  '`Selvage: cleaned up the files left by the last session.`',
  '`Selvage: joined the room; the room has no open documents yet.`',
  '`Selvage: joined the room — opening ${}.`',
  '`Selvage: joined the room — opening ${}; ${} more in the room.`',
  '`Selvage: joined the room.`',
  // The invite, and the room's documents.
  "'Selvage: there is no invite link; host or join a room first.'",
  "'Selvage: the invite link is on the clipboard.'",
  '`Selvage: the invite link could not be copied (${}).`',
  "'Selvage: this session holds no invite link to copy.'",
  "'Selvage: join a session first.'",
  "'Selvage: you are the host — the files you open are the ones your guests see.'",
  // `§13.4`'s third role (`§13.9`): the room's own word on this connection, said once, in the
  // words the Neovim client says it in.
  "'Selvage: you are a viewer in this room, so its documents are read-only.'",
  "'Selvage: the room has no open documents yet.'",
  '`Selvage: no shared document matches "${}".`',
  // The display name, and the room's participants.
  "'Selvage: not in a session.'",
  "'Selvage: left the session.'",
  "'Selvage: no display name is set yet.'",
  '`Selvage: the name others see is "${}".`',
  '`Selvage: could not write the "selvage.displayName" setting, so the name was not changed (${}).`',
  '`Selvage: display name set to "${}".`',
  '`Selvage: who is in the room`',
  // The status bar: the one Selvage surface a window always has, so its fragments are pinned
  // here with the codicon that leads them. The scan below reaches them through the same
  // optional prefix a template carries (`sentencesIn`).
  "'$(sync~spin) Selvage: reconnecting…'",
  '`$(warning) Selvage: host away — room closes in ${}s`',
  '`$(radio-tower) Selvage: ${} — ${}`',
  '`$(person) Selvage: following ${}`',
  // The empty room's one row: the invitation to copy the link.
  '`Selvage: you\'re the only one here — copy the invite link.`',
];

/**
 * The shared sentences this client shows without the `Selvage: ` wrapper. Each is a full
 * sentence the two clients agreed on, so it is what the user reads; the holes are `${}` as
 * in `SENTENCES`. Pinned by presence in the adapter source, because the scan above finds only
 * the wrapped literals.
 */
const PLAIN_SENTENCES = [
  'Stopped following ${} — you moved.',
  'Host disconnected. ${} left — if they return within ${} the session continues, otherwise this room closes and your local copy is kept.',
  '${} is back — the session continues.',
  'The room closed. Your copy is kept at ${}.',
];

/**
 * The two sentences a display name can be refused with. They are written without the `Selvage: `
 * prefix, because the adapter wraps them, so the scan above sees only the wildcard.
 */
const REFUSALS = [
  'a name is needed.',
  'this name is 33 UTF-16 code units and the limit is 32; a name is refused rather than shortened.',
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

/**
 * Whether a plain shared sentence appears in a source, with each `${}` hole matching any
 * `${…}` expression the adapter fills it with. The sentence is matched as words, so a change
 * to them is a failure rather than a silent miss. Comments are stripped first, so a sentence
 * left behind in a comment cannot stand in for one the code still shows.
 */
function containsPlainSentence(source: string, sentence: string): boolean {
  const stripped = stripComments(source);
  const parts = sentence.split('${}').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('\\$\\{[^}]*\\}')).test(stripped);
}

/** The source with its comments removed: line, block, and their shapes inside code. String
 * and template literals are kept whole, so a sentence they carry still matches. The scan only
 * has to tell a comment from a literal in the adapter's own sources: `${}` inside a template's
 * expression opens code, not another hole for a `}` to close.
 */
function stripComments(source: string): string {
  let out = '';
  let index = 0;
  const length = source.length;
  let string: string | undefined;
  let expression = 0;
  let regex = false;
  while (index < length) {
    const char = source[index] as string;
    const next = (index + 1 < length ? source[index + 1] : '') as string;
    if (string !== undefined) {
      out += char;
      if (char === '\\') {
        out += next;
        index += 2;
        continue;
      }
      if (string === '`' && char === '$' && next === '{') {
        out += next;
        index += 2;
        expression += 1;
        continue;
      }
      if (char === string && (string !== '`' || expression === 0)) {
        string = undefined;
      } else if (string === '`' && expression > 0 && char === '}') {
        expression -= 1;
      }
      index += 1;
      continue;
    }
    if (regex) {
      out += char;
      if (char === '\\') {
        out += next;
        index += 2;
        continue;
      }
      if (char === '[') {
        let close = index + 1;
        if (source[close] === '^') {
          close += 1;
        }
        if (source[close] === ']') {
          close += 1;
        }
        while (close < length && source[close] !== ']') {
          close += source[close] === '\\' ? 2 : 1;
        }
        out += source.slice(index + 1, close + 1);
        index = close + 1;
        continue;
      }
      if (char === '/') {
        regex = false;
      }
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      out += '\n';
      index = end === -1 ? length : end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      string = char;
      expression = 0;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/') {
      const before = out.replace(/\s+$/, '').slice(-1);
      if (before === '' || '([{=:;,!&|?+-*%<>^~'.includes(before)) {
        regex = true;
      }
    }
    out += char;
    index += 1;
    continue;
  }
  return out;
}

test('a shared sentence in a comment alone proves nothing', () => {
  const sentence = 'Stopped following ${} — you moved.';
  const live = 'void vscode.window.showInformationMessage(`Stopped following ${name} — you moved.`);';
  assert.equal(containsPlainSentence(live, sentence), true, 'a shown sentence no longer matches');
  const commentedOut = [
    `// ${live}`,
    `/* ${live} */`,
    `/**\n * ${live}\n */`,
    'const pattern = /Stopped following /; // ' + live,
  ];
  for (const source of commentedOut) {
    assert.equal(
      containsPlainSentence(source, sentence),
      false,
      `a comment stood in for the sentence: ${source}`,
    );
  }
  const codeThenComment = `${live} // Stopped following you — you moved.`;
  assert.equal(
    containsPlainSentence(codeThenComment, sentence),
    true,
    'a trailing comment hid the real code before it',
  );
});

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

test('the full sentences shown without a wrapper are the shared ones', () => {
  const source = readdirSync(ADAPTER)
    .filter((entry) => entry.endsWith('.ts'))
    .map((name) => readFileSync(resolve(ADAPTER, name), 'utf8'))
    .join('\n');
  const missing = PLAIN_SENTENCES.filter((sentence) => !containsPlainSentence(source, sentence));
  assert.deepEqual(missing, [], 'a shared sentence is not written in the adapter as agreed');
});

test('a display name is refused in the words both clients use', () => {
  assert.deepEqual(
    [displayNameRefusal(''), displayNameRefusal('a'.repeat(33))],
    REFUSALS,
    'a refusal a user can be shown is not the shared one',
  );
});
