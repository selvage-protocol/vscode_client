/**
 * Runs inside a real, headless VS Code Extension Development Host for the empty-window
 * stage of the two-instance proof (`run.ts` drives this file through
 * `@vscode/test-electron`, twice).
 *
 * Joining with no folder cannot add one — the API answers `true` and changes nothing —
 * so the join mints the mirror, stashes the invite in its marker and reopens the window
 * on it. That reload tears down this very run: the extension host exits and `runTests`
 * rejects, which the orchestrator counts as the stage passing *only* with the stashed
 * invite on disk to show for it.
 *
 * `SELVAGE_E2E_EMPTY_STAGE=join`: join on an empty window, poll the stashed invite, wait
 * out the reload's own beat so resolving means the reload never came, then return. A
 * resolution is the failure; a rejection after the marker is the proof.
 *
 * `SELVAGE_E2E_EMPTY_STAGE=reloaded`: the window reopened on the mirror folder. Nothing
 * here joins: the extension's own activation triage finishes the stashed join. The suite
 * proves it landed — the invite left the marker, the listing filled the mirror, and no
 * second folder was added — and returns.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const STAGE = process.env.SELVAGE_E2E_EMPTY_STAGE;
const INVITE = process.env.SELVAGE_E2E_EMPTY_INVITE;
const DISPLAY_NAME = process.env.SELVAGE_E2E_DISPLAY_NAME ?? 'Empty';
const DONE_FILE = process.env.SELVAGE_E2E_EMPTY_DONE_FILE;
const RESULT_FILE = process.env.SELVAGE_E2E_EMPTY_RESULT_FILE;
const SEED_PATH = process.env.SELVAGE_E2E_SEED_PATH ?? 'notes.txt';
const DEADLINE_MS = Number(process.env.SELVAGE_E2E_DEADLINE_MS ?? '20000');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, check, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    last = await check();
    if (last !== undefined && last !== false) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`empty: timed out after ${deadlineMs}ms waiting for ${label}; last observed ${JSON.stringify(last)}`);
    }
    await delay(100);
  }
}

/** The mirror marker in the window's folders, when one of them is a mirror. */
function mirrorInWindow() {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const markerFile = path.join(folder.uri.fsPath, '.selvage-mirror.json');
    try {
      const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (typeof marker.room === 'string' && typeof marker.window === 'string') {
        return { root: folder.uri.fsPath, marker };
      }
    } catch {
      // Not a mirror folder; the next one may be.
    }
  }
  return undefined;
}

async function stageJoin() {
  if ((vscode.workspace.workspaceFolders ?? []).length !== 0) {
    throw new Error('empty: the join stage did not start in an empty window');
  }
  try {
    await vscode.commands.executeCommand('selvage.join', { invite: INVITE, displayName: DISPLAY_NAME});
    // The command returned, so the reload is staged: say so on disk, because the
    // reload takes this run before it can say anything else.
    if (process.env.SELVAGE_E2E_STAGED_FILE !== undefined) {
      fs.writeFileSync(process.env.SELVAGE_E2E_STAGED_FILE, 'staged');
    }
  } catch (error) {
    // A join that never staged is a failure the teardown would otherwise mask as
    // the expected rejection: leave the cause where the orchestrator reads it.
    if (process.env.SELVAGE_E2E_STAGE_ERROR_FILE !== undefined) {
      try {
        fs.writeFileSync(process.env.SELVAGE_E2E_STAGE_ERROR_FILE, error instanceof Error ? error.stack ?? error.message : String(error));
      } catch {}
    }
    throw error;
  }
  // The reload owns everything after this: it tears down this run about a second after
  // the join, which rejects the run. Give it its beat, so returning means it never came
  // rather than that this run outran it. Returning resolves the run, which the
  // orchestrator reads as the failure; the rejection is the pass, with the stashed
  // invite on the orchestrator's disk to show for it.
  await delay(10000);
}

async function stageReloaded() {
  const result = { role: 'empty-reloaded', joined: false, materialised: false, singleFolder: false, error: undefined };
  try {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length !== 1) {
      throw new Error(`empty: the reloaded window holds ${folders.length} folders, not the mirror alone`);
    }
    const found = mirrorInWindow();
    if (found === undefined) {
      throw new Error('empty: the reloaded window is not on a mirror');
    }
    // The triage cleared the invite when the stashed join landed; the listing arriving
    // filled the mirror. Both are the join, observed after the fact.
    await waitFor(
      'the stashed join to land',
      () => {
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(found.root, '.selvage-mirror.json'), 'utf8'));
          return marker.invite === undefined ? true : false;
        } catch {
          return false;
        }
      },
      DEADLINE_MS,
    );
    result.joined = true;
    await waitFor(
      'the listing to fill the reloaded mirror',
      () => {
        try {
          return fs.statSync(path.join(found.root, SEED_PATH)).isFile() ? true : false;
        } catch {
          return false;
        }
      },
      DEADLINE_MS,
    );
    result.materialised = true;
    const again = vscode.workspace.workspaceFolders ?? [];
    result.singleFolder =
      again.length === 1 && again[0] !== undefined && again[0].uri.fsPath === found.root;
    if (!result.singleFolder) {
      throw new Error('empty: the reloaded join added a second folder to its own window');
    }
    fs.writeFileSync(DONE_FILE, 'go');
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  } finally {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  }
  if (result.error !== undefined) {
    throw new Error(result.error);
  }
}

async function run() {
  if (STAGE === 'join') {
    await stageJoin();
    return;
  }
  if (STAGE === 'reloaded') {
    await stageReloaded();
    return;
  }
  throw new Error(`empty: unknown stage ${JSON.stringify(STAGE)}`);
}

module.exports = { run };
