/**
 * The bridge: the half of the editor adapter that knows nothing about an editor.
 *
 * `DESIGN.md` §6 splits a client into a sync engine and an editor adapter, and the study
 * (`docs/studies/vscode-plugin.md` §6) puts both in the extension host behind a module
 * seam. This is the seam's editor-independent half. It decides *what* has to happen to a
 * document — which bytes enter the replica, which change an editor must apply, when a
 * document is written — and the adapter decides *how*.
 *
 * The split is what keeps the part that imports `vscode` small enough to review by reading.
 * Everything below is a rule rather than a call into an editor: seeding, the echo
 * comparison, the EOL policy, the save policy and cursor attribution are all exercised
 * against the fake `selvaged` with no editor in scope (`test/bridge.test.ts`).
 */

import type { PeerInfo, Role } from '../engine/envelope.ts';
import { isProtocolError } from '../engine/errors.ts';
import type { EngineEvent, EngineEventListener } from '../engine/events.ts';
import type { SessionInfo } from '../engine/engine.ts';
import type {
  AwarenessState,
  OffsetSelection,
  Presence,
  Selection,
} from '../engine/presence.ts';

import { cursorFor } from './cursors.ts';
import type { Cursor } from './cursors.ts';
import { diff, hasCarriageReturn, matchesReplica, render, toBufferOffset, toCrdt, toReplicaOffset } from './editing.ts';
import type { LineEnding, TextChange } from './editing.ts';
import { MAX_GRANT_FILE_BYTES, isGrantedPath, overFileBound } from './grant.ts';

/**
 * Why a path the room asked for has no text this window can put into a document.
 *
 * `not-granted` is the odd one out: it is a path the grant would never publish, which no
 * message may name (see `refusalSentence`), and it is here so that an adapter answering
 * about its own resolution does not have to lie about which of the others it is.
 */
export type GrantRefusal =
  /** A path this session does not share: outside the folder, or one the grant excludes. */
  | 'not-granted'
  /** Nothing is there: never there, deleted since the listing, or unreadable. */
  | 'missing'
  /** Something is there, and it is not a plain file: a directory, a link, a device. */
  | 'not-a-file'
  /** A plain file over the bytes a session will carry. */
  | 'too-large'
  /** A plain file whose bytes are not text, which is all a room can carry. */
  | 'binary';

/** What reading a granted path produced: the file's text, or why there is none. */
export type GrantedRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'refused'; readonly cause: GrantRefusal };

/**
 * The slice of `SelvageEngine` the bridge talks to. `SelvageEngine` satisfies it as it
 * stands — a test assigns the real class to it, so a drift is a compile error rather than
 * a surprise at run time — and a test can satisfy it with a stub.
 */
export interface Engine {
  session(): SessionInfo;
  text(path: string): string;
  has(path: string): boolean;
  open(path: string): Promise<void>;
  close(path: string): Promise<void>;
  insert(path: string, index: number, text: string): void;
  delete(path: string, index: number, length: number): void;
  setSelection(path: string, selection: OffsetSelection): void;
  setAwareness(state: AwarenessState | null): void;
  presence(): Presence[];
  resolveSelection(path: string, selection: Selection): OffsetSelection | undefined;
  on(listener: EngineEventListener): () => void;
}

/**
 * The editor, as the bridge sees it: text in, changes out. Every offset here is a UTF-16
 * code unit, which is what `Y.Text` indices and an editor's own offsets both count.
 */
export interface EditorHost {
  /** The text this editor holds for `path`, or `undefined` when the document is not open. */
  text(path: string): string | undefined;
  /** The document's line endings, as this editor has them. */
  lineEnding(path: string): LineEnding;
  /**
   * Replaces `[change.start, change.end)` with `change.text`, and resolves `true` once the
   * buffer holds it.
   *
   * An editor that refuses the change — `workspace.applyEdit` answers `false` — leaves the
   * buffer alone; the bridge works out the change again from the buffer's current text
   * rather than replaying a stale range, and gives up after a bounded number of attempts.
   * A `true` is not a promise that the range was the right one; it is only a promise that
   * the edit landed.
   */
  applyChange(path: string, change: TextChange): Promise<boolean>;
  /** Writes the document's content wherever it lives. A guest's is a no-op. */
  save(path: string): Promise<boolean>;
  /**
   * Reads a file from this window's working copy, for a path the room asked for.
   *
   * The path came from a peer and is not trusted, so the answer is the text or the reason
   * there is none: a path that escapes the folder or that the grant excludes (`.git/**`,
   * `.env`) is `not-granted`, and a directory, a symbolic link, a name that is not there, a
   * file over the size a session will carry and a file whose bytes are not text are each
   * named as they are. The distinction is the user's: one sentence for all of them sent a
   * person looking for a file that had never been deleted, when what they had was a zip.
   */
  readGrantedFile(path: string): Promise<GrantedRead>;
  /** Draws the remote cursors; `[]` clears them. */
  renderCursors(cursors: Cursor[]): void;
  /** Something the user can see. */
  report(report: Report): void;
}

/** What the editor has to be told, in the adapter's own vocabulary. */
export type Report =
  /** The room's open-document set, as the server owns it. */
  | { kind: 'documents'; documents: string[] }
  /** The room's grant: the host's whole listing, replacing whatever the adapter held. */
  | { kind: 'grant'; paths: string[] }
  /** Membership changed. */
  | { kind: 'peers'; peers: PeerInfo[] }
  /** The host disconnected; the room survives only until the grace period expires. */
  | { kind: 'hostDetached'; graceMs: number }
  | { kind: 'hostAttached'; peer: PeerInfo }
  | { kind: 'roomGone'; reason: string }
  | { kind: 'sessionError'; code: string; message: string }
  /** `applyEdit` refused every attempt: the buffer and the room are apart, and stay apart. */
  | { kind: 'applyRefused'; path: string }
  /** The buffer and the replica were apart, and the room's copy is what the buffer is brought to. */
  | { kind: 'divergence'; path: string }
  /** The document could not be written; the file on disk is stale. */
  | { kind: 'saveFailed'; path: string; message?: string }
  /** The socket dropped mid-session and the bounded retry is running. */
  | { kind: 'reconnecting' }
  | { kind: 'disconnected' };

/** Timers, so the save policy is testable without waiting for one. */
export interface Timers {
  /** Runs `run` after `delayMs`. The returned function cancels it if it has not run yet. */
  after(delayMs: number, run: () => void): () => void;
}

export const realTimers: Timers = {
  after(delayMs, run) {
    const handle = setTimeout(run, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** How long the room may go on editing a document before it is written to disk. */
export const DEFAULT_SAVE_SETTLE_MS = 500;

/**
 * How long the buffer is left alone before it is compared against the replica. The study's
 * §2.5 backstop: the minimal diff is always taken against the buffer as it reads, and an
 * editor applies it a macrotask later, so a change that slips into that window can leave
 * the two apart. The debounced check catches that class rather than the one window it knows.
 */
export const DEFAULT_RECONCILE_SETTLE_MS = 100;

/** How many times a refused change is worked out again before the refusal is reported. */
export const DEFAULT_MAX_APPLY_ATTEMPTS = 3;

export interface BridgeOptions {
  engine: Engine;
  host: EditorHost;
  timers?: Timers;
  saveSettleMs?: number;
  reconcileSettleMs?: number;
  maxApplyAttempts?: number;
  /**
   * Whether a document the room changed is written. A remote edit leaves a buffer dirty
   * and its file on disk stale, and the host's working copy is the truth (`DESIGN.md` §5),
   * so the default is to save it. A guest's document is virtual and its `save` is a no-op;
   * the call is still made, because that is what clears the editor's dirty marker.
   */
  autoSave?: boolean;
}

/**
 * Keeps the editor's documents and the session's replica in step, in both directions, with
 * no path between them that can loop.
 *
 * The two directions are independent and only one of them needs a guard. Buffer → replica
 * compares the buffer's text against the replica's before writing, which is not a bet on
 * when an editor delivers a coalesced change event; replica → buffer needs nothing,
 * because the engine reports a change only for a transaction that did not come from this
 * adapter's own edit (`SPIKES.md`, spike 2).
 *
 * A change the editor is asked to apply is asynchronous, so at most one apply per document
 * is ever in flight, and a change that arrives while one is in flight is not diffed — the
 * buffer it would be diffed against may be the pre-apply text, and a range applied to the
 * wrong text is not a range the editor can reject.
 */
export class SessionBridge {
  private readonly engine: Engine;
  private readonly host: EditorHost;
  private readonly timers: Timers;
  private readonly saveSettleMs: number;
  private readonly reconcileSettleMs: number;
  private readonly maxApplyAttempts: number;
  private readonly autoSave: boolean;
  /** The paths the editor currently has open in this session. */
  private readonly documents = new Set<string>();
  /**
   * The paths this host has seeded, so reopening a file does not push it in again. Pruned
   * when the document closes, along with `refusedSeeds`: the entries are one per path open.
   */
  private readonly seeded = new Set<string>();
  /** The paths this host has refused and reported, so reopening one does not nag again. */
  private readonly refusedSeeds = new Set<string>();
  /**
   * The paths the room has asked for, so a read that was refused is not attempted again.
   * Only the ones the room still holds open: `seedRequested` prunes to the set it is given,
   * because that set is a peer's word and a peer can churn it.
   */
  private readonly requested = new Set<string>();
  /** Documents a guest has opened whose room text has not arrived yet. See `documentOpened`. */
  private readonly unarrived = new Set<string>();
  /** The paths this client holds open on the server, as opposed to asked it to open. */
  private readonly held = new Set<string>();
  private readonly saves = new Map<string, () => void>();
  private readonly backstops = new Map<string, () => void>();
  /** One entry per document with an apply in flight: what it should leave, and from where. */
  private readonly inFlight = new Map<
    string,
    { expected: string; replica: string; before: string | undefined; moved: boolean }
  >();
  /** Documents with a reconcile wanted once the apply in flight settles. */
  private readonly pending = new Set<string>();
  /** Refused applies since the last change that landed, per document. */
  private readonly attempts = new Map<string, number>();
  private readonly stops: Array<() => void> = [];
  private disposed = false;

  constructor(options: BridgeOptions) {
    this.engine = options.engine;
    this.host = options.host;
    this.timers = options.timers ?? realTimers;
    this.saveSettleMs = options.saveSettleMs ?? DEFAULT_SAVE_SETTLE_MS;
    this.reconcileSettleMs = options.reconcileSettleMs ?? DEFAULT_RECONCILE_SETTLE_MS;
    this.maxApplyAttempts = options.maxApplyAttempts ?? DEFAULT_MAX_APPLY_ATTEMPTS;
    this.autoSave = options.autoSave ?? true;
    this.stops.push(this.engine.on((event) => this.onEngineEvent(event)));
  }

  /** `host` or `guest`: the host supplies document content, a guest follows it. */
  role(): Role {
    return this.engine.session().role;
  }

  /** The room paths this client has in front of the editor, ordered so two runs agree. */
  openDocuments(): string[] {
    return [...this.documents].sort();
  }

  // -- from the editor -------------------------------------------------------

  /** The editor has put a document in front of the user. */
  documentOpened(path: string): void {
    if (this.disposed) {
      return;
    }
    const text = this.host.text(path);
    if (text === undefined) {
      return;
    }
    // A guest follows the room, and there is nothing to follow until the room's text has
    // arrived for this path. A buffer that already holds text — a tab kept across a session,
    // say — would be diffed against a replica that has received nothing, the editor asked to
    // empty it, and whatever the buffer still holds when that settles is not the user's edit
    // but the buffer's own content; publishing it puts the guest's local text into the room.
    // The hold is taken now, because that is what makes the room send the text, and the
    // document is put in front of the bridge when it arrives. An empty buffer holds nothing
    // to publish, so it opens at once — which leaves a document the room names but never
    // writes to openable rather than waiting for a text that will not come.
    if (this.role() === 'guest' && !this.engine.has(path) && text !== '') {
      this.unarrived.add(path);
      this.hold(path);
      return;
    }
    this.documents.add(path);
    if (this.seed(path, text)) {
      this.documents.delete(path);
      return;
    }
    // The replica can hold more than the editor does: a peer may have edited the path before
    // this window opened it. Rendering it here is what keeps the next keystroke from being
    // published as a change back to the disk copy.
    this.reconcile(path);
    this.hold(path);
  }

  /**
   * The room's text for a document a guest opened before it arrived: the document now goes in
   * front of the bridge. `reconcile` is what brings the buffer to the room's text, and it is
   * here rather than at open so the buffer is never diffed against an empty replica.
   */
  private arrive(path: string): void {
    if (!this.unarrived.delete(path)) {
      return;
    }
    const text = this.host.text(path);
    if (text === undefined) {
      return;
    }
    this.documents.add(path);
    if (this.seed(path, text)) {
      this.documents.delete(path);
      return;
    }
    this.reconcile(path);
  }

  /**
   * The editor's buffer changed. A keystroke and a formatter's edit reach the replica from
   * here; the change event this adapter's own application of a peer's edit produces does not,
   * because the buffer then already holds what the replica holds — that comparison is the
   * guard, and it is the whole of it.
   *
   * While an apply is in flight the buffer may be behind the replica, and a change diffed
   * against the replica then is a change computed from two texts without a shared lineage.
   * Nothing is published: the apply's settle compares the buffer with what it asked for and
   * publishes what the user typed into the window.
   */
  documentChanged(path: string): void {
    if (this.disposed || !this.documents.has(path)) {
      return;
    }
    const text = this.host.text(path);
    if (text === undefined) {
      return;
    }
    const replica = this.engine.text(path);
    if (matchesReplica(text, replica)) {
      return;
    }
    const flight = this.inFlight.get(path);
    if (flight !== undefined) {
      // The buffer moved while the apply was in flight. The text it holds now may not survive
      // the apply — a rebased change can land the merge back on the pre-apply text — so the
      // flight records the movement itself, not just the text it started from.
      flight.moved = true;
      this.pending.add(path);
      return;
    }
    // The whole buffer is compared and diffed rather than the event's own ranges. A range an
    // editor reports is in the buffer's coordinates, and mapping it onto the replica's would
    // need the EOL offset table — a class of its own in the extension the study read. Two
    // string scans per change event buy the whole policy being four lines long.
    this.moveSave(path);
    // A refused publish leaves the buffer alone: the backstop converges the buffer to the
    // replica, which is exactly what must not happen to text the room refused to carry.
    if (this.publish(path, text, replica)) {
      this.scheduleBackstop(path);
    }
  }

  /** The editor closed a document: this client stops holding it open in the room. */
  documentClosed(path: string): void {
    if (this.disposed) {
      return;
    }
    this.unarrived.delete(path);
    this.documents.delete(path);
    // The flight belongs to the closed instance: without this a reopen queues behind it,
    // and its settlement — still the current entry — converges the new buffer as its own.
    this.inFlight.delete(path);
    this.cancelSave(path);
    this.cancelBackstop(path);
    this.pending.delete(path);
    this.attempts.delete(path);
    // The once-per-path memories go with the document, so a session that opens many paths
    // holds one entry per path *open* rather than one per path ever opened. A reopen is
    // judged afresh: `seed`'s engine guard is what keeps a second insert out, and a refusal
    // said again for a file the person has just reopened is the same sentence about the
    // same act.
    this.seeded.delete(path);
    this.refusedSeeds.delete(path);
    this.release(path);
  }

  /** The user's cursor moved inside a document this session shares. */
  selectionChanged(path: string, selection: OffsetSelection): void {
    if (this.disposed || !this.documents.has(path)) {
      return;
    }
    const buffer = this.host.text(path);
    if (buffer === undefined) {
      return;
    }
    // The adapter reports a buffer offset, the replica is LF-only: a caret after a `\r\n`
    // is one code unit further right here than there, and one past the replica's end at the
    // end of a CRLF file. Converting is what keeps the end-of-file caret from being withheld
    // and every other one from landing a column late. A document with no `\r` in it needs
    // none of that, and working it out once here is what keeps the flush off the conversion.
    const carriageReturn = hasCarriageReturn(buffer);
    this.engine.setSelection(path, {
      anchor: toReplicaOffset(buffer, selection.anchor, carriageReturn),
      head: toReplicaOffset(buffer, selection.head, carriageReturn),
    });
  }

  /**
   * The user left the session's documents, or the window lost focus. No cursor is published
   * rather than a stale one; a reader that comes back republishes as it moves.
   */
  selectionCleared(): void {
    if (this.disposed) {
      return;
    }
    this.engine.setAwareness(null);
  }

  // -- from the replica ------------------------------------------------------

  /**
   * Makes the document's buffer hold what the replica holds, with the smallest edit that
   * gets there. Public because the backstop and a settled apply both re-enter here.
   */
  reconcile(path: string): void {
    if (this.disposed) {
      return;
    }
    if (this.inFlight.has(path)) {
      this.pending.add(path);
      return;
    }
    const buffer = this.host.text(path);
    if (buffer === undefined) {
      return;
    }
    const rendered = render(this.engine.text(path), this.host.lineEnding(path));
    if (rendered === buffer) {
      this.attempts.delete(path);
      this.cancelBackstop(path);
      return;
    }
    this.issue(path, diff(buffer, rendered), rendered);
    this.scheduleSave(path);
    this.scheduleBackstop(path);
  }

  /** The remote cursors this replica can resolve right now, ordered by peer id. */
  cursors(): Cursor[] {
    const local = this.engine.session().peer.peer_id;
    const cursors: Cursor[] = [];
    // Every endpoint below is converted against the same buffer, and the answer to whether
    // that buffer's offsets need converting at all is the same for all of them: worked out
    // once per document rather than once per peer cursor.
    const carriageReturn = new Map<string, boolean>();
    const carriageReturnOf = (path: string, buffer: string): boolean => {
      const known = carriageReturn.get(path);
      if (known !== undefined) {
        return known;
      }
      const answer = hasCarriageReturn(buffer);
      carriageReturn.set(path, answer);
      return answer;
    };
    for (const presence of this.engine.presence()) {
      const peer = presence.peer;
      const path = presence.state?.path;
      const selection = presence.state?.selection;
      // A state this client cannot attribute to a session peer is one it cannot name, and a
      // cursor with no name is worse than none. A state carrying no selection is a peer in
      // a document without a caret in it, which is not something to draw.
      if (
        peer === undefined ||
        peer.peer_id === local ||
        path === undefined ||
        selection === undefined
      ) {
        continue;
      }
      const resolved = this.engine.resolveSelection(path, selection);
      if (resolved === undefined) {
        continue;
      }
      const buffer = this.host.text(path);
      if (buffer === undefined) {
        continue;
      }
      cursors.push(
        cursorFor(
          { peerId: peer.peer_id, displayName: peer.display_name, role: peer.role },
          {
            path,
            anchor: toBufferOffset(buffer, resolved.anchor, carriageReturnOf(path, buffer)),
            head: toBufferOffset(buffer, resolved.head, carriageReturnOf(path, buffer)),
          },
        ),
      );
    }
    return cursors.sort((left, right) =>
      left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0,
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.stops) {
      stop();
    }
    this.stops.length = 0;
    for (const cancel of this.saves.values()) {
      cancel();
    }
    this.saves.clear();
    for (const cancel of this.backstops.values()) {
      cancel();
    }
    this.backstops.clear();
    this.documents.clear();
    this.held.clear();
    this.unarrived.clear();
    this.requested.clear();
    this.inFlight.clear();
    this.pending.clear();
    this.attempts.clear();
  }

  // -- internals -------------------------------------------------------------

  /**
   * A host supplies document content: its working copy is the truth (`DESIGN.md` §5). It
   * seeds a path once, and only into a replica that has received nothing for it. A path a
   * peer has already edited is not something to overwrite with whatever happens to be on
   * this disk, and a file reopened later is already in the room.
   *
   * "Received nothing" is the replica having no text for the path at all, not its text being
   * empty: a room can legitimately agree on an empty document, and re-seeding that from disk
   * is the one way this rule loses an edit rather than protecting one.
   */
  private seed(path: string, bufferText: string): boolean {
    if (this.role() !== 'host' || this.seeded.has(path)) {
      return false;
    }
    // A file the user opened is still one the room has to carry: the grant's own rule and
    // the session's size bound gate this path exactly as they gate a peer's request below,
    // so opening `.env`, a key or a huge log shares nothing and wedges no frame. A refusal
    // is said once per path, out loud, rather than seeded as an empty document or left for
    // the user to discover from a guest's question; the editor may re-fire the open event
    // on focus or split, and that must not nag.
    const refusal = seedRefusal(path, bufferText);
    if (refusal !== undefined) {
      if (!this.refusedSeeds.has(path)) {
        this.refusedSeeds.add(path);
        this.host.report({
          kind: 'sessionError',
          code: 'error',
          message: `will not share ${path} with the room: ${refusal}; nothing was shared for it`,
        });
      }
      return true;
    }
    this.seeded.add(path);
    if (this.engine.has(path)) {
      return false;
    }
    const incoming = toCrdt(bufferText);
    if (incoming !== '') {
      this.engine.insert(path, 0, incoming);
    }
    return false;
  }

  /**
   * The room now holds a path this window does not. A host supplies document content — its
   * working copy is the truth (`DESIGN.md` §4.2) — so it reads the file and seeds the replica
   * once.
   *
   * This is the only place a host reads its disk because a peer asked rather than because the
   * user acted, so the path is not trusted: the editor refuses anything that is not a readable
   * text file inside the folder this window shares, and a refusal is reported rather than
   * seeded as an empty document. The guard on the insert is `seed`'s: only a replica that has
   * received nothing for the path may be given a disk copy.
   *
   * A refusal is recorded as asked-for and not as seeded: the user opening that file later
   * still passes through `seed`'s own gates, so a file the grant excludes stays out of the
   * room whichever way it was reached.
   */
  private seedRequested(documents: string[]): void {
    if (this.role() !== 'host') {
      return;
    }
    // This host remembers a path it was asked for only while the room holds it open. The
    // set is written from the room's own word, and the room is a stranger's: a token-holder
    // that opens and closes distinct paths in a cycle grows a union over the session without
    // bound, one string per path it ever named. What is not open now is asked for again if
    // it comes back, which costs the one bounded read the first ask cost.
    const open = new Set(documents);
    for (const path of [...this.requested]) {
      if (!open.has(path)) {
        this.requested.delete(path);
      }
    }
    const fresh: string[] = [];
    for (const path of documents) {
      if (this.requested.has(path) || this.documents.has(path)) {
        continue;
      }
      this.requested.add(path);
      // A path the grant would never publish — `.env`, `..`, an over-long name — is not
      // something a peer can talk the room into: it is dropped silently, so a guessed
      // secret buys no dialog confirming it, and a bogus listing buys no read at all.
      if (isGrantedPath(path)) {
        fresh.push(path);
      }
    }
    if (fresh.length === 0) {
      return;
    }
    // One report for the whole event, however many paths failed it: a listing of N
    // unknown paths is one dialog, never N.
    const refusals: string[] = [];
    let settled = 0;
    const report = (): void => {
      settled += 1;
      if (settled < fresh.length) {
        return;
      }
      if (refusals.length === 1) {
        this.host.report({ kind: 'sessionError', code: 'error', message: refusals[0] ?? '' });
      } else if (refusals.length > 1) {
        const shown = refusals.slice(0, 3).join('; ');
        const rest = refusals.length > 3 ? `; and ${refusals.length - 3} more` : '';
        this.host.report({
          kind: 'sessionError',
          code: 'error',
          message: `could not share ${refusals.length} paths the room asked for (${shown}${rest}); nothing was shared for them`,
        });
      }
    };
    for (const path of fresh) {
      void this.host
        .readGrantedFile(path)
        .then((read) => {
          if (read.kind === 'refused') {
            const said = refusalSentence(read.cause);
            // A path the grant would never publish is dropped without a word, whichever
            // layer found it out: the message would confirm that the name was worth asking
            // about, which is what a guessed secret is looking for.
            if (said !== undefined) {
              refusals.push(`could not share ${path}: ${said}; nothing was shared for it`);
            }
          } else {
            const text = read.text;
            // The size was checked before the read, so a file that grew in between arrives
            // over the bound: the read is judged the way an opened buffer is, and an
            // oversized one is refused rather than published past the sharing bound.
            const refusal = seedRefusal(path, text);
            if (refusal !== undefined) {
              refusals.push(`could not share ${path}: ${refusal}; nothing was shared for it`);
            } else if (!this.engine.has(path)) {
              const incoming = toCrdt(text);
              if (incoming !== '') {
                this.engine.insert(path, 0, incoming);
              }
            }
          }
          report();
        })
        .catch((error: unknown) => {
          refusals.push(
            `could not read ${path} from this window's working copy: ${describe(error)}; nothing was shared for it`,
          );
          report();
        });
    }
  }

  /**
   * Opens the path in the room. A document does not have to be held for its content to
   * arrive — the session is one replica that syncs whole — but the holds are what the
   * open-document set means (§5), and a reconnect re-opens what this client held (§9.1).
   */
  private hold(path: string): void {
    void this.engine
      .open(path)
      .then(() => {
        this.held.add(path);
        // A guest document whose text was here before the hold was answered: the engine
        // attached it silently, so the `documentChanged` event an arrival waits for will not
        // come, and this answer is the moment. See `documentOpened`.
        if (this.unarrived.has(path) && this.engine.has(path)) {
          this.arrive(path);
          return;
        }
        // Closed while the request was in flight: the hold it just gained is one nobody
        // wants, and letting it stand would leave the path offered to the room.
        if (!this.documents.has(path) && !this.unarrived.has(path)) {
          this.release(path);
        }
      })
      .catch((error: unknown) => {
        // A refused hold leaves nothing that will ever open this document, so the bridge
        // entry goes with the report rather than sitting there for the rest of the session:
        // `documents` still holding the path would let a later keystroke publish through
        // the whole-replica sync what the server refused to open. The in-flight apply goes
        // with it: its settlement must neither publish nor converge, and a reopen issues
        // its own flight rather than queueing behind a stale one.
        this.unarrived.delete(path);
        this.documents.delete(path);
        this.inFlight.delete(path);
        this.cancelSave(path);
        this.cancelBackstop(path);
        this.pending.delete(path);
        this.attempts.delete(path);
        this.refused('open', path, error);
      });
  }

  private release(path: string): void {
    if (!this.held.delete(path)) {
      return;
    }
    void this.engine.close(path).catch((error: unknown) => {
      this.refused('close', path, error);
    });
  }

  private refused(what: 'open' | 'close', path: string, error: unknown): void {
    this.host.report({
      kind: 'sessionError',
      code: isProtocolError(error) ? error.code : 'error',
      message: `the server refused to ${what} ${path}: ${describe(error)}`,
    });
  }

  /**
   * Writes the buffer's difference from the replica into the replica. A buffer that grew
   * past what the session carries — opened under the bound, typed past it — is refused
   * rather than published: the seed gate judges the buffer at open, and this is the same
   * gate on the buffer at every keystroke. Reported once per path, like a seed refusal.
   * True when the difference was published: a refusal leaves the buffer alone, the way a
   * refused seed does, rather than scheduling the convergence that would wipe it.
   */
  private publish(path: string, bufferText: string, replica: string): boolean {
    const refusal = seedRefusal(path, bufferText);
    if (refusal !== undefined) {
      if (!this.refusedSeeds.has(path)) {
        this.refusedSeeds.add(path);
        this.host.report({
          kind: 'sessionError',
          code: 'error',
          message: `will not share ${path} with the room: ${refusal}; nothing was shared for it`,
        });
      }
      return false;
    }
    const change = diff(replica, toCrdt(bufferText));
    if (change.end > change.start) {
      this.engine.delete(path, change.start, change.end - change.start);
    }
    if (change.text !== '') {
      this.engine.insert(path, change.start, change.text);
    }
    return true;
  }

  /**
   * Asks the editor for one change, and records what the buffer should hold when it lands.
   * The promise is what serialises this document's applies: nothing else is issued until it
   * settles, so a change is never diffed against a buffer an edit is still moving.
   */
  private issue(path: string, change: TextChange, expected: string): void {
    const flight = {
      expected,
      replica: this.engine.text(path),
      before: this.host.text(path),
      moved: false,
    };
    this.inFlight.set(path, flight);
    void this.host
      .applyChange(path, change)
      .then((applied) => {
        // The settlement belongs to the exact flight it was issued for: a refused hold or
        // a close drops the flight, and a reopen issues its own, so a stale settlement
        // converges nothing — neither a publish nor a wipe.
        if (this.inFlight.get(path) !== flight) {
          return;
        }
        this.settle(path, applied);
      })
      .catch((error: unknown) => {
        if (this.inFlight.get(path) !== flight) {
          return;
        }
        this.inFlight.delete(path);
        this.host.report({
          kind: 'sessionError',
          code: 'error',
          message: `the editor failed to apply a change to ${path}: ${describe(error)}`,
        });
        if (this.pending.delete(path)) {
          this.reconcile(path);
        }
      });
  }

  private settle(path: string, applied: boolean): void {
    const flight = this.inFlight.get(path);
    this.inFlight.delete(path);
    // The document left while the apply was in flight — refused open, or closed: its
    // settlement publishes nothing and converges nothing.
    if (!this.documents.has(path)) {
      return;
    }
    if (!applied) {
      this.refuse(path, flight?.moved ?? false);
      return;
    }
    this.attempts.delete(path);
    const actual = this.host.text(path);
    const replica = this.engine.text(path);
    if (actual !== undefined && actual !== flight?.expected && !matchesReplica(actual, replica)) {
      if (flight !== undefined && replica === flight.replica) {
        // The buffer moved while the edit was in flight — the user typed into the window.
        // It now holds the user's text with the change landed on it, and the replica has not
        // moved since: the difference is the user's, so it goes to the room. A buffer that held
        // what it held when the edit was issued was not moved by the user at all — the editor
        // reported the change landed without it landing — and publishing that is how a guest's
        // own text overwrites the room. The two states are told apart by `moved`, not by the
        // text alone: a change the editor refused and the adapter rebuilt through the local
        // edit behind it lands the merge exactly on the pre-apply text when the peer's change
        // and the user's edit are inverses.
        if (actual !== flight.before || flight.moved) {
          if (!this.publish(path, actual, replica)) {
            // The room refused the buffer — over the size bound, or ungrantable: it stays
            // as the user left it, the way a refused seed does. The pending reconcile would
            // converge it back to the replica, and an armed backstop would do the same, so
            // both go with the refusal.
            this.pending.delete(path);
            this.cancelBackstop(path);
          }
        }
      } else {
        // The replica moved too, so the buffer's difference is not separable from a peer's
        // edit that has not reached it. The replica wins; a whole-document reconcile is what
        // the backstop would do anyway, and the difference is reported rather than guessed.
        this.host.report({ kind: 'divergence', path });
      }
    }
    if (this.pending.delete(path)) {
      this.reconcile(path);
    }
  }

  /**
   * A refused `applyEdit`. `false` is the editor saying the range no longer fits — a
   * read-only document is the plain case — and the change is worked out again from the
   * buffer's current text, but only a bounded number of times: the retry cannot fix a
   * document that will refuse every range, and an unbounded one spins the extension host
   * with nothing on screen.
   *
   * `moved` is whether the buffer changed while that apply was in flight. When it did, the
   * reconcile below diffs the buffer against the replica and works the change out again from
   * the buffer's own text, which is the room's text without the local edit — the reconcile is
   * what deletes that edit. The first refusal of an episode is where it is still there to
   * report, so the person is told the room's copy is what the buffer is about to hold.
   */
  private refuse(path: string, moved: boolean): void {
    const attempts = (this.attempts.get(path) ?? 0) + 1;
    this.attempts.set(path, attempts);
    if (attempts < this.maxApplyAttempts) {
      if (moved && attempts === 1) {
        this.host.report({ kind: 'divergence', path });
      }
      this.reconcile(path);
      return;
    }
    this.pending.delete(path);
    this.cancelBackstop(path);
    this.host.report({ kind: 'applyRefused', path });
  }

  /**
   * The §2.5 backstop: once the buffer has been quiet for `reconcileSettleMs`, compare it
   * with the replica and, if the minimal diff did not get them together, replace the whole
   * document. The minimal diff is the right edit only if the buffer it was computed from is
   * still there; a whole-document replacement is the one edit that does not care.
   */
  private backstop(path: string): void {
    if (this.disposed || !this.documents.has(path)) {
      return;
    }
    if (this.inFlight.has(path)) {
      this.pending.add(path);
      return;
    }
    const buffer = this.host.text(path);
    if (buffer === undefined) {
      return;
    }
    const rendered = render(this.engine.text(path), this.host.lineEnding(path));
    if (rendered === buffer) {
      return;
    }
    this.host.report({ kind: 'divergence', path });
    // The whole document, and the only change in the bridge that `diff` did not work out: zero
    // and the buffer's own end are not positions inside a character, so unlike a change from
    // the diff this range needs no widening to stay out of a surrogate pair.
    this.issue(path, { start: 0, end: buffer.length, text: rendered }, rendered);
    this.scheduleSave(path);
  }

  /**
   * Writes the document once the room has stopped changing it. A second remote edit inside
   * the window moves the deadline rather than adding a write, so a burst of edits from a
   * peer costs one save, and a document the editor closed in the meantime is not written.
   */
  private scheduleSave(path: string): void {
    if (!this.autoSave) {
      return;
    }
    this.cancelSave(path);
    const cancel = this.timers.after(this.saveSettleMs, () => {
      this.saves.delete(path);
      if (this.host.text(path) === undefined) {
        return;
      }
      this.write(path);
    });
    this.saves.set(path, cancel);
  }

  /** A local edit inside the window moves the write rather than racing it. */
  private moveSave(path: string): void {
    if (this.saves.has(path)) {
      this.scheduleSave(path);
    }
  }

  private write(path: string): void {
    void this.host
      .save(path)
      .then((saved) => {
        if (!saved) {
          this.host.report({ kind: 'saveFailed', path });
        }
      })
      .catch((error: unknown) => {
        this.host.report({ kind: 'saveFailed', path, message: describe(error) });
      });
  }

  private cancelSave(path: string): void {
    const cancel = this.saves.get(path);
    if (cancel !== undefined) {
      cancel();
      this.saves.delete(path);
    }
  }

  private scheduleBackstop(path: string): void {
    this.cancelBackstop(path);
    if (this.reconcileSettleMs <= 0) {
      return;
    }
    const cancel = this.timers.after(this.reconcileSettleMs, () => {
      this.backstops.delete(path);
      this.backstop(path);
    });
    this.backstops.set(path, cancel);
  }

  private cancelBackstop(path: string): void {
    const cancel = this.backstops.get(path);
    if (cancel !== undefined) {
      cancel();
      this.backstops.delete(path);
    }
  }

  private onEngineEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'documentChanged': {
        // A guest document whose text the room had not sent when it was opened: the arrival
        // is this event, so it is now put in front of the bridge. See `documentOpened`.
        if (this.unarrived.has(event.path)) {
          this.arrive(event.path);
        } else {
          this.reconcile(event.path);
        }
        break;
      }
      case 'documentsChanged': {
        this.host.report({ kind: 'documents', documents: event.documents });
        this.seedRequested(event.documents);
        break;
      }
      case 'grantChanged': {
        this.host.report({ kind: 'grant', paths: event.paths });
        break;
      }
      case 'peersChanged': {
        this.host.report({ kind: 'peers', peers: event.peers });
        this.host.renderCursors(this.cursors());
        break;
      }
      case 'presenceChanged': {
        this.host.renderCursors(this.cursors());
        break;
      }
      case 'hostDetached': {
        this.host.report({ kind: 'hostDetached', graceMs: event.graceMs });
        break;
      }
      case 'hostAttached': {
        this.host.report({ kind: 'hostAttached', peer: event.peer });
        break;
      }
      case 'roomGone': {
        this.host.report({ kind: 'roomGone', reason: event.reason });
        break;
      }
      case 'sessionError': {
        this.host.report({
          kind: 'sessionError',
          code: event.code,
          message: event.message,
        });
        break;
      }
      case 'reconnecting': {
        this.host.report({ kind: 'reconnecting' });
        break;
      }
      case 'disconnected': {
        this.host.report({ kind: 'disconnected' });
        break;
      }
    }
  }
}

/**
 * What a refusal says, per cause, or `undefined` for a cause that must not be said at all.
 *
 * One sentence used to stand for every one of these, and it blamed a deletion: a person
 * refused a `.zip` went looking for a file that had never gone anywhere, when the answer was
 * that a room carries text and a zip is not text. `not-granted` is the exception, and it has
 * no sentence on purpose: a peer that guessed at a name the grant excludes learns nothing
 * from the answer — not even that the name failed a rule rather than being absent.
 */
function refusalSentence(cause: GrantRefusal): string | undefined {
  switch (cause) {
    case 'not-granted':
      return undefined;
    case 'missing':
      return 'there is no readable file there any more (it may have been deleted after the listing was published)';
    case 'not-a-file':
      return 'it is not a plain file in the folder this session shares (a directory, a link, or something else that cannot be read as one)';
    case 'too-large':
      return `it is over the ${MAX_GRANT_FILE_BYTES} bytes a session will carry`;
    case 'binary':
      return 'it is a binary file, and a room carries text, so this is not a file that can be shared at all';
  }
}

/**
 * Why a locally-opened file must not enter the room's replica, or `undefined` when it
 * may. The grant's shape rule and the session's size bound: the gates a peer's request
 * passes through, applied to the buffer rather than the disk. The editor holds decoded
 * text, so readability and decodability are what opening established; a file the window
 * has not saved yet is still shareable while it is otherwise grantable.
 */
function seedRefusal(path: string, bufferText: string): string | undefined {
  if (!isGrantedPath(path)) {
    return 'it is not a path the room shares (excluded from the grant, or escaping the folder)';
  }
  if (overFileBound(bufferText)) {
    return `it is over the ${MAX_GRANT_FILE_BYTES} bytes a session will carry`;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
