/**
 * Runs inside a real, headless VS Code Extension Development Host as the *host* side of the
 * two-instance convergence proof (`run.ts` drives this file through `@vscode/test-electron`).
 *
 * A real, unstubbed `vscode` object has no writable properties to monkeypatch — `vscode.window`
 * and `vscode.env` are getters with no setter, so overriding `showInputBox` or
 * `clipboard.writeText` the way a stubbed-editor unit test would silently does nothing here.
 * This drives `selvage.host`/`selvage.openDocument` through the small, optional-argument seam
 * `src/adapter/extension.ts` exports for exactly this (`HostArgs`, `OpenDocumentArgs`) instead
 * of a UI it cannot click through.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const WORKSPACE_DIR = process.env.SELVAGE_E2E_WORKSPACE;
const SEED_PATH = process.env.SELVAGE_E2E_SEED_PATH;
const SERVER_URL = process.env.SELVAGE_E2E_SERVER_URL;
const DISPLAY_NAME = process.env.SELVAGE_E2E_DISPLAY_NAME ?? 'Ada';
const INVITE_FILE = process.env.SELVAGE_E2E_INVITE_FILE;
const ROOM_PATH_FILE = process.env.SELVAGE_E2E_ROOM_PATH_FILE;
const CONTROL_FILE = process.env.SELVAGE_E2E_CONTROL_FILE;
const RESULT_FILE = process.env.SELVAGE_E2E_RESULT_FILE;
const MARKER_HOST = process.env.SELVAGE_E2E_MARKER_HOST;
const MARKER_GUEST = process.env.SELVAGE_E2E_MARKER_GUEST;
const MARKER_HOST_2 = process.env.SELVAGE_E2E_MARKER_HOST_2;
const MARKER_GUEST_2 = process.env.SELVAGE_E2E_MARKER_GUEST_2;
const DEADLINE_MS = Number(process.env.SELVAGE_E2E_DEADLINE_MS ?? '20000');
const RECONNECT_DEADLINE_MS = Number(process.env.SELVAGE_E2E_RECONNECT_DEADLINE_MS ?? '40000');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded polling of a real predicate, per AGENTS.md §5: never sleep-and-hope. */
async function waitFor(label, check, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    last = await check();
    if (last !== undefined && last !== false) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`host: timed out after ${deadlineMs}ms waiting for ${label}; last observed ${JSON.stringify(last)}`);
    }
    await delay(100);
  }
}

async function run() {
  const result = { role: 'host', phase1: undefined, phase2: undefined, error: undefined };
  try {
    await vscode.commands.executeCommand('selvage.host', {
      serverUrl: SERVER_URL,
      displayName: DISPLAY_NAME,
    });

    // `host()` runs detached from the command's own promise (`void host(files)`), so the
    // session appears asynchronously; `copyInvite` is the only observable that says it is
    // ready, since it no-ops with a warning until `current` exists. Reading the invite back
    // off the real clipboard (rather than monkeypatching `writeText`) is what actually works
    // against the unstubbed API.
    await vscode.env.clipboard.writeText('');
    const invite = await waitFor(
      'the invite link',
      async () => {
        await vscode.commands.executeCommand('selvage.copyInvite');
        const clipboard = await vscode.env.clipboard.readText();
        return clipboard.startsWith('ws://') ? clipboard : false;
      },
      DEADLINE_MS,
    );
    fs.writeFileSync(INVITE_FILE, invite);

    const uri = vscode.Uri.file(path.join(WORKSPACE_DIR, SEED_PATH));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    // The room path a host's file is shared under includes the workspace folder's name
    // (`src/adapter/documents.ts`'s `roomPath`); rather than have the guest guess it, the
    // host — the only side that can compute it the same way — writes it down.
    fs.writeFileSync(ROOM_PATH_FILE, vscode.workspace.asRelativePath(uri, true).replaceAll('\\', '/'));

    // The host prepends its marker at the very start of the seeded text.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, document.positionAt(0), MARKER_HOST);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error('host: applyEdit for the first marker was refused');
    }

    const converged1 = await waitFor(
      'both markers to appear in the host document',
      () => {
        const text = document.getText();
        return text.includes(MARKER_HOST) && text.includes(MARKER_GUEST) ? text : false;
      },
      DEADLINE_MS,
    );
    result.phase1 = { text: converged1 };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result));

    if (CONTROL_FILE !== undefined) {
      await waitFor(
        'the orchestrator to signal the network blip is over',
        () => (fs.existsSync(CONTROL_FILE) ? true : false),
        RECONNECT_DEADLINE_MS,
      );

      const edit2 = new vscode.WorkspaceEdit();
      edit2.insert(uri, document.positionAt(document.getText().length), MARKER_HOST_2);
      const applied2 = await vscode.workspace.applyEdit(edit2);
      if (!applied2) {
        throw new Error('host: applyEdit for the second marker was refused');
      }

      const converged2 = await waitFor(
        'all four markers to appear in the host document after the blip',
        () => {
          const text = document.getText();
          return [MARKER_HOST, MARKER_GUEST, MARKER_HOST_2, MARKER_GUEST_2].every((marker) =>
            text.includes(marker),
          )
            ? text
            : false;
        },
        RECONNECT_DEADLINE_MS,
      );
      result.phase2 = { text: converged2 };
    }
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  } finally {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  }
  if (result.error !== undefined) {
    throw new Error(result.error);
  }
}

module.exports = { run };
