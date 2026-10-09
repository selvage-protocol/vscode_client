/**
 * The editor windows a run of this repository started, found from the outside.
 *
 * `@vscode/test-electron` spawns a real VS Code and hands back no handle on it, so a run that ends
 * on a throw, a signal or its own watchdog would leave those windows alive behind it. What a window
 * carries of its launcher is its `--user-data-dir`, and every run passes one only it has: scanning
 * `/proc` for that directory is how the windows this run started are told apart from the editor
 * somebody happens to have open.
 *
 * Both the end-to-end proof (`run.ts`) and the README's screenshot (`../screenshots/capture.ts`)
 * leave windows behind if they give up, so this is shared rather than written twice.
 */

import { readdirSync, readFileSync } from 'node:fs';

/**
 * The pids whose command line names each of `profiles`, keyed by the profile they name. A profile
 * no process matches is absent from the map; a machine with no procfs answers with an empty one
 * rather than guessing.
 */
export function windowsFor(profiles: readonly string[]): Map<string, number[]> {
  const found = new Map<string, number[]>(profiles.map((profile) => [profile, []]));
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    // No procfs: say nothing rather than guess.
    return found;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      // It exited between the listing and the read.
      continue;
    }
    for (const profile of profiles) {
      if (cmdline.includes(profile)) {
        found.get(profile)?.push(Number(entry));
        break;
      }
    }
  }
  return found;
}

/**
 * SIGTERMs those pids, through `say` so each run keeps the log it already writes. A pid that was
 * gone between the scan and the signal is not a failure: the point is that nothing is left alive.
 */
export function killWindows(pids: readonly number[], what: string, say: (line: string) => void): void {
  if (pids.length > 0) {
    say(`killing ${what}: ${pids.join(', ')}`);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It exited between the scan and the signal.
    }
  }
}
