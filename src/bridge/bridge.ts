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
import { diff, matchesReplica, render, toCrdt } from './editing.ts';
import type { LineEnding, TextChange } from './editing.ts';

/**
 * The slice of `SelvageEngine` the bridge talks to. `SelvageEngine` satisfies it as it
 * stands — a test assigns the real class to it, so a drift is a compile error rather than
 * a surprise at run time — and a test can satisfy it with a stub.
 */
export interface Engine {
  session(): SessionInfo;
  text(path: string): string;
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
   * Replaces `[change.start, change.end)` with `change.text`.
   *
   * An editor that refuses the change — `workspace.applyEdit` answers `false`, and it does
   * so when the range it was given no longer fits — must ask for `reconcile` again rather
   * than leave the buffer behind: the range is recomputed from the buffer's current text,
   * so a retry is always the right edit and never a stale one.
   */
  applyChange(path: string, change: TextChange): void;
  /** Writes the document's content wherever it lives. A guest's is a no-op. */
  save(path: string): void;
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

export interface BridgeOptions {
  engine: Engine;
  host: EditorHost;
  timers?: Timers;
  saveSettleMs?: number;
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
 */
export class SessionBridge {
  private readonly engine: Engine;
  private readonly host: EditorHost;
  private readonly timers: Timers;
  private readonly saveSettleMs: number;
  private readonly autoSave: boolean;
  /** The paths the editor currently has open in this session. */
  private readonly documents = new Set<string>();
  /** The paths this host has seeded, so reopening a file does not push it in again. */
  private readonly seeded = new Set<string>();
  /** The paths this client holds open on the server, as opposed to asked it to open. */
  private readonly held = new Set<string>();
  private readonly saves = new Map<string, () => void>();
  private readonly stops: Array<() => void> = [];
  private disposed = false;

  constructor(options: BridgeOptions) {
    this.engine = options.engine;
    this.host = options.host;
    this.timers = options.timers ?? realTimers;
    this.saveSettleMs = options.saveSettleMs ?? DEFAULT_SAVE_SETTLE_MS;
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
    // The whole buffer is compared and diffed rather than the event's own ranges. A range an
    // editor reports is in the buffer's coordinates, and mapping it onto the replica's would
    // need the EOL offset table — a class of its own in the extension the study read. Two
    // string scans per change event buy the whole policy being four lines long.
    const incoming = toCrdt(text);
    const change = diff(replica, incoming);
    if (change.end > change.start) {
      this.engine.delete(path, change.start, change.end - change.start);
    }
    if (change.text !== '') {
      this.engine.insert(path, change.start, change.text);
    }
  }

  /** The editor closed a document: this client stops holding it open in the room. */
  documentClosed(path: string): void {
    if (this.disposed) {
      return;
    }
    this.documents.delete(path);
    this.cancelSave(path);
    this.release(path);
  }

  /** The user's cursor moved inside a document this session shares. */
  selectionChanged(path: string, selection: OffsetSelection): void {
    if (this.disposed || !this.documents.has(path)) {
      return;
    }
    this.engine.setSelection(path, selection);
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
   * gets there. Public because an editor can refuse an applied change and has to ask
   * again; nothing else needs to call it.
   */
  reconcile(path: string): void {
    if (this.disposed) {
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
    this.host.applyChange(path, diff(buffer, rendered));
    this.scheduleSave(path);
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
      cursors.push(
        cursorFor(
          { peerId: peer.peer_id, displayName: peer.display_name, role: peer.role },
          { path, anchor: resolved.anchor, head: resolved.head },
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
    this.documents.clear();
    this.held.clear();
  }

  // -- internals -------------------------------------------------------------

  /**
   * A host supplies document content: its working copy is the truth (`DESIGN.md` §5). It
   * seeds a path once, and only into a replica that has received nothing for it. A path a
   * peer has already edited is not something to overwrite with whatever happens to be on
   * this disk, and a file reopened later is already in the room.
   */
  private seed(path: string, bufferText: string): void {
    if (this.role() !== 'host' || this.seeded.has(path)) {
      return;
    }
    this.seeded.add(path);
    if (this.engine.text(path) !== '') {
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
      this.host.save(path);
    });
    this.saves.set(path, cancel);
  }

  private cancelSave(path: string): void {
    const cancel = this.saves.get(path);
    if (cancel !== undefined) {
      cancel();
      this.saves.delete(path);
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
