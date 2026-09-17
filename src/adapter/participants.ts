/**
 * The Participants view: the TreeView and the peer file badges over the roster model.
 *
 * This is the only module here that touches `vscode` for the view, which is what keeps
 * `test/boundary.test.ts`'s layering honest — the roster itself is editor-independent
 * and lives in `src/bridge/participants.ts`. Words live here too: the roster says
 * *which* note stands in for missing peers, and this module says it, so the sentence
 * stays inside the `test/vocabulary.test.ts` scan.
 */

import * as vscode from 'vscode';

import { badgeFiles } from '../bridge/index.ts';
import type {
  FilePresence,
  ParticipantRow,
  RosterRow,
} from '../bridge/index.ts';

/** The empty room's row. Pinned in `test/vocabulary.test.ts`, like every sentence. */
export const NO_PEERS_LABEL = `Selvage: you're the only one here — copy the invite link.`;

/** The row when no session is live. The existing sentence, said by other moments too. */
export const NO_SESSION_LABEL = 'Selvage: join a session first.';

/** A row that is a sentence rather than a peer: the empty room, or no session. */
export interface NoteRow {
  kind: 'note';
  label: string;
  /** The command a click runs, when the note offers one. */
  command?: string;
}

/** What the view lists: one row per peer, or the one note when there is nothing to list. */
export type ViewRow = (ParticipantRow & { kind: 'peer' }) | NoteRow;

/**
 * Turns the roster's answer into words: peers pass through, and each note becomes its
 * pinned sentence — the empty room offering the invite copy on click.
 */
export function resolveViewRows(rows: readonly RosterRow[]): ViewRow[] {
  return rows.map((row) => {
    if (row.kind === 'peer') {
      return row;
    }
    return row.kind === 'empty'
      ? { kind: 'note' as const, label: NO_PEERS_LABEL, command: 'selvage.copyInvite' }
      : { kind: 'note' as const, label: NO_SESSION_LABEL };
  });
}

/**
 * One roster row: a `TreeItem` carrying the peer id, which is structurally the argument
 * the go-to and follow commands already take — so a view action calls straight through
 * with no new command. Rows deliberately carry no click command: a glance must not
 * navigate. The colour dot is the picker's `swatch`, so the row and the caret agree.
 */
export class ParticipantItem extends vscode.TreeItem {
  readonly peerId: string;
  private colour: string;

  constructor(row: ParticipantRow) {
    super(row.label, vscode.TreeItemCollapsibleState.None);
    this.peerId = row.peerId;
    this.colour = row.colour;
    this.apply(row);
  }

  /** Brings the row up to date, answering whether anything the tree shows changed. */
  update(row: ParticipantRow): boolean {
    if (
      this.label === row.label &&
      this.description === row.description &&
      this.tooltip === row.tooltip &&
      this.contextValue === row.contextValue &&
      this.colour === row.colour
    ) {
      return false;
    }
    this.apply(row);
    return true;
  }

  private apply(row: ParticipantRow): void {
    this.label = row.label;
    this.description = row.description;
    this.tooltip = row.tooltip;
    this.contextValue = row.contextValue;
    this.colour = row.colour;
    this.iconPath = ParticipantItem.swatch(row.colour);
  }

  static swatch(colour: string): vscode.Uri {
    return swatch(colour);
  }
}

/**
 * A peer's marker colour as a dot, for the rows and the picker. The colour is
 * `peerColour`'s — the very value the caret bar, the selection fill, the
 * overview-ruler tick and the caret's hover are built from, so the key cannot
 * disagree with the thing it explains. A data-URI SVG is the only shape an icon
 * carries a colour in; nothing in the suite can see the dot, only the URI.
 */
export function swatch(colour: string): vscode.Uri {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">' +
    `<circle cx="6" cy="6" r="6" fill="${colour}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(svg)}`);
}

/**
 * The Participants view's rows: one stable item per peer, keyed by id, plus the one
 * note when there is nothing to list. Membership changes refresh the tree; anything
 * else fires only the rows it touched, so unchanged rows stand still.
 */
export class ParticipantsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private items: vscode.TreeItem[] = [];
  private readonly byPeer = new Map<string, ParticipantItem>();
  private note: vscode.TreeItem | undefined;
  private noteKey: string | undefined;

  refresh(rows: ViewRow[]): void {
    const peers = rows.filter((row) => row.kind === 'peer');
    if (peers.length !== rows.length || peers.length === 0) {
      const note = rows[0];
      const key =
        note === undefined ? 'none' : `${note.label} ${note.kind === 'note' ? (note.command ?? '') : ''}`;
      if (this.note === undefined || this.noteKey !== key) {
        const item = new vscode.TreeItem(
          note?.label ?? '',
          vscode.TreeItemCollapsibleState.None,
        );
        item.contextValue = 'selvageParticipantsNote';
        if (note !== undefined && note.kind === 'note' && note.command !== undefined) {
          item.command = { command: note.command, title: 'Copy the invite link' };
        }
        this.note = item;
        this.noteKey = key;
      }
      if (this.byPeer.size > 0 || this.items[0] !== this.note) {
        this.byPeer.clear();
        this.items = this.note === undefined ? [] : [this.note];
        this.changed.fire(undefined);
      }
      return;
    }
    this.note = undefined;
    this.noteKey = undefined;
    const wanted = new Set(peers.map((row) => row.peerId));
    const membership =
      wanted.size !== this.byPeer.size ||
      [...wanted].some((peerId) => !this.byPeer.has(peerId));
    if (membership) {
      for (const peerId of [...this.byPeer.keys()]) {
        if (!wanted.has(peerId)) {
          this.byPeer.delete(peerId);
        }
      }
      for (const row of peers) {
        const kept = this.byPeer.get(row.peerId);
        if (kept !== undefined) {
          kept.update(row);
        } else {
          this.byPeer.set(row.peerId, new ParticipantItem(row));
        }
      }
      this.items = peers.map((row) => this.byPeer.get(row.peerId) as ParticipantItem);
      this.changed.fire(undefined);
      return;
    }
    for (const row of peers) {
      const item = this.byPeer.get(row.peerId);
      if (item !== undefined && item.update(row)) {
        this.changed.fire(item);
      }
    }
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    return [...this.items];
  }
}

/**
 * The peer markers on the room files' own rows: one badge per file peers are in — a
 * dot, or the headcount when several share it — with the names in the hover. Only
 * changed files fire, so a caret move never redraws the tree it decorates.
 *
 * The marker is deliberately not the peer colour: a file decoration's colour takes
 * only a theme colour, never an arbitrary hex, so the exact hex lives on the roster
 * dots, the follow indicator and the carets instead.
 */
export class PeerFileDecorations implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private badges = new Map<string, { badge: string; tooltip: string }>();

  refresh(files: FilePresence[]): void {
    const next = new Map(badgeFiles(files).map((badge) => [badge.uri, badge] as const));
    for (const [uri, badge] of next) {
      const prev = this.badges.get(uri);
      if (prev?.badge !== badge.badge || prev?.tooltip !== badge.tooltip) {
        this.changed.fire(vscode.Uri.parse(uri));
      }
    }
    for (const uri of this.badges.keys()) {
      if (!next.has(uri)) {
        this.changed.fire(vscode.Uri.parse(uri));
      }
    }
    this.badges = next;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    const badge = this.badges.get(uri.toString());
    if (badge === undefined) {
      return undefined;
    }
    return { badge: badge.badge, tooltip: badge.tooltip };
  }
}
