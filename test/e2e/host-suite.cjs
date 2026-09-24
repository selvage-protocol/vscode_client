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
 *
 * The watch phase is this suite's own file system work: a file made and a file removed under
 * the folder this window shares, with plain `fs`, which is what a build, a branch switch or a
 * person with another terminal does to a project. The guest's half is the room's listing; this
 * half waits for the guest to be finished with the phase so the room does not outlive it.
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
const GRANTED_PATH_FILE = process.env.SELVAGE_E2E_GRANTED_PATH_FILE;
const GRANTED_DONE_FILE = process.env.SELVAGE_E2E_GRANTED_DONE_FILE;
const GRANTED_PATH = process.env.SELVAGE_E2E_GRANTED_PATH;
const WATCH_PATH = process.env.SELVAGE_E2E_WATCH_PATH;
const WATCH_TEXT = process.env.SELVAGE_E2E_WATCH_TEXT;
const WATCH_DOOMED_PATH = process.env.SELVAGE_E2E_WATCH_DOOMED_PATH;
const WATCH_READY_FILE = process.env.SELVAGE_E2E_WATCH_READY_FILE;
const WATCH_DONE_FILE = process.env.SELVAGE_E2E_WATCH_DONE_FILE;
const FOLLOW_READY_FILE = process.env.SELVAGE_E2E_FOLLOW_READY_FILE;
const FOLLOW_MOVED_FILE = process.env.SELVAGE_E2E_FOLLOW_MOVED_FILE;
const FOLLOW_STOPPED_FILE = process.env.SELVAGE_E2E_FOLLOW_STOPPED_FILE;
const CONTROL_FILE = process.env.SELVAGE_E2E_CONTROL_FILE;
const PHASE2_ACK_FILE = process.env.SELVAGE_E2E_PHASE2_ACK_FILE;
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

/**
 * The invite has to name the server this window was told to host on, and carry the room and the
 * token it minted. An invite is the room's own server address over the scheme a browser speaks
 * (`ws://` as `http://`, `wss://` as `https://`), so a plain `ws://` server's link is `http://`;
 * the retired `server=` parameter is neither read nor written. The same shape
 * `test/https-invite.test.ts` pins without an editor (`buildPageLink`), checked here against the
 * link a real clipboard actually holds.
 */
function assertInviteNamesServer(invite) {
  let link;
  let server;
  try {
    link = new URL(invite);
    server = new URL(SERVER_URL);
  } catch (error) {
    throw new Error(
      `host: the invite ${JSON.stringify(invite)} or the server address ${JSON.stringify(SERVER_URL)} is not a URL: ${error.message}`,
    );
  }
  const pageScheme = server.protocol === 'wss:' ? 'https:' : 'http:';
  if (link.protocol !== pageScheme) {
    throw new Error(
      `host: the invite of ${SERVER_URL} opens with ${link.protocol}, not the ${pageScheme} of its own server: ${invite}`,
    );
  }
  if (link.host !== server.host) {
    throw new Error(
      `host: the invite names ${link.host}, not the ${server.host} it was hosted on: ${invite}`,
    );
  }
  for (const part of ['room', 'token']) {
    if ((link.searchParams.get(part) ?? '') === '') {
      throw new Error(`host: the invite carries no ${part}: ${invite}`);
    }
  }
  if (link.searchParams.has('server')) {
    throw new Error(`host: the invite carries the retired server= parameter: ${invite}`);
  }
  return invite;
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
  const result = { role: 'host', phase1: undefined, phase2: undefined, granted: undefined, watch: undefined, follow: undefined, error: undefined };
  try {
    await vscode.commands.executeCommand('selvage.host', {
      serverUrl: SERVER_URL,
      displayName: DISPLAY_NAME,
    });

    // `host()` runs detached from the command's own promise (`void host(args)`), so the
    // session appears asynchronously; `copyInvite` is the only observable that says it is
    // ready, since it no-ops with a warning until `current` exists. Reading the invite back
    // off the real clipboard (rather than monkeypatching `writeText`) is what actually works
    // against the unstubbed API.
    await vscode.env.clipboard.writeText('');
    // What is polled is that the copy landed at all; what the link says is asserted once, so a
    // wrong link fails with the link in the message instead of reading as "last observed false".
    const invite = assertInviteNamesServer(
      await waitFor(
        'the invite link',
        async () => {
          await vscode.commands.executeCommand('selvage.copyInvite');
          const clipboard = (await vscode.env.clipboard.readText()).trim();
          return clipboard === '' ? false : clipboard;
        },
        DEADLINE_MS,
      ),
    );
    fs.writeFileSync(INVITE_FILE, invite);

    const uri = vscode.Uri.file(path.join(WORKSPACE_DIR, SEED_PATH));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);

    // The room path a host's file is shared under (`src/adapter/documents.ts`'s `roomPath`):
    // relative to the folder the session shares, qualified by that folder's name only when the
    // window is open on more than one. `asRelativePath` without the flag is exactly that rule,
    // and this side — the only one that can compute it — writes it down for the guest.
    fs.writeFileSync(ROOM_PATH_FILE, vscode.workspace.asRelativePath(uri).replaceAll('\\', '/'));

    // The room path of the granted file, for the guest to open. This window writes the file
    // down and does not open it: the guest's read is the only way its text can arrive, which
    // is what makes the granted phase a proof of the on-request read rather than of an open.
    const grantedUri = vscode.Uri.file(path.join(WORKSPACE_DIR, GRANTED_PATH));
    fs.writeFileSync(
      GRANTED_PATH_FILE,
      vscode.workspace.asRelativePath(grantedUri).replaceAll('\\', '/'),
    );

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

    if (FOLLOW_READY_FILE !== undefined) {
      // The follow phase's moving side: once the guest is following, the caret goes to the
      // end of the shared document — a caret move with no edit — and the offset is written
      // down for the guest to track. After the guest stops, the caret goes back to the start,
      // which a follow that did not stop would track back.
      await waitFor(
        'the guest to follow and land',
        () => (fs.existsSync(FOLLOW_READY_FILE) ? true : false),
        DEADLINE_MS,
      );
      const hostEditor = vscode.window.activeTextEditor;
      if (hostEditor === undefined || hostEditor.document.uri.fsPath !== uri.fsPath) {
        throw new Error('host: the shared document is not the active editor for the follow phase');
      }
      const end = hostEditor.document.positionAt(hostEditor.document.getText().length);
      hostEditor.selection = new vscode.Selection(end, end);
      const movedTo = hostEditor.document.offsetAt(end);
      fs.writeFileSync(FOLLOW_MOVED_FILE, String(movedTo));
      await waitFor(
        'the guest to stop following',
        () => (fs.existsSync(FOLLOW_STOPPED_FILE) ? true : false),
        DEADLINE_MS,
      );
      const start = hostEditor.document.positionAt(0);
      hostEditor.selection = new vscode.Selection(start, start);
      result.follow = { movedTo };
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
    }

    if (GRANTED_DONE_FILE !== undefined) {
      const heldBeforeGuest = vscode.workspace.textDocuments.some(
        (document) => document.uri.fsPath === grantedUri.fsPath,
      );
      await waitFor(
        'the guest to converge on the granted path',
        () => (fs.existsSync(GRANTED_DONE_FILE) ? true : false),
        DEADLINE_MS + 15_000,
      );

      // The file was never open here, so whatever the room holds for it came from the read
      // this window made because the guest asked for it. Opening it now puts the room's copy
      // in front of the user: the guest's marker has to be in it.
      const granted = await vscode.workspace.openTextDocument(grantedUri);
      await vscode.window.showTextDocument(granted);
      const grantedText = await waitFor(
        'the host copy of the granted file to hold the guest marker',
        () => {
          const text = granted.getText();
          return text.includes(MARKER_GUEST) ? text : false;
        },
        DEADLINE_MS,
      );
      result.granted = { text: grantedText, heldBeforeGuest };
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
    }

    if (WATCH_PATH !== undefined && WATCH_DONE_FILE !== undefined) {
      // The guest has to have read the room's listing before a path is taken out of it, and it
      // says so by writing the ready file. What this phase proves is the listing following the
      // folder, not the listing as it happened to stand.
      await waitFor(
        'the guest to have seen the room\u2019s listing',
        () => (fs.existsSync(WATCH_READY_FILE) ? true : false),
        DEADLINE_MS,
      );

      const created = path.join(WORKSPACE_DIR, WATCH_PATH);
      fs.mkdirSync(path.dirname(created), { recursive: true });
      fs.writeFileSync(created, WATCH_TEXT);
      fs.rmSync(path.join(WORKSPACE_DIR, WATCH_DOOMED_PATH));

      await waitFor(
        'the guest to open the created path and to lose the deleted one',
        () => (fs.existsSync(WATCH_DONE_FILE) ? true : false),
        DEADLINE_MS + 15_000,
      );
      result.watch = { created: WATCH_PATH, deleted: WATCH_DOOMED_PATH };
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
    }

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
      // The room now holds the guest's post-blip edit, which is what the guest's side of this
      // phase waits for: its own buffer holds that edit from the moment it types it, whether or
      // not the room ever got it, and a re-seat publishes nothing until a state commits its new
      // key (§13.1's step 4). The record goes first so the acknowledgement cannot find a result
      // file that is not written yet.
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
      if (PHASE2_ACK_FILE !== undefined) {
        fs.writeFileSync(PHASE2_ACK_FILE, 'seen');
      }
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
