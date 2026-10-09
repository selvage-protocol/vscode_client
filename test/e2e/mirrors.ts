/**
 * A guest's mirror on the orchestrator's own disk: where it is, what its marker says, and how a
 * window is staged onto one.
 *
 * A join replaces the window's tree with the room's mirror and reloads, so a driven guest runs in
 * two windows — the first joins and is torn down by its own reload, the second opens straight onto
 * a mirror. Both the end-to-end proof (`run.ts`) and the README's screenshot
 * (`../screenshots/capture.ts`) read the first window's work off disk and stage the second, and
 * neither can see the other's copy: the layout below is the extension's own
 * (`src/adapter/mirror.ts`), read from the outside.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * Every mirror window directory for `room` under a user-data dir, as `{ publisher,
 * window, root, marker }`: what the orchestrator reads off its own disk instead of
 * driving a window it cannot click through.
 */
export function roomMirrors(
  userDataDir: string,
  room: string,
): Array<{ publisher: string; window: string; root: string; marker: { invite?: string } }> {
  const found: Array<{ publisher: string; window: string; root: string; marker: { invite?: string } }> = [];
  let publishers: Dirent[];
  try {
    publishers = readdirSync(join(userDataDir, 'User', 'globalStorage'), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const publisher of publishers) {
    if (!publisher.isDirectory()) {
      continue;
    }
    let windows: Dirent[];
    try {
      windows = readdirSync(join(userDataDir, 'User', 'globalStorage', publisher.name, 'rooms', room), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const window of windows) {
      if (!window.isDirectory()) {
        continue;
      }
      const root = join(userDataDir, 'User', 'globalStorage', publisher.name, 'rooms', room, window.name);
      try {
        const marker = JSON.parse(readFileSync(join(root, '.selvage-mirror.json'), 'utf8')) as {
          invite?: string;
        };
        found.push({ publisher: publisher.name, window: window.name, root, marker });
      } catch {
        // Not a mirror yet.
      }
    }
  }
  return found;
}

/**
 * The mirror whose marker still carries a pending join: the join stashed it, and
 * the reload tore the joining run down before any triage could finish it — under
 * the test runner the reloaded window never boots, so a stashed marker is the
 * whole proof the reload staged, read off the orchestrator's disk.
 */
export function stashedMirror(
  userDataDir: string,
  room: string,
): { publisher: string; root: string; invite: string; displayName?: string } | undefined {
  for (const mirror of roomMirrors(userDataDir, room)) {
    if (mirror.marker.invite === undefined) {
      continue;
    }
    try {
      const marker = JSON.parse(readFileSync(join(mirror.root, '.selvage-mirror.json'), 'utf8')) as {
        invite: string;
        displayName?: string;
      };
      return { publisher: mirror.publisher, root: mirror.root, invite: marker.invite, displayName: marker.displayName };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Stashes a join the way `mintMirror` writes it — the marker a reload's triage
 * finishes — so a window opened straight onto the mirror lands without joining.
 * The invite is the one the join stage wrote down verbatim (proxy rewrite and
 * all); the name rides beside it so no question interrupts the landing. The room
 * is alive on the server either way: minting here mints no room, it stages one.
 */
export function mintStash(
  userDataDir: string,
  publisher: string,
  room: string,
  invite: string,
  displayName: string,
): string {
  const window = randomUUID();
  const root = join(userDataDir, 'User', 'globalStorage', publisher, 'rooms', room, window);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, '.selvage-mirror.json'),
    `${JSON.stringify({
      room,
      window,
      pid: process.pid,
      created: new Date().toISOString(),
      invite,
      displayName,
    })}\n`,
  );
  return root;
}
