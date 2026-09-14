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
 * `DESIGN.md` §4.2 has no file tree: `readDirectory` on this scheme returns nothing, and
 * one URI is one shared document.
 */

export const SCHEME = 'selvage';

const ROOM_KEY = 'room';

/** Percent-encodes each path segment, leaving the separators alone. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function decodePath(encoded: string): string {
  return encoded.split('/').map(decodeURIComponent).join('/');
}

/** The URI a guest opens for a room path. */
export function virtualUri(roomId: string, path: string): string {
  return `${SCHEME}:/${encodePath(path)}?${ROOM_KEY}=${encodeURIComponent(roomId)}`;
}

export interface VirtualUri {
  roomId: string;
  path: string;
}

/**
 * Takes a `selvage:` URI back apart. `undefined` for any other scheme, for a URI with no
 * room, and for one whose path is empty — a document this client cannot name is one it must
 * not open, because a wrong path is a document that exists and a missing one is not.
 */
export function parseVirtualUri(uri: string): VirtualUri | undefined {
  const prefix = `${SCHEME}:/`;
  if (!uri.startsWith(prefix)) {
    return undefined;
  }
  const rest = uri.slice(prefix.length);
  const at = rest.indexOf('?');
  const encodedPath = at === -1 ? rest : rest.slice(0, at);
  const query = at === -1 ? '' : rest.slice(at + 1);
  if (encodedPath === '') {
    return undefined;
  }
  let roomId: string | undefined;
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    if (equals !== -1 && pair.slice(0, equals) === ROOM_KEY) {
      roomId = decodeURIComponent(pair.slice(equals + 1));
    }
  }
  if (roomId === undefined || roomId === '') {
    return undefined;
  }
  return { roomId, path: decodePath(encodedPath) };
}

/** True for a URI this client's guest documents live under. */
export function isVirtual(uri: string): boolean {
  return uri.startsWith(`${SCHEME}:/`);
}
