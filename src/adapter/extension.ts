/**
 * The VS Code extension: the commands, the status bar, and the wiring between this window's
 * documents and the bridge.
 *
 * This is the only module here that decides anything about the user's session, and every
 * decision it makes is a message or a URI. What happens to a document is `src/bridge/`'s,
 * and how a document is reached is `documents.ts`'s.
 */

import * as vscode from 'vscode';

import { SessionBridge, grantUnion, isGrantedPath, matchesReplica, peerColour } from '../bridge/index.ts';
import type { Report } from '../bridge/index.ts';
import {
  SelvageEngine,
  code as errCode,
  isProtocolError,
  parseSessionUrl,
} from '../engine/index.ts';
import type { PeerInfo, Role } from '../engine/index.ts';
import { displayNameInput, displayNameRefusal } from './display-name.ts';
import { WorkspaceEditor } from './documents.ts';
import { enumerateGrant, grantedFile } from './grant.ts';
import type { Mirror } from './mirror.ts';
import {
  MIRROR_MARKER,
  mintMirror,
  mirrorRelative,
  openMirror,
  processAlive,
  pruneRoom,
  readMarker,
  scanStorage,
} from './mirror.ts';

/** Identifies this client in `session.hello`, for diagnostics (`PROTOCOL.md` §5). */
const CLIENT = 'selvage-vscode/0.1.0';

/**
 * How long after the first caret event a selection reaches the room. The editor moves a caret
 * on every keystroke of its own, so one frame per event would put presence on the wire for
 * every character typed; a burst is coalesced into one flush per interval instead. This is the
 * Neovim client's value (`SELECTION_INTERVAL_MS`), so the two clients lag a peer's caret by
 * the same amount.
 */
const SELECTION_INTERVAL_MS = 100;

/**
 * How long a filesystem event waits before the room is told the listing again. A burst — a
 * `cargo build`, a branch switch, an editor writing its own files — is tens of thousands of
 * events, so a trailing throttle turns them into one walk of the folder per interval rather
 * than one per event, and one frame per interval at most. It bounds the starts and not the
 * walks: a walk can outlast the interval that began it, and the walk that started last is the
 * one allowed to publish, so a slower walk is dropped rather than sent over a newer listing.
 * This is the Neovim client's value, so a peer sees a listing change after the same delay
 * whichever client is hosting.
 */
const GRANT_REFRESH_INTERVAL_MS = 250;

/**
 * How long a read waits for the room to send a path this replica has received nothing for.
 *
 * A listed path is a candidate and not a promise — it names what the host's folder held when
 * it was enumerated — so the wait is bounded. What a timeout gives back is an empty document,
 * which is what a path with no content looks like; the alternative is a read that never
 * answers and a tab that never opens.
 */
const FETCH_TIMEOUT_MS = 5000;

/**
 * The most paths one fetch holds at once. Every held path is a `doc.open` every peer
 * absorbs and a `Y.Text` every replica keeps, so a whole listing — or one directory of
 * it — past this refuses with a sentence naming a narrower target instead of holding
 * the room sequentially, each path up to `FETCH_TIMEOUT_MS`.
 */
const MAX_FETCH_ALL_PATHS = 100;

/**
 * The most unlisted mirror paths each once-per-path warning set holds. Past it the oldest
 * entry is evicted: a tool churning unlisted names re-warns rather than growing memory.
 */
const MAX_UNLISTED_WARNINGS = 500;

/** The session this window is in. One per window: multi-room is a v1 non-goal. */
let current: Session | undefined;

/**
 * Where this window mirrors rooms, from the activation context. Commands fail loudly
 * without it, which is unreachable in a real window — the editor always provides one —
 * and only a test activates with a context that has none.
 */
let storageUri: vscode.Uri | undefined;

/**
 * The last server a user typed, so the next prompt is a keystroke rather than a paste.
 * In memory for the window, and in `globalState` (see `LAST_SERVER_KEY`) for the next
 * window: a server address is not a secret, and a prefill the user can still edit is not
 * a commitment, so remembering it is safe.
 */
let lastServer: string | undefined;

/** The `globalState` key carrying the last typed server across windows. */
const LAST_SERVER_KEY = 'selvage.lastServer';

/**
 * The server a window hosts on when nothing was typed, remembered or configured: the Pi
 * demo from `ai_notes/docs/runbook-pi-demo.md`. An overridable prefill, never a commitment —
 * the prompt still asks, explicit arguments and the `selvage.serverUrl` setting always win —
 * so moving the demo is this one line.
 */
const DEFAULT_SERVER_URL = 'ws://100.64.0.3:8080';

export function activate(context: vscode.ExtensionContext): void {
  // A window the user typed a server into leaves it behind for the next one. The in-memory
  // value still wins: it is what this window was told most recently.
  lastServer = context.globalState?.get<string>(LAST_SERVER_KEY) ?? lastServer;
  storageUri = context.globalStorageUri;
  context.subscriptions.push(
    vscode.commands.registerCommand('selvage.host', (args?: HostArgs) => {
      void host(args, context);
    }),
    vscode.commands.registerCommand('selvage.join', (args?: JoinArgs) => {
      void join(args);
    }),
    vscode.commands.registerCommand('selvage.copyInvite', () => {
      void copyInvite();
    }),
    vscode.commands.registerCommand('selvage.openDocument', (args?: OpenDocumentArgs) => {
      void openDocument(args);
    }),
    vscode.commands.registerCommand('selvage.fetch', (args?: FetchArgs) => {
      void fetchCommand(args);
    }),
    vscode.commands.registerCommand('selvage.leave', () => {
      leave();
    }),
    vscode.commands.registerCommand('selvage.displayName', (args?: DisplayNameArgs) => {
      void displayName(args);
    }),
    vscode.commands.registerCommand('selvage.peers', () => {
      void listPeers();
    }),
    vscode.commands.registerCommand('selvage.goToParticipant', (args?: GoToParticipantArgs) => {
      void goToParticipant(args);
    }),
    vscode.commands.registerCommand('selvage.followParticipant', (args?: FollowParticipantArgs) => {
      void followParticipant(args);
    }),
    vscode.commands.registerCommand('selvage.stopFollowing', () => {
      stopFollowing();
    }),
  );
  // A reload onto a mirror, or a crash that left one: the window's own triage runs
  // detached, because a pending invite finishes by joining and joining is async.
  if (storageUri !== undefined) {
    void triageMirrors(storageUri);
  }
}

export function deactivate(): void {
  void current?.dispose();
  current = undefined;
}

/**
 * One other participant, as the participant list needs them: who the room says they are, and
 * the colour their caret is drawn in. The colour is `peerColour`'s — the same value the caret
 * bar, the selection fill and the overview-ruler tick are built from — so a row in the list
 * and the caret in the document cannot disagree.
 */
interface Participant {
  peerId: string;
  displayName: string;
  role: Role;
  colour: string;
  /** The document the peer says it is in, when this client knows of one. */
  path?: string;
}
/**
 * One session in one window: the engine, the bridge, this window's editor, and the status
 * the user watches.
 */
class Session {
  /** A guest's mirror: the directory the room's listing fills, gone at leave. */
  readonly mirror: Mirror | undefined;
  private readonly engine: SelvageEngine;
  private readonly editor: WorkspaceEditor;
  private readonly bridge: SessionBridge;
  private readonly status: vscode.StatusBarItem;
  private readonly listeners: vscode.Disposable[] = [];
  /**
   * The folders this session shares, captured the moment it started. The window can be opened
   * on another folder afterwards; what the room holds is the folder it was invited on.
   */
  private readonly folders: readonly vscode.WorkspaceFolder[];
  /**
   * The listing the room holds, as this session last established it: what a `grant` was accepted
   * with, or what a server with no grant answered `unknown_method` to. The engine writes
   * whatever it is handed and keeps no memory of it, so whether a listing is news is decided
   * here. Undefined until one has been sent.
   */
  private published: string[] | undefined;
  /**
   * The listing the server last refused. A walk that enumerates the same listing has nothing
   * new to offer a server that already refused it, so it is neither sent nor reported again; a
   * listing that differs is offered and reported as usual, which is what lets a folder that
   * changed back into what was refused be refused out loud a second time.
   */
  private refusedListing: string[] | undefined;
  /**
   * How many republish walks this session has started. A walk records the count before it reads
   * the folder and may publish only while no later walk has started: a walk slower than the one
   * after it is dropped rather than sent, so the room cannot go backwards to an older listing.
   */
  private grantWalks = 0;
  /** A filesystem event whose republish has not run yet. */
  private grantTimer: ReturnType<typeof setTimeout> | undefined;
  /** What makes the listing follow the folders, live only while this session hosts. */
  private readonly grantWatchers: vscode.Disposable[] = [];
  private peers: PeerInfo[] = [];
  private documents: string[] = [];
  private granted: string[] = [];
  /**
   * Every path the room's listing has named while this session is live. A path the
   * listing named and no longer names is one the host has stopped sharing, which is what
   * tells a fresh open of it apart from a document the room never wrote to.
   */
  private readonly seenListed = new Set<string>();
  private detachedMs: number | undefined;
  /** The socket dropped and the engine's bounded retry is running. */
  private reconnecting = false;
  private finished = false;
  /** True while a guest's one auto-open is still owed; the room's first document spends it. */
  private autoOpen: boolean;
  /**
   * Unlisted mirror paths already said once this session: an open and a save each say
   * their own sentence once per path, and the person's own action is the only thing
   * that could clear them — nothing does, so they stand for the session. Bounded with
   * FIFO eviction, so a tool churning unlisted names cannot grow them without bound;
   * a path evicted and reopened says its sentence again, which is the honest answer.
   */
  private readonly unlistedOpened = new Set<string>();
  private readonly unlistedSaved = new Set<string>();
  /** A caret event that has not reached the room yet. */
  private selectionDirty = false;
  /** The one flush the interval allows, while one is armed. */
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The peer this window follows, by id. A local view state, never advertised: nothing on
   * the wire carries it, so no other client sees it beyond this window's own caret.
   */
  private followingPeerId: string | undefined;
  /** The followed peer's name as last seen: what the indicator says. */
  private followingName = '';
  /** The indicator: created when a follow begins, gone when it ends, and the stop control. */
  private followStatus: vscode.StatusBarItem | undefined;
  /** A go-to whose document has not arrived yet: re-resolved on every room event. */
  private pendingGoTo: string | undefined;
  /** Every landing stamps the cycle: a newer frame supersedes an older one still opening. */
  private landingCycle = 0;
  /** The room events the follow and the pending go-to re-resolve on. */
  private readonly stopEngine: () => void;

  constructor(engine: SelvageEngine, options: { mirror?: Mirror } = {}) {
    this.mirror = engine.session().role === 'guest' ? options.mirror : undefined;
    this.engine = engine;
    this.folders = [...(vscode.workspace.workspaceFolders ?? [])];
    this.peers = engine.peers();
    this.documents = engine.documents();
    this.granted = engine.grantedPaths();
    for (const path of this.granted) {
      this.seenListed.add(path);
    }
    this.autoOpen = engine.session().role === 'guest';
    this.editor = new WorkspaceEditor({
      role: engine.session().role,
      mirrorRoot: this.mirror?.root,
      folders: this.folders,
      report: (report) => {
        this.onReport(report);
      },
    });
    this.bridge = new SessionBridge({
      engine,
      host: this.editor,
      autoSave: config().get<boolean>('autoSave', true),
    });
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.status.name = 'Selvage';
    this.status.command = engine.session().role === 'host' ? 'selvage.copyInvite' : undefined;

    // A document that was already open when the session started is shared too.
    for (const document of vscode.workspace.textDocuments) {
      this.open(document);
    }
    this.listeners.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.open(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.close(document);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.changed(event.document);
      }),
      // A save writes the mirror file — the room already holds the text — and only the
      // save of a file the room does not list has anything to say.
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.saved(document);
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.scheduleSelection();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.scheduleSelection();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.editor.renderCursors(this.bridge.cursors());
      }),
      // The label is chosen per draw, so a window that is told the setting changed only has to
      // draw again. Without this the choice would appear to do nothing until a peer moved.
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('selvage.cursorLabel')) {
          this.editor.renderCursors(this.bridge.cursors());
        }
        if (event.affectsConfiguration('selvage.displayName')) {
          this.renameToConfigured();
        }
      }),
    );
    this.status.show();
    this.refreshStatus();
    this.selection();
    // The room's shape is the host's to publish: the folder the invite names is the grant, read
    // off the working copy at the start and again whenever a file under it appears, disappears
    // or changes. What the window has *open* is not a statement about the folder.
    if (this.role() === 'host') {
      this.watchFolders();
      void this.publishGrant();
    }
    // The join already carried a listing: fill the mirror before anything opens into it,
    // so the landing reads placeholders rather than missing files.
    this.applyListing(this.granted);
    // A guest joins a room that may have documents already, and may join one that has none.
    // Landing in the room's first document is the whole point of "come edit my code with me";
    // the palette round trip is the chore this removes.
    this.openFromRoom();
    // The follow re-reads presence on every frame, and a go-to whose document has not
    // arrived yet resolves again on every event that could have brought it: the hold taken
    // by the open is what makes the room send the text, and the anchors cannot resolve
    // before it lands. Membership counts too: presence can arrive before the peers report
    // names its peer, and the landing waits on the join rather than only on the caret.
    // Listening to the engine directly is the whole hook: the bridge fans presence out
    // only to the caret drawing, which is not where a landing belongs.
    this.stopEngine = this.engine.on((event) => {
      switch (event.type) {
        case 'presenceChanged':
        case 'documentChanged':
        case 'peersChanged':
        case 'documentsChanged':
          void this.followTick();
          void this.retryGoTo();
          break;
        default:
          break;
      }
    });
  }

  /**
   * Opens the room's first document, once, whenever it arrives: the join's own landing when
   * the room already has documents, and the landing a room that was empty at join still owes
   * the guest who stayed. Only the first — a host with five files open must not open five
   * editors here, and "Open a document from the room" still lists every path — and a second
   * document that arrives later is left alone, because taking the window then would interrupt
   * whatever the guest is editing. `selvage.openOnJoin` turns the landing off, and a host
   * never lands anywhere: its open files are the room's, and it already has them open.
   */
  private openFromRoom(): void {
    if (!this.autoOpen) {
      return;
    }
    const path = this.documents[0];
    if (path === undefined) {
      return;
    }
    this.autoOpen = false;
    if (opensOnJoin()) {
      void openRoomDocument(this, path);
    }
  }

  role(): Role {
    return this.engine.session().role;
  }

  roomId(): string {
    return this.engine.session().roomId;
  }

  /** The invite link, for the connection that minted the room and no other. */
  invite(): string | undefined {
    return this.engine.inviteUrl();
  }

  /** The room's open-document set, as the server owns it. */
  roomDocuments(): string[] {
    return this.documents;
  }

  /**
   * What the room offers: its grant, unioned with the documents it holds open. The union is
   * what a tree, a picker and a guest's file system all read, so a server that has no grant
   * still shows everything the room knows.
   */
  offered(): string[] {
    return grantUnion(this.granted, this.documents);
  }

  /**
   * Whether the room's listing named `path` and no longer does: still offered through
   * the open-document set, gone from the grant. A path the listing never named is not
   * this, so a server with no grant never reports one and a document nobody wrote to
   * still reads as an empty document rather than as a deletion.
   */
  leftListing(path: string): boolean {
    return this.seenListed.has(path) && !this.granted.includes(path);
  }

  /**
   * The room's listing, as last reported: what a fetch may name. A document the room
   * holds and its listing does not name has nothing to fetch for it, so the offered
   * set — the listing unioned with the open documents — is wider than what this answers.
   */
  listed(): string[] {
    return [...this.granted];
  }

  /**
   * Records an unlisted path as warned, true when this is the first time: the once-per-path
   * rule with a bound. The oldest entry goes past `MAX_UNLISTED_WARNINGS`, so the set
   * cannot grow one entry per distinct path a tool drops in the mirror.
   */
  private noteUnlisted(warned: Set<string>, path: string): boolean {
    if (warned.has(path)) {
      return false;
    }
    if (warned.size >= MAX_UNLISTED_WARNINGS) {
      const oldest = warned.values().next();
      if (!oldest.done) {
        warned.delete(oldest.value);
      }
    }
    warned.add(path);
    return true;
  }

  /**
   * Fetches the room's content for listed paths: one path, or a directory of them —
   * the `:SelvageFetch` twin (`nvim_client/README.md`). A fetch is a hold: every path
   * it names joins the room's open-document set, so every peer receives it, which is
   * said before it happens because afterwards is too late to choose. The wait itself
   * is `fetch`'s — the progress notice, the `leftListing` refusal, the still-empty
   * warning — so this only resolves what to hold and reports what holding it did.
   */
  async fetchFromRoom(wanted: string | undefined): Promise<void> {
    if (this.role() === 'host') {
      // The Neovim refusal verbatim: a host's disk already holds what a mirror would.
      void vscode.window.showInformationMessage(
        'Selvage: you are hosting, so the files a mirror would hold are already on your disk.',
      );
      return;
    }
    const listed = this.listed();
    // A directory typed with a trailing slash names the directory: the prefix match below
    // compares `dir/`, so the slash is stripped rather than missed.
    const trimmed = (wanted ?? '').trim().replace(/\/+$/, '');
    // A named path resolves against the listing as it stands — including an empty one,
    // where a stale name still earns the reason it left rather than a miss or an empty
    // room. Only the picker's offer needs a listing to offer from.
    let targets: string[];
    if (trimmed !== '') {
      if (listed.includes(trimmed)) {
        targets = [trimmed];
      } else {
        const under = listed.filter((path) => path.startsWith(`${trimmed}/`));
        if (under.length === 0) {
          if (this.leftListing(trimmed)) {
            void vscode.window.showErrorMessage(
              `Selvage: could not fetch ${trimmed} from the room: ${leftListingNotice(trimmed)}`,
            );
          } else {
            void vscode.window.showErrorMessage(
              `Selvage: no file the room lists matches "${trimmed}".`,
            );
          }
          return;
        }
        if (under.length > MAX_FETCH_ALL_PATHS) {
          void vscode.window.showErrorMessage(
            `Selvage: ${under.length} files under ${trimmed} is more than one fetch holds (at most ${MAX_FETCH_ALL_PATHS} at once); name a narrower directory.`,
          );
          return;
        }
        targets = under;
      }
    } else {
      if (listed.length === 0) {
        void vscode.window.showInformationMessage('Selvage: the room lists no files to fetch.');
        return;
      }
      if (listed.length > MAX_FETCH_ALL_PATHS) {
        void vscode.window.showErrorMessage(
          `Selvage: fetching all ${listed.length} listed files at once would hold every one in the room; fetch a file or a directory instead (at most ${MAX_FETCH_ALL_PATHS} at once).`,
        );
        return;
      }
      // The whole listing leads the offer: bare `:SelvageFetch` fetches it all, and the
      // palette's equivalent is one row down. A row is not a path, so picking it takes
      // the confirm below rather than the single-path flow.
      const whole: vscode.QuickPickItem = {
        label: 'Fetch the whole listing',
        description: `${listed.length} files`,
      };
      // Mixed rows: the whole-listing row is an object, paths are strings, told apart by
      // shape at runtime. The overloads take one or the other, never the union, so the
      // call carries the union under a cast rather than a lie about what is offered.
      const picked = await vscode.window.showQuickPick([whole, ...listed] as unknown as string[], {
        title: 'Fetch a path from the room',
        placeHolder: `${listed.length} listed in this room`,
      });
      if (picked === undefined) {
        return;
      }
      if (typeof picked !== 'string') {
        // A whole listing is a whole project held at once — unbounded mirror growth for
        // an unbounded room (R5) — so it asks first, with what the yes means, and a
        // dismissal or any other answer leaves the room unheld.
        const fetchAll = 'Fetch the whole listing';
        const confirmed = await vscode.window.showWarningMessage(
          `Selvage: fetch all ${listed.length} listed files into the mirror? Each is held in the room so every peer receives it, and the mirror holds whatever arrives.`,
          { modal: true },
          fetchAll,
        );
        if (confirmed !== fetchAll) {
          return;
        }
        targets = [...listed];
      } else {
        targets = [picked];
      }
    }
    // A path this window already holds needs no announcement: nothing is asked for.
    const fresh = targets.filter((target) => !this.engine.has(target));
    if (fresh.length > 0) {
      if (targets.length === 1 && targets[0] !== undefined) {
        void vscode.window.showInformationMessage(
          `Selvage: fetching opens ${targets[0]} in the room, so every peer receives it.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          'Selvage: fetching opens them in the room, so every peer receives them.',
        );
      }
    }
    let failures = 0;
    for (const target of targets) {
      // The file comes before the hold: the editor reads the placeholder, the hold
      // brings the room's text, and the save that follows writes it into the file —
      // the loop §4.1 walks for every open. Never a clobber: a file that is there stays.
      if (this.mirror !== undefined) {
        try {
          const uri = this.mirrorUri(target);
          if (uri === undefined) {
            throw new Error('this window has no mirror for the room');
          }
          if (!this.mirror.materialise([target]).mirrored.includes(target)) {
            throw new Error('the file could not be mirrored');
          }
          // Open, not shown: the fetch fills the mirror the way Neovim's does, without
          // taking the window. The open reports the document, which is what holds it.
          await vscode.workspace.openTextDocument(uri);
        } catch (error) {
          failures += 1;
          void vscode.window.showErrorMessage(
            `Selvage: could not fetch ${target} from the room: ${message(error)}`,
          );
          continue;
        }
      }
      try {
        await this.fetch(target);
      } catch (error) {
        failures += 1;
        void vscode.window.showErrorMessage(
          `Selvage: could not fetch ${target} from the room: ${message(error)}`,
        );
      }
    }
    // The report confirms an arrival, not a wait: a path the replica holds nothing for
    // already earned its still-empty warning, and naming it fetched would lie about it.
    const missing = targets.filter((target) => !this.engine.has(target));
    if (failures === 0 && missing.length === 0) {
      void vscode.window.showInformationMessage('Selvage: fetched the files.');
    }
  }

  /**
   * Asks the room for a path and resolves once its text has arrived, or once waiting can
   * no longer help.
   *
   * Holding the path is what makes the room send it: a document does not have to be open for
   * its content to sync, but the hold is what puts it in the room's set and, when the path is
   * the host's to supply, what makes the host read its own working copy. The listener is in
   * place before the hold is asked for, so text that arrives with the answer is not missed.
   *
   * A wait that gives up with nothing arriving is not always an empty document: when the
   * room's listing named the path and no longer does, the host has nothing to serve, so the
   * fetch is refused with the reason instead of opening a phantom empty document. Arrival
   * is the room sending the path's content: the change event, or text the replica holds at
   * the deadline — a sync for a path this window never held carries no event, since the
   * engine only observes held documents, but its text is still the room's. An empty
   * replica at the deadline is not arrival, only an empty sync counted as seen. A path the
   * listing still names may yet arrive — the host may only be slow — and one it never
   * named is a document nobody wrote to, so both still resolve as before.
   */
  private fetch(path: string): Promise<void> {
    if (this.engine.has(path)) {
      return Promise.resolve();
    }
    // A read that has to ask the room says so while it waits: without the notice the tab
    // opens when the wait is over and nothing says it was ever loading.
    return Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Selvage: fetching ${path}…`,
        },
        () => this.waitForText(path),
      ),
    );
  }

  /**
   * The wait `fetch` shows its notice over: the hold, the listener, and the bounded wait.
   * A wait that gives up with the replica still holding nothing is named out loud rather
   * than left as a silent empty editor: the host has not sent the text yet.
   */
  private waitForText(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      let contentSeen = false;
      let stop: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        stop();
        clearTimeout(timer);
        resolve();
      };
      const giveUp = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        stop();
        clearTimeout(timer);
        if (
          opened &&
          !contentSeen &&
          this.engine.text(path) === '' &&
          this.leftListing(path)
        ) {
          reject(new Error(leftListingNotice(path)));
          return;
        }
        // A session that ended mid-wait owes no marker: the tab it leaves behind keeps
        // whatever the freeze gave it, and a warning about a room already left misleads.
        if (!this.finished && !this.engine.has(path)) {
          void vscode.window.showWarningMessage(
            `Selvage: ${path} is still empty: the host has not sent its text yet. Selvage: Fetch a path from the room tries again.`,
          );
        }
        resolve();
      };
      stop = this.engine.on((event) => {
        if (event.type === 'documentChanged' && event.path === path) {
          contentSeen = true;
          finish();
        }
      });
      timer = setTimeout(giveUp, FETCH_TIMEOUT_MS);
      void this.engine
        .open(path)
        .then(() => {
          opened = true;
        })
        .catch(finish);
    });
  }

  /**
   * Publishes the listing of the folders this session was invited on.
   *
   * A server that does not know `doc.grant` answers `unknown_method`, which means it has no
   * grant rather than that anything failed: the session goes on and the room falls back to its
   * open-document set. Any other refusal is reported and also changes nothing. A listing the
   * room already holds is not sent; one the server has already refused is neither sent nor
   * reported again while it says the same thing.
   *
   * A walk can outlast the interval that started it, so a second event during one starts a
   * second walk. Only the walk that started last may publish, and a walk whose session has
   * ended publishes nothing at all.
   */
  private async publishGrant(): Promise<void> {
    // A republish the interval had already armed when the session ended has nothing to say to
    // a room this window has left.
    if (this.finished) {
      return;
    }
    this.grantWalks += 1;
    const attempt = this.grantWalks;
    let paths: string[];
    try {
      paths = await enumerateGrant(this.folders);
    } catch (error) {
      // A later walk describes the folder now, and its own read reports its outcome.
      if (this.finished || attempt !== this.grantWalks) {
        return;
      }
      this.onReport({
        kind: 'sessionError',
        code: 'error',
        message: `could not read the folder this window shares: ${message(error)}`,
      });
      return;
    }
    // The session can end, or a later event start a walk of its own, while this one reads the
    // folder. Either way this listing is not the one to publish: the window has left the room,
    // or a walk that started after this one is already saying what the folder holds now.
    if (this.finished || attempt !== this.grantWalks) {
      return;
    }
    if (this.published !== undefined && sameListing(this.published, paths)) {
      return;
    }
    if (this.refusedListing !== undefined && sameListing(this.refusedListing, paths)) {
      return;
    }
    try {
      await this.engine.grant(paths);
      // A later walk that started while this frame was out is the one whose outcome describes
      // the folder, and its own send has recorded it.
      if (attempt === this.grantWalks) {
        this.published = paths;
        this.refusedListing = undefined;
      }
    } catch (error) {
      // The session can end while the frame is out, and the closed engine answers rather than
      // the server: there is no room left to be refused by, and nothing to report.
      if (this.finished) {
        return;
      }
      if (isProtocolError(error) && error.code === errCode.unknownMethod) {
        // A server with no grant stores no listing, so repeating one is a frame per change for
        // nothing. Remembering it here is the same tolerance the first publication gets.
        if (attempt === this.grantWalks) {
          this.published = paths;
          this.refusedListing = undefined;
        }
        return;
      }
      // A later walk describes the folder now, and its own send reports its outcome.
      if (attempt !== this.grantWalks) {
        return;
      }
      this.refusedListing = paths;
      this.onReport({
        kind: 'sessionError',
        code: isProtocolError(error) ? error.code : 'error',
        message: `the server refused the listing of the folder this window shares: ${message(error)}`,
      });
    }
  }

  /**
   * Makes the room's listing follow the folders this session was invited on.
   *
   * One watcher per folder, because a `RelativePattern` names one base. The session is the
   * watchers' owner: a guest publishes nothing and so watches nothing, and nothing outlives
   * `dispose`.
   */
  private watchFolders(): void {
    for (const folder of this.folders) {
      let watcher: vscode.FileSystemWatcher;
      try {
        watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, '**/*'),
        );
      } catch (error) {
        // An editor that cannot watch one of the folders is not one to half-watch with: the
        // listing would follow some of what this window shares and silently not the rest, which
        // is a worse thing to leave running than a listing that is known to be as of session
        // start. So the watch is dropped and said once, and the session goes on.
        //
        // A synchronous throw is the only failure this can see. `vscode.FileSystemWatcher` has
        // no error channel: an editor that returns a watcher for a folder it then never delivers
        // an event for leaves the listing frozen, and nothing here can tell that apart from a
        // folder that did not change.
        this.stopWatching();
        this.onReport({
          kind: 'sessionError',
          code: 'error',
          message: `could not watch the folder this window shares: ${message(error)}`,
        });
        return;
      }
      // A content change is one of the three: a file that grows past what a session will carry
      // leaves the listing, and one that shrinks back into it returns.
      const refresh = (): void => {
        this.scheduleGrant();
      };
      this.grantWatchers.push(
        watcher.onDidCreate(refresh),
        watcher.onDidChange(refresh),
        watcher.onDidDelete(refresh),
        watcher,
      );
    }
  }

  /**
   * Arms the one republish the interval allows. Further events inside the window do not extend
   * it, and the flush enumerates when it runs, so what a burst publishes is the folder as it
   * stands then rather than what each event saw.
   */
  private scheduleGrant(): void {
    if (this.grantTimer !== undefined) {
      return;
    }
    this.grantTimer = setTimeout(() => {
      this.grantTimer = undefined;
      void this.publishGrant();
    }, GRANT_REFRESH_INTERVAL_MS);
  }

  private stopWatching(): void {
    for (const disposable of this.grantWatchers.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // A watcher the editor will not release must not stop the rest of the session's teardown.
      }
    }
  }

  names(): string[] {
    return this.peers.map((peer) => peer.display_name);
  }

  /** The name this session is known by: the handshake's, until a live rename replaces it. */
  displayName(): string {
    return this.engine.session().peer.display_name;
  }

  /**
   * The `selvage.displayName` setting changed. The listener is the one sender, so both the
   * `Selvage: Set the display name` command — which writes the setting — and a direct
   * settings-UI edit arrive here. A name already in force sends nothing; a name the
   * protocol refuses is skipped rather than sent, and a refusal from the server is reported
   * and leaves the live name alone.
   */
  private renameToConfigured(): void {
    const configured = config().get<string>('displayName', '');
    if (displayNameRefusal(configured) !== undefined) {
      return;
    }
    const name = configured.trim();
    if (name === this.displayName()) {
      return;
    }
    void this.engine.rename(name).catch((error: unknown) => {
      this.onReport({
        kind: 'sessionError',
        code: isProtocolError(error) ? error.code : 'error',
        message: `the server refused the display-name change: ${message(error)}`,
      });
    });
  }

  /**
   * The room's other participants, for the list. Read at the moment it is asked for rather
   * than cached, so a row is as fresh as the presence behind it. A peer whose name the room
   * left blank is shown by id, which is the rule the caret's own label follows
   * (`cursors.ts`), and a peer with no document is still listed: its colour is derived from
   * its id, so there is always a caret colour to look it up by.
   */
  participants(): Participant[] {
    const paths = new Map<string, string>();
    for (const presence of this.engine.presence()) {
      const peer = presence.peer;
      const path = presence.state?.path;
      if (peer !== undefined && path !== undefined) {
        paths.set(peer.peer_id, path);
      }
    }
    return this.engine.peers().map((peer) => ({
      peerId: peer.peer_id,
      displayName: peer.display_name,
      role: peer.role,
      colour: peerColour(peer.peer_id),
      path: paths.get(peer.peer_id),
    }));
  }

  /**
   * The palette's choice of participant: the programmatic id when it names someone in the
   * room, else the rows the list already uses, with a name shared by two peers disambiguated
   * by the shortest peer-id prefix that tells them apart. An unknown id falls through to
   * the palette rather than an invented sentence: the rows carry the names, so a stale
   * programmatic id still lands by hand.
   *
   * A picked row in no document is refused here, where the row itself says so: the row's
   * detail reads `no shared document open`, so the refusal answers what the user just saw.
   * Refusing on the landing instead would lie whenever presence lags the pick — a record
   * not yet arrived reads exactly like a peer in no document — while a programmatic id
   * pends on the next frame rather than refusing a peer whose update is one frame away.
   */
  async pickParticipant(
    peerIdHint: string | undefined,
    title: string,
    verb: 'go to' | 'follow',
    displayNameHint?: string,
  ): Promise<string | undefined> {
    const participants = this.participants();
    if (participants.length === 0) {
      void vscode.window.showWarningMessage('Selvage: no other participants yet.');
      return undefined;
    }
    if (peerIdHint !== undefined && participants.some((peer) => peer.peerId === peerIdHint)) {
      return peerIdHint;
    }
    // A name is what the Neovim commands take and what automation can know: an exact,
    // unambiguous match lands without the palette. Several matches, or none, fall through
    // to the rows, where the disambiguated names tell them apart by hand.
    if (displayNameHint !== undefined) {
      const matches = participants.filter(
        (peer) => peerName(peer.displayName, peer.peerId) === displayNameHint,
      );
      if (matches.length === 1 && matches[0] !== undefined) {
        return matches[0].peerId;
      }
    }
    const picked = await vscode.window.showQuickPick(
      participants.map((participant) => ({
        label: participantLabel(participant, participants),
        description: participant.role,
        detail: participant.path ?? 'no shared document open',
        iconPath: swatch(participant.colour),
        peerId: participant.peerId,
        path: participant.path,
      })),
      {
        title,
        placeHolder: 'Whose document to open, and where they are',
        matchOnDescription: true,
        matchOnDetail: true,
      },
    );
    if (picked !== undefined && picked.path === undefined) {
      if (verb === 'go to') {
        void vscode.window.showWarningMessage(
          `Selvage: nothing to go to: ${this.displayLabel(picked.peerId)} is not in a document.`,
        );
      } else {
        void vscode.window.showWarningMessage(
          `Selvage: nothing to follow: ${this.displayLabel(picked.peerId)} is not in a document.`,
        );
      }
      return undefined;
    }
    return picked?.peerId;
  }

  /**
   * Go to a participant: land once where they are. A pending landing is a one-shot follow:
   * the hold taken by the open is what makes the room send the text, so a document that has
   * not arrived yet resolves again on every room event rather than landing at offset zero.
   */
  async goTo(peerId: string): Promise<void> {
    // A deliberate navigation is the user's own act, the same class as typing: a follow
    // would yank them back a moment later, so going somewhere stops following first, and
    // says so — the stop is a side effect the user did not ask for.
    if (this.followingPeerId !== undefined) {
      const name = this.followingName;
      this.clearFollow();
      void vscode.window.showInformationMessage(`Selvage: Stopped following ${name}.`);
    }
    this.pendingGoTo = peerId;
    await this.retryGoTo();
  }

  private async retryGoTo(): Promise<void> {
    const peerId = this.pendingGoTo;
    if (peerId === undefined) {
      return;
    }
    const cycle = (this.landingCycle += 1);
    const valid = (): boolean => cycle === this.landingCycle && this.pendingGoTo === peerId;
    const outcome = await this.landOn(peerId, 'go', valid);
    if (outcome !== 'waiting' && this.pendingGoTo === peerId) {
      this.pendingGoTo = undefined;
    }
  }

  /**
   * Follow a participant: land where they are, and again on every frame. Re-running on the
   * peer already followed re-lands idempotently; following someone else re-targets and the
   * indicator re-labels. Establishing waits on the frames rather than on the read: a record
   * not yet arrived is awareness lag, and the next frame lands.
   *
   * The indicator goes up before the first landing, deliberately: the target is known and a
   * frame is incoming, so immediate feedback beats silence, and no toast marks the landing
   * itself — the indicator is the whole announcement. A programmatic follow of a peer in no document
   * pends the same way a go-to does rather than refusing: a record not yet arrived reads
   * exactly like a peer in no document, so refusing here would lie during awareness lag
   * (the picker owns the refusal instead, where its row displays the staleness). The next
   * frame tells the two apart — arrival lands, a steady absence keeps pending — and the pend
   * holds no resources: one slot, overwritten by the next go-to, cleared by follow or stop.
   */
  async follow(peerId: string): Promise<void> {
    if (this.followingPeerId === peerId) {
      await this.followTick();
      return;
    }
    this.followingPeerId = peerId;
    this.followingName = this.displayLabel(peerId);
    this.pendingGoTo = undefined;
    this.showFollowStatus();
    await this.followTick();
  }

  /** Stop following, or say there is nothing to stop: the indicator's command lands here. */
  stopFollowing(): void {
    if (this.followingPeerId === undefined) {
      void vscode.window.showWarningMessage('Selvage: not following anyone.');
      return;
    }
    this.clearFollow();
  }

  /**
   * The mirror file a room path lives at, or `undefined` outside a guest's mirror: the
   * one address a guest's document has, whether the editor opens it or a tool reads it.
   *
   * A path a peer names — follow, go-to, the open command — is untrusted input: presence
   * carries any string, so the grant's shape rule gates it here, at the narrow waist every
   * guest open passes through, rather than at each caller. The marker is refused with it:
   * it names the mirror's own bookkeeping, never a room document.
   */
  mirrorUri(path: string): vscode.Uri | undefined {
    if (this.mirror === undefined) {
      return undefined;
    }
    if (!isGrantedPath(path) || path === MIRROR_MARKER) {
      return undefined;
    }
    return vscode.Uri.joinPath(this.mirror.uri, ...path.split('/'));
  }

  /**
   * Opens a room path in an editor: a guest's mirror file, or a host's own file under
   * the folders captured at invite time. An editor already showing the path is reused, so a
   * follow that re-lands moves the caret rather than reopening the document.
   */
  async openRoomPath(path: string): Promise<vscode.TextEditor | undefined> {
    const active = vscode.window.activeTextEditor;
    if (active !== undefined && this.editor.pathOf(active.document) === path) {
      return active;
    }
    try {
      if (this.role() === 'guest') {
        // The path may have come from a peer's presence, so a refusal here reads as the
        // grant's answer rather than a missing mirror: `mirrorUri` already applied it.
        if (this.mirror === undefined) {
          throw new Error('this window has no mirror for the room');
        }
        const uri = this.mirrorUri(path);
        if (uri === undefined) {
          throw new Error('the path is not one this window shares');
        }
        return await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      }
      // The path came from a peer, so it goes through the check a read on a peer's behalf
      // does: inside the captured folders, of a publishable shape, through plain directories.
      // `openTextDocument` will not create a file, so this cannot plant one the way an
      // unconditional edit could.
      const file = await grantedFile(this.folders, path);
      if (file === undefined) {
        throw new Error('the path is not one this window shares');
      }
      return await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Selvage: could not open ${path} from the room: ${message(error)}`,
      );
      return undefined;
    }
  }

  /**
   * One landing on a peer's presence: open, resolve, place the caret and reveal it. Never
   * lands at offset zero for an anchor that does not resolve: without the text that is a
   * frame still to come, and with the text it is a refusal with a sentence. The follow
   * moves the follower's caret — the viewport alone is inexpressible in the Neovim client,
   * so parity decides it for both — and publishes through the coalesced path rather than
   * depending on the selection event, which no harness here observes firing for a
   * programmatic move.
   */
  private async landOn(
    peerId: string,
    mode: 'go' | 'follow',
    valid: () => boolean,
  ): Promise<'landed' | 'waiting' | 'refused' | 'gone'> {
    const record = this.engine.presence().find((candidate) => candidate.peer?.peer_id === peerId);
    if (record === undefined) {
      if (this.peers.some((peer) => peer.peer_id === peerId)) {
        return 'waiting';
      }
      if (mode === 'go') {
        void vscode.window.showWarningMessage(
          `Selvage: nothing to go to: ${this.displayLabel(peerId)} is not in a document.`,
        );
        return 'refused';
      }
      return 'gone';
    }
    if (record.peer !== undefined && mode === 'follow') {
      this.followingName = peerName(record.peer.display_name, peerId);
    }
    const path = record.state?.path;
    // No path yet is not a refusal: the record may predate the publish, and the next frame
    // tells a stale one from a peer in no document. The palette refuses its own rows, where
    // the row says as much; a programmatic landing waits instead.
    if (path === undefined) {
      return 'waiting';
    }
    const editor = await this.openRoomPath(path);
    // A newer frame supersedes this one: placing now would land where the peer was.
    if (!valid()) {
      return 'waiting';
    }
    if (editor === undefined) {
      return 'refused';
    }
    const selection = record.state?.selection;
    // A path without a selection is a caret still unknown — an empty document publishes no
    // anchors — and the next frame brings it. Only a selection that is there and does not
    // resolve is a refusal, never a landing at offset zero.
    if (selection === undefined) {
      return 'waiting';
    }
    const resolved = this.engine.resolveSelection(path, selection);
    if (resolved === undefined) {
      if (!this.engine.has(path)) {
        return 'waiting';
      }
      if (mode === 'go') {
        void vscode.window.showWarningMessage(
          `Selvage: nothing to go to: ${this.displayLabel(peerId)}'s caret does not resolve here.`,
        );
      }
      return 'refused';
    }
    const position = editor.document.positionAt(resolved.head);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    this.scheduleSelection();
    return 'landed';
  }

  /**
   * The follow's every frame: re-read presence and land again, so a peer's caret move and a
   * document change both move this window. A frame that does not resolve is a frame with
   * nothing to do, and the next one will; a peer gone from membership ends the follow.
   */
  private async followTick(): Promise<void> {
    const peerId = this.followingPeerId;
    if (peerId === undefined) {
      return;
    }
    const cycle = (this.landingCycle += 1);
    const valid = (): boolean => cycle === this.landingCycle && this.followingPeerId === peerId;
    const outcome = await this.landOn(peerId, 'follow', valid);
    if (outcome === 'gone' && this.followingPeerId === peerId) {
      this.stopForLeftPeer();
      return;
    }
  }

  private stopForLeftPeer(): void {
    if (this.followingPeerId === undefined) {
      return;
    }
    const name = this.followingName;
    this.clearFollow();
    void vscode.window.showWarningMessage(`Selvage: ${name} left the room, so following stopped.`);
  }

  /**
   * Ends the follow silently: the indicator going down is the whole announcement, the way
   * its going up is. Only a stop the user did not ask for — the peer leaving — says why.
   */
  private clearFollow(): void {
    this.followingPeerId = undefined;
    this.followStatus?.dispose();
    this.followStatus = undefined;
  }

  private showFollowStatus(): void {
    if (this.followStatus === undefined) {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
      item.name = 'Selvage follow';
      // The indicator is the stop control: selecting it runs `selvage.stopFollowing`.
      item.command = 'selvage.stopFollowing';
      this.followStatus = item;
    }
    this.followStatus.text = `$(person) Selvage: following ${this.followingName}`;
    // The foreground is the peer's marker colour: the mapping the caret wears, so the
    // indicator and the caret cannot disagree. Only the foreground — a status-bar background
    // takes two theme colours, never an arbitrary one.
    if (this.followingPeerId !== undefined) {
      this.followStatus.color = peerColour(this.followingPeerId);
    }
    this.followStatus.tooltip = `Following ${this.followingName} — select to stop following`;
    this.followStatus.show();
  }

  /** The name a sentence says: the room's, or the id when the room left it blank. */
  private displayLabel(peerId: string): string {
    const peer = this.peers.find((candidate) => candidate.peer_id === peerId);
    const display =
      peer?.display_name ??
      this.engine.presence().find((record) => record.peer?.peer_id === peerId)?.peer?.display_name ??
      '';
    return peerName(display, peerId);
  }

  dispose(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    // The follow is session state: it goes with the session, with no sentence, the way the
    // caret drawing and the room's document set do.
    this.stopEngine();
    this.followingPeerId = undefined;
    this.pendingGoTo = undefined;
    this.followStatus?.dispose();
    this.followStatus = undefined;
    // A queued republish is dropped rather than sent: the room is not this window's any more.
    if (this.grantTimer !== undefined) {
      clearTimeout(this.grantTimer);
      this.grantTimer = undefined;
    }
    this.stopWatching();
    // The position the interval was still holding reaches the room before the session ends.
    this.flushSelection();
    // Leaving takes the mirror with it: the room's tabs close first, or they point at
    // files nobody owns and a save would recreate them. The folder goes between the tabs
    // and the directory in a shared window, and last in a window that is only the room —
    // removing the only folder reloads the window, so there must be no session left to
    // lose. The close is requested, not awaited: teardown is synchronous, and the stub
    // records the request order, which is the order the editor honours them in.
    if (this.mirror !== undefined) {
      const mirror = this.mirror;
      const tabs = (vscode.window.tabGroups?.all ?? [])
        .flatMap((group) => group.tabs)
        .filter((tab) => {
          const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
          return (
            uri?.scheme === 'file' &&
            mirrorRelative(mirror.root, uri.fsPath) !== undefined
          );
        });
      if (tabs.length > 0) {
        void vscode.window.tabGroups?.close(tabs);
      }
      const folders = vscode.workspace.workspaceFolders ?? [];
      const at = folders.findIndex(
        (folder) => folder.uri.toString() === mirror.uri.toString(),
      );
      if (at !== -1 && folders.length > 1) {
        vscode.workspace.updateWorkspaceFolders(at, 1);
        mirror.remove();
      } else {
        mirror.remove();
        if (at !== -1) {
          vscode.workspace.updateWorkspaceFolders(at, 1);
        }
      }
    }
    this.bridge.dispose();
    this.editor.dispose();
    for (const listener of this.listeners) {
      listener.dispose();
    }
    this.status.dispose();
    void this.engine.disconnect();
    if (current === this) {
      current = undefined;
    }
  }

  /** Whether a document of this window still holds `path`: what keeps a removed file. */
  private held(path: string): boolean {
    return this.editor.text(path) !== undefined;
  }

  /**
   * A document opened while the room did not name it joins now that it does: the open
   * skipped it, and no second open announces it. Documents already shared, unshared
   * schemes and still-unlisted paths are untouched — `open` decides each one the way
   * the first open did. Runs on every listing and document report, because either can
   * be what names a path first.
   */
  private rejoinListed(): void {
    if (this.mirror === undefined) {
      return;
    }
    for (const document of vscode.workspace.textDocuments) {
      if (this.editor.pathOf(document) === undefined) {
        this.open(document);
      }
    }
  }

  /**
   * Fills the mirror's shape from a listing: new paths materialise empty, files that
   * left it are removed unless a document of this window still holds them, and what
   * could not be mirrored is said out loud rather than left missing in silence. Runs
   * on every grant report and once for the listing the join already carried — state
   * syncs without an event, so the report alone would miss what was there at seating.
   */
  private applyListing(paths: readonly string[]): void {
    if (this.mirror === undefined) {
      return;
    }
    const applied = this.mirror.republish(paths, (path) => this.held(path));
    if (applied.refused.length > 0) {
      const first = applied.refused[0] ?? '';
      void vscode.window.showWarningMessage(
        `Selvage: ${applied.refused.length} of the room's files could not be mirrored, starting with ${first}.`,
      );
    }
  }

  private open(document: vscode.TextDocument): void {
    const path = this.editor.register(document);
    if (path === undefined) {
      return;
    }
    // A mirror file the listing does not name is not shared: the registration is
    // dropped again — otherwise its edits would publish — and the sentence says so,
    // once per path. (`roomPath` already refuses the mirror's own marker, so an
    // unlisted path here is always a real file worth naming.)
    if (this.role() === 'guest' && this.mirror !== undefined && !this.offered().includes(path)) {
      this.editor.forget(document.uri);
      if (this.noteUnlisted(this.unlistedOpened, path)) {
        void vscode.window.showWarningMessage(
          `Selvage: ${path} is not in the room, so it is not shared; the mirror holds the room's files and is removed when the session ends.`,
        );
      }
      return;
    }
    this.bridge.documentOpened(path);
    this.refreshStatus();
  }

  /**
   * A save writes the mirror file even when the room has no path for it — the editor
   * writes what it is told to, and there is no provider left to refuse with. The
   * sentence afterwards is the honest half of that: the save is not shared, said once
   * per path, with what to do instead.
   */
  private saved(document: vscode.TextDocument): void {
    if (this.role() !== 'guest' || this.mirror === undefined) {
      return;
    }
    const rel =
      document.uri.scheme === 'file'
        ? mirrorRelative(this.mirror.root, document.uri.fsPath)
        : undefined;
    if (rel === undefined || rel === MIRROR_MARKER || this.offered().includes(rel)) {
      return;
    }
    if (this.noteUnlisted(this.unlistedSaved, rel)) {
      void vscode.window.showWarningMessage(
        `Selvage: ${rel} is not in the room, so the save is not shared; copy it out of the mirror to keep it.`,
      );
    }
  }

  private close(document: vscode.TextDocument): void {
    const path = this.editor.forget(document.uri);
    if (path !== undefined) {
      this.bridge.documentClosed(path);
      this.refreshStatus();
    }
  }

  private changed(document: vscode.TextDocument): void {
    const path = this.editor.pathOf(document);
    if (path !== undefined) {
      this.localEditEndsFollow(document, path);
      this.bridge.documentChanged(path);
    }
  }

  /**
   * A local edit of a shared document ends the follow: with the caret moved to the peer's
   * position, typing while following would otherwise have the next frame yank the caret
   * back, and the text land where the peer is rather than where it was typed.
   *
   * A remote edit must not end it, and the comparison tells the two apart without a bridge
   * change: the bridge writes the replica's own text into the buffer when it applies a
   * peer's edit, so the buffer then holds what the room holds, while a keystroke leaves it
   * holding what only this window has. The comparison is the echo guard's own
   * (`matchesReplica`): the replica is LF-only while a CRLF buffer holds `\r\n`, so a raw
   * `===` would read every remote apply in a CRLF document as divergent and end the follow.
   * Compared before the bridge publishes, because afterwards the replica holds the buffer
   * either way.
   */
  private localEditEndsFollow(document: vscode.TextDocument, path: string): void {
    if (this.followingPeerId === undefined) {
      return;
    }
    if (matchesReplica(document.getText(), this.engine.text(path))) {
      return;
    }
    // Typing ends a follow the user did not ask to end, so it says so, in the twin's
    // sentence: the indicator going down alone does not carry the news to eyes on the
    // document. An asked-for stop stays silent.
    const name = this.followingName;
    this.clearFollow();
    void vscode.window.showInformationMessage(`Selvage: Stopped following ${name}.`);
  }

  /**
   * Arms the one flush the interval allows. A burst of caret events — typing, an auto-repeat
   * arrow key, a drag — becomes a single read of the editor and a single presence frame. The
   * flush reads the selection when it runs, so what a burst publishes is where the caret
   * ended, and what it publishes when the user has left the shared documents is a clear.
   */
  private scheduleSelection(): void {
    this.selectionDirty = true;
    if (this.selectionTimer !== undefined) {
      return;
    }
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      this.flushSelection();
    }, SELECTION_INTERVAL_MS);
  }

  /**
   * Publishes the position the editor holds now, if an event left one unsent. Called when the
   * session ends: the final position must not be lost to a timer that will never run.
   */
  private flushSelection(): void {
    if (this.selectionTimer !== undefined) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = undefined;
    }
    if (!this.selectionDirty) {
      return;
    }
    this.selectionDirty = false;
    this.selection();
  }

  private selection(): void {
    const editor = vscode.window.activeTextEditor;
    const path = editor === undefined ? undefined : this.editor.pathOf(editor.document);
    if (editor === undefined || path === undefined) {
      this.bridge.selectionCleared();
      return;
    }
    this.bridge.selectionChanged(path, {
      anchor: editor.document.offsetAt(editor.selection.anchor),
      head: editor.document.offsetAt(editor.selection.active),
    });
  }

  private onReport(report: Report): void {
    switch (report.kind) {
      case 'documents': {
        this.documents = report.documents;
        // A seat reports the document set — the first one and every re-seat — so the
        // retry is over whenever this arrives.
        this.reconnecting = false;
        this.refreshStatus();
        this.rejoinListed();
        this.openFromRoom();
        break;
      }
      case 'grant': {
        this.granted = report.paths;
        for (const path of report.paths) {
          this.seenListed.add(path);
        }
        this.applyListing(report.paths);
        this.rejoinListed();
        break;
      }
      case 'peers': {
        this.peers = report.peers;
        this.refreshStatus();
        // The follow target is a peer id, so a rename only re-labels the indicator while a
        // departure ends the follow: the peer is gone from membership and its awareness state
        // with it, so there is nothing left to land on.
        const following = this.followingPeerId;
        if (following !== undefined) {
          const peer = report.peers.find((candidate) => candidate.peer_id === following);
          if (peer === undefined) {
            this.stopForLeftPeer();
          } else {
            this.followingName = peerName(peer.display_name, following);
            this.showFollowStatus();
          }
        }
        break;
      }
      case 'hostDetached': {
        this.detachedMs = report.graceMs;
        this.refreshStatus();
        void vscode.window.showWarningMessage(
          `Selvage: the host left the room; it closes in ${seconds(report.graceMs)} unless they come back.`,
        );
        break;
      }
      case 'hostAttached': {
        this.detachedMs = undefined;
        this.refreshStatus();
        void vscode.window.showInformationMessage(
          `Selvage: ${report.peer.display_name} is hosting again.`,
        );
        break;
      }
      case 'roomGone': {
        void vscode.window.showWarningMessage(`Selvage: the room is gone (${report.reason}).`);
        this.dispose();
        break;
      }
      case 'sessionError': {
        void vscode.window.showErrorMessage(
          `Selvage: ${report.message} (${report.code})`,
        );
        break;
      }
      case 'applyRefused': {
        void vscode.window.showErrorMessage(
          `Selvage: the editor would not apply the room's change to ${report.path}; the file may be read-only.`,
        );
        break;
      }
      case 'divergence': {
        void vscode.window.showWarningMessage(
          `Selvage: ${report.path} was out of step with the room; the room's copy has been put back.`,
        );
        break;
      }
      case 'saveFailed': {
        void vscode.window.showErrorMessage(
          report.message === undefined
            ? `Selvage: could not save ${report.path}; the file on disk is behind the room.`
            : `Selvage: could not save ${report.path}; the file on disk is behind the room (${report.message}).`,
        );
        break;
      }
      case 'reconnecting': {
        this.reconnecting = true;
        this.refreshStatus();
        break;
      }
      case 'disconnected': {
        void vscode.window.showWarningMessage(
          'Selvage: the connection ended and the session is over; it could not be re-established.',
        );
        this.dispose();
        break;
      }
    }
  }

  private refreshStatus(): void {
    const shared = this.bridge.openDocuments();
    if (this.reconnecting) {
      this.status.text = '$(sync~spin) Selvage: reconnecting…';
      this.status.tooltip = 'The connection dropped; trying to rejoin the room.';
      return;
    }
    if (this.detachedMs !== undefined) {
      this.status.text = '$(warning) Selvage: the host is away';
      this.status.tooltip = `The room closes in ${seconds(this.detachedMs)} if the host does not come back.`;
      return;
    }
    const who = this.role() === 'host' ? 'hosting' : 'in a room';
    const here = this.peers.length + 1;
    this.status.text = `$(radio-tower) Selvage: ${who} · ${here} here`;
    const lines = [
      `${this.role() === 'host' ? 'Hosting' : 'Guest in'} room ${this.roomId()}`,
      `In the room: ${summarise([this.names(), 'you'].flat())}`,
      `Documents the room offers: ${summarise(this.documents)}`,
      `Shared from this window: ${summarise(shared)}`,
    ];
    if (this.invite() !== undefined) {
      // The token stays out of the tooltip: a screenshot or screen-share of the status
      // bar must not carry it. The bar itself copies the link when it is clicked.
      lines.push('Invite link: click the status bar to copy it.');
    }
    this.status.tooltip = lines.join('\n');
  }
}

/**
 * How many names a status tooltip lists before it counts the rest: the listing and the
 * peer set are a stranger's input, and the tooltip is not where either is read in full.
 */
const MAX_TOOLTIP_ENTRIES = 20;

/** At most `MAX_TOOLTIP_ENTRIES` names, however many the room holds. */
function summarise(names: readonly string[]): string {
  if (names.length === 0) {
    return 'none';
  }
  const shown = names.slice(0, MAX_TOOLTIP_ENTRIES).join(', ');
  return names.length > MAX_TOOLTIP_ENTRIES
    ? `${shown}, … and ${names.length - MAX_TOOLTIP_ENTRIES} more`
    : shown;
}

/**
 * What the Join command is about to cost this window, in one sentence per moment: a host's room
 * ends for everyone in it, a guest's is left behind for the session it is joining.
 */
function joinWarning(session: Session): string {
  return session.role() === 'host'
    ? `Selvage: you are hosting room ${session.roomId()}; joining another session ends this room for everyone.`
    : `Selvage: you are in room ${session.roomId()}; joining another session leaves it.`;
}

/** What the Host command asks a guest to give up: the room it is in, before it can host one. */
function hostWarning(session: Session): string {
  return `Selvage: you are in room ${session.roomId()}; hosting a session means leaving it first.`;
}

/**
 * Arguments a caller of `vscode.commands.executeCommand` can pass to `selvage.host` instead
 * of the interactive prompts — the same commands, driven programmatically. Used by
 * `test/e2e/`, which cannot click through a `showInputBox`; there is no other consumer today.
 */
export interface HostArgs {
  serverUrl?: string;
  displayName?: string;
}

async function host(
  args?: HostArgs,
  context?: vscode.ExtensionContext,
): Promise<void> {
  const inSession = current;
  if (inSession !== undefined) {
    if (inSession.role() === 'host') {
      // Hosting again is reaching for the invite, not asking for a second room.
      if ((await copyInviteLink()) !== undefined) {
        void vscode.window.showInformationMessage(
          `Selvage: you are already hosting room ${inSession.roomId()}; the invite link is on the clipboard.`,
        );
      }
      return;
    }
    // A guest cannot host without leaving the room it is in, and leaving is the user's call.
    const leave = 'Leave and host';
    const choice = await vscode.window.showWarningMessage(
      hostWarning(inSession),
      { modal: true },
      leave,
    );
    if (choice !== leave) {
      return;
    }
    inSession.dispose();
  }
  const baseUrl =
    args?.serverUrl ??
    (await ask(
      'serverUrl',
      'The Selvage server to host on',
      'The server you and your guest connect to — usually the address it prints when it starts. Set "selvage.serverUrl" to stop being asked.',
      'The address the server prints when it starts',
      lastServer ?? DEFAULT_SERVER_URL,
    ));
  if (baseUrl === undefined) {
    return;
  }
  lastServer = baseUrl;
  await rememberServer(context, baseUrl);
  const displayName = await resolveDisplayName(args?.displayName);
  if (displayName === undefined) {
    return;
  }
  let engine: SelvageEngine;
  try {
    engine = await SelvageEngine.host(baseUrl, displayName, { client: CLIENT });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Selvage: could not host on ${baseUrl} (${message(error)}); is the server running at that address?`,
    );
    return;
  }
  current = new Session(engine);
  const invite = engine.inviteUrl();
  if (invite === undefined) {
    return;
  }
  const copy = 'Copy invite link';
  const choice = await vscode.window.showInformationMessage(
    `Selvage: room ${engine.session().roomId} is open; copy the invite link to let someone join.`,
    copy,
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(invite);
  }
}

/** See `HostArgs`: the same programmatic seam for `selvage.join`. */
export interface JoinArgs {
  invite?: string;
  displayName?: string;
}

async function join(args?: JoinArgs): Promise<void> {
  const inSession = current;
  if (inSession !== undefined) {
    const leave = 'Leave and join';
    const choice = await vscode.window.showWarningMessage(
      joinWarning(inSession),
      { modal: true },
      leave,
    );
    if (choice !== leave) {
      return;
    }
    inSession.dispose();
  }
  let invite: string | undefined;
  if (args?.invite !== undefined) {
    invite = args.invite;
  } else {
    // The clipboard is not read here: prefilling the box with it would lift whatever the
    // user last copied — a password, a token — into a field a shoulder-surfer can read,
    // before any paste asked for it. Joining pastes explicitly, or arrives by argument.
    invite = await vscode.window.showInputBox({
      title: 'Join a Selvage session',
      prompt: 'Paste the invite link the host sent you.',
      placeHolder: 'ws://host:8080/session?room=…&token=…',
      value: '',
      ignoreFocusOut: true,
      validateInput: (value) => inviteLinkRefusal(value),
    });
  }
  if (invite === undefined) {
    return;
  }
  const displayName = await resolveDisplayName(args?.displayName);
  if (displayName === undefined) {
    return;
  }
  await joinGuestRoom({ invite, displayName });
}

/**
 * Joins a room as a guest: the mirror first, the session second.
 *
 * The window's folder count at join time chooses the shape. With at least one folder the
 * room's folder is added beside the person's own — no reload, nothing else moves — and the
 * add is read back rather than trusted. With none, the invite is stashed in the fresh
 * marker and the window reopens on the mirror: the extension host after the reload is new,
 * so a session started before it would be lost, and the stashed invite is what finishes
 * the join there. A resumed mirror — the reload's own — only wants its folder ensured.
 */
async function joinGuestRoom(options: {
  invite: string;
  displayName: string;
  resume?: Mirror;
}): Promise<void> {
  const room = parseSessionUrl(options.invite)?.join.room ?? 'room';
  let mirror = options.resume;
  if (mirror === undefined) {
    if (storageUri === undefined) {
      void vscode.window.showErrorMessage(
        `Selvage: could not join room ${room}: the editor gave this window no storage for the room's files.`,
      );
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      let fresh: Mirror;
      try {
        fresh = mintMirror(storageUri, room, { invite: options.invite });
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Selvage: could not add the room's folder to this window (${message(error)}); join again.`,
        );
        return;
      }
      try {
        await vscode.commands.executeCommand('vscode.openFolder', fresh.uri, {
          forceReuseWindow: true,
        });
      } catch {
        fresh.remove();
        void vscode.window.showErrorMessage(
          `Selvage: could not open the room's folder in this empty window; open a folder first and join again.`,
        );
      }
      return;
    }
    try {
      mirror = mintMirror(storageUri, room);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Selvage: could not add the room's folder to this window (${message(error)}); join again.`,
      );
      return;
    }
    pruneRoom(storageUri, room, mirror.window);
    if (!(await addRoomFolder(mirror))) {
      mirror.remove();
      return;
    }
  } else {
    if (storageUri === undefined) {
      void vscode.window.showErrorMessage(
        `Selvage: could not join room ${room}: the editor gave this window no storage for the room's files.`,
      );
      return;
    }
    // The reload's own mirror: its folder is the window, or is added beside the rest.
    // The invite leaves the marker now — the join below either lands, or its failure
    // path deletes the directory, so a failed join never rejoins itself.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const resumed: Mirror = mirror;
    if (!folders.some((folder) => folder.uri.toString() === resumed.uri.toString())) {
      if (folders.length === 0) {
        try {
          await vscode.commands.executeCommand('vscode.openFolder', mirror.uri, {
            forceReuseWindow: true,
          });
        } catch {
          mirror.remove();
          void vscode.window.showErrorMessage(
            `Selvage: could not open the room's folder in this empty window; open a folder first and join again.`,
          );
        }
        return;
      }
      if (!(await addRoomFolder(mirror))) {
        mirror.remove();
        return;
      }
    }
    mirror.clearInvite();
  }
  const live: Mirror = mirror;
  let engine: SelvageEngine;
  try {
    engine = await SelvageEngine.join(options.invite, options.displayName, { client: CLIENT });
  } catch (error) {
    // A failed join leaves no room-shaped folder behind: the folder goes first in a
    // shared window, and the directory with it either way.
    removeRoomFolder(live);
    live.remove();
    void vscode.window.showErrorMessage(
      `Selvage: could not join the session (${message(error)}); check the link is complete and the server is running.`,
    );
    return;
  }
  current = new Session(engine, { mirror: live });
  void vscode.window.showInformationMessage(
    joinedMessage(engine.session().roomId, engine.documents()),
  );
}

/** The room's folder beside the person's own, confirmed present rather than trusted. */
async function addRoomFolder(mirror: Mirror): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const room = mirror.room;
  // The reason is a value, not a second sentence: the vocabulary pins the one template.
  let refusal: string | undefined = 'the editor refused the folder';
  try {
    if (
      vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
        uri: mirror.uri,
        name: `Selvage room ${room}`,
      }) === true
    ) {
      refusal = (vscode.workspace.workspaceFolders ?? []).some(
        (folder) => folder.uri.toString() === mirror.uri.toString(),
      )
        ? undefined
        : 'the folder never landed';
    }
  } catch {
    refusal = 'the editor refused the folder';
  }
  if (refusal !== undefined) {
    void vscode.window.showErrorMessage(
      `Selvage: could not add the room's folder to this window (${refusal}); join again.`,
    );
    return false;
  }
  return true;
}

/** Takes the room's folder back out of the window, where one was put. Best effort. */
function removeRoomFolder(mirror: Mirror): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const at = folders.findIndex((folder) => folder.uri.toString() === mirror.uri.toString());
  if (at !== -1) {
    try {
      vscode.workspace.updateWorkspaceFolders(at, 1);
    } catch {
      // Teardown already reports its outcome; a folder that will not leave is the
      // window's to close by hand.
    }
  }
}

/**
 * The window's own triage at activation: a reload onto a mirror, or a crash that left
 * one. A marker with a pending invite finishes the join it was stashed for; a marker
 * with no invite and no session is a cache with no room — the directory goes, the folder
 * goes with it, and one sentence says what went. A live sibling's directory, and anything
 * without a marker of ours, is untouched.
 */
async function triageMirrors(storage: vscode.Uri): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const stored of scanStorage(storage)) {
    if (current !== undefined) {
      return;
    }
    const mirror = openMirror(storage, stored.room, stored.window);
    if (mirror === undefined) {
      continue;
    }
    if (stored.invite !== undefined) {
      const displayName = await resolveDisplayName();
      if (displayName === undefined || current !== undefined) {
        return;
      }
      await joinGuestRoom({ invite: stored.invite, displayName, resume: mirror });
      return;
    }
    const inWindow = folders.some(
      (folder) => folder.uri.toString() === mirror.uri.toString(),
    );
    if (!inWindow && processAlive(readMarker(mirror.root)?.pid ?? 0)) {
      continue;
    }
    // Stale either way: restored onto it with no session, or owned by nobody anywhere.
    removeRoomFolder(mirror);
    mirror.remove();
    void vscode.window.showWarningMessage(
      `Selvage: removed room ${stored.room}'s leftover files from the last session; they were the room's text, not unsaved work.`,
    );
  }
}

/**
 * Why a join box value is not an invite link, or `undefined` when it is. A truncated paste
 * fails here, in plain words saying what a good link looks like, rather than later as
 * whatever the engine said: a newcomer cannot tell "bad paste" from "server down" from
 * an ECONNREFUSED. The engine still refuses one that arrives by argument.
 */
function inviteLinkRefusal(value: string): string | undefined {
  const invite = value.trim();
  // An absolute WebSocket URL first: `parseSessionUrl` only checks the `/session` suffix
  // and the query fields, so a relative `not-a-url/session?room=…&token=…` would otherwise
  // pass this box and fail later inside the engine.
  let url: URL;
  try {
    url = new URL(invite);
  } catch {
    return inviteLinkHint();
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return inviteLinkHint();
  }
  const parsed = parseSessionUrl(invite);
  if (
    parsed === undefined ||
    parsed.join.room === undefined ||
    parsed.join.room === '' ||
    parsed.join.token === undefined ||
    parsed.join.token === ''
  ) {
    return inviteLinkHint();
  }
  return undefined;
}

/** What a good invite link looks like, for the join box refusal. */
function inviteLinkHint(): string {
  return 'That does not look like a Selvage invite link. Paste the whole link the host sent you — it looks like ws://host:8080/session?room=…&token=….';
}

/**
 * The join's sentence: the room the window joined, and the landing it is about to make in it —
 * which is nothing to name when the room has no documents yet, and the palette when
 * `selvage.openOnJoin` has turned the landing off.
 */
function joinedMessage(roomId: string, documents: string[]): string {
  const first = documents[0];
  if (first === undefined) {
    return `Selvage: joined room ${roomId}; the room has no open documents yet.`;
  }
  if (!opensOnJoin()) {
    return `Selvage: joined room ${roomId}. Selvage: Open a document from the room lists every path.`;
  }
  // The landing opens one document; the rest wait behind the palette, so the join names
  // them rather than leaving the guest to assume the room is one file.
  const rest = documents.length - 1;
  const more =
    rest > 0 ? ` and ${rest} more; Selvage: Open a document from the room lists every path, Selvage: Fetch a path from the room fills the files on disk` : '';
  return `Selvage: joined room ${roomId}; opening ${first}${more}.`;
}

/**
 * Puts this window's invite on the clipboard, or warns that it has none — only the connection
 * that minted the room has one. The sentence that accompanies the copy is the caller's:
 * hosting again and copying the link deliberately say different things about the same copy.
 */
async function copyInviteLink(): Promise<string | undefined> {
  const invite = current?.invite();
  if (invite === undefined) {
    void vscode.window.showWarningMessage(
      'Selvage: there is no invite link: only the connection that opened the room has one.',
    );
    return undefined;
  }
  await vscode.env.clipboard.writeText(invite);
  return invite;
}

async function copyInvite(): Promise<void> {
  if ((await copyInviteLink()) !== undefined) {
    void vscode.window.showInformationMessage('Selvage: the invite link is on the clipboard.');
  }
}

/**
 * Why a path the listing named and no longer names cannot be opened. One sentence
 * for both places that report it: the fetch that gives up waiting for its text, and
 * the open command handed a name the listing just dropped.
 */
function leftListingNotice(path: string): string {
  return `the host no longer shares ${path}; it may have been deleted after the listing was published`;
}

/** See `HostArgs`: the same programmatic seam for `selvage.openDocument`. */
export interface OpenDocumentArgs {
  path?: string;
}

/**
 * A guest's documents are virtual and only a guest has them: a host edits its own files,
 * and opening the room's copy of a file it is already editing would be two buffers for one
 * path.
 */
async function openDocument(args?: OpenDocumentArgs): Promise<void> {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: join a session first.');
    return;
  }
  if (session.role() === 'host') {
    void vscode.window.showInformationMessage(
      'Selvage: you are hosting, so the files you open are the ones the room has.',
    );
    return;
  }
  const paths = session.offered();
  let picked: string | undefined;
  if (args?.path !== undefined) {
    if (paths.includes(args.path)) {
      picked = args.path;
    } else if (session.leftListing(args.path)) {
      // A click or call naming a path that just left the listing: the gate below
      // would silently return, so the stale name is refused here with the reason
      // a fetch that gives up on it reports. The gate never reaches `readFile`.
      void vscode.window.showErrorMessage(
        `Selvage: could not open ${args.path} from the room: ${leftListingNotice(args.path)}`,
      );
      return;
    } else if (paths.length === 0) {
      void vscode.window.showInformationMessage('Selvage: the room has no open documents yet.');
      return;
    } else {
      // A caller naming a path the listing never held: the palette cannot offer it,
      // and the gate below would return silently, so the miss is refused outright.
      void vscode.window.showErrorMessage(`Selvage: no shared document matches "${args.path}".`);
      return;
    }
  } else {
    if (paths.length === 0) {
      void vscode.window.showInformationMessage('Selvage: the room has no open documents yet.');
      return;
    }
    const single = paths[0];
    if (paths.length === 1 && single !== undefined) {
      // One document is no choice: reveal it directly rather than drawing a one-row picker.
      picked = single;
    } else {
      picked = await vscode.window.showQuickPick(paths, {
        title: 'Open a document from the room',
        placeHolder: `${paths.length} open in this room`,
      });
    }
  }
  if (picked === undefined) {
    return;
  }
  await openRoomDocument(session, picked);
}

/** See `HostArgs`: the same programmatic seam for `selvage.fetch`. */
export interface FetchArgs {
  /** One listed path, or a directory of them; without one the listing is offered. */
  path?: string;
}

/**
 * Fetches a listed path's content into the room's hold, outside a session refused.
 * A host has no mirror to fill, so the refusal says where its files already are.
 */
async function fetchCommand(args?: FetchArgs): Promise<void> {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: join a session first.');
    return;
  }
  await session.fetchFromRoom(args?.path);
}

/** Opens a room path as a guest's mirror file: what the editor reads and tools see. */
async function openRoomDocument(session: Session, path: string): Promise<void> {
  try {
    const uri = session.mirrorUri(path);
    if (uri === undefined) {
      throw new Error('the path is not one this window shares');
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Selvage: could not open ${path} from the room: ${message(error)}`,
    );
  }
}

function leave(): void {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: not in a session.');
    return;
  }
  void session.dispose();
  void vscode.window.showInformationMessage('Selvage: left the session.');
}

/**
 * The name others see, as the room has it or as the setting has it. Undefined when neither
 * has one, because that is the case that asks.
 */
function nameInForce(): string | undefined {
  const live = current?.displayName();
  if (live !== undefined && live !== '') {
    return live;
  }
  const configured = config().get<string>('displayName', '').trim();
  return configured === '' ? undefined : configured;
}

/**
 * A name inside the protocol's bound, or `undefined` with the refusal reported.
 */
function withinBound(raw: string): string | undefined {
  const name = raw.trim();
  const refusal = displayNameRefusal(name);
  if (refusal !== undefined) {
    void vscode.window.showErrorMessage(`Selvage: ${refusal}`);
    return undefined;
  }
  return name;
}

/**
 * The name this window will be seated with: the one a caller named, else the
 * `selvage.displayName` setting, else the answer to a question that states the bound.
 *
 * A name over the bound is refused wherever it came from — a server refuses the
 * `session.hello` it would arrive in, and being asked for a shorter name is better than being
 * refused one. A configured name that is refused falls through to the question rather than
 * failing the command: the box starts from the name that was refused, so it can be shortened
 * instead of retyped.
 */
async function resolveDisplayName(given?: string): Promise<string | undefined> {
  if (given !== undefined) {
    return withinBound(given);
  }
  const configured = config().get<string>('displayName', '').trim();
  if (configured !== '') {
    const name = withinBound(configured);
    if (name !== undefined) {
      return name;
    }
  }
  const answer = await vscode.window.showInputBox(
    displayNameInput({
      title: 'The name other participants see',
      value: configured === '' ? userName() : configured,
    }),
  );
  if (answer === undefined) {
    return undefined;
  }
  return withinBound(answer);
}

/** See `HostArgs`: the same programmatic seam for `selvage.displayName`. */
export interface DisplayNameArgs {
  name?: string;
}

/**
 * The name other participants see, and when a change to it takes effect.
 *
 * With no name it reports the one in force and offers the question, which is how a palette
 * command can both read and set: a Neovim command takes `:SelvageDisplayName [name]` and a
 * palette entry takes nothing, so the report is the first thing the user sees either way.
 *
 * The name travels in the `host`/`join` handshake, and a live session changes it with the
 * `selvage.displayName` setting write: the configuration listener sends a `session.rename`,
 * so a change applies to the room now rather than only to the next host or join. The setting
 * is written at the global scope, so a later window is not asked again.
 */
async function displayName(args?: DisplayNameArgs): Promise<void> {
  if (args?.name !== undefined) {
    await acceptDisplayName(args.name);
    return;
  }
  const currentName = nameInForce();
  const reported =
    currentName === undefined
      ? 'Selvage: no display name is set yet.'
      : `Selvage: the name others see is "${currentName}".`;
  const change = 'Change the name';
  const choice = await vscode.window.showInformationMessage(reported, change);
  if (choice !== change) {
    return;
  }
  const answer = await vscode.window.showInputBox(
    displayNameInput({
      title: 'Set the name other participants see',
      value: currentName ?? userName(),
      current: currentName,
    }),
  );
  if (answer === undefined) {
    return;
  }
  await acceptDisplayName(answer);
}

/**
 * Writes a name that is inside the bound and says when it takes effect. A refusal changes
 * nothing: the name in force stays the one that was in force.
 *
 * The write is what makes the name the next session's, so a settings file that will not take it
 * — one a configuration manager owns and leaves read-only — is reported rather than swallowed,
 * and the confirmation is not sent.
 */
async function acceptDisplayName(raw: string): Promise<void> {
  const name = withinBound(raw);
  if (name === undefined) {
    return;
  }
  try {
    await config().update('displayName', name, vscode.ConfigurationTarget.Global);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Selvage: could not write the "selvage.displayName" setting, so the name was not changed (${message(error)}).`,
    );
    return;
  }
  void vscode.window.showInformationMessage(`Selvage: display name set to "${name}".`);
}

/**
 * A peer's caret colour as a dot, for the list.
 *
 * The colour is `peerColour`'s — the very value the caret bar, the selection fill, the
 * overview-ruler tick and the caret's hover are built from, so the key cannot disagree with
 * the thing it explains. A data-URI SVG is the only shape `QuickPickItem.iconPath` carries a
 * colour in; nothing in this suite can see the dot, only the URI.
 */
function swatch(colour: string): vscode.Uri {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12">' +
    `<circle cx="6" cy="6" r="6" fill="${colour}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent(svg)}`);
}

/**
 * Lists the room's other participants: each one's colour, name, role and document.
 *
 * This is the lookup `:SelvagePeers` exists to be: a caret is a coloured bar with a name in
 * its hover, and the list is where a colour is turned back into a person. The list is every
 * peer the room names, including one in a document this window does not hold — a colour is
 * derived from a peer id, so it is known before the caret is drawn.
 */
async function listPeers(): Promise<void> {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: join a session first.');
    return;
  }
  const participants = session.participants();
  if (participants.length === 0) {
    void vscode.window.showWarningMessage('Selvage: no other participants yet.');
    return;
  }
  await vscode.window.showQuickPick(
    participants.map((participant) => ({
      label: participant.displayName === '' ? participant.peerId : participant.displayName,
      description: participant.role,
      detail: participant.path ?? 'no shared document open',
      iconPath: swatch(participant.colour),
    })),
    {
      title: `Selvage: room ${session.roomId()}`,
      placeHolder: 'Who is here, and the colour their caret is drawn in',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
}

/** See `HostArgs`: the same programmatic seam for `selvage.goToParticipant`. */
export interface GoToParticipantArgs {
  peerId?: string;
  /** A display name to land on without the palette: exact and unambiguous, or the pick. */
  displayName?: string;
}

/** See `HostArgs`: the same programmatic seam for `selvage.followParticipant`. */
export interface FollowParticipantArgs {
  peerId?: string;
  /** A display name to follow without the palette: exact and unambiguous, or the pick. */
  displayName?: string;
}

async function goToParticipant(args?: GoToParticipantArgs): Promise<void> {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: join a session first.');
    return;
  }
  const peerId = await session.pickParticipant(args?.peerId, 'Go to a participant', 'go to', args?.displayName);
  if (peerId === undefined) {
    return;
  }
  await session.goTo(peerId);
}

async function followParticipant(args?: FollowParticipantArgs): Promise<void> {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: join a session first.');
    return;
  }
  const peerId = await session.pickParticipant(args?.peerId, 'Follow a participant', 'follow', args?.displayName);
  if (peerId === undefined) {
    return;
  }
  await session.follow(peerId);
}

function stopFollowing(): void {
  const session = current;
  if (session === undefined) {
    void vscode.window.showWarningMessage('Selvage: join a session first.');
    return;
  }
  session.stopFollowing();
}

/**
 * The name a row says: the display name, or the id when the room left the name blank — the
 * rule the caret's own label follows (`cursors.ts`).
 */
function peerName(displayName: string, peerId: string): string {
  return displayName === '' ? peerId : displayName;
}

/**
 * A picker's row label, disambiguated only when it must: one `Ada` reads `Ada`, two read
 * `Ada (p-3d334f)` and `Ada (p-a91c02)`, where the fragment is the shortest prefix of the
 * peer id unique among the peers sharing that name. The prefix is a label only — the row
 * carries the full id, which is what the command lands on.
 */
function participantLabel(participant: Participant, all: Participant[]): string {
  const name = peerName(participant.displayName, participant.peerId);
  if (participant.displayName === '') {
    return name;
  }
  const shared = all.filter(
    (other) => other.peerId !== participant.peerId && other.displayName === participant.displayName,
  );
  if (shared.length === 0) {
    return name;
  }
  const ids = new Set([participant.peerId, ...shared.map((other) => other.peerId)]);
  for (let length = 1; length <= participant.peerId.length; length += 1) {
    const prefix = participant.peerId.slice(0, length);
    if ([...ids].every((id) => id === participant.peerId || !id.startsWith(prefix))) {
      return `${name} (${prefix})`;
    }
  }
  return `${name} (${participant.peerId})`;
}

/**
 * A setting when there is one, and a question when there is not. The question carries a
 * prefilled fallback — the last typed server, else the demo default (`DEFAULT_SERVER_URL`) —
 * so asking is a keystroke rather than a paste.
 */
async function ask(
  key: string,
  title: string,
  prompt: string,
  placeHolder: string,
  fallback?: string,
): Promise<string | undefined> {
  const configured = config().get<string>(key, '');
  if (configured !== '') {
    return configured;
  }
  const answer = await vscode.window.showInputBox({
    title,
    prompt,
    placeHolder,
    value: fallback ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'A value is needed to go on.' : undefined),
  });
  const trimmed = answer?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Keeps the typed server for the next window. Memory only: a window that cannot remember
 * still hosts, so a write that fails is dropped rather than reported.
 */
async function rememberServer(
  context: vscode.ExtensionContext | undefined,
  baseUrl: string,
): Promise<void> {
  try {
    await context?.globalState?.update(LAST_SERVER_KEY, baseUrl);
  } catch {
    // A window that cannot remember still hosts.
  }
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('selvage');
}

/** Whether two listings say the same thing, in the same order. */
function sameListing(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

/** Whether a join puts the room's first document in front of the guest (`selvage.openOnJoin`). */
function opensOnJoin(): boolean {
  return config().get<boolean>('openOnJoin', true);
}

function userName(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}
