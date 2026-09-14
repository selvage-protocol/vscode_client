/**
 * Runs inside a second, real, headless VS Code Extension Development Host as the *guest* side
 * of the two-instance convergence proof (`run.ts` drives this file through
 * `@vscode/test-electron`).
 *
 * As with `host-suite.cjs`: the real, unstubbed `vscode` object cannot be monkeypatched
 * (`vscode.window`/`vscode.env` are getter-only), so this drives `selvage.join` and
 * `selvage.openDocument` through the optional-argument seam `src/adapter/extension.ts`
 * exports for automation (`JoinArgs`, `OpenDocumentArgs`) rather than a `showInputBox`/
 * `showQuickPick` it has no way to click through.
 */

const vscode = require('vscode');
const fs = require('fs');

const DISPLAY_NAME = process.env.SELVAGE_E2E_DISPLAY_NAME ?? 'Bob';
const INVITE_FILE = process.env.SELVAGE_E2E_INVITE_FILE;
const ROOM_PATH_FILE = process.env.SELVAGE_E2E_ROOM_PATH_FILE;
const PROXY_ADDR = process.env.SELVAGE_E2E_PROXY_ADDR;
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

async function waitFor(label, check, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let last;
  for (;;) {
    last = await check();
    if (last !== undefined && last !== false) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`guest: timed out after ${deadlineMs}ms waiting for ${label}; last observed ${JSON.stringify(last)}`);
    }
    await delay(100);
  }
}

/** Routes the guest through the reconnect proxy when one is configured, keeping the room and
 * token the host actually minted. */
function routeThroughProxy(invite) {
  if (PROXY_ADDR === undefined) {
    return invite;
  }
  return invite.replace(/^ws:\/\/[^/]+/, `ws://${PROXY_ADDR}`);
}

async function run() {
  const result = { role: 'guest', phase1: undefined, phase2: undefined, error: undefined };
  try {
    const rawInvite = await waitFor(
      'the host to publish an invite link',
      () => (fs.existsSync(INVITE_FILE) ? fs.readFileSync(INVITE_FILE, 'utf8') : false),
      DEADLINE_MS,
    );

    await vscode.commands.executeCommand('selvage.join', {
      invite: routeThroughProxy(rawInvite),
      displayName: DISPLAY_NAME,
    });

    const roomPath = await waitFor(
      'the host to publish the room path of the shared document',
      () => (fs.existsSync(ROOM_PATH_FILE) ? fs.readFileSync(ROOM_PATH_FILE, 'utf8') : false),
      DEADLINE_MS,
    );

    const editor = await waitFor(
      'the room document to open in a virtual editor',
      async () => {
        await vscode.commands.executeCommand('selvage.openDocument', { path: roomPath });
        return vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.scheme === 'selvage');
      },
      DEADLINE_MS,
    );
    const document = editor.document;

    // The guest appends its marker at the end of whatever the host has published so far.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(document.getText().length), MARKER_GUEST);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error('guest: applyEdit for the first marker was refused');
    }

    const converged1 = await waitFor(
      'both markers to appear in the guest document',
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
      edit2.insert(document.uri, document.positionAt(document.getText().length), MARKER_GUEST_2);
      const applied2 = await vscode.workspace.applyEdit(edit2);
      if (!applied2) {
        throw new Error('guest: applyEdit for the second marker was refused');
      }

      const converged2 = await waitFor(
        'all four markers to appear in the guest document after the blip',
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
