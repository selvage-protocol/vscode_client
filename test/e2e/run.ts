/**
 * The two-real-instance convergence proof: two independent, real VS Code Extension
 * Development Host processes (`@vscode/test-electron`, headless under Xvfb), each with the
 * real built `dist/extension.js` loaded, one hosting and one joining over a real `selvaged`,
 * editing the same document concurrently.
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
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { constants } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

import { RealServer } from '../helpers/selvaged.ts';

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
const DEADLINE_MS = Number(process.env.SELVAGE_E2E_DEADLINE_MS ?? '20000');
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
    String(DEADLINE_MS + (RECONNECT ? RECONNECT_DEADLINE_MS : 0) + 180_000),
);
/**
 * The bound on the whole run. Every other deadline above bounds a step; this one covers the
 * steps that have none, and the shape that produces no output at all — the orchestrator past
 * its last log line, waiting on something that is no longer there, which reads as a hang
 * rather than a failure when the output is piped somewhere it is only read at exit. A run that
 * has to download a build the cache does not hold is doing an announced, one-off transfer, and
 * can be given room with `SELVAGE_E2E_WATCHDOG_MS`.
 */
const WATCHDOG_MS = Number(process.env.SELVAGE_E2E_WATCHDOG_MS ?? '300000');
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
const inFlight = new Set<'host' | 'guest'>();
/** The server this run started, if it has got that far; stopped on every way out. */
let activeServer: RealServer | undefined;

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
function liveEditorProcesses(): { host: number[]; guest: number[] } {
  const alive: { host: number[]; guest: number[] } = { host: [], guest: [] };
  const hostUserData = resolve(RUN_DIR, 'host-user-data');
  const guestUserData = resolve(RUN_DIR, 'guest-user-data');
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
    } else if (cmdline.includes(guestUserData)) {
      alive.guest.push(Number(entry));
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
function killLiveEditors(): void {
  const alive = liveEditorProcesses();
  for (const pid of [...alive.host, ...alive.guest]) {
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
async function stopWhatThisRunStarted(): Promise<void> {
  const server = activeServer;
  activeServer = undefined;
  if (server !== undefined) {
    // `stop` escalates to SIGKILL on its own; the race is what makes the wait bounded even if
    // that never lands, since the process is leaving either way.
    await Promise.race([server.stop(), delay(SERVER_STOP_GRACE_MS)]);
  }
  killLiveEditors();
}

/** Stop, then leave with this code: the body of every failing ending. */
async function stopAndExit(code: number): Promise<void> {
  await stopWhatThisRunStarted();
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
    console.error(`[e2e] WATCHDOG: editor processes alive: host ${list(alive.host)}; guest ${list(alive.guest)}`);
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

  private constructor(server: net.Server, port: number, sockets: Set<net.Socket>) {
    this.server = server;
    this.port = port;
    this.sockets = sockets;
  }

  static async start(targetHost: string, targetPort: number): Promise<DropProxy> {
    return new Promise((resolvePromise, reject) => {
      const sockets = new Set<net.Socket>();
      const server = net.createServer((client) => {
        const upstream = net.connect(targetPort, targetHost);
        sockets.add(client);
        sockets.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        const forget = (): void => {
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on('close', forget);
        upstream.on('close', forget);
        client.on('error', () => {
          upstream.destroy();
        });
        upstream.on('error', () => {
          client.destroy();
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('proxy has no port'));
          return;
        }
        resolvePromise(new DropProxy(server, address.port, sockets));
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
  /** What the granted path held in this editor, and whether the host had it open too early. */
  granted?: { text: string; heldBeforeGuest?: boolean };
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

async function runInstance(
  role: 'host' | 'guest',
  vscodeExecutablePath: string,
  workspaceDir: string,
  userDataDir: string,
  extensionsDir: string,
  env: Record<string, string | undefined>,
  logFile: string,
): Promise<{ code: number }> {
  mkdirSync(dirname(logFile), { recursive: true });
  const out = createWriteStream(logFile);
  inFlight.add(role);
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: resolve(import.meta.dirname, `${role}-suite.cjs`),
      extensionTestsEnv: env,
      stdout: out,
      stderr: out,
      launchArgs: [
        workspaceDir,
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
    cachePath: resolve(TMP, 'vscode-test'),
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
  mkdirSync(join(hostWorkspace, dirname(GRANTED_PATH)), { recursive: true });
  writeFileSync(join(hostWorkspace, GRANTED_PATH), GRANTED_TEXT);

  const hostUserData = resolve(RUN_DIR, 'host-user-data');
  const hostExtensions = resolve(RUN_DIR, 'host-extensions');
  const guestUserData = resolve(RUN_DIR, 'guest-user-data');
  const guestExtensions = resolve(RUN_DIR, 'guest-extensions');

  const inviteFile = resolve(RUN_DIR, 'invite.txt');
  const roomPathFile = resolve(RUN_DIR, 'room-path.txt');
  const grantedPathFile = resolve(RUN_DIR, 'granted-path.txt');
  const grantedDoneFile = resolve(RUN_DIR, 'granted-done.txt');
  const controlFile = RECONNECT ? resolve(RUN_DIR, 'blip-done.txt') : undefined;
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
    SELVAGE_E2E_MARKER_HOST: MARKER_HOST,
    SELVAGE_E2E_MARKER_GUEST: MARKER_GUEST,
    SELVAGE_E2E_MARKER_HOST_2: MARKER_HOST_2,
    SELVAGE_E2E_MARKER_GUEST_2: MARKER_GUEST_2,
    SELVAGE_E2E_DEADLINE_MS: String(DEADLINE_MS),
    SELVAGE_E2E_RECONNECT_DEADLINE_MS: String(RECONNECT_DEADLINE_MS),
    ...(controlFile === undefined ? {} : { SELVAGE_E2E_CONTROL_FILE: controlFile }),
  };

  phase = 'launching the instances';
  log('launching both real VS Code instances concurrently');
  const hostRun = runInstance(
    'host',
    vscodeExecutablePath,
    hostWorkspace,
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
  const guestRun = runInstance(
    'guest',
    vscodeExecutablePath,
    guestWorkspace,
    guestUserData,
    guestExtensions,
    {
      ...sharedEnv,
      SELVAGE_E2E_RESULT_FILE: guestResultFile,
      SELVAGE_E2E_DISPLAY_NAME: 'Bob',
      ...(proxy === undefined ? {} : { SELVAGE_E2E_PROXY_ADDR: `127.0.0.1:${proxy.port}` }),
    },
    resolve(RUN_DIR, 'guest.log'),
  );
  // Neither promise is awaited until `Promise.allSettled` below, which can be a while (the
  // phase-1 poll and the blip); attach a no-op rejection handler now so Node does not treat
  // an early failure as unhandled in the meantime.
  hostRun.catch(() => {});
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

  if (proxy !== undefined && controlFile !== undefined) {
    phase = 'cutting the relay and reconnecting';
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
  await stopWhatThisRunStarted();

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
            hostOutcome?.phase2 !== undefined &&
            guestOutcome?.phase2 !== undefined &&
            hostOutcome.phase2.text === guestOutcome.phase2.text &&
            [MARKER_HOST, MARKER_GUEST, MARKER_HOST_2, MARKER_GUEST_2].every((marker) =>
              hostOutcome.phase2?.text.includes(marker),
            ),
          hostText: hostOutcome?.phase2?.text,
          guestText: guestOutcome?.phase2?.text,
        }
      : undefined,
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
  };
  writeFileSync(resolve(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  log('summary:', JSON.stringify(summary, null, 2));

  if (!summary.phase1.converged) {
    throw new Error('the two real VS Code instances did not converge on the shared document');
  }
  if (!summary.granted.converged) {
    throw new Error(
      'the guest did not converge on a granted path the host supplied on request',
    );
  }
  if (RECONNECT && summary.phase2?.converged !== true) {
    throw new Error('the reconnect phase did not converge after the simulated network blip');
  }
  log(
    'PASSED: two real VS Code instances converged on the shared document, and a guest read a granted path the host never opened' +
      (RECONNECT ? ', and again after a simulated network blip' : ''),
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
