/**
 * What launching a real VS Code build here takes, shared by the proofs that launch one: the build
 * itself, the library path a build unpacked outside nix needs on this host, and the environment an
 * instance may be given without handing it somebody's desktop.
 *
 * The end-to-end proof (`run.ts`) and the README's screenshot (`../screenshots/capture.ts`) both
 * start real windows, and both have to start the same build from the same cache with the same
 * display: a fact of either belongs here rather than beside one of them.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { downloadAndUnzipVSCode } from '@vscode/test-electron';

import { ensureVscodeCache } from './vscode-cache.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const TMP = resolve(ROOT, '.tmp');

/**
 * How long the one `nix eval` below may take. It resolves and evaluates `<nixpkgs>`, which can
 * block on an evaluation, a fetch or a store lock, so it is bounded like every other step: an
 * answer that never comes is a failure naming the cache and the way out, rather than a run that
 * sits there until its own watchdog. The answer is slow and stable and is cached once it arrives.
 */
const NIX_EVAL_TIMEOUT_MS = Number(process.env.SELVAGE_E2E_NIX_TIMEOUT_MS ?? '120000');
const NIX_EVAL_KILL_GRACE_MS = 2000;

/**
 * The VS Code build the proofs run against: the floor `package.json` declares, so the version that
 * gets exercised is the version the manifest promises, and `test/manifest.test.ts` fails when the
 * two drift apart. Left to `@vscode/test-electron`, that is whatever the update service calls
 * stable at the moment of the run, so the editor being proved moves under the proof without
 * anything here changing — and the version is resolved over the network before the cache is
 * consulted for *what* to run. Pinned, a build already in the cache is used without a request at
 * all. Move it deliberately with `SELVAGE_E2E_VSCODE_VERSION`, which is the seam for a run against
 * another build; a version the cache does not hold is downloaded on the next run.
 */
export const VSCODE_VERSION = process.env.SELVAGE_E2E_VSCODE_VERSION ?? '1.137.0';

/**
 * The build to launch, unpacked and ready: the pinned version, from the cache the checkout shares
 * with a worktree of itself (`vscode-cache.ts`), downloaded into it the first time it is used.
 */
export async function vscodeExecutable(): Promise<string> {
  return downloadAndUnzipVSCode({ version: VSCODE_VERSION, cachePath: ensureVscodeCache(ROOT) });
}

/**
 * The clipboard a suite reads its invite back from has to be this run's own. `xvfb-run` gives the
 * instances an X display, but the Wayland variables it leaves in place are the login session's, so
 * a Wayland-capable Electron reads — and writes — the session clipboard that `wl-copy` and every
 * other client on the machine own, so the invite a run reads could be another repository's test
 * value and the address it names one nothing is listening on. With X display, the selection belongs
 * to the instances this run started and to nothing else.
 *
 * `XDG_SESSION_TYPE` is named rather than dropped because it is the hint a client falls back on.
 * The session bus is left alone: it is not a display, and the portal clipboard is out of play in a
 * dev host with the sandbox off.
 */
export const DISPLAY_ONLY_ENV: Record<string, string | undefined> = {
  WAYLAND_DISPLAY: undefined,
  WAYLAND_SOCKET: undefined,
  XDG_SESSION_TYPE: 'x11',
};

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

/**
 * `nix`'s answer for the shared libraries an Electron binary downloaded outside nix needs on
 * NixOS — `nix-ld` supplies the loader, not the libraries a desktop app links against. Empty on a
 * host that is not NixOS, where the loader finds its own.
 *
 * A host that installs its own system libraries needs no answer, and using this one there is worse
 * than leaving it out: those libraries are built against nixpkgs' glibc, and a binary linked
 * against the host's glibc cannot load them — on Ubuntu 24.04 the editor dies before it opens a
 * window with `version 'GLIBC_ABI_GNU2_TLS' not found`, raised the moment `libmount` is looked up
 * in this path. So `/etc/NIXOS`, the marker nixpkgs itself reads, decides: with no marker there is
 * no path and the loader stays on the host's own libraries.
 *
 * Cached under `.tmp/`, because evaluating it is the slow part of every run, and shared with the
 * end-to-end proof, which reads the same file.
 */
export async function nixElectronLibraryPath(): Promise<string> {
  if (!existsSync('/etc/NIXOS')) {
    return '';
  }
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
 * Puts that path in this process's environment, where an editor spawned from here inherits it. A
 * no-op on a host that needs none, and an addition to whatever the run already had rather than a
 * replacement: `nix develop` sets one of its own.
 */
export async function inheritElectronLibraries(): Promise<void> {
  const libraryPath = await nixElectronLibraryPath();
  process.env['LD_LIBRARY_PATH'] = [libraryPath, process.env['LD_LIBRARY_PATH'] ?? '']
    .filter((part) => part !== '')
    .join(':');
}
