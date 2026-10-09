/**
 * The README's screenshot, taken from two real VS Code windows in one room on a real `selvaged`:
 * the host as a real Extension Development Host with the real built extension, drawn on an Xvfb
 * display at 1280×800, and a guest behind it but just as real — on its own display, in the same
 * room, with its selection on the same file. The window is staged through the driver suites beside
 * this file (`scene-host.cjs` and `scene-guest.cjs`, launched by `@vscode/test-electron` the way
 * the end-to-end proof launches its own), captured `import -window root` once the display has
 * stopped changing, and written to the output directory.
 *
 * A manual step, run when the extension's look changes, and never part of the gate:
 *
 *   scripts/screenshots/capture.sh
 *   node test/screenshots/capture.ts <output directory>   # what that script runs for you
 *
 * It has the end-to-end proof's prerequisites — a `selvaged`, a `nix` for the library path a build
 * unpacked outside nix needs on NixOS, and a network path the first time a build is downloaded —
 * plus a display to draw on and `xdotool` and `import` to read it, all of which
 * `scripts/screenshots/capture.sh` supplies. The image is recompressed and size-checked there.
 *
 * A join reloads the window it joined in, so the guest runs in two windows, exactly as it does in
 * the end-to-end proof: the first joins and is torn down by its own reload, the second opens
 * straight onto the mirror the first stashed. Both are on the guest's own display and neither is
 * captured — what the picture is of is the host, which needs a real guest in the room and nothing
 * from that guest's window.
 *
 * Nothing here is named after the machine taking the picture: each window's `--user-data-dir` is
 * its own sandbox under `.tmp/screenshots/`, the host's `HOME` is that sandbox, and the project
 * opens under its own folder, so the window's title reads `taskboard` and its breadcrumb reads
 * `src/board.ts` rather than a path of this checkout.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runTests } from '@vscode/test-electron';

import { RealServer } from '../helpers/selvaged.ts';
import { DISPLAY_ONLY_ENV, inheritElectronLibraries, vscodeExecutable } from '../e2e/electron.ts';
import { mintStash, stashedMirror } from '../e2e/mirrors.ts';
import { killWindows, windowsFor } from '../e2e/windows.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TMP = resolve(ROOT, '.tmp');
const RUN = resolve(TMP, 'screenshots');

/** The shared folder, as a host's window shows it: the project's own name, and one file of it. */
const FOLDER = 'taskboard';
const DOC = 'src/board.ts';

/**
 * Where each side of the picture stands, as the text the scene finds rather than a line number, so
 * that editing the project moves the two with it. Ada's caret is on the line the task is looked up
 * on; Grace selects the line the room's whole business is about, the work-in-progress check.
 */
const HOST_AT = 'const task = this.tasks.get(id)';
const GUEST_SELECTS = 'this.column(to).length >= limit';

/** The screen this run makes for the host's window. It is the size the screenshot is of. */
const SCREEN = { width: 1280, height: 800 };
/** How many captures of the display in a row have to agree before one is taken. */
const STILL_SAMPLES = 3;

const DEADLINE_MS = Number(process.env['SELVAGE_E2E_DEADLINE_MS'] ?? '60000');
/** How long the windows hold the scene for the capture once it is staged. */
const HOLD_MS = 600_000;
/** The bound on the whole run, so that a step with no bound of its own fails rather than hangs. */
const WATCHDOG_MS = 1_200_000;
const COMMAND_MS = 120_000;
const DISPLAY_DEADLINE_MS = 30_000;
const WINDOW_DEADLINE_MS = 300_000;

/** The profile directories this run passes, which is how its windows are told from anybody else's. */
const hostUserData = resolve(RUN, 'host-user-data');
const guestJoinUserData = resolve(RUN, 'guest-join-user-data');
const guestPhasesUserData = resolve(RUN, 'guest-phases-user-data');
const profiles = [hostUserData, guestJoinUserData, guestPhasesUserData];

/**
 * What the host's profile is told before its window opens: this is somebody's editor, and the
 * settings below are the ones that keep the first-run furniture — a welcome tab, a tip, a sign-in
 * offer for an assistant, a second sidebar — out of a picture of a session. Everything else is
 * VS Code's own default, its theme and its font included: what a reader sees is the extension's own
 * look, not a theme this repository chose.
 */
const SETTINGS: Record<string, unknown> = {
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoCheckUpdates': false,
  // A caret that blinks is a display that never stops changing, which is a picture that never
  // settles: what this run captures is an editor nobody is typing in.
  'editor.cursorBlinking': 'solid',
  // The sandbox project sits inside this checkout, so the git extension would offer to open the
  // repository around it: not what a picture of a session is about.
  'git.openRepositoryInParentFolders': 'never',
};

/**
 * The project the screenshot shows, as the same small kanban board the other clients' own
 * screenshots use — a person's real work, not a fixture. It is TypeScript because VS Code reads
 * that without an extension installed, and it is written into the host's sandbox on every run.
 */
const PROJECT: Record<string, string> = {
  'src/board.ts': `export type Status = 'todo' | 'in-progress' | 'review' | 'done';

export class Task {
  constructor(
    readonly id: number,
    readonly title: string,
    public status: Status = 'todo',
    public assignee?: string,
    public due?: Date,
  ) {}

  isOverdue(today: Date): boolean {
    return this.status !== 'done' && this.due !== undefined && this.due < today;
  }
}

/** How many tasks a column may hold at once. */
const defaultLimits: Partial<Record<Status, number>> = { 'in-progress': 3, review: 2 };

export class Board {
  private readonly tasks = new Map<number, Task>();
  private nextId = 1;

  constructor(private readonly limits: Partial<Record<Status, number>> = defaultLimits) {}

  add(title: string, due?: Date): Task {
    const task = new Task(this.nextId++, title, 'todo', undefined, due);
    this.tasks.set(task.id, task);
    return task;
  }

  column(status: Status): Task[] {
    return [...this.tasks.values()].filter((task) => task.status === status);
  }

  move(id: number, to: Status): Task {
    const task = this.tasks.get(id);
    if (task === undefined) {
      throw new Error(\`no task \${id}\`);
    }
    const limit = this.limits[to];
    if (limit !== undefined && this.column(to).length >= limit) {
      throw new Error(\`\${to} is full (\${limit})\`);
    }
    task.status = to;
    return task;
  }

  overdue(today: Date): Task[] {
    return [...this.tasks.values()].filter((task) => task.isOverdue(today));
  }
}
`,
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
`,
  'README.md': `# taskboard

A small kanban board in TypeScript: tasks move from To do to Done, and a column refuses a task once
it is at its work-in-progress limit.
`,
};

/** What the run is doing, for the watchdog to report when a step outlives its bound. */
let phase = 'startup';
/** The display the host's window is on, for a failed run to save the screen it stood in. */
let hostDisplay = '';
let lastLogged = '(nothing logged yet)';

function log(...parts: unknown[]): void {
  lastLogged = parts.map((part) => String(part)).join(' ');
  console.log('[screenshots]', ...parts);
}

function fail(message: string): never {
  throw new Error(message);
}

/** Every process this run started, so that every way out takes them down with it. */
const running = new Set<ChildProcess>();
/** The logs `@vscode/test-electron` writes into, ended on the way out so a failure is readable. */
const logs: WriteStream[] = [];

function spawnTracked(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.on('exit', () => {
    running.delete(child);
  });
  return child;
}

async function stopRunning(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  for (const child of running) {
    try {
      child.kill(signal);
    } catch {
      // It exited between the scan and the signal.
    }
  }
  // The editor windows are `@vscode/test-electron`'s children and no handle on them comes back, so
  // they are found the way the proof finds them: by the profile directory only this run passes.
  killWindows([...windowsFor(profiles).values()].flat(), 'editor windows', log);
  await delay(1000);
  for (const stream of logs) {
    stream.end();
  }
}

/**
 * One command, bounded, with its output read back: what `xdotool` and `import` answer with is the
 * run's own reading of the display, and a command that never returns is a failure here rather than
 * a run that says nothing for as long as something else is willing to wait. `stream` hands the
 * output to this run's own instead, for the one command whose output is progress rather than an
 * answer, and `display` is the X display the command is to look at.
 */
async function command(
  program: string,
  args: string[],
  options: { want?: 'text'; stream?: boolean; display?: string } = {},
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const child = spawn(program, args, {
      stdio: options.stream === true ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      ...(options.display === undefined ? {} : { env: { ...process.env, DISPLAY: options.display } }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`\`${program} ${args.join(' ')}\` did not finish within ${String(COMMAND_MS)}ms`));
    }, COMMAND_MS);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const said = Buffer.concat(stderr).toString().trim();
        reject(new Error(`\`${program} ${args.join(' ')}\` exited with ${String(code)}: ${said}`));
        return;
      }
      const out = Buffer.concat(stdout);
      resolvePromise(options.want === 'text' ? Buffer.from(out.toString().trim()) : out);
    });
  });
}

async function xdotool(args: string[], display?: string): Promise<string> {
  return (await command('xdotool', args, { want: 'text', ...(display === undefined ? {} : { display }) })).toString();
}

async function pollFor<T>(
  label: string,
  check: () => T | Promise<T> | undefined,
  deadlineMs = DEADLINE_MS,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    // Awaited, so an asynchronous check is polled rather than answered with its own promise: a
    // promise is never `undefined`, and a poll that takes one for an answer asks exactly once.
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      fail(`timed out after ${String(deadlineMs)}ms waiting for ${label}`);
    }
    await delay(200);
  }
}

/** Reads a file a scene wrote, or nothing while it is not there yet. */
function readIfThere(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The last lines of a log, for a failure that has one behind it. */
function tail(path: string, lines = 12): string {
  const text = readIfThere(path);
  if (text === undefined) {
    return `${path} (no log)`;
  }
  return `${path}:\n${text.split('\n').slice(-lines).join('\n')}`;
}

function writeProject(root: string): void {
  for (const [path, text] of Object.entries(PROJECT)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/**
 * One `Xvfb` screen at the size the screenshot is of, on the first display name nothing is using,
 * so that two runs on one machine — or one run's host and guest — never share a screen.
 */
async function startDisplay(): Promise<string> {
  for (let number = 90; number < 120; number += 1) {
    const name = `:${String(number)}`;
    const socket = `/tmp/.X11-unix/X${String(number)}`;
    if (existsSync(socket)) {
      continue;
    }
    const xvfb = spawnTracked(
      'Xvfb',
      [name, '-screen', '0', `${String(SCREEN.width)}x${String(SCREEN.height)}x24`, '-nolisten', 'tcp'],
      {},
    );
    xvfb.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    await pollFor(`the display ${name} to come up`, () => (existsSync(socket) ? true : undefined), DISPLAY_DEADLINE_MS);
    return name;
  }
  return fail('every display from :90 to :119 is in use');
}

/** The screen that display was made with, from the outside: a capture of the root does not say. */
async function assertScreenSize(display: string): Promise<void> {
  const [width, height] = (await xdotool(['getdisplaygeometry'], display)).split(' ').map(Number);
  if (width !== SCREEN.width || height !== SCREEN.height) {
    fail(
      `${display} is ${String(width)}x${String(height)}, not ${String(SCREEN.width)}x${String(SCREEN.height)}: ` +
        'this run makes its own Xvfb screen at that size',
    );
  }
}

/**
 * Every window on a display, as `#id "name" WxH+X+Y`: what a display holds is not something a
 * capture of it answers, and a run that cannot find the editor in it has to say what it found
 * instead.
 */
async function describeWindows(display: string): Promise<string> {
  let ids: string[];
  try {
    ids = (await xdotool(['search', '--name', '.'], display)).split('\n').filter((id) => id !== '');
  } catch {
    return '(nothing on it answers)';
  }
  const described: string[] = [];
  for (const id of ids) {
    const name = (await xdotool(['getwindowname', id], display)).trim();
    const geometry = await xdotool(['getwindowgeometry', '--shell', id], display);
    const read = (field: string): number => {
      const match = new RegExp(`^${field}=(-?\\d+)$`, 'm').exec(geometry);
      return match === null ? NaN : Number(match[1]);
    };
    described.push(
      `#${id} ${JSON.stringify(name)} ${String(read('WIDTH'))}x${String(read('HEIGHT'))}+${String(read('X'))}+${String(read('Y'))}`,
    );
  }
  return described.join('; ');
}

/**
 * Whether a window showing the whole display is up on it: a picture of a desktop with a small
 * window on it says nothing. Electron opens more than one X window per editor — and there is no
 * window manager under Xvfb, so the editor asks for the screen and adds the frame one would have
 * given it — so this is about a window anchored at the display's origin and at least as large as
 * it, whichever of the editor's windows that is.
 */
async function windowFillsDisplay(display: string): Promise<boolean> {
  const ids = (await xdotool(['search', '--name', '.'], display)).split('\n').filter((id) => id !== '');
  for (const window of ids) {
    const geometry = await xdotool(['getwindowgeometry', '--shell', window], display);
    const read = (name: string): number => {
      const match = new RegExp(`^${name}=(-?\\d+)$`, 'm').exec(geometry);
      return match === null ? NaN : Number(match[1]);
    };
    if (read('X') === 0 && read('Y') === 0 && read('WIDTH') >= SCREEN.width && read('HEIGHT') >= SCREEN.height) {
      return true;
    }
  }
  return false;
}

/** One capture of that whole display, as the raw bytes `import` hands back. */
async function frame(display: string): Promise<Buffer> {
  return command('import', ['-display', display, '-window', 'root', 'ppm:-']);
}

/**
 * How many of the 256 byte values a capture holds. A blank display holds the black every channel
 * is and the header of the format itself — a handful — while a window with text in it holds a
 * shade for every glyph: this is what tells a picture of a window from a picture of nothing, which
 * stillness alone cannot, since a blank display is perfectly still.
 */
function distinctBytes(capture: Buffer): number {
  const seen = new Uint8Array(256);
  for (const byte of capture) {
    seen[byte] = 1;
  }
  let count = 0;
  for (const value of seen) {
    count += value;
  }
  return count;
}

/**
 * Saves the display once `STILL_SAMPLES` captures in a row are byte-for-byte the same. `after` is
 * what the display held before the guest was in the room: the picture is of a frame that has the
 * guest drawn in it, so a frame identical to that one is one the guest never reached, and it is
 * refused rather than saved as a picture of a room nobody is in.
 */
async function captureStillness(
  display: string,
  label: string,
  out: string,
  after: Buffer | undefined,
): Promise<void> {
  let last: Buffer | undefined;
  let same = 0;
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const current = await frame(display);
    if (distinctBytes(current) < 16) {
      fail(`${label} is blank: the window drew nothing into it, so there is no picture to take`);
    }
    if (after !== undefined && current.equals(after)) {
      fail(`${label} has not changed since before the guest was in the room: the guest is not drawn in it`);
    }
    same = last !== undefined && current.equals(last) ? same + 1 : 0;
    last = current;
    if (same >= STILL_SAMPLES - 1) {
      break;
    }
    if (Date.now() >= deadline) {
      fail(`${label} keeps changing: ${String(STILL_SAMPLES)} captures of it in a row never agreed`);
    }
    await delay(500);
  }
  await command('import', ['-display', display, '-window', 'root', out]);
  log('ok:', out);
}

function armWatchdog(): void {
  const timer = setTimeout(() => {
    log(`the watchdog fired after ${String(WATCHDOG_MS)}ms in phase ${phase}; last line: ${lastLogged}`);
    void stopRunning('SIGKILL').finally(() => {
      process.exit(1);
    });
  }, WATCHDOG_MS);
  timer.unref();
}

/** The arguments every window of this run is given: a profile of its own and nothing of the host. */
function launchArgs(workspace: string, userDataDir: string, extensionsDir: string): string[] {
  return [
    workspace,
    '--user-data-dir',
    userDataDir,
    '--extensions-dir',
    extensionsDir,
    '--disable-workspace-trust',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--use-gl=swiftshader',
    '--disable-software-rasterizer',
    // The screen, asked for as the screen: there is no window manager under Xvfb to size the
    // window, and the editor's own default is the smaller one a desktop is happy with.
    `--window-size=${String(SCREEN.width)},${String(SCREEN.height)}`,
  ];
}

/**
 * Starts one real window on its own display, with its own profile, and does not wait for it to
 * end: a window that is part of the room has to stay up while the others are staged, and what the
 * run waits for is the files the scenes write rather than the editor's own exit. What comes back
 * is the one fact the caller needs from it — whether the run inside finished or was torn down,
 * which is how a join that reloaded its own window is told from one that never did.
 */
async function launchWindow(options: {
  workspace: string;
  userDataDir: string;
  extensionsDir: string;
  display: string;
  suite: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}): Promise<{ finished: Promise<'ran' | 'torn down'> }> {
  const out = createWriteStream(options.logFile);
  logs.push(out);
  log(`starting the ${options.suite} window on ${options.display}, profile ${options.userDataDir}`);
  const started = runTests({
    vscodeExecutablePath: await vscodeExecutable(),
    extensionDevelopmentPath: ROOT,
    extensionTestsPath: resolve(import.meta.dirname, options.suite),
    extensionTestsEnv: {
      ...process.env,
      ...DISPLAY_ONLY_ENV,
      ...options.env,
      DISPLAY: options.display,
    },
    stdout: out,
    stderr: out,
    launchArgs: launchArgs(options.workspace, options.userDataDir, options.extensionsDir),
  });
  // Nothing is awaited until the caller's own gate, which for a window that has to stay up is the
  // end of the run: a rejection nothing has a handler on yet is an unhandled one in the meantime.
  const finished = started.then(
    () => 'ran' as const,
    () => 'torn down' as const,
  );
  finished.catch(() => {});
  return { finished };
}

/**
 * A window's run, watched: what comes back says whether it has left, so a window that leaves
 * mid-scene fails the run rather than being a line in a log beside a picture of a room it is not
 * in. `@vscode/test-electron` hands back no child, so the promise of its run is the whole of what a
 * caller can know about it.
 */
function watchWindow(role: string, finished: Promise<'ran' | 'torn down'>): () => string | undefined {
  let left: string | undefined;
  void finished.then((outcome) => {
    left = `the ${role} window left (${outcome})`;
  });
  return () => left;
}

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? RUN);
  await inheritElectronLibraries();

  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(out, { recursive: true });

  const hostWorkspace = join(RUN, 'home', FOLDER);
  const guestWorkspace = join(RUN, 'guest');
  writeProject(hostWorkspace);
  mkdirSync(guestWorkspace, { recursive: true });
  const hostSettings = join(hostUserData, 'User', 'settings.json');
  mkdirSync(dirname(hostSettings), { recursive: true });
  writeFileSync(hostSettings, `${JSON.stringify(SETTINGS, null, 2)}\n`);

  const inviteFile = join(RUN, 'invite.txt');
  const roomPathFile = join(RUN, 'room-path.txt');
  const hostReady = join(RUN, 'host-ready.txt');
  const guestReady = join(RUN, 'guest-ready.txt');
  const guestStaged = join(RUN, 'guest-staged.txt');
  const guestStageError = join(RUN, 'guest-stage-error.txt');
  const doneFile = join(RUN, 'done.txt');
  const hostLog = join(RUN, 'host.log');
  const guestJoinLog = join(RUN, 'guest-join.log');
  const guestPhasesLog = join(RUN, 'guest-phases.log');

  /** What every scene is told: the room's own facts, where to say what it reached, and the bounds. */
  const shared: NodeJS.ProcessEnv = {
    SELVAGE_SHOT_DOC: DOC,
    SELVAGE_SHOT_INVITE_FILE: inviteFile,
    SELVAGE_SHOT_ROOM_PATH_FILE: roomPathFile,
    SELVAGE_SHOT_DONE_FILE: doneFile,
    SELVAGE_SHOT_DEADLINE_MS: String(DEADLINE_MS),
    SELVAGE_SHOT_HOLD_MS: String(HOLD_MS),
  };

  phase = 'starting the real selvaged';
  log('starting the real selvaged');
  const server = await RealServer.start();
  log('selvaged listening at', server.wsBase);

  phase = 'building the extension bundle';
  log('building the extension bundle (npm run build)');
  await command('npm', ['run', 'build'], { stream: true });

  phase = 'starting the displays';
  hostDisplay = await startDisplay();
  const guestDisplay = await startDisplay();
  log('the host draws on', hostDisplay, 'and the guest on', guestDisplay);

  phase = 'launching the host window';
  log(`launching the host window on ${hostDisplay}, at ${String(SCREEN.width)}x${String(SCREEN.height)}`);
  const host = await launchWindow({
    workspace: hostWorkspace,
    userDataDir: hostUserData,
    extensionsDir: resolve(RUN, 'host-extensions'),
    display: hostDisplay,
    suite: 'scene-host.cjs',
    env: {
      ...shared,
      HOME: join(RUN, 'home'),
      SELVAGE_SHOT_WORKSPACE: hostWorkspace,
      SELVAGE_SHOT_SERVER_URL: server.wsBase,
      SELVAGE_SHOT_HOST_AT: HOST_AT,
      SELVAGE_SHOT_READY_FILE: hostReady,
    },
    logFile: hostLog,
  });
  const hostLeft = watchWindow('host', host.finished);

  phase = 'waiting for the host to be staged';
  await pollFor('the host to publish its invite', () => readIfThere(inviteFile));
  await pollFor('the host to open the shared file and place its caret', () => readIfThere(hostReady));
  await pollFor(
    "the host's window to fill the display",
    async () => ((await windowFillsDisplay(hostDisplay)) ? true : undefined),
    WINDOW_DEADLINE_MS,
  ).catch(async (error: unknown) => {
    fail(`${String(error)}; ${hostDisplay} holds ${await describeWindows(hostDisplay)}`);
  });
  await assertScreenSize(hostDisplay);
  // What the display holds with the host alone in the room: a picture taken after this has to
  // differ from it, which is what says the guest is drawn in the frame at all.
  const before = await frame(hostDisplay);
  log('the host is staged; the guest is next');

  phase = 'launching the guest join window';
  log('launching the guest join window: it joins, reloads, and is torn down by its own reload');
  const joined = await launchWindow({
    workspace: guestWorkspace,
    userDataDir: guestJoinUserData,
    extensionsDir: resolve(RUN, 'guest-join-extensions'),
    display: guestDisplay,
    suite: 'scene-guest.cjs',
    env: {
      ...shared,
      HOME: join(RUN, 'guest-join'),
      SELVAGE_SHOT_STAGE: 'join',
      SELVAGE_SHOT_STAGED_FILE: guestStaged,
      SELVAGE_SHOT_STAGE_ERROR_FILE: guestStageError,
    },
    logFile: guestJoinLog,
  });
  if ((await joined.finished) === 'ran') {
    fail('the guest join resolved instead of reloading onto the mirror');
  }
  if (!existsSync(guestStaged)) {
    const cause = readIfThere(guestStageError) ?? '(no cause left)';
    fail(`the guest join tore down without staging the reload: ${cause}\n${tail(guestJoinLog)}`);
  }
  const invite = readIfThere(inviteFile);
  if (invite === undefined) {
    fail('the host published no invite for the guest join');
  }
  const room = decodeURIComponent(/[?&]room=([^&]+)/.exec(invite)?.[1] ?? '');
  if (room === '') {
    fail('the invite names no room for the guest join');
  }
  const stash = await pollFor('the guest join to stash its mirror', () =>
    stashedMirror(guestJoinUserData, room),
  );
  log('the guest join stashed its mirror at', stash.root);

  // The join's own window is alive again on that mirror and has landed the room as a second Grace:
  // the picture is of a room with one of her in it, so that window is taken down here, by its
  // profile, and never the phases window's.
  killWindows(windowsFor([guestJoinUserData]).get(guestJoinUserData) ?? [], 'the guest join window', log);

  phase = 'launching the guest window';
  const mirror = mintStash(guestPhasesUserData, stash.publisher, room, stash.invite, 'Grace');
  log('the guest window opens straight onto', mirror);
  const guest = await launchWindow({
    workspace: mirror,
    userDataDir: guestPhasesUserData,
    extensionsDir: resolve(RUN, 'guest-phases-extensions'),
    display: guestDisplay,
    suite: 'scene-guest.cjs',
    env: {
      ...shared,
      HOME: join(RUN, 'guest-phases'),
      SELVAGE_SHOT_STAGE: 'phases',
      SELVAGE_SHOT_GUEST_SELECTS: GUEST_SELECTS,
      SELVAGE_SHOT_READY_FILE: guestReady,
    },
    logFile: guestPhasesLog,
  });
  const guestLeft = watchWindow('guest', guest.finished);

  phase = 'waiting for the guest to be staged';
  await pollFor('the guest to open the room document and select in it', () => readIfThere(guestReady));
  log('the guest is staged');

  phase = 'capturing the display';
  // The picture is of a room both windows are in, so one that left before the frame — or while the
  // display was being read — fails the run rather than passing with an empty window in the output.
  const bothPresent = (): void => {
    const gone = [hostLeft(), guestLeft()].filter((value) => value !== undefined);
    if (gone.length > 0) {
      fail(`${gone.join('; ')}: the picture is of a room both windows are in`);
    }
  };
  bothPresent();
  await captureStillness(hostDisplay, "the host's display", join(out, 'host-editing.png'), before);
  bothPresent();

  phase = 'stopping';
  writeFileSync(doneFile, 'done\n');
  await delay(3000);
  await stopRunning();
  await server.stop();
  log('PASS: one screenshot in', out);
}

armWatchdog();

main()
  .then(async () => {
    await stopRunning('SIGKILL');
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log(`FAIL: ${String(error)}`);
    log(`  phase: ${phase}`);
    // What a window has to say about a failure is on its screen rather than only in its log, so a
    // failed run saves the screen as well, and prints what each scene did manage to say.
    if (hostDisplay !== '') {
      try {
        await command('import', ['-display', hostDisplay, '-window', 'root', join(RUN, 'host-failure.png')]);
        log('  the host screen as it stood:', join(RUN, 'host-failure.png'));
      } catch (alsoFailed: unknown) {
        log(`  the host screen could not be saved: ${String(alsoFailed)}`);
      }
      for (const name of ['host.log', 'guest-join.log', 'guest-phases.log']) {
        log(`  ${tail(join(RUN, name), 6)}`);
      }
    }
    await stopRunning('SIGKILL');
    process.exit(1);
  });
