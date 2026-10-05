/**
 * The words every client says at the same moments, pinned as the web client says them.
 *
 * A sentence here is the web's own, so a change to one of them is a change to what every client
 * says and has to be made here deliberately. `Stopped following … because you moved your cursor.`,
 * `hostAwaySentence`, the download of several files and the leave question's first sentence alone are
 * the ones the desktop clients need that the web has no moment for as a named sentence; they follow
 * the web's pattern.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endingReason } from '../src/engine/index.ts';
import {
  COPIED_LABEL,
  COPIED_STAND_MS,
  COPY_INVITE_LABEL,
  DOWNLOAD_COST_MANY_SENTENCE,
  HOST_LEAVE_CONSEQUENCE,
  HOST_LEAVE_QUESTION,
  LEAVE_ASKING_LABEL,
  LEAVE_CANCEL_LABEL,
  LEAVE_HOST_LABEL,
  RECONNECTING_NOTE,
  SESSION_ENDED_MESSAGE,
  SHARED_SESSION_IDENTITY,
  disconnectingReading,
  downloadCostSentence,
  followEndedByFileGone,
  followEndedByLeaving,
  followEndedByMoving,
  followEndedByTyping,
  goToCursorNotFound,
  goToNotInFile,
  graceWording,
  guestIdentity,
  hostAwaySentence,
  hostBackSentence,
  hostLeftSentence,
  hostingIdentity,
  roomGoneSentence,
} from '../src/bridge/index.ts';

test('a session is named by the folder it shares, or by its host', () => {
  assert.equal(hostingIdentity('notes'), 'Sharing “notes”');
  assert.equal(guestIdentity('Ada'), 'In Ada’s session');
  assert.equal(guestIdentity(undefined), 'In a shared session');
  assert.equal(SHARED_SESSION_IDENTITY, 'In a shared session');
});

test('the invite control reads Copy invite link, then Copied for 1800 ms', () => {
  assert.equal(COPY_INVITE_LABEL, 'Copy invite link');
  assert.equal(COPIED_LABEL, 'Copied');
  assert.equal(COPIED_STAND_MS, 1800);
});

test('the grace window reads in the largest whole unit, rounded down', () => {
  assert.equal(graceWording(500), 'a moment');
  assert.equal(graceWording(-1), 'a moment');
  assert.equal(graceWording(1_000), '1 second');
  assert.equal(graceWording(30_000), '30 seconds');
  assert.equal(graceWording(59_999), '59 seconds');
  assert.equal(graceWording(60_000), '1 minute');
  assert.equal(graceWording(119_999), '1 minute');
  assert.equal(graceWording(3_599_999), '59 minutes');
  assert.equal(graceWording(3_600_000), '1 hour');
  assert.equal(graceWording(7_200_000), '2 hours');
});

test('a window under a minute counts down in whole seconds, rounded up', () => {
  assert.equal(disconnectingReading(30_000, 30_000), '30s');
  assert.equal(disconnectingReading(30_000, 1_000), '1s');
  assert.equal(disconnectingReading(30_000, 400), '1s');
  assert.equal(disconnectingReading(30_000, 0), '0s');
  assert.equal(disconnectingReading(30_000, -5), '0s');
});

test('a window of a minute or more counts down in the unit graceWording picks', () => {
  assert.equal(disconnectingReading(60_000, 60_000), '1 minute');
  assert.equal(disconnectingReading(600_000, 599_999), '9 minutes');
  assert.equal(disconnectingReading(3_600_000, 3_600_000), '1 hour');
});

test('the host leaving and coming back name the host, or the role when the name is blank', () => {
  assert.equal(hostLeftSentence('Jo'), 'Jo left the session');
  assert.equal(hostLeftSentence('  Jo  '), 'Jo left the session');
  assert.equal(hostLeftSentence(''), 'The host left the session');
  assert.equal(hostBackSentence('Jo'), 'Jo is back. The session continues.');
  assert.equal(hostBackSentence('  '), 'the host is back. The session continues.');
});

test('the host-away sentence says the window once, rounded to the second the countdown starts on', () => {
  assert.equal(hostAwaySentence('Jo', 30_000), 'Jo left the session. The room disconnects in 30 seconds.');
  assert.equal(hostAwaySentence('Jo', 29_999), 'Jo left the session. The room disconnects in 30 seconds.');
  assert.equal(hostAwaySentence('', 3_600_000), 'The host left the session. The room disconnects in 1 hour.');
  assert.equal(hostAwaySentence('Jo', -1), 'Jo left the session. The room disconnects in a moment.');
  // The countdown and the sentence read one window the same way.
  assert.equal(disconnectingReading(29_999, 29_999), '30s');
});

test('from a minute up, the host-away sentence names the window the countdown starts on', () => {
  for (const grace of [60_000, 119_999, 120_000, 3_599_999, 3_600_000]) {
    assert.equal(
      hostAwaySentence('Jo', grace),
      `Jo left the session. The room disconnects in ${disconnectingReading(grace, grace)}.`,
      `a ${grace} ms window reads one way in the sentence and another in the countdown`,
    );
  }
  assert.equal(hostAwaySentence('Jo', 119_999), 'Jo left the session. The room disconnects in 1 minute.');
});

test('a dropped socket says it is reconnecting', () => {
  assert.equal(RECONNECTING_NOTE, 'Connection dropped. Reconnecting…');
});

test('a go-to with nowhere to go says why, as a reason a headline or a full stop finishes', () => {
  assert.equal(goToNotInFile('Ada'), 'Ada is not in a file');
  assert.equal(goToCursorNotFound('Ada'), 'Ada’s cursor could not be found in this file');
});

test('a follow that ended says why', () => {
  assert.equal(followEndedByTyping('Ada'), 'Stopped following Ada because you started typing.');
  assert.equal(followEndedByMoving('Ada'), 'Stopped following Ada because you moved your cursor.');
  assert.equal(followEndedByLeaving('Ada'), 'Ada left the room, so following stopped.');
  assert.equal(followEndedByFileGone('Ada'), 'Stopped following Ada because the file is gone.');
});

test('the first download says what it costs the room', () => {
  assert.equal(
    downloadCostSentence('src/main.rs'),
    'Downloading src/main.rs opens it in the room, so everyone there gets its text.',
  );
  assert.equal(
    DOWNLOAD_COST_MANY_SENTENCE,
    'Downloading these files opens them in the room, so everyone there gets their text.',
  );
});

test('a host’s leave is named for its consequence and asks with two answers', () => {
  assert.equal(LEAVE_HOST_LABEL, 'Leave and end the room');
  assert.equal(LEAVE_ASKING_LABEL, 'Leave anyway');
  assert.equal(LEAVE_CANCEL_LABEL, 'Cancel');
  assert.equal(HOST_LEAVE_CONSEQUENCE, 'Leaving ends the room for everyone and stops the invite link.');
  assert.equal(
    HOST_LEAVE_QUESTION,
    'Leaving ends the room for everyone and stops the invite link. Your last few keystrokes may not reach your folder.',
  );
});

test('a room that is gone is said in the person’s words', () => {
  assert.equal(roomGoneSentence(endingReason('closing')), 'The host ended the session.');
  assert.equal(roomGoneSentence(` ${endingReason('closing')} `), 'The host ended the session.');
  assert.equal(roomGoneSentence(endingReason('host-away')), 'The host was away too long, so the session ended.');
  assert.equal(roomGoneSentence('host did not return'), 'The session ended (host did not return).');
  assert.equal(roomGoneSentence('  '), 'The session ended.');
  assert.equal(SESSION_ENDED_MESSAGE, 'The session ended.');
});
