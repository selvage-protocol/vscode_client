/**
 * The words every client says at the same moments: a session's identity, the invite control, the
 * host's absence and return, a follow that ended, a host's leave, and the end of a session. They
 * are the web client's, kept here so each client says the same sentence by construction rather than
 * by copying it.
 */

import { endingReason } from '../engine/peer.ts';

// -- a session's identity -------------------------------------------------------------------------

/** What a host's session is called: the folder it shares. */
export function hostingIdentity(folder: string): string {
  return `Sharing “${folder}”`;
}

/** What a guest's session is called before the host's name has arrived. */
export const SHARED_SESSION_IDENTITY = 'In a shared session';

/** What a guest's session is called: the host's, once the room has named them. */
export function guestIdentity(hostName: string | undefined): string {
  return hostName === undefined ? SHARED_SESSION_IDENTITY : `In ${hostName}’s session`;
}

// -- the invite control ---------------------------------------------------------------------------

/** The invite control's own words. */
export const COPY_INVITE_LABEL = 'Copy invite link';

/** What the invite control reads after a copy. */
export const COPIED_LABEL = 'Copied';

/** How long `COPIED_LABEL` stands before the control reads `COPY_INVITE_LABEL` again. */
export const COPIED_STAND_MS = 1800;

// -- the host's absence ---------------------------------------------------------------------------

/**
 * A dropped socket: the room is out of reach and the engine's bounded retry is re-dialling it
 * (`PROTOCOL.md` §9.1).
 */
export const RECONNECTING_NOTE = 'Connection dropped. Reconnecting…';

/**
 * How long the grace window reads: the largest whole unit the window still has one of, rounded
 * down, so the reading never gives the guest more time than the room has. The window is the
 * server's own number (`room_grace_ms`, echoed on the detach frame), so it can be anything up to an
 * hour, and a raw second count makes the reader divide it.
 */
export function graceWording(graceMs: number): string {
  const ms = Math.max(0, graceMs);
  const seconds = Math.floor(ms / 1000);
  if (seconds === 0) {
    return 'a moment';
  }
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(ms / 3_600_000);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * What the countdown reads at `remainingMs` of a window `graceMs` long.
 *
 * A window under a minute, which is every grace a server sends by default, is counted in whole
 * seconds (`18s`). A longer one is read in the unit `graceWording` picks, because nobody counts
 * 3600 seconds. The second is rounded up: with any part of a second left the room still has a
 * second to come back in.
 */
export function disconnectingReading(graceMs: number, remainingMs: number): string {
  const left = Math.max(0, remainingMs);
  if (graceMs >= 60_000) {
    return graceWording(left);
  }
  return `${Math.ceil(left / 1000)}s`;
}

/**
 * The host's absence, as a headline. The name is the room's, so it can be blank (a guest that
 * joined after the host's socket dropped never saw one), and the sentence then falls back to the
 * role rather than to a gap.
 */
export function hostLeftSentence(name: string): string {
  const who = name.trim() === '' ? 'The host' : name.trim();
  return `${who} left the session`;
}

/**
 * The host's absence said once, with the window as a unit rather than a number the reader has to
 * catch: the sentence for a notification or a screen reader, where a ticking countdown would be
 * read out every second.
 */
export function hostAwaySentence(name: string, graceMs: number): string {
  return `${hostLeftSentence(name)}. The room disconnects in ${windowWords(Math.max(0, graceMs))}.`;
}

/** The host coming back inside the grace. A blank name falls back to the role. */
export function hostBackSentence(name: string): string {
  const who = name.trim() === '' ? 'the host' : name.trim();
  return `${who} is back. The session continues.`;
}

/**
 * The window as words, read the way `disconnectingReading` starts the countdown on it, so the two
 * readings of one window cannot disagree. Under a minute the countdown rounds up to the whole
 * second, so a server that advertises `29 999 ms` reads `30s` there and `30 seconds` here. From a
 * minute up it reads `graceWording`'s unit rounded down, so `119 999 ms` is `1 minute` in both.
 */
function windowWords(graceMs: number): string {
  return graceMs >= 60_000 ? graceWording(graceMs) : graceWording(Math.ceil(graceMs / 1000) * 1000);
}

// -- a follow that ended --------------------------------------------------------------------------

/** Following ended because the follower typed. */
export function followEndedByTyping(name: string): string {
  return `Stopped following ${name} because you started typing.`;
}

/** Following ended because the follower moved their own caret. */
export function followEndedByMoving(name: string): string {
  return `Stopped following ${name} because you moved.`;
}

/** Following ended because the followed peer left the room. */
export function followEndedByLeaving(name: string): string {
  return `${name} left the room, so following stopped.`;
}

/** Following ended because the file the followed peer was in left the room. */
export function followEndedByFileGone(name: string): string {
  return `Stopped following ${name} because the file is gone.`;
}

// -- a host's leave -------------------------------------------------------------------------------

/**
 * The leave control's name for a host, whose connection is the room: the consequence is in the
 * name before it is pressed, not only in the question the press opens.
 */
export const LEAVE_HOST_LABEL = 'Leave and end the room';

/** The answer that leaves: the words on the destructive button. */
export const LEAVE_ASKING_LABEL = 'Leave anyway';

/** The answer that does not. */
export const LEAVE_CANCEL_LABEL = 'Cancel';

/**
 * The question a host's leave asks. It names the consequence rather than the countdown that follows
 * it: the room and its invite link go with the host who leaves, and the last keystrokes may not
 * reach the folder.
 */
export const HOST_LEAVE_QUESTION =
  'Leaving ends the room for everyone and stops the invite link, and your last few keystrokes may not reach your folder.';

// -- the end of a session -------------------------------------------------------------------------

/** A terminal disconnect that carried no room-gone reason: reconnection gave up. */
export const SESSION_ENDED_MESSAGE = 'The session ended.';

/** The room is gone: one short sentence, in the person's words rather than the protocol's. */
export function roomGoneSentence(reason: string): string {
  const why = reason.trim();
  if (why === endingReason('closing')) {
    return 'The host ended the session.';
  }
  if (why === endingReason('host-away')) {
    return 'The host was away too long, so the session ended.';
  }
  return why === '' ? SESSION_ENDED_MESSAGE : `The session ended (${why}).`;
}
