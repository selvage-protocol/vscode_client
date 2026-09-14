/**
 * The VS Code extension: the commands, the status bar, and the wiring between this window's
 * documents and the bridge.
 *
 * This is the only module here that decides anything about the user's session, and every
 * decision it makes is a message or a URI. What happens to a document is `src/bridge/`'s,
 * and how a document is reached is `documents.ts`'s.
 */

import * as vscode from 'vscode';

import { SCHEME, SessionBridge, peerColour, virtualUri } from '../bridge/index.ts';
import type { Report } from '../bridge/index.ts';
import { SelvageEngine, parseSessionUrl } from '../engine/index.ts';
import type { PeerInfo, Role } from '../engine/index.ts';
import { displayNameInput, displayNameRefusal } from './display-name.ts';
import { WorkspaceEditor } from './documents.ts';
import { GuestFileSystem } from './guest-fs.ts';

/** Identifies this client in `session.hello`, for diagnostics (`PROTOCOL.md` §5). */
const CLIENT = 'selvage-vscode/0.1.0';

/** The session this window is in. One per window: multi-room is a v1 non-goal. */
let current: Session | undefined;

/** The last server a user typed, so the next prompt is a keystroke rather than a paste. */
let lastServer: string | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const files = new GuestFileSystem();
  context.subscriptions.push(files);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, files, {
      isCaseSensitive: true,
      isReadonly: false,
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('selvage.host', (args?: HostArgs) => {
      void host(files, args);
    }),
    vscode.commands.registerCommand('selvage.join', (args?: JoinArgs) => {
      void join(files, args);
    }),
    vscode.commands.registerCommand('selvage.copyInvite', () => {
      void copyInvite();
    }),
    vscode.commands.registerCommand('selvage.openDocument', (args?: OpenDocumentArgs) => {
      void openDocument(args);
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
  );
}

export function deactivate(): void {
  current?.dispose();
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
  private readonly files: GuestFileSystem;
  private readonly engine: SelvageEngine;
  private readonly editor: WorkspaceEditor;
  private readonly bridge: SessionBridge;
  private readonly status: vscode.StatusBarItem;
  private readonly listeners: vscode.Disposable[] = [];
  private peers: PeerInfo[] = [];
  private documents: string[] = [];
  private detachedMs: number | undefined;
  private finished = false;

  constructor(files: GuestFileSystem, engine: SelvageEngine) {
    this.files = files;
    this.engine = engine;
    this.peers = engine.peers();
    this.documents = engine.documents();
    this.editor = new WorkspaceEditor({
      role: engine.session().role,
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

    this.files.use({ roomId: engine.session().roomId, text: (path) => engine.text(path) });
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
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.selection();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.selection();
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
      }),
    );
    this.status.show();
    this.refreshStatus();
    this.selection();
    // A guest joins a room that already has documents. Landing in one of them is the whole
    // point of "come edit my code with me"; the palette round trip is the chore this removes.
    if (this.role() === 'guest') {
      this.openFromRoom();
    }
  }

  /**
   * Opens one of the room's documents as the session is built, so a guest that just joined
   * lands in the work. Only the first: a host with five files open must not open five
   * editors here, and "Open a document from the room" still lists every path. Called from
   * the constructor alone, so it can never pull focus from a document the user is editing
   * mid-session.
   */
  private openFromRoom(): void {
    const path = this.documents[0];
    if (path !== undefined) {
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

  names(): string[] {
    return this.peers.map((peer) => peer.display_name);
  }

  /** The name this session was seated with. It travelled in the handshake and never moves. */
  displayName(): string {
    return this.engine.session().peer.display_name;
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

  dispose(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    // A guest's tabs keep what the room held for them: the session is over, but nothing a
    // user is looking at should turn into an error.
    const frozen: Array<[uri: string, content: string]> = this.editor
      .virtualDocuments()
      .map(([uri, path]) => [uri, this.engine.text(path)]);
    this.files.freeze(frozen);
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

  private open(document: vscode.TextDocument): void {
    const path = this.editor.register(document);
    if (path !== undefined) {
      this.bridge.documentOpened(path);
      this.refreshStatus();
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
      this.bridge.documentChanged(path);
    }
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
        this.refreshStatus();
        break;
      }
      case 'peers': {
        this.peers = report.peers;
        this.refreshStatus();
        break;
      }
      case 'hostDetached': {
        this.detachedMs = report.graceMs;
        this.refreshStatus();
        void vscode.window.showWarningMessage(
          `Selvage: the host left the room. It closes in ${seconds(report.graceMs)} unless they come back.`,
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
          `Selvage: the editor would not apply the room's change to ${report.path}. The file is not in step with the room; it may be read-only.`,
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
          `Selvage: could not save ${report.path}; the file on disk is behind the room${report.message === undefined ? '' : ` (${report.message})`}.`,
        );
        break;
      }
      case 'disconnected': {
        void vscode.window.showWarningMessage('Selvage: the session ended.');
        this.dispose();
        break;
      }
    }
  }

  private refreshStatus(): void {
    const shared = this.bridge.openDocuments();
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
      `In the room: ${[this.names(), 'you'].flat().join(', ')}`,
      `Documents the room offers: ${this.documents.length === 0 ? 'none' : this.documents.join(', ')}`,
      `Shared from this window: ${shared.length === 0 ? 'none' : shared.join(', ')}`,
    ];
    const invite = this.invite();
    if (invite !== undefined) {
      lines.push(`Invite link (click to copy): ${invite}`);
    }
    this.status.tooltip = lines.join('\n');
  }
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

async function host(files: GuestFileSystem, args?: HostArgs): Promise<void> {
  const inSession = current;
  if (inSession !== undefined) {
    if (inSession.role() === 'host') {
      // Hosting again is reaching for the invite, not asking for a second room.
      await copyInvite();
      return;
    }
    // A guest cannot host without leaving the room it is in, and leaving is the user's call.
    const leave = 'Leave and host';
    const choice = await vscode.window.showWarningMessage(
      `Selvage: you are a guest in room ${inSession.roomId()}. Hosting a session means leaving it first.`,
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
      'ws://127.0.0.1:8080 — the address a selvaged prints',
      lastServer,
    ));
  if (baseUrl === undefined) {
    return;
  }
  lastServer = baseUrl;
  const displayName = await resolveDisplayName(args?.displayName);
  if (displayName === undefined) {
    return;
  }
  let engine: SelvageEngine;
  try {
    engine = await SelvageEngine.host(baseUrl, displayName, { client: CLIENT });
  } catch (error) {
    void vscode.window.showErrorMessage(`Selvage: ${message(error)}`);
    return;
  }
  current = new Session(files, engine);
  const invite = engine.inviteUrl();
  if (invite === undefined) {
    return;
  }
  const copy = 'Copy invite link';
  const choice = await vscode.window.showInformationMessage(
    `Selvage: room ${engine.session().roomId} is open. Share the invite link to let someone join.`,
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

async function join(files: GuestFileSystem, args?: JoinArgs): Promise<void> {
  const inSession = current;
  if (inSession !== undefined) {
    const hosting = inSession.role() === 'host';
    const leave = 'Leave and join';
    const choice = await vscode.window.showWarningMessage(
      hosting
        ? `Selvage: you are hosting room ${inSession.roomId()}. Joining another session ends this room for everyone in it.`
        : `Selvage: you are in room ${inSession.roomId()}. Joining another session leaves it.`,
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
    const clipboard = await vscode.env.clipboard.readText();
    invite = await vscode.window.showInputBox({
      title: 'Join a Selvage session',
      prompt: 'Paste the invite link the host sent you.',
      placeHolder: 'ws://host:8080/session?room=…&token=…',
      value: parseSessionUrl(clipboard) === undefined ? '' : clipboard,
      ignoreFocusOut: true,
    });
  }
  if (invite === undefined) {
    return;
  }
  const displayName = await resolveDisplayName(args?.displayName);
  if (displayName === undefined) {
    return;
  }
  let engine: SelvageEngine;
  try {
    engine = await SelvageEngine.join(invite, displayName, { client: CLIENT });
  } catch (error) {
    void vscode.window.showErrorMessage(`Selvage: ${message(error)}`);
    return;
  }
  current = new Session(files, engine);
  const documents = engine.documents();
  const howMany =
    documents.length > 1
      ? `; run "Selvage: Open a document from the room" for the other ${documents.length - 1}`
      : '';
  void vscode.window.showInformationMessage(
    documents.length === 0
      ? `Selvage: joined room ${engine.session().roomId}. This room has no open documents yet.`
      : `Selvage: joined room ${engine.session().roomId}. Opening ${documents[0]}${howMany}.`,
  );
}

async function copyInvite(): Promise<void> {
  const invite = current?.invite();
  if (invite === undefined) {
    void vscode.window.showWarningMessage(
      'Selvage: this window holds no invite link. Only the connection that opened the room has one.',
    );
    return;
  }
  await vscode.env.clipboard.writeText(invite);
  void vscode.window.showInformationMessage('Selvage: invite link copied.');
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
    void vscode.window.showWarningMessage('Selvage: host or join a session first.');
    return;
  }
  if (session.role() === 'host') {
    void vscode.window.showInformationMessage(
      'Selvage: you are hosting, so the files you open are the ones the room has.',
    );
    return;
  }
  const paths = session.roomDocuments();
  if (paths.length === 0) {
    void vscode.window.showInformationMessage(
      'Selvage: this room has no open documents yet. One appears here as soon as the host opens a file.',
    );
    return;
  }
  let picked: string | undefined;
  if (args?.path !== undefined) {
    picked = paths.includes(args.path) ? args.path : undefined;
  } else {
    picked = await vscode.window.showQuickPick(paths, {
      title: 'Open a document from the room',
      placeHolder: `${paths.length} open in this room`,
    });
  }
  if (picked === undefined) {
    return;
  }
  await openRoomDocument(session, picked);
}

/** Opens a room path as a guest's virtual document: `selvage:/<path>?room=<room id>`. */
async function openRoomDocument(session: Session, path: string): Promise<void> {
  const uri = vscode.Uri.parse(virtualUri(session.roomId(), path));
  try {
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
    void vscode.window.showWarningMessage('Selvage: this window is not in a session.');
    return;
  }
  session.dispose();
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
 * A name inside the protocol's bound, or `undefined` with the reason reported. `where` names
 * the source in the refusal, so a person knows which of the three to fix.
 */
function withinBound(raw: string, where: string): string | undefined {
  const name = raw.trim();
  const refusal = displayNameRefusal(name);
  if (refusal !== undefined) {
    void vscode.window.showErrorMessage(`Selvage: the ${where} was not sent: ${refusal}`);
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
    return withinBound(given, 'name you gave');
  }
  const configured = config().get<string>('displayName', '').trim();
  if (configured !== '') {
    const name = withinBound(configured, '"selvage.displayName" setting');
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
  return withinBound(answer, 'name you typed');
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
 * The name travels in the `host`/`join` handshake and nothing carries it afterwards, so a
 * session already live keeps the name it started with; the change is for the next one. The
 * setting is written at the global scope, so a later window is not asked again.
 */
async function displayName(args?: DisplayNameArgs): Promise<void> {
  if (args?.name !== undefined) {
    await acceptDisplayName(args.name);
    return;
  }
  const currentName = nameInForce();
  const reported =
    currentName === undefined
      ? 'Selvage: no display name is set, so the next host or join will ask for one.'
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
 */
async function acceptDisplayName(raw: string): Promise<void> {
  const name = withinBound(raw, 'name you gave');
  if (name === undefined) {
    return;
  }
  await config().update('displayName', name, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    current === undefined
      ? `Selvage: display name set to "${name}"; the next session will use it.`
      : `Selvage: display name set to "${name}"; this session keeps the name it started with, the change applies to the next host or join.`
  );
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
    void vscode.window.showWarningMessage('Selvage: host or join a session first.');
    return;
  }
  const participants = session.participants();
  if (participants.length === 0) {
    void vscode.window.showWarningMessage(
      'Selvage: no other participants to name; a session names them as they arrive.',
    );
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

/**
 * A setting when there is one, and a question when there is not. There is no default
 * server: a value baked into the extension would be an endpoint someone else chose.
 */
async function ask(
  key: string,
  title: string,
  placeHolder: string,
  fallback?: string,
): Promise<string | undefined> {
  const configured = config().get<string>(key, '');
  if (configured !== '') {
    return configured;
  }
  const answer = await vscode.window.showInputBox({
    title,
    prompt: `Set "selvage.${key}" to stop being asked.`,
    placeHolder,
    value: fallback ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'A value is needed to go on.' : undefined),
  });
  const trimmed = answer?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('selvage');
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
