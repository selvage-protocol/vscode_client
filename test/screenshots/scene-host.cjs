/**
 * The hosting half of the README's screenshot: the window the picture is of, launched by
 * `test/screenshots/capture.ts` as a real Extension Development Host with the real built extension.
 *
 * It seats a session as Ada, hands the invite on through a file, opens the project's own file with
 * the caret on the line the picture is about, and holds the window while the display is captured.
 * What it writes to `SELVAGE_SHOT_READY_FILE` is its own part of the scene: the guest's own
 * readiness is a second file, and the orchestrator waits for both.
 *
 * The window keeps its caret where it was put: the scene is a still frame rather than an edit, and
 * a window that typed would put its own text in the picture.
 */

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const WORKSPACE = process.env['SELVAGE_SHOT_WORKSPACE'];
const DOC = process.env['SELVAGE_SHOT_DOC'];
const AT = process.env['SELVAGE_SHOT_HOST_AT'];
const SERVER_URL = process.env['SELVAGE_SHOT_SERVER_URL'];
const INVITE_FILE = process.env['SELVAGE_SHOT_INVITE_FILE'];
const ROOM_PATH_FILE = process.env['SELVAGE_SHOT_ROOM_PATH_FILE'];
const READY_FILE = process.env['SELVAGE_SHOT_READY_FILE'];
const DONE_FILE = process.env['SELVAGE_SHOT_DONE_FILE'];
const DEADLINE_MS = Number(process.env['SELVAGE_SHOT_DEADLINE_MS'] ?? '60000');
const HOLD_MS = Number(process.env['SELVAGE_SHOT_HOLD_MS'] ?? '600000');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded polling of a real predicate; every wait here reports what it last saw. */
async function waitFor(label, check, deadlineMs = DEADLINE_MS) {
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
    await delay(200);
  }
}

/** The offset in `text` that `needle` starts at, refusing a document that does not hold it. */
function offsetOf(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0) {
    throw new Error(`host: the shared document holds no ${JSON.stringify(needle)}`);
  }
  return at;
}

async function run() {
  await vscode.commands.executeCommand('selvage.host', { serverUrl: SERVER_URL, displayName: 'Ada' });

  // `host()` runs detached from the command's own promise, so the session appears asynchronously;
  // `copyInvite` is the observable that says it is ready, since it no-ops with a warning until the
  // session exists. The clipboard is the real one, read back the way the e2e's own host reads it.
  await vscode.env.clipboard.writeText('');
  const invite = await waitFor('the invite link', async () => {
    await vscode.commands.executeCommand('selvage.copyInvite');
    const clipboard = (await vscode.env.clipboard.readText()).trim();
    return clipboard === '' ? false : clipboard;
  });
  fs.writeFileSync(INVITE_FILE, invite);

  const uri = vscode.Uri.file(path.join(WORKSPACE, DOC));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  // The room path a host's file is shared under, computed where only this side can: relative to
  // the folder the session shares, with the folder's name only when the window holds more than one.
  fs.writeFileSync(ROOM_PATH_FILE, vscode.workspace.asRelativePath(uri).replaceAll('\\', '/'));

  // The invite poll above runs `copyInvite` before the session exists, which says so in a
  // notification; that is what polling a command whose only answer is the clipboard costs, and a
  // picture of a session is not the place for it.
  await vscode.commands.executeCommand('notifications.clearAll');

  const at = offsetOf(document.getText(), AT);
  const position = document.positionAt(at);
  editor.selection = new vscode.Selection(position, position);
  // Centred rather than at the top of the file: the guest's selection is a few lines below this
  // caret, and a view that starts at line one would leave half the scene off screen.
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

  fs.writeFileSync(READY_FILE, String(at));

  // A guest's own editor is the reason there is a picture at all, so the window is held until the
  // orchestrator says it has taken it — and no longer: a run that never says so ends at the bound.
  await waitFor('the capture to be done', () => fs.existsSync(DONE_FILE), HOLD_MS);
}

exports.run = run;
