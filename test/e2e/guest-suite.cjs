/**
 * Runs inside a second, real, headless VS Code Extension Development Host as the *guest* side
 * of the two-instance convergence proof (`run.ts` drives this file through
 * `@vscode/test-electron`, twice).
 *
 * As with `host-suite.cjs`: the real, unstubbed `vscode` object cannot be monkeypatched
 * (`vscode.window`/`vscode.env` are getter-only), so this drives `selvage.join` and
 * `selvage.openDocument` through the optional-argument seam `src/adapter/extension.ts`
 * exports for automation (`JoinArgs`, `OpenDocumentArgs`) rather than a `showInputBox`/
 * `showQuickPick` it has no way to click through.
 *
 * A join replaces the window's tree with the room mirror — one reload, never a second
 * root — so this suite runs in two stages, like `guest-empty-suite.cjs`:
 *
 * `SELVAGE_E2E_STAGE=join`: join on a window holding its own folder, then wait out
 * the reload's own beat so resolving means the reload never came. The reload tears
 * down this very run: the extension host exits and `runTests` rejects, which the
 * orchestrator counts as the stage passing. Resolving is the failure.
 *
 * `SELVAGE_E2E_STAGE=phases`: the window the orchestrator opened straight onto the
 * mirror (with a freshly stashed invite the activation triage lands). Nothing here
 * joins: the suite waits for the stashed join to land, proves the window is the
 * mirror and nothing else, then runs every phase — convergence both ways, follow,
 * the granted path, the watched listing, the reconnect leg.
 *
 * The room is a real directory here: the mirror on disk its Explorer reads — the
 * materialised files, the listing following the host's folder, the saved room text
 * a tool would read. The Explorer view itself cannot be driven from an extension
 * test, and the mirror on disk is what it is drawn from.
 */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DISPLAY_NAME = process.env.SELVAGE_E2E_DISPLAY_NAME ?? 'Bob';
const STAGE = process.env.SELVAGE_E2E_STAGE ?? 'join';
const INVITE_FILE = process.env.SELVAGE_E2E_INVITE_FILE;
const ROOM_PATH_FILE = process.env.SELVAGE_E2E_ROOM_PATH_FILE;
const GRANTED_PATH_FILE = process.env.SELVAGE_E2E_GRANTED_PATH_FILE;
const GRANTED_DONE_FILE = process.env.SELVAGE_E2E_GRANTED_DONE_FILE;
const GRANTED_TEXT = process.env.SELVAGE_E2E_GRANTED_TEXT;
const WATCH_PATH = process.env.SELVAGE_E2E_WATCH_PATH;
const WATCH_TEXT = process.env.SELVAGE_E2E_WATCH_TEXT;
const WATCH_DOOMED_PATH = process.env.SELVAGE_E2E_WATCH_DOOMED_PATH;
const WATCH_READY_FILE = process.env.SELVAGE_E2E_WATCH_READY_FILE;
const WATCH_DONE_FILE = process.env.SELVAGE_E2E_WATCH_DONE_FILE;
const FOLLOW_READY_FILE = process.env.SELVAGE_E2E_FOLLOW_READY_FILE;
const FOLLOW_MOVED_FILE = process.env.SELVAGE_E2E_FOLLOW_MOVED_FILE;
const FOLLOW_STOPPED_FILE = process.env.SELVAGE_E2E_FOLLOW_STOPPED_FILE;
const FOLLOW_HOST_NAME = process.env.SELVAGE_E2E_FOLLOW_HOST_NAME ?? 'Ada';
const PROXY_ADDR = process.env.SELVAGE_E2E_PROXY_ADDR;
const STAGED_FILE = process.env.SELVAGE_E2E_STAGED_FILE;
const STAGE_ERROR_FILE = process.env.SELVAGE_E2E_STAGE_ERROR_FILE;
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

/** The mirror root in this window: the folder whose marker names the room. */
function mirrorRoot(roomId) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') {
      continue;
    }
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(path.join(folder.uri.fsPath, '.selvage-mirror.json'), 'utf8'));
    } catch {
      continue;
    }
    if (marker.room === roomId && typeof marker.window === 'string') {
      return folder.uri.fsPath;
    }
  }
  throw new Error(`guest: no mirror folder for ${roomId} in this window`);
}

/**
 * Whether `rg` finds `pattern` under the mirror: what a tool outside the editor sees.
 * A bounded spawn, skipped with a log line when `rg` is not installed.
 */
function rgMirror(pattern, dir) {
  return new Promise((resolve, reject) => {
    execFile('rg', ['-l', '-F', '--', pattern, dir], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        if (error.code === 'ENOENT') {
          console.log('guest: rg is not installed, skipping the mirror search check');
          resolve('skipped');
          return;
        }
        reject(new Error(`guest: rg over the mirror failed: ${error.message}`));
        return;
      }
      resolve(stdout.trim().length > 0 ? 'found' : 'missing');
    });
  });
}

/** Routes the guest through the reconnect proxy when one is configured, keeping the room and
 * token the host actually minted. A page link carries the server as a parameter; a wire
 * invite is rewritten as it always was. */
function routeThroughProxy(invite) {
  if (PROXY_ADDR === undefined) {
    return invite;
  }
  try {
    const url = new URL(invite);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.searchParams.set('server', `ws://${PROXY_ADDR}`);
      return url.toString();
    }
  } catch {
    // Not a page link: fall through to the wire rewrite below.
  }
  return invite.replace(/^ws:\/\/[^/]+/, `ws://${PROXY_ADDR}`);
}

async function stageJoin(rawInvite) {
  try {
    await vscode.commands.executeCommand('selvage.join', {
      invite: routeThroughProxy(rawInvite),
      displayName: DISPLAY_NAME,
    });
    // The command returned, so the reload is staged: say so on disk, because the
    // reload takes this run before it can say anything else.
    if (STAGED_FILE !== undefined) {
      fs.writeFileSync(STAGED_FILE, 'staged');
    }
  } catch (error) {
    // A join that never staged is a failure the teardown would otherwise mask as
    // the expected rejection: leave the cause where the orchestrator reads it.
    if (STAGE_ERROR_FILE !== undefined) {
      try {
        fs.writeFileSync(STAGE_ERROR_FILE, error instanceof Error ? error.stack ?? error.message : String(error));
      } catch {}
    }
    throw error;
  }
  // The reload owns everything after this: it tears down this run about a second after
  // the join, which rejects the run. Give it its beat, so returning means it never came
  // rather than that this run outran it. Returning resolves the run, which the
  // orchestrator reads as the failure; the rejection is the pass.
  await delay(10000);
}

async function stagePhases(rawInvite, result) {
  const roomPath = await waitFor(
      'the host to publish the room path of the shared document',
      () => (fs.existsSync(ROOM_PATH_FILE) ? fs.readFileSync(ROOM_PATH_FILE, 'utf8') : false),
      DEADLINE_MS,
    );

    const roomId = decodeURIComponent(/[?&]room=([^&]+)/.exec(rawInvite)[1]);
    // Nothing here joins: the activation triage lands the stashed invite this window
    // opened on. The window must be the mirror and nothing else — the join's whole
    // point — and the listing arriving fills it, which is what the phases below read.
    const root = mirrorRoot(roomId);
    await waitFor(
      'the stashed join to land',
      () => {
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(root, '.selvage-mirror.json'), 'utf8'));
          return marker.invite === undefined ? true : false;
        } catch {
          return false;
        }
      },
      DEADLINE_MS,
    );
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length !== 1) {
      throw new Error(`guest: the phases window holds ${folders.length} folders, not the mirror alone`);
    }
    result.singleFolder = true;
    // The shape lands before content: the mirror holds the empty file before anything
    // opens it, which is what makes the open below a read of the room's shape.
    const mirrorFile = path.join(root, roomPath);
    await waitFor(
      'the mirror to hold the empty file',
      () => {
        try {
          return fs.statSync(mirrorFile).size === 0 ? true : false;
        } catch {
          return false;
        }
      },
      DEADLINE_MS,
    );
    const editor = await waitFor(
      'the room document to open in a mirror editor',
      async () => {
        await vscode.commands.executeCommand('selvage.openDocument', { path: roomPath });
        return vscode.window.visibleTextEditors.find(
          (candidate) =>
            candidate.document.uri.scheme === 'file' && candidate.document.uri.fsPath === mirrorFile,
        );
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
              .filter((candidate) => candidate.document.uri.scheme === 'file')
              .map((candidate) => candidate.document.uri.toString()),
          )}`,
      );
    });
    result.phase1 = { text: converged1 };
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result));

    // The room's text on disk, as a tool outside the editor would read it: saving writes
    // what the room already holds, and `rg` finds the host's marker in the mirror.
    await document.save();
    const savedText = fs.readFileSync(mirrorFile, 'utf8');
    if (!savedText.includes(MARKER_HOST) || !savedText.includes(MARKER_GUEST)) {
      throw new Error(
        `guest: the saved mirror file does not hold the room's text: ${JSON.stringify(savedText)}`,
      );
    }
    result.savedMirror = { text: savedText };
    const searched = await rgMirror(MARKER_HOST, root);
    if (searched === 'missing') {
      throw new Error('guest: rg found no host marker in the mirror');
    }
    result.searchedMirror = searched;

    if (FOLLOW_READY_FILE !== undefined) {
      // The follow phase: this window follows the host by name — the programmatic seam for a
      // peer the suite cannot pick — and has to arrive where the host is. Membership strictly
      // precedes phase 1's marker exchange, so the name resolves without the palette.
      await vscode.commands.executeCommand('selvage.followParticipant', { displayName: FOLLOW_HOST_NAME });
      await waitFor(
        'the follow to land in the room document',
        () => {
          const active = vscode.window.activeTextEditor;
          return active !== undefined && active.document.uri.scheme === 'file' ? true : false;
        },
        DEADLINE_MS,
      );
      fs.writeFileSync(FOLLOW_READY_FILE, 'go');

      // The host moves its caret to the end once it sees the ready file; the follow has to
      // track it there. This also answers the unverified question of whether assigning
      // `editor.selection` publishes presence: if the event never fires, nothing here moves.
      const movedTo = await waitFor(
        'the host to move its caret to the end',
        () => {
          if (!fs.existsSync(FOLLOW_MOVED_FILE)) {
            return false;
          }
          // The host creates the file before its bytes land; an empty read is a race,
          // not a caret at offset zero.
          const raw = fs.readFileSync(FOLLOW_MOVED_FILE, 'utf8').trim();
          if (raw === '') {
            return false;
          }
          const offset = Number(raw);
          return Number.isInteger(offset) ? offset : false;
        },
        DEADLINE_MS,
      );
      await waitFor(
        'the follow to track the host caret to the end',
        () => {
          const active = vscode.window.activeTextEditor;
          if (active === undefined || active.document.uri.scheme !== 'file') {
            return false;
          }
          return active.document.offsetAt(active.selection.active) === movedTo ? true : false;
        },
        DEADLINE_MS,
      );

      // Stopping ends it: the host moves back to the start, and this window must hold the
      // tracked position instead of yanking back. Held constant over two seconds of presence
      // frames, each iteration asserting, is what tells a stopped follow from a slow one.
      await vscode.commands.executeCommand('selvage.stopFollowing');
      fs.writeFileSync(FOLLOW_STOPPED_FILE, 'go');
      const held = movedTo;
      const steadyUntil = Date.now() + 2000;
      for (;;) {
        const active = vscode.window.activeTextEditor;
        const at = active === undefined ? -1 : active.document.offsetAt(active.selection.active);
        if (at !== held) {
          throw new Error(`guest: the stopped follow moved the caret to ${at}; it should hold ${held}`);
        }
        if (Date.now() >= steadyUntil) {
          break;
        }
        await delay(100);
      }
      result.follow = { tracked: movedTo, heldAfterStop: held };
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
    }

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
              candidate.document.uri.scheme === 'file' &&
              candidate.document.uri.fsPath === path.join(root, grantedPath) &&
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

    if (WATCH_PATH !== undefined && WATCH_DONE_FILE !== undefined) {
      // The room's listing, as this window's own provider renders it: the same listing the
      // Explorer view is drawn from, read off disk the way anything in this editor would
      // read them.
      const roomId = decodeURIComponent(/[?&]room=([^&]+)/.exec(rawInvite)[1]);
      const watchRoot = mirrorRoot(roomId);
      const namesIn = (dir) => fs.readdirSync(dir);
      const top = WATCH_PATH.split('/')[0];
      const leaf = WATCH_PATH.slice(top.length + 1);

      // The path the host is about to remove has to be in the listing first, and this window
      // says it read it: what the phase proves is the listing following the folder, not the
      // listing as it happened to stand.
      const rootBefore = await waitFor(
        'the room\u2019s listing to name the path the host is about to remove',
        async () => {
          try {
            const seen = namesIn(watchRoot);
            return seen.includes(WATCH_DOOMED_PATH) ? seen : false;
          } catch {
            return false;
          }
        },
        DEADLINE_MS,
      );
      fs.writeFileSync(WATCH_READY_FILE, 'go');

      // The host makes one path under its folder and removes another. The room's listing has
      // to end up with the one and without the other, which only a republished grant can say.
      const rootAfter = await waitFor(
        'the room\u2019s listing to gain the created path and lose the removed one',
        async () => {
          try {
            const seen = namesIn(watchRoot);
            return seen.includes(top) && !seen.includes(WATCH_DOOMED_PATH) ? seen : false;
          } catch {
            return false;
          }
        },
        DEADLINE_MS + 15_000,
      );

      // The created path is a directory in the listing because a path goes through it: this
      // window walks into it, which a file could not answer.
      const createdDir = await waitFor(
        'the created path to be a directory this window can walk into',
        async () => {
          try {
            const seen = namesIn(path.join(watchRoot, top));
            return seen.includes(leaf) ? seen : false;
          } catch {
            return false;
          }
        },
        DEADLINE_MS,
      );

      // And it opens with the host's text in it: it was a name in the listing a moment ago, so
      // its content can only have arrived because this window asked the room for it.
      const createdEditor = await waitFor(
        'the created path to open with the host\u2019s text in it',
        async () => {
          await vscode.commands.executeCommand('selvage.openDocument', { path: WATCH_PATH });
          return vscode.window.visibleTextEditors.find(
            (candidate) =>
              candidate.document.uri.scheme === 'file' &&
              candidate.document.uri.fsPath === path.join(watchRoot, WATCH_PATH) &&
              candidate.document.getText() === WATCH_TEXT,
          );
        },
        DEADLINE_MS + 15_000,
      );

      result.watch = {
        created: WATCH_PATH,
        deleted: WATCH_DOOMED_PATH,
        rootBefore,
        rootAfter,
        createdDir,
        text: createdEditor.document.getText(),
      };

      // The removed path is gone from the mirror: the republish took the file, so no
      // phantom empty document can open in its place, and asking for it opens nothing.
      // (The refusal sentence itself goes to a message the test API cannot read.) The
      // command runs detached, so the absence is polled rather than read off the call:
      // an editor for the path appearing at any point in the window fails it.
      const doomedFile = path.join(watchRoot, WATCH_DOOMED_PATH);
      if (fs.existsSync(doomedFile)) {
        throw new Error(`the de-listed file is still on disk: ${doomedFile}`);
      }
      await vscode.commands.executeCommand('selvage.openDocument', { path: WATCH_DOOMED_PATH });
      const start = Date.now();
      let deleteRefused = false;
      let deleteRefusal = 'the republish removed the de-listed file from the mirror';
      for (;;) {
        const openedDoomed = vscode.window.visibleTextEditors.some(
          (candidate) => candidate.document.uri.fsPath === doomedFile,
        );
        if (openedDoomed) {
          deleteRefused = false;
          deleteRefusal = 'the de-listed path opened an editor anyway';
          break;
        }
        if (Date.now() - start > 3000) {
          deleteRefused = true;
          break;
        }
        await delay(50);
      }
      result.watch.deleteRefused = deleteRefused;
      result.watch.deleteRefusal = deleteRefusal;
      fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
      fs.writeFileSync(WATCH_DONE_FILE, 'go');
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
}

async function run() {
  const result = { role: 'guest', phase1: undefined, phase2: undefined, granted: undefined, watch: undefined, follow: undefined, singleFolder: undefined, error: undefined };
  try {
    const rawInvite = await waitFor(
      'the host to publish an invite link',
      () => (fs.existsSync(INVITE_FILE) ? fs.readFileSync(INVITE_FILE, 'utf8') : false),
      DEADLINE_MS,
    );
    if (STAGE === 'join') {
      await stageJoin(rawInvite);
      return;
    }
    await stagePhases(rawInvite, result);
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  } finally {
    // The join stage writes nothing: its proof is the teardown, and the reload may
    // take the window before a write lands.
    if (RESULT_FILE !== undefined) {
      try {
        fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
      } catch {}
    }
  }
  if (result.error !== undefined) {
    throw new Error(result.error);
  }
}

module.exports = { run };
