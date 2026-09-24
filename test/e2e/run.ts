/**
 * The two-real-instance convergence proof: two independent, real VS Code Extension
 * Development Host processes (`@vscode/test-electron`, headless under Xvfb), each with the
 * real built `dist/extension.js` loaded, one hosting and one joining over a real `selvaged`,
 * editing the same document concurrently.
 *
 * A join replaces the window's tree with the room mirror — one reload, never a second
 * root — so the guest runs in two windows: the first joins on its own folder and the
 * reload tears that run down (resolving instead would fail the stage), and the second
 * opens straight onto a freshly stashed mirror in its own profile, where the
 * activation triage lands the join and the suite proves the window is the mirror
 * alone before running every phase.
 *
 * This has heavier prerequisites than `npm test` — a network, Xvfb, a VS Code build pinned
 * below and downloaded the first time that version is used, `nix` for the shared-library path
 * an unpackaged Electron binary needs on NixOS — so it is not part of `npm test`/`test:fast` or
 * CI (see `README.md`). Run it with `scripts/e2e/run-two-instance.sh` from the repository root.
 *
 * The reconnect phase (§4 of the task, optional) proves the bounded-backoff reconnect path
 * for real: a `DropProxy` sits in front of the real server, the guest is routed through it
 * (its invite is rewritten to the proxy's address; the host talks to the server directly), and
 * cutting the proxy's sockets is a real TCP close the guest's engine has to recover from on
 * its own, with the room and the host's connection untouched — unlike killing the server
 * itself, which would destroy the room along with the connection.
 *
 * The granted phase proves the room's grant end to end: the host's folder holds a file the
 * host never opens, the guest opens it by path alone, and the host reads its own working copy
 * because the guest asked — then opens the file afterwards and finds the guest's edit in it.
 * Nothing else in the suite proves that a path was only ever a name until somebody asked for
 * its content.
 *
 * The watch phase proves the listing follows the folder: the host makes a file under its own
 * folder and removes another while the room is live, and the guest's own view of the room — the
 * mirror on disk its Explorer reads — has to gain the created path and lose the deleted one,
 * with the created path's content arriving when the guest opens it.
 *
 * The follow phase proves follow-and-jump across two real editors: the guest follows the host
 * by name, the host moves its caret to the end with no edit, and the guest's caret has to
 * arrive at the same offset; the guest then stops, the host moves back to the start, and the
 * guest's caret has to hold what it tracked. The host's move is a programmatic selection, so
 * the phase also answers whether assigning `editor.selection` publishes presence — if that
 * event never fires, the guest never tracks.
 *
 * The empty-window stage proves the join from a window with no folder: the first instance
 * joins and the reload that puts the room's folder in the window tears the run down,
 * which counts only with the landed join on disk to show for it — the marker without
 * its invite and the listing filled. The second instance opens straight onto a freshly
 * stashed mirror in the same profile and proves the landing again — the invite left
 * the marker, the listing filled the mirror, and no second folder was added — with no
 * command run at all.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import net from 'node:net';
import { constants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

import { RealServer } from '../helpers/selvaged.ts';
import { ensureVscodeCache } from './vscode-cache.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TMP = resolve(ROOT, '.tmp');
const RUN_DIR = resolve(TMP, 'e2e-run');

const MARKER_HOST = '[[HOST-EDIT]]';
const MARKER_GUEST = '[[GUEST-EDIT]]';
const MARKER_HOST_2 = '[[HOST-EDIT-2]]';
const MARKER_GUEST_2 = '[[GUEST-EDIT-2]]';
const SEED_PATH = 'notes.txt';
const SEED_TEXT = 'a document two real editors are about to share\n';
// A file the host writes down but never opens: the guest opens it, so its text can only have
// arrived because the host read its own working copy on the guest's request.
const GRANTED_PATH = 'granted/never-opened.txt';
const GRANTED_TEXT = 'a file the host never opens in its own window\n';
// The watch phase: a path the host makes under its folder while the room is live, and a path
// it removes. The guest's view of the room has to gain the first and lose the second, which
// nothing but the folder being watched can tell it.
const WATCH_PATH = 'made-while-live/after-start.txt';
const WATCH_TEXT = 'a file the host made while the room was live\n';
const WATCH_DOOMED_PATH = 'doomed-while-live.txt';
const WATCH_DOOMED_TEXT = 'a file the host removes while the room is live\n';

/**
 * The VS Code build this proof runs against. Left to `@vscode/test-electron`, that is whatever
 * the update service calls stable at the moment of the run, so the editor being proved moves
 * under the proof without anything here changing — and the version is resolved over the
 * network before the cache is consulted for *what* to run. Pinned, a build already in the
 * cache is used without a request at all. Move it deliberately with
 * `SELVAGE_E2E_VSCODE_VERSION`; a version the cache does not hold is downloaded on the next
 * run.
 */
const VSCODE_VERSION = process.env.SELVAGE_E2E_VSCODE_VERSION ?? '1.137.0';

const RECONNECT = process.env.SELVAGE_E2E_RECONNECT !== '0';
/**
 * How long one poll may take. The guest joins in two windows — the join stage
 * reloads, the phases stage boots fresh — so two editor startups and a reload
 * stand between the host seating and the first guest marker; the bound leaves
 * room for all three with a slow boot.
 */
const DEADLINE_MS = Number(process.env.SELVAGE_E2E_DEADLINE_MS ?? '60000');
const RECONNECT_DEADLINE_MS = Number(process.env.SELVAGE_E2E_RECONNECT_DEADLINE_MS ?? '40000');
/**
 * How long one editor may take to finish on its own before the run gives up on it. Startup,
 * both phases and the shutdown, with room to spare: this is the bound that turns an editor
 * that never exits into a failure, rather than an orchestrator that says nothing for as long
 * as whatever started it is willing to wait. A run with the reconnect phase off never waits
 * for that phase either, so it does not reserve its budget.
 */
const INSTANCE_DEADLINE_MS = Number(
  process.env.SELVAGE_E2E_INSTANCE_DEADLINE_MS ??
    String(DEADLINE_MS + (RECONNECT ? RECONNECT_DEADLINE_MS : 0) + 420_000),
);
/**
 * The bound on the whole run. Every other deadline above bounds a step; this one covers the
 * steps that have none, and the shape that produces no output at all — the orchestrator past
 * its last log line, waiting on something that is no longer there, which reads as a hang
 * rather than a failure when the output is piped somewhere it is only read at exit. A run that
 * has to download a build the cache does not hold is doing an announced, one-off transfer, and
 * can be given room with `SELVAGE_E2E_WATCHDOG_MS`.
 */
const WATCHDOG_MS = Number(process.env.SELVAGE_E2E_WATCHDOG_MS ?? '900000');
/**
 * How long the one `nix eval` below may take. It resolves and evaluates `<nixpkgs>`, which can
 * block on an evaluation, a fetch or a store lock, so it is bounded like every other step: an
 * answer that never comes is a failure naming the cache and the way out, rather than a run that
 * sits there until the watchdog. The answer is slow and stable and is cached once it arrives.
 */
const NIX_EVAL_TIMEOUT_MS = Number(process.env.SELVAGE_E2E_NIX_TIMEOUT_MS ?? '120000');
const NIX_EVAL_KILL_GRACE_MS = 2000;
/** How long the server is given to stop on the way out before the process leaves without it. */
const SERVER_STOP_GRACE_MS = 5000;

/**
 * What the watchdog reports on: the phase the run is in, the last line it logged, and which
 * instances are still in flight as far as the orchestrator can tell.
 */
let phase = 'startup';
let lastLogged = '(nothing logged yet)';
const inFlight = new Set<'host' | 'guest' | 'empty'>();
/** The server this run started, if it has got that far; stopped on every way out. */
let activeServer: RealServer | undefined;
/**
 * What the relay had accepted when the blip was cut. The reconnect is the connection accepted
 * after it, so this is the number the phase is judged against; `-1` when there was no relay.
 */
let relayConnectionsBeforeCut = -1;

function log(...parts: unknown[]): void {
  lastLogged = parts.map((part) => String(part)).join(' ');
  console.log('[e2e]', ...parts);
}

/**
 * The editor processes still running, found in `/proc` by the user-data directory each editor
 * was given. `runTests` does not hand back the child it spawns, and the promise it returns is
 * the one thing that cannot answer this: the stall worth reporting is the one where that
 * promise never settles, which says nothing about whether anything is still behind it.
 */
function liveEditorProcesses(): { host: number[]; guest: number[]; guestPhases: number[]; empty: number[] } {
  const alive: { host: number[]; guest: number[]; guestPhases: number[]; empty: number[] } = {
    host: [],
    guest: [],
    guestPhases: [],
    empty: [],
  };
  const hostUserData = resolve(RUN_DIR, 'host-user-data');
  const guestUserData = resolve(RUN_DIR, 'guest-user-data');
  const guestPhasesUserData = resolve(RUN_DIR, 'guest-phases-user-data');
  const emptyUserData = resolve(RUN_DIR, 'empty-user-data');
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    // No procfs: say nothing rather than guess.
    return alive;
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
    if (cmdline.includes(hostUserData)) {
      alive.host.push(Number(entry));
    } else if (cmdline.includes(guestPhasesUserData)) {
      alive.guestPhases.push(Number(entry));
    } else if (cmdline.includes(guestUserData)) {
      alive.guest.push(Number(entry));
    } else if (cmdline.includes(emptyUserData)) {
      alive.empty.push(Number(entry));
    }
  }
  return alive;
}

/**
 * SIGTERMs the editors this run spawned, found the way the watchdog reports them: by the
 * user-data directory only this run passes, so nothing else on the machine can match. They are
 * `@vscode/test-electron`'s children and no handle on them comes back, so on a throw, a signal
 * or the watchdog they are otherwise abandoned alive.
 */
function killLiveEditors(reason: string): void {
  const alive = liveEditorProcesses();
  const pids = [...alive.host, ...alive.guest, ...alive.guestPhases, ...alive.empty];
  if (pids.length > 0) {
    log(`killing live editors (${reason}): ${pids.join(', ')}`);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It exited between the scan and the signal.
    }
  }
}

/**
 * Takes down only the empty-window stage's windows: the join run is over and the
 * reloaded window proves the landing again, while the run's own host and guest
 * must keep running for the legs after this one. Killing by profile, not by
 * everything alive.
 */
function killEmptyEditors(reason: string): void {
  const alive = liveEditorProcesses();
  if (alive.empty.length > 0) {
    log(`killing empty-window editors (${reason}): ${alive.empty.join(', ')}`);
  }
  for (const pid of alive.empty) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It exited between the scan and the signal.
    }
  }
}

/**
 * Everything this run started is stopped here, whatever ended it: the server is on an ephemeral
 * port and outlives the proof that started it, and the editors are children nobody hands back.
 */
async function stopWhatThisRunStarted(reason: string): Promise<void> {
  const server = activeServer;
  activeServer = undefined;
  if (server !== undefined) {
    // `stop` escalates to SIGKILL on its own; the race is what makes the wait bounded even if
    // that never lands, since the process is leaving either way.
    await Promise.race([server.stop(), delay(SERVER_STOP_GRACE_MS)]);
  }
  killLiveEditors(reason);
}

/** Stop, then leave with this code: the body of every failing ending. */
async function stopAndExit(code: number): Promise<void> {
  await stopWhatThisRunStarted(`stop-and-exit(${code})`);
  process.exit(code);
}

/**
 * The deadline for the whole run. It is armed before `main` starts and cleared once the run is
 * done — until it is cleared it holds the event loop open itself, which is what keeps a
 * promise that never settles or a child that never exits from ending the process quietly.
 */
function armWatchdog(): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const alive = liveEditorProcesses();
    const list = (pids: number[]): string => (pids.length === 0 ? 'none' : pids.join(', '));
    console.error(`[e2e] WATCHDOG: the run did not finish within ${WATCHDOG_MS}ms; giving up`);
    console.error(`[e2e] WATCHDOG: phase: ${phase}`);
    console.error(`[e2e] WATCHDOG: last log line: ${lastLogged}`);
    console.error(
      `[e2e] WATCHDOG: instances still in flight: ${inFlight.size === 0 ? 'none' : [...inFlight].join(', ')}`,
    );
    console.error(`[e2e] WATCHDOG: editor processes alive: host ${list(alive.host)}; guest ${list(alive.guest)}; guest-phases ${list(alive.guestPhases)}; empty ${list(alive.empty)}`);
    console.error(
      `[e2e] WATCHDOG: editor output: ${resolve(RUN_DIR, 'host.log')}, ${resolve(RUN_DIR, 'guest.log')}`,
    );
    void stopAndExit(1);
  }, WATCHDOG_MS);
}

/** A TCP relay a test can cut without touching the process on either end of it — the same
 * idea as `reference_server/crates/harness`'s `DropProxy`, reimplemented here because the
 * guest in this proof is a real VS Code process reached only through its invite URL. */
class DropProxy {
  private readonly server: net.Server;
  private readonly sockets: Set<net.Socket>;
  readonly port: number;
  /**
   * Client connections the relay has accepted. This is how a reconnect is visible from the
   * harness: the guest's socket closing and coming back is a new TCP connection here, where a
   * guest dialling the server directly never shows up at all.
   */
  private accepted = 0;

  private constructor(server: net.Server, port: number, sockets: Set<net.Socket>) {
    this.server = server;
    this.port = port;
    this.sockets = sockets;
  }

  /** Adopts one accepted connection and forwards it to the server. */
  private relay(client: net.Socket, targetHost: string, targetPort: number): void {
    this.accepted += 1;
    const upstream = net.connect(targetPort, targetHost);
    this.sockets.add(client);
    this.sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const forget = (): void => {
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on('close', forget);
    upstream.on('close', forget);
    client.on('error', () => {
      upstream.destroy();
    });
    upstream.on('error', () => {
      client.destroy();
    });
  }

  /** Connections accepted so far, the ones before a cut included. */
  get connections(): number {
    return this.accepted;
  }

  static async start(targetHost: string, targetPort: number): Promise<DropProxy> {
    return new Promise((resolvePromise, reject) => {
      const sockets = new Set<net.Socket>();
      // A connection cannot arrive before `listen` reports the port, which is before this is
      // assigned, so nothing is ever adopted uncounted.
      let relay: DropProxy | undefined;
      const server = net.createServer((client) => {
        relay?.relay(client, targetHost, targetPort);
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('proxy has no port'));
          return;
        }
        relay = new DropProxy(server, address.port, sockets);
        resolvePromise(relay);
      });
    });
  }

  /** Destroys every socket the relay is currently forwarding: a network blip, from both
   * ends, without touching the server or the other peer. */
  dropAll(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  async stop(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolvePromise) => {
      this.server.close(() => {
        resolvePromise();
      });
    });
  }
}

/** A step of the run whose output belongs on this run's own stdout, awaited rather than blocked
 * on: a synchronous spawn would keep the watchdog from firing for as long as it ran. */
async function inherit(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with ${String(code)}`));
      }
    });
  });
}

/**
 * `nix eval`, awaited and bounded. `execFile`'s own timeout sends one signal and then waits for
 * ever on a child that ignores it, which bounds nothing; this kills in two steps and reports.
 */
function nixEval(expr: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn('nix', ['eval', '--impure', '--raw', '--expr', expr], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killed = (): Error =>
      new Error(
        `nix eval did not finish within ${String(timeoutMs)}ms, so it was killed` +
          (stderr.trim() === '' ? '' : `; its last output was:\n${stderr.trim()}`),
      );
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (escalation !== undefined) {
        clearTimeout(escalation);
      }
      if (error === undefined) {
        resolvePromise(stdout);
      } else {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        child.kill('SIGKILL');
      }, NIX_EVAL_KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish(error);
    });
    // A killed child's stdio can be held open by something behind it, so a timed-out evaluation
    // reports at `exit`; one that finished waits for `close`, when its output has been read.
    child.on('exit', () => {
      if (timedOut) {
        finish(killed());
      }
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish(killed());
      } else if (code !== 0) {
        finish(new Error(`nix eval exited with ${String(code)}:\n${stderr.trim()}`));
      } else {
        finish();
      }
    });
  });
}

/** `nix`'s answer for the shared libraries an Electron binary downloaded outside nix needs on
 * NixOS — `nix-ld` supplies the loader, not the libraries a desktop app links against.
 * Cached, because evaluating it is the slow part of every run. */
async function nixElectronLibraryPath(): Promise<string> {
  const cacheFile = resolve(TMP, 'e2e-libpath.txt');
  try {
    return readFileSync(cacheFile, 'utf8').trim();
  } catch {
    // fall through and compute it
  }
  const packages = [
    'glib', 'nss', 'nspr', 'dbus', 'atk', 'cups', 'gtk3', 'pango', 'cairo', 'expat',
    'libdrm', 'mesa', 'alsa-lib', 'at-spi2-atk', 'at-spi2-core', 'libx11', 'libxcb',
    'libxcomposite', 'libxdamage', 'libxext', 'libxfixes', 'libxrandr', 'libxkbcommon',
    'libGL', 'systemd', 'libnotify', 'gsettings-desktop-schemas', 'libxtst',
    'libxscrnsaver', 'libxshmfence', 'libgbm', 'libxi', 'libxrender', 'libuuid',
  ];
  const expr = `with import <nixpkgs> {}; lib.makeLibraryPath [${packages.join(' ')}]`;
  let stdout: string;
  try {
    stdout = await nixEval(expr, NIX_EVAL_TIMEOUT_MS);
  } catch (error) {
    throw new Error(
      `nix eval for the Electron library path failed:\n${String(error)}\n` +
        `That answer is cached: one that was obtained is written to\n  ${cacheFile}\n` +
        `and every later run reads it instead of evaluating again. Warm it once, in a shell with\n` +
        `a working nixpkgs, with\n  nix eval --impure --raw --expr '${expr}' > ${cacheFile}\n` +
        `or allow the evaluation longer with SELVAGE_E2E_NIX_TIMEOUT_MS.`,
    );
  }
  writeFileSync(cacheFile, stdout);
  return stdout.trim();
}

/**
 * The clipboard the host suite reads its invite back from has to be this run's own. `xvfb-run`
 * gives the instances an X display, but the Wayland variables it leaves in place are the login
 * session's, so a Wayland-capable Electron reads — and writes — the session clipboard that
 * `wl-copy` and every other client on the machine own: a run has taken another repository's test
 * value off it as its invite, and then joined an address nothing was listening on. With only the
 * X display, the selection belongs to these two instances and to nothing else.
 *
 * `XDG_SESSION_TYPE` is named rather than dropped because it is the hint a client falls back on.
 * The session bus is left alone: it is not a display, and the portal clipboard is out of play in
 * a dev host with the sandbox off.
 */
const DISPLAY_ONLY_ENV: Record<string, string | undefined> = {
  WAYLAND_DISPLAY: undefined,
  WAYLAND_SOCKET: undefined,
  XDG_SESSION_TYPE: 'x11',
};

interface InstanceOutcome {
  role: string;
  phase1?: { text: string };
  phase2?: { text: string };
  /** The follow phase: what the host moved to, and what the guest tracked and then held. */
  follow?: { movedTo?: number; tracked?: number; heldAfterStop?: number };
  /** What the granted path held in this editor, and whether the host had it open too early. */
  granted?: { text: string; heldBeforeGuest?: boolean };
  /** What the host changed under its folder, and what the guest's view of the room became. */
  watch?: {
    created?: string;
    deleted?: string;
    rootBefore?: string[];
    rootAfter?: string[];
    createdDir?: string[];
    text?: string;
    /** Whether opening the removed path fresh was refused with the reason, and what it said. */
    deleteRefused?: boolean;
    deleteRefusal?: string;
  };
  /** Whether the window that ran the phases is the room mirror and nothing else. */
  singleFolder?: boolean;
  error?: string;
}

function readOutcome(resultFile: string): InstanceOutcome | undefined {
  try {
    return JSON.parse(readFileSync(resultFile, 'utf8')) as InstanceOutcome;
  } catch {
    return undefined;
  }
}

async function pollFor<T>(label: string, check: () => T | undefined, deadlineMs: number): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`orchestrator: timed out after ${deadlineMs}ms waiting for ${label}`);
    }
    await delay(200);
  }
}

/**
 * Every mirror window directory for `room` under a user-data dir, as `{ publisher,
 * window, root, marker }`: what the orchestrator reads off its own disk instead of
 * driving a window it cannot click through.
 */
function roomMirrors(
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
function stashedMirror(
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
function mintStash(
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

/** Takes down only the guest's join-stage window: its reload landed and the phases
 * run in another window, so the undriven guest leaves before it can add presence
 * noise. Scoped to the join profile, never the phases one. */
function killGuestJoinEditors(reason: string): void {
  const alive = liveEditorProcesses();
  if (alive.guest.length > 0) {
    log(`killing guest join-stage editors (${reason}): ${alive.guest.join(', ')}`);
  }
  for (const pid of alive.guest) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // It exited between the scan and the signal.
    }
  }
}

async function runInstance(
  role: 'host' | 'guest' | 'empty',
  vscodeExecutablePath: string,
  workspaceDirs: string[],
  userDataDir: string,
  extensionsDir: string,
  env: Record<string, string | undefined>,
  logFile: string,
  suite: string = `${role}-suite.cjs`,
): Promise<{ code: number }> {
  mkdirSync(dirname(logFile), { recursive: true });
  const out = createWriteStream(logFile);
  inFlight.add(role);
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: resolve(import.meta.dirname, suite),
      extensionTestsEnv: env,
      stdout: out,
      stderr: out,
      launchArgs: [
        ...workspaceDirs,
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--disable-workspace-trust',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-gpu-sandbox',
        '--use-gl=swiftshader',
        '--disable-software-rasterizer',
      ],
    });
    return { code: 0 };
  } finally {
    inFlight.delete(role);
    out.end();
  }
}


async function main(): Promise<void> {
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  phase = 'building the extension bundle';
  log('building the extension bundle (npm run build)');
  try {
    await inherit('npm', ['run', 'build']);
  } catch (error) {
    throw new Error(`npm run build failed: ${String(error)}`);
  }

  phase = 'starting the real selvaged';
  log('starting the real selvaged');
  const server = await RealServer.start();
  activeServer = server;
  log('selvaged listening at', server.wsBase);

  const [, hostPort] = /:(\d+)$/.exec(server.address) ?? [];
  if (hostPort === undefined) {
    throw new Error(`could not parse a port out of ${server.address}`);
  }
  const proxy = RECONNECT ? await DropProxy.start('127.0.0.1', Number(hostPort)) : undefined;
  if (proxy !== undefined) {
    log('reconnect proxy listening on 127.0.0.1:' + proxy.port, '-> forwards to', server.address);
  }

  phase = 'resolving the VS Code build';
  log(`resolving VS Code ${VSCODE_VERSION} (downloads it the first time that version is used)`);
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: VSCODE_VERSION,
    cachePath: ensureVscodeCache(ROOT),
  });
  phase = 'working out the Electron library path';
  const libraryPath = await nixElectronLibraryPath();
  process.env['LD_LIBRARY_PATH'] = [libraryPath, process.env['LD_LIBRARY_PATH'] ?? '']
    .filter((part) => part !== '')
    .join(':');
  log('VS Code executable:', vscodeExecutablePath);

  const hostWorkspace = mkdtempSync(join(scratchDir(), 'selvage-host-'));
  const guestWorkspace = mkdtempSync(join(scratchDir(), 'selvage-guest-'));
  writeFileSync(join(hostWorkspace, SEED_PATH), SEED_TEXT);
  writeFileSync(join(hostWorkspace, WATCH_DOOMED_PATH), WATCH_DOOMED_TEXT);
  mkdirSync(join(hostWorkspace, dirname(GRANTED_PATH)), { recursive: true });
  writeFileSync(join(hostWorkspace, GRANTED_PATH), GRANTED_TEXT);

  const hostUserData = resolve(RUN_DIR, 'host-user-data');
  const hostExtensions = resolve(RUN_DIR, 'host-extensions');
  const guestUserData = resolve(RUN_DIR, 'guest-user-data');
  const guestExtensions = resolve(RUN_DIR, 'guest-extensions');

  const inviteFile = resolve(RUN_DIR, 'invite.txt');
  const roomPathFile = resolve(RUN_DIR, 'room-path.txt');
  const grantedPathFile = resolve(RUN_DIR, 'granted-path.txt');
  const watchReadyFile = resolve(RUN_DIR, 'watch-ready.txt');
  const watchDoneFile = resolve(RUN_DIR, 'watch-done.txt');
  const grantedDoneFile = resolve(RUN_DIR, 'granted-done.txt');
  const followReadyFile = resolve(RUN_DIR, 'follow-ready.txt');
  const followMovedFile = resolve(RUN_DIR, 'follow-moved.txt');
  const followStoppedFile = resolve(RUN_DIR, 'follow-stopped.txt');
  const controlFile = RECONNECT ? resolve(RUN_DIR, 'blip-done.txt') : undefined;
  // What the host writes once its own document holds the guest's post-blip edit. The guest waits
  // for it before it finishes: a re-seat cannot publish under its new key until a state commits
  // it, so the guest's edit is in flight for as long as that takes, and a window that exits with
  // an unsent frame takes the edit out of the room with it. Without this the phase's guest side
  // is satisfied by the guest's own buffer — text the room may never have received.
  const phase2AckFile = RECONNECT ? resolve(RUN_DIR, 'phase2-ack.txt') : undefined;
  const hostResultFile = resolve(RUN_DIR, 'host-result.json');
  const guestResultFile = resolve(RUN_DIR, 'guest-result.json');

  const sharedEnv = {
    ...DISPLAY_ONLY_ENV,
    SELVAGE_E2E_SEED_PATH: SEED_PATH,
    SELVAGE_E2E_INVITE_FILE: inviteFile,
    SELVAGE_E2E_ROOM_PATH_FILE: roomPathFile,
    SELVAGE_E2E_GRANTED_PATH_FILE: grantedPathFile,
    SELVAGE_E2E_GRANTED_DONE_FILE: grantedDoneFile,
    SELVAGE_E2E_GRANTED_PATH: GRANTED_PATH,
    SELVAGE_E2E_GRANTED_TEXT: GRANTED_TEXT,
    SELVAGE_E2E_WATCH_PATH: WATCH_PATH,
    SELVAGE_E2E_WATCH_TEXT: WATCH_TEXT,
    SELVAGE_E2E_WATCH_DOOMED_PATH: WATCH_DOOMED_PATH,
    SELVAGE_E2E_WATCH_READY_FILE: watchReadyFile,
    SELVAGE_E2E_WATCH_DONE_FILE: watchDoneFile,
    SELVAGE_E2E_FOLLOW_READY_FILE: followReadyFile,
    SELVAGE_E2E_FOLLOW_MOVED_FILE: followMovedFile,
    SELVAGE_E2E_FOLLOW_STOPPED_FILE: followStoppedFile,
    SELVAGE_E2E_FOLLOW_HOST_NAME: 'Ada',
    SELVAGE_E2E_MARKER_HOST: MARKER_HOST,
    SELVAGE_E2E_MARKER_GUEST: MARKER_GUEST,
    SELVAGE_E2E_MARKER_HOST_2: MARKER_HOST_2,
    SELVAGE_E2E_MARKER_GUEST_2: MARKER_GUEST_2,
    SELVAGE_E2E_DEADLINE_MS: String(DEADLINE_MS),
    SELVAGE_E2E_RECONNECT_DEADLINE_MS: String(RECONNECT_DEADLINE_MS),
    ...(controlFile === undefined ? {} : { SELVAGE_E2E_CONTROL_FILE: controlFile }),
    ...(phase2AckFile === undefined ? {} : { SELVAGE_E2E_PHASE2_ACK_FILE: phase2AckFile }),
  };

  phase = 'launching the host and the guest join stage';
  log('launching the host and the guest join stage concurrently');
  const hostRun = runInstance(
    'host',
    vscodeExecutablePath,
    [hostWorkspace],
    hostUserData,
    hostExtensions,
    {
      ...sharedEnv,
      SELVAGE_E2E_WORKSPACE: hostWorkspace,
      SELVAGE_E2E_RESULT_FILE: hostResultFile,
      SELVAGE_E2E_SERVER_URL: server.wsBase,
      SELVAGE_E2E_DISPLAY_NAME: 'Ada',
    },
    resolve(RUN_DIR, 'host.log'),
  );
  const guestStagedFile = resolve(RUN_DIR, 'guest-staged.txt');
  const guestStageErrorFile = resolve(RUN_DIR, 'guest-stage-error.txt');
  const guestJoinRun = runInstance(
    'guest',
    vscodeExecutablePath,
    [guestWorkspace],
    guestUserData,
    guestExtensions,
    {
      ...sharedEnv,
      SELVAGE_E2E_STAGE: 'join',
      SELVAGE_E2E_STAGED_FILE: guestStagedFile,
      SELVAGE_E2E_STAGE_ERROR_FILE: guestStageErrorFile,
      SELVAGE_E2E_DISPLAY_NAME: 'Bob',
      ...(proxy === undefined ? {} : { SELVAGE_E2E_PROXY_ADDR: `127.0.0.1:${proxy.port}` }),
    },
    resolve(RUN_DIR, 'guest-join.log'),
    'guest-suite.cjs',
  );
  // Neither promise is awaited until its own gate below, which can be a while (the
  // phase-1 poll and the blip); attach a no-op rejection handler now so Node does not
  // treat an early failure as unhandled in the meantime.
  hostRun.catch(() => {});
  guestJoinRun.catch(() => {});

  // The join stage proves the reload: the run tears itself down, which rejects.
  // Resolving means the reload never came.
  phase = 'waiting for the guest join to reload';
  let guestReloaded = false;
  try {
    await guestJoinRun;
  } catch {
    guestReloaded = true;
  }
  if (!guestReloaded) {
    throw new Error('orchestrator: the guest join resolved instead of reloading onto the mirror');
  }
  log('the guest join reloaded instead of resolving');
  // The teardown rejects either way, so the staged file is what tells a staged
  // reload from a join that never got that far — with the cause beside it.
  if (!existsSync(guestStagedFile)) {
    const cause = existsSync(guestStageErrorFile) ? readFileSync(guestStageErrorFile, 'utf8') : '(no cause left)';
    throw new Error(`orchestrator: the guest join tore down without staging the reload: ${cause}`);
  }

  // The join's own stash, read off disk: the reload without it fails here loudly,
  // which is what tells a torn-down run from a failed join apart. The invite the
  // phases window re-stashes is the marker's own — the wire form the client
  // stashed, byte for byte — never re-derived here.
  const guestInvite = existsSync(inviteFile) ? readFileSync(inviteFile, 'utf8') : undefined;
  if (guestInvite === undefined) {
    throw new Error('orchestrator: the host published no invite for the guest join');
  }
  const guestRoom = decodeURIComponent(/[?&]room=([^&]+)/.exec(guestInvite)?.[1] ?? '');
  if (guestRoom === '') {
    throw new Error('orchestrator: the invite names no room for the guest join');
  }
  const guestStash = await pollFor(
    'the guest join to stash its mirror',
    () => stashedMirror(guestUserData, guestRoom) ?? undefined,
    DEADLINE_MS,
  );
  const guestStashInvite = guestStash.invite;
  if (guestStash === undefined) {
    throw new Error('orchestrator: the guest stash vanished after the reload');
  }
  log('the guest join stashed its mirror at', guestStash.root);
  if (guestStash.displayName !== 'Bob') {
    throw new Error('orchestrator: the stashed join carries no name to land with');
  }
  const guestPublisher = guestStash.publisher;
  const guestPhasesUserData = resolve(RUN_DIR, 'guest-phases-user-data');
  const guestPhasesExtensions = resolve(RUN_DIR, 'guest-phases-extensions');
  const phasesMirror = mintStash(guestPhasesUserData, guestPublisher, guestRoom, guestStashInvite, 'Bob');
  log('the phases window opens straight onto', phasesMirror);
  killGuestJoinEditors('join stage stashed; phases run in their own window');

  phase = 'launching the guest phases window';
  const guestRun = runInstance(
    'guest',
    vscodeExecutablePath,
    [phasesMirror],
    guestPhasesUserData,
    guestPhasesExtensions,
    {
      ...sharedEnv,
      SELVAGE_E2E_STAGE: 'phases',
      SELVAGE_E2E_RESULT_FILE: guestResultFile,
      SELVAGE_E2E_DISPLAY_NAME: 'Bob',
      ...(proxy === undefined ? {} : { SELVAGE_E2E_PROXY_ADDR: `127.0.0.1:${proxy.port}` }),
    },
    resolve(RUN_DIR, 'guest.log'),
    'guest-suite.cjs',
  );
  guestRun.catch(() => {});

  // Phase 1 has to actually land in both real editors before anything after it means
  // anything, in both the reconnect run and the plain one.
  phase = 'waiting for phase 1 in both instances';
  await pollFor(
    'both instances to report phase 1 converged',
    () => {
      const hostOutcome = readOutcome(hostResultFile);
      const guestOutcome = readOutcome(guestResultFile);
      return hostOutcome?.phase1 !== undefined && guestOutcome?.phase1 !== undefined
        ? true
        : undefined;
    },
    DEADLINE_MS + 15_000,
  );

  // The follow phase runs before the granted phase in both suites, so it gets its own
  // gate: otherwise a slow follow is reported as a granted-path failure.
  phase = 'waiting for the follow phase to finish';
  await pollFor(
    'the guest to follow the host and then stop following',
    () => (existsSync(followStoppedFile) ? true : undefined),
    DEADLINE_MS + 15_000,
  );
  log('the guest tracked the host caret and stopped following');

  // The guest opens a granted path the host never opened. The guest writes the control file
  // once its own copy of that file's text has arrived, so the host's half of the proof —
  // opening the file and finding the guest's marker in it — starts only after the guest has
  // read what the host supplied on request.
  phase = 'waiting for the guest to read a granted path';
  await pollFor(
    'the guest to converge on a granted path the host never opened',
    () => (existsSync(grantedDoneFile) ? true : undefined),
    DEADLINE_MS + 15_000,
  );
  log('the guest has the granted path; the host will now open the file it never opened');

  // The watch phase: the host's suite makes a file under its own folder and removes another,
  // and the guest's half is what the room's listing became. It runs on its own files, so the
  // reconnect leg's scheduling is not moved by it.
  phase = 'waiting for the room\u2019s listing to follow the host\u2019s folder';
  await pollFor(
    'the guest to walk the room\u2019s listing after the host changed its folder',
    () => (existsSync(watchDoneFile) ? true : undefined),
    DEADLINE_MS + 15_000,
  );
  log('the guest has walked the room\u2019s listing the host\u2019s folder now stands for');

  // The empty-window stage: joining with no folder reloads the window onto the mirror,
  // which tears the first run down; the landed state is read off disk, and a second
  // window on a freshly stashed mirror proves the landing again with no command run.
  phase = 'empty window: joining with no folder';
  const emptyInvite = readFileSync(inviteFile, 'utf8');
  const emptyRoom = decodeURIComponent(/[?&]room=([^&]+)/.exec(emptyInvite)?.[1] ?? '');
  if (emptyRoom === '') {
    throw new Error('orchestrator: the invite names no room for the empty-window stage');
  }
  const emptyUserData = resolve(RUN_DIR, 'empty-user-data');
  const emptyExtensions = resolve(RUN_DIR, 'empty-extensions');
  const emptyStagedFile = resolve(RUN_DIR, 'empty-staged.txt');
  const emptyStageErrorFile = resolve(RUN_DIR, 'empty-stage-error.txt');
  const emptyJoinRun = runInstance(
    'empty',
    vscodeExecutablePath,
    [],
    emptyUserData,
    emptyExtensions,
    {
      ...sharedEnv,
      SELVAGE_E2E_EMPTY_STAGE: 'join',
      SELVAGE_E2E_STAGED_FILE: emptyStagedFile,
      SELVAGE_E2E_STAGE_ERROR_FILE: emptyStageErrorFile,
      SELVAGE_E2E_EMPTY_INVITE: emptyInvite,
      SELVAGE_E2E_DISPLAY_NAME: 'Empty',
    },
    resolve(RUN_DIR, 'empty-join.log'),
    'guest-empty-suite.cjs',
  );
  emptyJoinRun.catch(() => {});
  let emptyReloaded = false;
  try {
    await emptyJoinRun;
  } catch {
    emptyReloaded = true;
  }
  if (!emptyReloaded) {
    throw new Error('orchestrator: the empty-window join resolved instead of reloading');
  }
  if (!existsSync(emptyStagedFile)) {
    const cause = existsSync(emptyStageErrorFile) ? readFileSync(emptyStageErrorFile, 'utf8') : '(no cause left)';
    throw new Error(`orchestrator: the empty-window join tore down without staging the reload: ${cause}`);
  }
  const emptyStash = await pollFor(
    'the empty-window join to stash its mirror',
    () => stashedMirror(emptyUserData, emptyRoom) ?? undefined,
    DEADLINE_MS,
  );
  log('the empty-window join stashed its mirror at', emptyStash.root);
  if (emptyStash.displayName !== 'Empty') {
    throw new Error('orchestrator: the stashed join carries no name to land with');
  }
  const emptyPublisher = emptyStash.publisher;
  // Take the join run's leftovers down, then re-stash for the second window: leaving
  // removed the directory with the session, so the reloaded window proves the same
  // landing again from the fresh stash, in this same profile.
  killEmptyEditors('empty-window join stashed; the reloaded window proves it again');
  // The join's own stash goes first: triage finishes the first pending invite it
  // finds, so a dead stash beside the fresh one would hijack the landing into a
  // reload somewhere else. The reload it proved is already on record.
  rmSync(emptyStash.root, { recursive: true, force: true });
  const emptyRestash = mintStash(emptyUserData, emptyPublisher, emptyRoom, emptyStash.invite, 'Empty');
  log('the reloaded window opens straight onto', emptyRestash);

  phase = 'empty window: proving the stashed join landed';
  const emptyDoneFile = resolve(RUN_DIR, 'empty-done.txt');
  const emptyResultFile = resolve(RUN_DIR, 'empty-result.json');
  const emptyReloadRun = runInstance(
    'empty',
    vscodeExecutablePath,
    [emptyRestash],
    emptyUserData,
    emptyExtensions,
    {
      ...sharedEnv,
      SELVAGE_E2E_EMPTY_STAGE: 'reloaded',
      SELVAGE_E2E_EMPTY_DONE_FILE: emptyDoneFile,
      SELVAGE_E2E_EMPTY_RESULT_FILE: emptyResultFile,
      SELVAGE_E2E_DISPLAY_NAME: 'Empty',
    },
    resolve(RUN_DIR, 'empty-reload.log'),
    'guest-empty-suite.cjs',
  );
  await emptyReloadRun;
  await pollFor(
    'the reloaded window to prove the stashed join',
    () => (existsSync(emptyDoneFile) ? true : undefined),
    DEADLINE_MS + 15_000,
  );
  const emptyOutcome = JSON.parse(readFileSync(emptyResultFile, 'utf8')) as {
    joined?: boolean;
    materialised?: boolean;
    singleFolder?: boolean;
    error?: string;
  };
  log('empty-window outcome:', JSON.stringify(emptyOutcome));

  if (proxy !== undefined && controlFile !== undefined) {
    phase = 'cutting the relay and reconnecting';
    relayConnectionsBeforeCut = proxy.connections;
    log('cutting the guest relay (a real TCP close)');
    proxy.dropAll();
    await delay(2000);
    writeFileSync(controlFile, 'go');
    log('blip signalled; waiting for the guest to reconnect and both sides to re-converge');
  }

  const hostLogFile = resolve(RUN_DIR, 'host.log');
  const guestLogFile = resolve(RUN_DIR, 'guest.log');
  // A launched editor that never finishes is otherwise waited on for ever, and a run that
  // prints nothing while it waits cannot be told from a hung one — which is how a stalled run
  // reads when its output is piped somewhere it will not be read until it exits. The deadline
  // names the logs instead.
  //
  // The deadline is cancelled as soon as the instances settle: the timer behind it would
  // otherwise outlive the race and hold the process open for the rest of its budget, which is
  // minutes of wall clock on a run that has already passed.
  phase = 'waiting for the instances to settle';
  const deadline = new AbortController();
  const [hostResult, guestResult] = await Promise.race([
    Promise.allSettled([hostRun, guestRun]),
    delay(INSTANCE_DEADLINE_MS, undefined, { signal: deadline.signal }).then((): never => {
      throw new Error(
        `orchestrator: an instance did not finish within ${INSTANCE_DEADLINE_MS}ms; its output is in ${hostLogFile} and ${guestLogFile}`,
      );
    }),
  ]).finally(() => {
    deadline.abort();
  });
  await proxy?.stop();
  await stopWhatThisRunStarted('run finished');

  phase = 'checking the outcomes';
  const hostOutcome = readOutcome(hostResultFile);
  const guestOutcome = readOutcome(guestResultFile);

  log('host runTests settled:', hostResult.status, hostResult.status === 'rejected' ? String(hostResult.reason) : '');
  log('guest runTests settled:', guestResult.status, guestResult.status === 'rejected' ? String(guestResult.reason) : '');
  log('host outcome:', JSON.stringify(hostOutcome));
  log('guest outcome:', JSON.stringify(guestOutcome));

  const summary = {
    phase1: {
      converged:
        hostOutcome?.phase1 !== undefined &&
        guestOutcome?.phase1 !== undefined &&
        hostOutcome.phase1.text === guestOutcome.phase1.text &&
        hostOutcome.phase1.text.includes(MARKER_HOST) &&
        hostOutcome.phase1.text.includes(MARKER_GUEST),
      hostText: hostOutcome?.phase1?.text,
      guestText: guestOutcome?.phase1?.text,
    },
    phase2: RECONNECT
      ? {
          converged:
            phase2AckFile !== undefined &&
            existsSync(phase2AckFile) &&
            hostOutcome?.phase2 !== undefined &&
            guestOutcome?.phase2 !== undefined &&
            hostOutcome.phase2.text === guestOutcome.phase2.text &&
            [MARKER_HOST, MARKER_GUEST, MARKER_HOST_2, MARKER_GUEST_2].every((marker) =>
              hostOutcome.phase2?.text.includes(marker),
            ),
          acked: phase2AckFile !== undefined && existsSync(phase2AckFile),
          hostText: hostOutcome?.phase2?.text,
          guestText: guestOutcome?.phase2?.text,
        }
      : undefined,
    follow: {
      // The guest followed the host to the end of the shared document, then stopped and held
      // the tracked position while the host moved back to the start: a follow that did not
      // stop would have tracked back.
      converged:
        hostOutcome?.follow !== undefined &&
        guestOutcome?.follow !== undefined &&
        typeof hostOutcome.follow.movedTo === 'number' &&
        guestOutcome.follow.tracked === hostOutcome.follow.movedTo &&
        guestOutcome.follow.heldAfterStop === hostOutcome.follow.movedTo,
      hostMovedTo: hostOutcome?.follow?.movedTo,
      guestTracked: guestOutcome?.follow?.tracked,
      guestHeld: guestOutcome?.follow?.heldAfterStop,
    },
    granted: {
      // The guest read a file the host never opened, and the host then opened it and found
      // the guest's marker in the room's copy: content travelled both ways over a path that
      // was only ever a name until somebody asked for it.
      converged:
        hostOutcome?.granted !== undefined &&
        guestOutcome?.granted !== undefined &&
        guestOutcome.granted.text === GRANTED_TEXT + MARKER_GUEST &&
        hostOutcome.granted.text === GRANTED_TEXT + MARKER_GUEST &&
        hostOutcome.granted.heldBeforeGuest === false,
      hostText: hostOutcome?.granted?.text,
      guestText: guestOutcome?.granted?.text,
      heldBeforeGuest: hostOutcome?.granted?.heldBeforeGuest,
    },
    empty: {
      // The empty-window join reloaded instead of resolving and landed in the
      // reloaded window, and the window reopened on a freshly stashed mirror
      // proved the landing again — invite gone, listing filled, no second
      // folder — with no command run at all.
      converged:
        emptyOutcome.joined === true &&
        emptyOutcome.materialised === true &&
        emptyOutcome.singleFolder === true &&
        emptyOutcome.error === undefined,
      joined: emptyOutcome.joined,
      materialised: emptyOutcome.materialised,
      singleFolder: emptyOutcome.singleFolder,
    },
    singleFolder: {
      // The phases window is the mirror and nothing else: the join replaced the
      // tree rather than adding a second root beside it.
      converged: guestOutcome?.singleFolder === true,
    },
    watch: {
      // The host made a file under its own folder and removed another while the room was live,
      // and the guest's view of the room — its mirror on disk — gained the
      // one and lost the other. The content travelled because the guest opened a path that was
      // a name in the listing a moment before. The removed path, opened fresh after the
      // listing lost it, is refused with the reason instead of a phantom empty document.
      converged:
        hostOutcome?.watch !== undefined &&
        guestOutcome?.watch !== undefined &&
        guestOutcome.watch.rootBefore?.includes(WATCH_DOOMED_PATH) === true &&
        guestOutcome.watch.rootAfter?.includes(WATCH_DOOMED_PATH) === false &&
        guestOutcome.watch.rootAfter?.includes(dirname(WATCH_PATH)) === true &&
        guestOutcome.watch.createdDir?.includes(basename(WATCH_PATH)) === true &&
        guestOutcome.watch.text === WATCH_TEXT &&
        guestOutcome.watch.deleteRefused === true,
      created: guestOutcome?.watch?.created,
      deleted: guestOutcome?.watch?.deleted,
      rootBefore: guestOutcome?.watch?.rootBefore,
      rootAfter: guestOutcome?.watch?.rootAfter,
      createdDir: guestOutcome?.watch?.createdDir,
      guestText: guestOutcome?.watch?.text,
      deleteRefused: guestOutcome?.watch?.deleteRefused,
      deleteRefusal: guestOutcome?.watch?.deleteRefusal,
    },
  };
  writeFileSync(resolve(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  log('summary:', JSON.stringify(summary, null, 2));

  if (!summary.phase1.converged) {
    throw new Error('the two real VS Code instances did not converge on the shared document');
  }
  if (!summary.follow.converged) {
    throw new Error(
      'the guest did not track the host caret while following, or did not hold its position after stopping',
    );
  }
  if (!summary.granted.converged) {
    throw new Error(
      'the guest did not converge on a granted path the host supplied on request',
    );
  }
  if (RECONNECT && proxy !== undefined && summary.phase2?.converged === true) {
    log(
      `the relay accepted ${proxy.connections} client connection(s): ${relayConnectionsBeforeCut} before the blip, ${proxy.connections - relayConnectionsBeforeCut} after it`,
    );
    if (relayConnectionsBeforeCut < 1) {
      throw new Error(
        'the reconnect phase converged without the guest ever reaching the relay: the blip cut a socket the guest did not hold, so nothing in this run was reconnected',
      );
    }
    if (proxy.connections <= relayConnectionsBeforeCut) {
      throw new Error(
        'the reconnect phase converged without the guest reconnecting through the relay: no connection was accepted after the blip, so the blip cut nothing the guest held',
      );
    }
  }
  if (RECONNECT && summary.phase2?.converged !== true) {
    throw new Error(
      `the reconnect phase did not converge after the simulated network blip (the host's acknowledgement of the guest's post-blip edit: ${String(summary.phase2?.acked)})`,
    );
  }
  if (!summary.watch.converged) {
    throw new Error(
      'the room\u2019s listing did not follow the host\u2019s folder: the guest\u2019s view of the room did not gain the path the host made, did not lose the one it removed, or was not told the removed path is gone',
    );
  }
  if (!summary.empty.converged) {
    throw new Error(
      'the empty-window join did not reload onto a mirror whose stashed join landed',
    );
  }
  if (!summary.singleFolder.converged) {
    throw new Error(
      'the guest phases window holds more than the room mirror: the join added a second root instead of replacing the tree',
    );
  }
  log(
    'PASSED: two real VS Code instances converged on the shared document, the guest joined by reloading its window onto the room mirror alone, the guest tracked the host caret while following and held its position after stopping, a guest read a granted path the host never opened, the room\u2019s listing followed the host\u2019s folder, and an empty window joined by reloading onto the mirror' +
      (RECONNECT ? ', and the guest re-converged after a simulated network blip' : ''),
  );
  phase = 'done';
}

function scratchDir(): string {
  mkdirSync(RUN_DIR, { recursive: true });
  return RUN_DIR;
}

const watchdog = armWatchdog();
main()
  .then(() => {
    clearTimeout(watchdog);
  })
  .catch((error: unknown) => {
    console.error('[e2e] FAILED:', error);
    // A failed run must end here. The editor processes are `@vscode/test-electron`'s children, and
    // an exception thrown before they settle leaves them holding the event loop open: the run then
    // sits silent until whatever started it gives up, which reads like a hang rather than a
    // failure. The exit code is the report; nothing after this point is worth waiting for. The
    // server and the editors are stopped first, or a failed run leaves them running for ever.
    void stopAndExit(1);
  });

/**
 * A signal is a run ending non-zero too, and it ends in the same place: stop what was started,
 * then leave with the code the shell expects for that signal.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    console.error(`[e2e] ${signal}: stopping the server and the editors this run started`);
    void stopAndExit(128 + constants.signals[signal]);
  });
}
