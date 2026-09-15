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
const GRANTED_PATH_FILE = process.env.SELVAGE_E2E_GRANTED_PATH_FILE;
const GRANTED_DONE_FILE = process.env.SELVAGE_E2E_GRANTED_DONE_FILE;
const GRANTED_TEXT = process.env.SELVAGE_E2E_GRANTED_TEXT;
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

/**
 * Appends `marker` to the document, recomputing the position on every attempt.
 *
 * An editor refuses an edit whose document changed between the edit being worked out and being
 * applied, and the peer is typing into this same document: a refusal is not a failure, it is an
 * attempt at a position that has moved. The retry is bounded and reports the text it saw, so a
 * marker that never lands fails with evidence rather than hanging.
 */
async function appendMarker(document, marker, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(document.getText().length), marker);
    if (await vscode.workspace.applyEdit(edit)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `guest: ${document.uri.toString()} refused ${marker} for ${deadlineMs}ms; it reads ${JSON.stringify(document.getText())}`,
      );
    }
    await delay(50);
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
  const result = { role: 'guest', phase1: undefined, phase2: undefined, granted: undefined, error: undefined };
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
    await appendMarker(document, MARKER_GUEST, DEADLINE_MS);

    const converged1 = await waitFor(
      'both markers to appear in the guest document',
      () => {
        const text = document.getText();
        return text.includes(MARKER_HOST) && text.includes(MARKER_GUEST) ? text : false;
      },
      DEADLINE_MS,
    ).catch((error) => {
      // A timeout here has to say what the window actually held: whether the guest's own
      // marker is in the buffer, and whether the room's document is one editor or two.
      throw new Error(
        `${error.message}; the guest document reads ${JSON.stringify(document.getText())}; ` +
          `open room documents: ${JSON.stringify(
            vscode.window.visibleTextEditors
              .filter((candidate) => candidate.document.uri.scheme === 'selvage')
              .map((candidate) => candidate.document.uri.toString()),
          )}`,
      );
    });
    result.phase1 = { text: converged1 };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result));

    if (GRANTED_DONE_FILE !== undefined) {
      // A path the room grants and nobody has opened. Opening it is what makes the host read
      // its own working copy, so the guest waits for this file's *text* rather than for the
      // document to exist: an empty buffer would be the failure this phase exists to catch.
      const grantedPath = await waitFor(
        'the host to publish the granted path',
        () =>
          fs.existsSync(GRANTED_PATH_FILE)
            ? fs.readFileSync(GRANTED_PATH_FILE, 'utf8')
            : false,
        DEADLINE_MS,
      );

      const grantedEditor = await waitFor(
        'the granted path to open with the host\'s text in it',
        async () => {
          await vscode.commands.executeCommand('selvage.openDocument', { path: grantedPath });
          return vscode.window.visibleTextEditors.find(
            (candidate) =>
              candidate.document.uri.scheme === 'selvage' &&
              candidate.document.getText() === GRANTED_TEXT,
          );
        },
        DEADLINE_MS,
      );
      const grantedDocument = grantedEditor.document;

      // The guest appends its marker, so the host's copy of a file it never opened becomes
      // something this window wrote.
      await appendMarker(grantedDocument, MARKER_GUEST, DEADLINE_MS);
      const grantedText = await waitFor(
        'the granted marker to land in the guest document',
        () => {
          const text = grantedDocument.getText();
          return text.includes(MARKER_GUEST) ? text : false;
        },
        DEADLINE_MS,
      ).catch((error) => {
        throw new Error(`${error.message}; the granted document reads ${JSON.stringify(grantedDocument.getText())}`);
      });
      result.granted = { text: grantedText };
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
      fs.writeFileSync(GRANTED_DONE_FILE, 'go');
    }

    if (CONTROL_FILE !== undefined) {
      await waitFor(
        'the orchestrator to signal the network blip is over',
        () => (fs.existsSync(CONTROL_FILE) ? true : false),
        RECONNECT_DEADLINE_MS,
      );

      await appendMarker(document, MARKER_GUEST_2, RECONNECT_DEADLINE_MS);

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
