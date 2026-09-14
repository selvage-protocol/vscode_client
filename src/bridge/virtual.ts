/**
 * The guest's document URIs.
 *
 * A guest edits a buffer that exists nowhere on disk, so it has to live in the editor's
 * workspace behind a scheme of its own. That scheme is a user-visible choice — it is what
 * the tab, the breadcrumb and the Explorer show — and it is settled once, here, so that the
 * `FileSystemProvider`, the commands and the tests all name the same URI.
 *
 * `selvage:/<path>?room=<room id>`. The path is the workspace-relative path the room
 * addresses, percent-encoded per segment so a name with a space, a `?` or a `#` survives.
 * The room travels in the query rather than in the URI authority because an authority is
 * case-folded by every URI parser and a room id is not this client's to fold.
 *
 * Reading one back takes the components an editor's URI type gives — scheme, path, query —
 * rather than its string form: an editor is free to re-encode what it prints, and a room id
 * that came back encoded is a room this client cannot name.
 *
 * `DESIGN.md` §4.2 has no file tree: `readDirectory` on this scheme returns nothing, and
 * one URI is one shared document.
 */

export const SCHEME = 'selvage';

const ROOM_KEY = 'room';

/** Percent-encodes each path segment, leaving the separators alone. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function decodePath(path: string): string {
  return path.split('/').map(decodeURIComponent).join('/');
}

/** The URI a guest opens for a room path. */
export function virtualUri(roomId: string, path: string): string {
  return `${SCHEME}:/${encodePath(path)}?${ROOM_KEY}=${encodeURIComponent(roomId)}`;
}

export interface VirtualDocument {
  roomId: string;
  path: string;
}

/**
 * Reads the components of a `selvage:` URI back into the document it names. `undefined` for
 * any other scheme, for a URI with no room, and for one whose path is empty — a document
 * this client cannot name is one it must not open, because a wrong path is a document that
 * exists and a missing one is not.
 */
export function virtualDocument(
  scheme: string,
  path: string,
  query: string,
): VirtualDocument | undefined {
  if (scheme !== SCHEME || path.length < 2 || !path.startsWith('/')) {
    return undefined;
  }
  const roomId = roomFromQuery(query);
  if (roomId === undefined) {
    return undefined;
  }
  return { roomId, path: decodePath(path.slice(1)) };
}

/** The room id a URI's query names, `undefined` when it names none. */
export function roomFromQuery(query: string): string | undefined {
  let room: string | undefined;
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    if (equals !== -1 && pair.slice(0, equals) === ROOM_KEY) {
      room = decodeURIComponent(pair.slice(equals + 1));
    }
  }
  return room === undefined || room === '' ? undefined : room;
}
