/**
 * The joining half of the README's screenshot, launched twice by `test/screenshots/capture.ts`:
 *
 * `SELVAGE_SHOT_STAGE=join`: this window joins the link the host published, on its own folder, the
 * way a guest really joins. A join replaces the window's tree with the room's mirror and reloads,
 * which tears this run down: the orchestrator reads the invite the join stashed off its own disk and
 * counts the rejection as this stage passing. Resolving is the failure.
 *
 * `SELVAGE_SHOT_STAGE=phases`: the window the orchestrator opened straight onto a mirror stashed
 * from that join. Nothing here joins — the activation triage lands the stashed invite — so this
 * stage waits for the landing, opens the room's own document and selects the line the picture is
 * about, then holds both the selection and the process until the display has been captured.
 * A guest's selection is what the host's window draws, so this is the half of the scene the picture
 * is actually about.
 */

const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const STAGE = process.env['SELVAGE_SHOT_STAGE'] ?? 'join';
const DOC = process.env['SELVAGE_SHOT_DOC'];
const SELECTS = process.env['SELVAGE_SHOT_GUEST_SELECTS'];
const INVITE_FILE = process.env['SELVAGE_SHOT_INVITE_FILE'];
const ROOM_PATH_FILE = process.env['SELVAGE_SHOT_ROOM_PATH_FILE'];
const READY_FILE = process.env['SELVAGE_SHOT_READY_FILE'];
const DONE_FILE = process.env['SELVAGE_SHOT_DONE_FILE'];
const STAGED_FILE = process.env['SELVAGE_SHOT_STAGED_FILE'];
const STAGE_ERROR_FILE = process.env['SELVAGE_SHOT_STAGE_ERROR_FILE'];
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
      throw new Error(`guest: timed out after ${deadlineMs}ms waiting for ${label}; last observed ${JSON.stringify(last)}`);
    }
    await delay(200);
  }
}

/** The offset in `text` that `needle` starts at, refusing a document that does not hold it. */
function offsetOf(text, needle) {
  const at = text.indexOf(needle);
  if (at < 0) {
    throw new Error(`guest: the shared document holds no ${JSON.stringify(needle)}`);
  }
  return at;
}

/**
 * The folder this window was opened on. In the phases stage that is the stashed mirror itself —
 * the orchestrator opened it there — so the room's copy of a path is this folder plus that path.
 */
function mirrorRoot() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length !== 1) {
    throw new Error(`guest: the window holds ${folders.length} folders, not the mirror alone`);
  }
  return folders[0].uri.fsPath;
}

async function stageJoin() {
  try {
    const invite = await waitFor('the host to publish its invite', () =>
      fs.existsSync(INVITE_FILE) ? fs.readFileSync(INVITE_FILE, 'utf8').trim() : false,
    );
    await vscode.commands.executeCommand('selvage.join', { invite, displayName: 'Grace' });
    // The command returned, so the reload is staged: say so on disk, because the reload takes this
    // run before it can say anything else.
    fs.writeFileSync(STAGED_FILE, 'staged');
  } catch (error) {
    // A join that never staged is a failure the teardown would otherwise mask as the expected
    // rejection: leave the cause where the orchestrator reads it.
    fs.writeFileSync(STAGE_ERROR_FILE, error instanceof Error ? (error.stack ?? error.message) : String(error));
    throw error;
  }
  // Give the reload its beat, so that returning means it never came rather than that this run
  // outran it: a resolved stage is the orchestrator's failure.
  await delay(10000);
}

async function stagePhases() {
  const root = mirrorRoot();
  // The stashed join is landed when the marker no longer carries the invite it landed with.
  await waitFor('the stashed join to land', () => {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(root, '.selvage-mirror.json'), 'utf8'));
      return marker.invite === undefined;
    } catch {
      return false;
    }
  });

  // The room path is the host's own reading of what it shares, and the only side that can say it.
  const roomPath = await waitFor('the host to publish the room path of the shared document', () =>
    fs.existsSync(ROOM_PATH_FILE) ? fs.readFileSync(ROOM_PATH_FILE, 'utf8').trim() : false,
  );
  if (roomPath !== DOC) {
    throw new Error(`guest: the host shares ${JSON.stringify(roomPath)}, not ${JSON.stringify(DOC)}`);
  }

  // Opening the room's document is what takes the hold that fetches its content, and the editor
  // that lands is the one whose selection the host draws.
  const mirrored = path.join(root, roomPath);
  const editor = await waitFor('the room document to open in a mirror editor', async () => {
    await vscode.commands.executeCommand('selvage.openDocument', { path: roomPath });
    return vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === 'file' && candidate.document.uri.fsPath === mirrored,
    );
  });

  // The content arrives through the hold the open took, so the line to select is only in the
  // document once the room has answered: what is waited for is the text, not the buffer.
  const at = await waitFor('the room text to arrive in the open document', () =>
    editor.document.getText().includes(SELECTS) ? offsetOf(editor.document.getText(), SELECTS) : false,
  );
  const from = editor.document.positionAt(at);
  const to = editor.document.positionAt(at + SELECTS.length);
  editor.selection = new vscode.Selection(from, to);
  editor.revealRange(new vscode.Range(from, to), vscode.TextEditorRevealType.InCenter);

  fs.writeFileSync(READY_FILE, SELECTS);
  await waitFor('the capture to be done', () => fs.existsSync(DONE_FILE), HOLD_MS);
}

async function run() {
  if (STAGE === 'join') {
    await stageJoin();
    return;
  }
  await stagePhases();
}

exports.run = run;
