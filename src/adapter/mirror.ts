/**
 * The room's mirror on disk: a real directory holding the shape of the room's listing.
 *
 * A guest's documents are files under `<globalStorage>/rooms/<room>/<window>/`, so a
 * language server, ripgrep or a tree plugin — separate processes reading the filesystem —
 * sees ordinary paths. The room is the truth and the mirror is a cache: files are
 * materialised empty and never overwritten, content arrives through the buffer, and the
 * directory goes at leave. The marker `.selvage-mirror.json` at the root names the room,
 * the window and the process that minted it, which is what tells a stale directory from a
 * live one and what the window's activation event matches.
 *
 * Every path a listing carries is gated by `isGrantedPath` before a byte is written, and
 * every directory segment the materialiser walks must already be a plain directory — a
 * symlinked directory on the way is where a walk escapes, not the linked file the guard
 * already rejects. The leaf is opened `O_NOFOLLOW | O_EXCL`, so a symlink planted between
 * the check and the use is refused rather than followed; a directory swapped in the same
 * window still is (Node has no `openat`), which stays a stated residual rather than a
 * claimed guarantee.
 */

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';


import { MAX_GRANT_PATHS, isGrantedPath } from '../bridge/index.ts';

/** The marker at a mirror root: whose room it is, which window owns it, who minted it. */
export const MIRROR_MARKER = '.selvage-mirror.json';

/**
 * A filesystem path as the room path it names under a mirror root, or `undefined` when
 * it names nothing there: outside the root, the root itself, or a `..` that escaped it.
 * A URI normalises `..` away before this ever sees it; the check is defence in depth.
 * Backslashes normalise to slashes on both sides: `fsPath` uses the platform's
 * separators, and a listing never carries a backslash, so the comparison is on one form.
 * Empty and `.` segments name nothing either, for symmetry with the grant's shape rule:
 * a tool's stray spelling resolves no room path rather than a different file.
 */
export function mirrorRelative(root: string, fsPath: string): string | undefined {
  const normalRoot = root.replace(/\\/g, '/');
  const normalPath = fsPath.replace(/\\/g, '/');
  const base = normalRoot.endsWith('/') ? normalRoot : `${normalRoot}/`;
  if (!normalPath.startsWith(base)) {
    return undefined;
  }
  const rel = normalPath.slice(base.length);
  if (rel === '' || rel.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return rel;
}

/** True when `process.kill(pid, 0)` says the process is there; refusal counts as alive. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A mirror directory the storage scan found, with what its marker says. */
export interface StoredMirror {
  room: string;
  window: string;
  root: string;
  invite?: string;
  displayName?: string;
}

/**
 * Every room window directory under `<storage>/rooms` carrying a marker this client wrote.
 * A directory with no marker, an unreadable one, or a symlink at any level is not
 * positively ours and is never listed: pruning only ever deletes what this returns.
 */
export function scanStorage(storage: vscode.Uri): StoredMirror[] {
  const rooms = join(storage.fsPath, 'rooms');
  let roomDirs: Dirent[];
  try {
    roomDirs = readdirSync(rooms, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: StoredMirror[] = [];
  for (const roomDir of roomDirs) {
    if (!roomDir.isDirectory() || roomDir.isSymbolicLink()) {
      continue;
    }
    let windows: Dirent[];
    try {
      windows = readdirSync(join(rooms, roomDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const windowDir of windows) {
      if (!windowDir.isDirectory() || windowDir.isSymbolicLink()) {
        continue;
      }
      const root = join(rooms, roomDir.name, windowDir.name);
      let marker: MirrorMarker | undefined;
      try {
        marker = readMarker(root);
      } catch {
        continue;
      }
      if (marker === undefined) {
        continue;
      }
      found.push({
        room: marker.room,
        window: marker.window,
        root,
        ...(marker.invite === undefined ? {} : { invite: marker.invite }),
        ...(marker.displayName === undefined ? {} : { displayName: marker.displayName }),
      });
    }
  }
  return found;
}

/** What `mintMirror` wrote, as `readMarker` reads it back. */
export interface MirrorMarker {
  room: string;
  window: string;
  pid: number;
  created: string;
  /**
   * A join the reload has not finished yet: deleted when it lands. The link as the person
   * gave it — a page link keeps the origin it arrived on — because it is also the link the
   * landed session hands on when someone asks for the invite (`Session.joinedWith`).
   */
  invite?: string;
  /**
   * The name the join was started with, stashed beside the invite so the
   * reload's window does not ask again: the answer given seconds ago stands.
   * Deleted with the invite when the join lands.
   */
  displayName?: string;
}

/** What applying a listing did: what is on disk now, and what was refused. */
export interface MirrorReport {
  mirrored: string[];
  refused: string[];
}

/** What a republish did, beside the materialise pass: which files it removed. */
export interface RepublishReport extends MirrorReport {
  removed: string[];
}

/** Options `mintMirror` takes from the caller rather than minting itself. */
export interface MintOptions {
  window?: string;
  pid?: number;
  invite?: string;
  displayName?: string;
}

/** A mirror root, minted or opened: the operations a session performs on it. */
export interface Mirror {
  readonly room: string;
  readonly window: string;
  /** The root on disk. */
  readonly root: string;
  /** The root as a `file:` URI: what the window opens its folder on. */
  readonly uri: vscode.Uri;
  /** Writes one empty file per listed path, with the directories on the way to it. */
  materialise(listing: readonly string[]): MirrorReport;
  /**
   * Applies a republished listing: the materialise pass, then the removal pass. A file
   * the listing no longer names is removed unless `held` says a document of this window
   * still holds it — then it goes when that document closes instead.
   */
  republish(listing: readonly string[], held: (path: string) => boolean): RepublishReport;
  /** Deletes the stashed join — the invite and the name — out of the marker: it has landed. */
  clearInvite(): void;
  /** Deletes the directory recursively: leaving the room deletes the whole cache at once. */
  remove(): void;
}

/** A room id as one path segment, the way the Neovim mirror names it. */
export function sanitiseRoom(room: string): string {
  return room.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Mints `<storage>/rooms/<room>/<window>/`: the directory, and the marker naming it.
 * A pre-existing symlink at the rooms, room or window segment is refused rather than
 * followed, so the mirror never lands outside the storage directory.
 */
export function mintMirror(storage: vscode.Uri, room: string, options: MintOptions = {}): Mirror {
  const window = options.window ?? randomUUID();
  const pid = options.pid ?? process.pid;
  const segment = sanitiseRoom(room);
  if (segment === '') {
    throw new Error(`cannot mirror a room with no name in it: ${JSON.stringify(room)}`);
  }
  const rooms = join(storage.fsPath, 'rooms');
  const roomDir = join(rooms, segment);
  const root = join(roomDir, window);
  for (const dir of [rooms, roomDir, root]) {
    assertPlainDirectoryOrAbsent(dir);
  }
  if (isPlainDirectory(root)) {
    // A window id is minted, never reused — a directory already here is a retry of this
    // same mint, or someone else's. An unreadable or foreign marker refuses the mint
    // rather than writing over state this client cannot account for.
    let marker: MirrorMarker | undefined;
    try {
      marker = readMarker(root);
    } catch {
      throw new Error(`refusing to mint over the unreadable mirror at ${root}`);
    }
    if (marker !== undefined && (marker.room !== room || marker.window !== window)) {
      throw new Error(`refusing to mint over the mirror at ${root}: owned by another window`);
    }
  }
  mkdirSync(root, { recursive: true });
  const marker: MirrorMarker = {
    room,
    window,
    pid,
    created: new Date().toISOString(),
    ...(options.invite === undefined ? {} : { invite: options.invite }),
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
  };
  writeFileSync(join(root, MIRROR_MARKER), `${JSON.stringify(marker)}\n`);
  return handle(room, window, root);
}

/**
 * Opens an existing mirror: the root with a marker naming this room and window. Anything
 * else — no directory, no marker, a marker for another room or window — is not this
 * window's mirror and answers `undefined` rather than throwing.
 */
export function openMirror(
  storage: vscode.Uri,
  room: string,
  window: string,
): Mirror | undefined {
  const root = join(storage.fsPath, 'rooms', sanitiseRoom(room), window);
  let marker: MirrorMarker | undefined;
  try {
    marker = readMarker(root);
  } catch {
    return undefined;
  }
  if (marker === undefined || marker.room !== room || marker.window !== window) {
    return undefined;
  }
  return handle(room, window, root);
}

/** Reads the marker at a mirror root, or `undefined` when it is absent or unreadable. */
export function readMarker(root: string): MirrorMarker | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(root, MIRROR_MARKER), 'utf8');
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(raw) as Partial<MirrorMarker>;
  if (
    typeof parsed.room !== 'string' ||
    typeof parsed.window !== 'string' ||
    typeof parsed.pid !== 'number' ||
    typeof parsed.created !== 'string' ||
    (parsed.invite !== undefined && typeof parsed.invite !== 'string') ||
    (parsed.displayName !== undefined && typeof parsed.displayName !== 'string')
  ) {
    throw new Error(`the mirror marker at ${root} is not one this client wrote`);
  }
  return {
    room: parsed.room,
    window: parsed.window,
    pid: parsed.pid,
    created: parsed.created,
    ...(parsed.invite === undefined ? {} : { invite: parsed.invite }),
    ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
  };
}

/**
 * Prunes a room's dead siblings: every `<window>` directory under it whose marker names
 * this client and whose process is gone. The current window's directory is never pruned —
 * it is adopted, its marker rewritten with the current pid, because after the reload that
 * puts the folder in the window the minting process is gone while the directory is in use.
 * Returns the window ids it removed.
 */
export function pruneRoom(
  storage: vscode.Uri,
  room: string,
  currentWindow: string,
  pid: number = process.pid,
): string[] {
  const roomDir = join(storage.fsPath, 'rooms', sanitiseRoom(room));
  let entries: string[];
  try {
    entries = readdirSync(roomDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const dir = join(roomDir, entry);
    if (!isPlainDirectory(dir)) {
      continue;
    }
    let marker: MirrorMarker | undefined;
    try {
      marker = readMarker(dir);
    } catch {
      continue;
    }
    if (marker === undefined || marker.room !== room) {
      continue;
    }
    if (marker.window === currentWindow) {
      writeMarker(dir, { ...marker, pid });
      continue;
    }
    if (processAlive(marker.pid)) {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(marker.window);
  }
  return removed;
}

function handle(room: string, window: string, root: string): Mirror {
  return {
    room,
    window,
    root,
    get uri() {
      return vscode.Uri.file(root);
    },
    materialise(listing: readonly string[]): MirrorReport {
      const mirrored: string[] = [];
      const refused: string[] = [];
      listing.forEach((path, index) => {
        if (index >= MAX_GRANT_PATHS || !isGrantedPath(path) || path === MIRROR_MARKER) {
          refused.push(path);
          return;
        }
        if (materialiseOne(root, path)) {
          mirrored.push(path);
        } else {
          refused.push(path);
        }
      });
      return { mirrored, refused };
    },
    republish(listing: readonly string[], held: (path: string) => boolean): RepublishReport {
      const applied = this.materialise(listing);
      const keep = new Set(listing);
      const removed: string[] = [];
      for (const rel of filesUnder(root)) {
        if (rel === MIRROR_MARKER || keep.has(rel) || held(rel)) {
          continue;
        }
        try {
          unlinkSync(join(root, ...rel.split('/')));
        } catch {
          // A concurrent delete or an uncooperative mode leaves the file for the next
          // republish, which still names it as long as the listing does not.
          continue;
        }
        removed.push(rel);
      }
      return { ...applied, removed };
    },
    clearInvite(): void {
      const marker = readMarker(root);
      if (marker === undefined) {
        throw new Error(`the mirror at ${root} has no marker to clear the invite from`);
      }
      if (marker.invite === undefined) {
        return;
      }
      const { invite: _dropped, displayName: _alsoDropped, ...rest } = marker;
      writeMarker(root, rest);
    },
    remove(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Writes one empty file, with the directories on the way to it. True when the file is on
 * disk afterwards — created now, or kept because a republish must never clobber — and
 * false when the path is refused: a directory on the way that is not a plain directory,
 * a leaf that is not a regular file, or a leaf a symlink won between the check and the use.
 */
function materialiseOne(root: string, path: string): boolean {
  const segments = path.split('/');
  const leaf = segments[segments.length - 1] ?? '';
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    if (!isPlainDirectory(dir)) {
      if (!tryMkdir(dir)) {
        return false;
      }
    }
  }
  const file = join(dir, leaf);
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(file);
  } catch {
    stat = undefined;
  }
  if (stat !== undefined) {
    // Never clobber: whatever is there — the room's text written through the buffer, a
    // tool's file — stays as it is. What is *not* kept is a leaf that is not a regular
    // file: the editor reads such a file through the link and saves through it, so a link
    // standing where the room's file should be is refused rather than listed as mirrored,
    // which is what Neovim does with a non-regular leaf (`nvim_client/lua/selvage/mirror.lua`).
    return stat.isFile();
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    );
  } catch {
    return false;
  }
  closeSync(fd);
  return true;
}

/** Every file under a mirror root, as `/`-separated room paths. */
function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        found.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return found;
}



/** Refuses what is there unless it is a real directory: a symlink, a file, anything else. */
function assertPlainDirectoryOrAbsent(dir: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing to mirror under ${dir}: not a plain directory`);
  }
}

/**
 * Whether a room path under a mirror root is one this window may read and write: every
 * directory between the root and the leaf is a plain directory — a path that reaches
 * through a link leaves the mirror — and the leaf is absent or a regular file. An absent
 * leaf is a file the person has not written yet; a link, a directory, a socket or a fifo
 * at the leaf is not the room's file. `materialiseOne` refuses the same leaf at the disk;
 * this is the check the read and the write beside it make, because the object can change
 * between one and the next.
 */
export function plainMirrorPath(root: string, path: string): boolean {
  const segments = path.split('/');
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(dir);
    } catch {
      // Nothing there: a path the editor holds for a file nobody has written.
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return false;
    }
  }
  const leaf = join(dir, segments[segments.length - 1] ?? '');
  try {
    return lstatSync(leaf).isFile();
  } catch {
    return true;
  }
}

function isPlainDirectory(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function tryMkdir(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch {
    return isPlainDirectory(dir);
  }
}

function writeMarker(root: string, marker: MirrorMarker): void {
  writeFileSync(join(root, MIRROR_MARKER), `${JSON.stringify(marker)}\n`);
}
