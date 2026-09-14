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
import { diff, matchesReplica, render, toBufferOffset, toCrdt, toReplicaOffset } from './editing.ts';
import type { LineEnding, TextChange } from './editing.ts';

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
  /** Draws the remote cursors; `[]` clears them. */
  renderCursors(cursors: Cursor[]): void;
  /** Something the user can see. */
  report(report: Report): void;
}

/** What the editor has to be told, in the adapter's own vocabulary. */
export type Report =
  /** The room's open-document set, as the server owns it. */
  | { kind: 'documents'; documents: string[] }
  /** Membership changed. */
  | { kind: 'peers'; peers: PeerInfo[] }
  /** The host disconnected; the room survives only until the grace period expires. */
  | { kind: 'hostDetached'; graceMs: number }
  | { kind: 'hostAttached'; peer: PeerInfo }
  | { kind: 'roomGone'; reason: string }
  | { kind: 'sessionError'; code: string; message: string }
  /** `applyEdit` refused every attempt: the buffer and the room are apart, and stay apart. */
  | { kind: 'applyRefused'; path: string }
  /** The buffer and the replica differ after the edit meant to bring them together. */
  | { kind: 'divergence'; path: string }
  /** The document could not be written; the file on disk is stale. */
  | { kind: 'saveFailed'; path: string; message?: string }
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
  /** The paths this host has seeded, so reopening a file does not push it in again. */
  private readonly seeded = new Set<string>();
  /** The paths this client holds open on the server, as opposed to asked it to open. */
  private readonly held = new Set<string>();
  private readonly saves = new Map<string, () => void>();
  private readonly backstops = new Map<string, () => void>();
  /** One entry per document with an apply in flight: what it should leave, and from where. */
  private readonly inFlight = new Map<string, { expected: string; replica: string }>();
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
    this.documents.add(path);
    this.seed(path, text);
    // The replica can hold more than the editor does: a peer may have edited the path before
    // this window opened it. Rendering it here is what keeps the next keystroke from being
    // published as a change back to the disk copy.
    this.reconcile(path);
    this.hold(path);
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
    if (this.inFlight.has(path)) {
      this.pending.add(path);
      return;
    }
    // The whole buffer is compared and diffed rather than the event's own ranges. A range an
    // editor reports is in the buffer's coordinates, and mapping it onto the replica's would
    // need the EOL offset table — a class of its own in the extension the study read. Two
    // string scans per change event buy the whole policy being four lines long.
    this.publish(path, text, replica);
    this.moveSave(path);
    this.scheduleBackstop(path);
  }

  /** The editor closed a document: this client stops holding it open in the room. */
  documentClosed(path: string): void {
    if (this.disposed) {
      return;
    }
    this.documents.delete(path);
    this.cancelSave(path);
    this.cancelBackstop(path);
    this.pending.delete(path);
    this.attempts.delete(path);
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
    // and every other one from landing a column late.
    this.engine.setSelection(path, {
      anchor: toReplicaOffset(buffer, selection.anchor),
      head: toReplicaOffset(buffer, selection.head),
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
            anchor: toBufferOffset(buffer, resolved.anchor),
            head: toBufferOffset(buffer, resolved.head),
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
  private seed(path: string, bufferText: string): void {
    if (this.role() !== 'host' || this.seeded.has(path)) {
      return;
    }
    this.seeded.add(path);
    if (this.engine.has(path)) {
      return;
    }
    const incoming = toCrdt(bufferText);
    if (incoming !== '') {
      this.engine.insert(path, 0, incoming);
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
        // Closed while the request was in flight: the hold it just gained is one nobody
        // wants, and letting it stand would leave the path offered to the room.
        if (!this.documents.has(path)) {
          this.release(path);
        }
      })
      .catch((error: unknown) => {
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

  /** Writes the buffer's difference from the replica into the replica. */
  private publish(path: string, bufferText: string, replica: string): void {
    const change = diff(replica, toCrdt(bufferText));
    if (change.end > change.start) {
      this.engine.delete(path, change.start, change.end - change.start);
    }
    if (change.text !== '') {
      this.engine.insert(path, change.start, change.text);
    }
  }

  /**
   * Asks the editor for one change, and records what the buffer should hold when it lands.
   * The promise is what serialises this document's applies: nothing else is issued until it
   * settles, so a change is never diffed against a buffer an edit is still moving.
   */
  private issue(path: string, change: TextChange, expected: string): void {
    this.inFlight.set(path, { expected, replica: this.engine.text(path) });
    void this.host
      .applyChange(path, change)
      .then((applied) => {
        this.settle(path, applied);
      })
      .catch((error: unknown) => {
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
    if (!applied) {
      this.refuse(path);
      return;
    }
    this.attempts.delete(path);
    const actual = this.host.text(path);
    const replica = this.engine.text(path);
    if (actual !== undefined && actual !== flight?.expected && !matchesReplica(actual, replica)) {
      if (flight !== undefined && replica === flight.replica) {
        // The buffer moved while the edit was in flight — the user typed into the window.
        // It now holds the user's text with the change landed on it, and the replica has not
        // moved since: the difference is the user's, so it goes to the room.
        this.publish(path, actual, replica);
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
   */
  private refuse(path: string): void {
    const attempts = (this.attempts.get(path) ?? 0) + 1;
    this.attempts.set(path, attempts);
    if (attempts < this.maxApplyAttempts) {
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
        this.reconcile(event.path);
        break;
      }
      case 'documentsChanged': {
        this.host.report({ kind: 'documents', documents: event.documents });
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
      case 'disconnected': {
        this.host.report({ kind: 'disconnected' });
        break;
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
