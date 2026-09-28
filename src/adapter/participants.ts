/**
 * The Participants view: everyone in the room as the web's faces list them, and the peer file
 * badges.
 *
 * The people are seated the way the web page seats its bar: the host first, then this window,
 * then the others in the order the room lists them. The seat decides the colour (`seatColours`),
 * so a row, a caret, a gutter badge and a file badge all name the same person in one colour.
 */

import * as vscode from 'vscode';

import { badgeFiles, initials, peerColour, peerColourId, peerName, rosterLabel, seatColours } from '../bridge/index.ts';
import type { FileBadge, FilePresence } from '../bridge/index.ts';
import type { Role } from '../engine/index.ts';

import { avatarDataUri } from './gutter.ts';

/** The web's words for the host mark and for a person in no document. */
export const HOST_LABEL = 'Host';
export const NO_PATH = 'not in a file yet';
export const YOU_MARK = '(you)';

/** Someone in the room, as the room names them. */
export interface RoomMember {
  peerId: string;
  displayName: string;
  role: Role;
  /** The document they say they are in, already captioned for display. */
  path?: string;
}

/** A member in their seat: the name the roster shows and the colour the seat gives. */
export interface Person extends RoomMember {
  self: boolean;
  label: string;
  colour: string;
  /** The theme colour a file badge takes: the seat's, or the hashed palette's past the seats. */
  colourId: string;
}

/**
 * Seats the room: the host first, then this window, then the others in the room's order. Past
 * the seats, a person falls back to the colour their id hashes to.
 */
export function seatPeople(self: RoomMember, others: readonly RoomMember[]): Person[] {
  const everyone = [self, ...others.filter((other) => other.peerId !== self.peerId)];
  const host = everyone.find((member) => member.role === 'host');
  const ordered = host === undefined ? everyone : [host, ...everyone.filter((member) => member !== host)];
  const colours = seatColours(ordered);
  const named = ordered.map((member) => ({
    peerId: member.peerId,
    displayName: peerName(member.displayName, member.peerId),
  }));
  return ordered.map((member, index) => {
    const seat = colours.get(member.peerId);
    return {
      ...member,
      self: member.peerId === self.peerId,
      label: rosterLabel(named[index] ?? { peerId: member.peerId, displayName: member.peerId }, named),
      colour: seat ?? peerColour(member.peerId),
      colourId: seat === undefined ? peerColourId(member.peerId) : `selvage.seat.${index + 1}`,
    };
  });
}

/** One row of the view and of the people picker. */
export interface PersonRow {
  peerId: string;
  label: string;
  description: string;
  tooltip: string;
  /** Which actions the row offers: yourself, the followed person, someone in a file, or not. */
  contextValue: string;
  colour: string;
  initials: string;
  self: boolean;
  host: boolean;
  following: boolean;
  path?: string;
}

/** Where a person is, in the web's words. Your own row says nothing about it. */
export function whereLine(person: Pick<Person, 'self' | 'path'>): string {
  if (person.self) {
    return '';
  }
  return person.path === undefined ? NO_PATH : `in ${person.path}`;
}

export function personRows(people: readonly Person[], followingPeerId?: string): PersonRow[] {
  return people.map((person) => {
    const host = person.role === 'host';
    const following = !person.self && person.peerId === followingPeerId;
    const where = whereLine(person);
    const description = [
      person.self ? YOU_MARK : '',
      host ? HOST_LABEL : '',
      following ? 'following' : '',
      where,
    ]
      .filter((part) => part !== '')
      .join(' · ');
    const tooltip = [
      person.self ? `${person.label} ${YOU_MARK}` : person.label,
      host ? HOST_LABEL : '',
      where,
      following ? `Following ${person.label}` : '',
    ]
      .filter((part) => part !== '')
      .join(' · ');
    const contextValue = person.self
      ? 'selvageParticipantSelf'
      : following
        ? 'selvageParticipantFollowing'
        : person.path === undefined
          ? 'selvageParticipantAway'
          : 'selvageParticipant';
    return {
      peerId: person.peerId,
      label: person.label,
      description,
      tooltip,
      contextValue,
      colour: person.colour,
      initials: initials(person.label),
      self: person.self,
      host,
      following,
      ...(person.path === undefined ? {} : { path: person.path }),
    };
  });
}

/** A row's face, as a data URI the tree and the picker can both draw. */
export function avatar(row: PersonRow): vscode.Uri {
  return vscode.Uri.parse(avatarDataUri(row.initials, row.colour, { host: row.host, following: row.following }));
}

function rowKey(row: PersonRow): string {
  return JSON.stringify([row.label, row.description, row.tooltip, row.contextValue, row.colour, row.initials]);
}

/**
 * One person's row. It carries the peer id, which is the argument the go-to, follow and rename
 * commands take, so an inline action calls straight through. A click on someone in a document
 * goes to them.
 */
export class ParticipantItem extends vscode.TreeItem {
  readonly peerId: string;
  private key = '';

  constructor(row: PersonRow) {
    super(row.label, vscode.TreeItemCollapsibleState.None);
    this.peerId = row.peerId;
    this.apply(row);
  }

  /** Brings the row up to date, answering whether anything the tree shows changed. */
  update(row: PersonRow): boolean {
    if (this.key === rowKey(row)) {
      return false;
    }
    this.apply(row);
    return true;
  }

  private apply(row: PersonRow): void {
    this.key = rowKey(row);
    this.label = row.label;
    this.description = row.description;
    // A string tooltip is rendered as markdown, and a name is a stranger's text: `appendText`
    // keeps it plain.
    this.tooltip = new vscode.MarkdownString().appendText(row.tooltip);
    this.contextValue = row.contextValue;
    this.iconPath = avatar(row);
    this.command =
      !row.self && row.path !== undefined
        ? { command: 'selvage.goToParticipant', title: `Go to ${row.label}`, arguments: [{ peerId: row.peerId }] }
        : undefined;
  }
}

/**
 * The view's rows: one stable item per person, keyed by id. A change of membership or order
 * redraws the list; anything else fires only the rows it touched.
 */
export class ParticipantsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private items: ParticipantItem[] = [];
  private readonly byPeer = new Map<string, ParticipantItem>();

  refresh(rows: readonly PersonRow[]): void {
    const order = rows.map((row) => row.peerId);
    const reordered =
      order.length !== this.items.length || order.some((peerId, index) => this.items[index]?.peerId !== peerId);
    const touched: ParticipantItem[] = [];
    for (const row of rows) {
      const kept = this.byPeer.get(row.peerId);
      if (kept === undefined) {
        this.byPeer.set(row.peerId, new ParticipantItem(row));
      } else if (kept.update(row)) {
        touched.push(kept);
      }
    }
    if (reordered) {
      const wanted = new Set(order);
      for (const peerId of [...this.byPeer.keys()]) {
        if (!wanted.has(peerId)) {
          this.byPeer.delete(peerId);
        }
      }
      this.items = order.map((peerId) => this.byPeer.get(peerId) as ParticipantItem);
      this.changed.fire(undefined);
      return;
    }
    for (const item of touched) {
      this.changed.fire(item);
    }
  }

  /** The first row, which `reveal` uses to open the view when a session starts. */
  first(): ParticipantItem | undefined {
    return this.items[0];
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    return [...this.items];
  }

  getParent(): undefined {
    return undefined;
  }
}

/**
 * The peer markers on the room files' own rows: the initials of the one person in a file, in
 * their seat colour, or the headcount when several share it, with the names in the hover. Only
 * changed files fire, so a caret move never redraws the tree it decorates.
 *
 * A file decoration takes a theme colour's id and never a hex, which is why the seats are
 * contributed as `selvage.seat.<n>`. A shared file claims no colour.
 */
export class PeerFileDecorations implements vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private badges = new Map<string, FileBadge>();

  refresh(files: FilePresence[], colourIds: ReadonlyMap<string, string> = new Map()): void {
    const soleOf = new Map(files.map((file) => [file.uri, file.peers[0]?.peerId] as const));
    const next = new Map(
      badgeFiles(files).map((badge) => {
        const sole = soleOf.get(badge.uri);
        const seated = badge.colourId !== undefined && sole !== undefined ? colourIds.get(sole) : undefined;
        return [badge.uri, seated === undefined ? badge : { ...badge, colourId: seated }] as const;
      }),
    );
    for (const [uri, badge] of next) {
      const prev = this.badges.get(uri);
      if (prev?.badge !== badge.badge || prev?.tooltip !== badge.tooltip || prev?.colourId !== badge.colourId) {
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
    return {
      badge: badge.badge,
      tooltip: badge.tooltip,
      color: badge.colourId === undefined ? undefined : new vscode.ThemeColor(badge.colourId),
    };
  }
}
