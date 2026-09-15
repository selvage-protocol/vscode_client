/**
 * A stand-in for the `vscode` module: enough of it to activate the built extension in a
 * plain Node process, and a record of what the extension did with it.
 *
 * It is a `.cjs` file because the bundle requires it as CommonJS. `activate` registers the
 * commands and the guest file system, and a test can then *run* a command through
 * `commands.executeCommand` — which is how the command flows are exercised without an
 * editor. Recording the clipboard, the messages and the editors a command produced is what
 * lets a test see the effect of a command that resolves before its own work is done.
 */

const registered = {
  commands: [],
  schemes: [],
  files: undefined,
  /** The handler each `registerCommand` was given, so `executeCommand` can run it. */
  handlers: new Map(),
  /** What the clipboard holds, as the extension last left it. */
  clipboard: '',
  clipboardWrites: [],
  information: [],
  /** The buttons each information message offered, in order, beside `information`. */
  informationItems: [],
  warnings: [],
  errors: [],
  quickPicks: [],
  inputs: [],
  /** Every configuration write: `{ key, value, target }`, in order. */
  settingWrites: [],
  /** `true` models a settings file the editor will not write — one a config manager owns. */
  settingWriteFails: false,
  /** The URI strings `workspace.openTextDocument` was asked for, in order. */
  opened: [],
  /** The URI strings `window.showTextDocument` was given, in order. */
  shown: [],
  /** Every `createTextEditorDecorationType` call: `{ options }`, in order. */
  decorations: [],
  /** Every status bar item the extension created, as the object it kept drawing into. */
  statusBarItems: [],
  informationReply: undefined,
  warningReply: undefined,
  quickPickReply: undefined,
  inputReply: undefined,
  /** The window's open documents, as a test seeded them before the session started. */
  textDocuments: [],
};

/** The one folder the stub says every `file:` document belongs to; a host shares under it. */
const WORKSPACE_FOLDER = 'file:///workspace';

/** The settings a window has been configured with, as `get` and `update` see them. */
const configured = new Map();

/**
 * Clears everything a test observed and every setting it wrote, leaving registration in place.
 * A test starts from a window configured with nothing, which is the state the settings are
 * documented against; one that needs a configured value writes it itself.
 */
function reset() {
  registered.clipboard = '';
  registered.clipboardWrites.length = 0;
  registered.information.length = 0;
  registered.informationItems.length = 0;
  registered.warnings.length = 0;
  registered.errors.length = 0;
  registered.quickPicks.length = 0;
  registered.inputs.length = 0;
  registered.settingWrites.length = 0;
  registered.settingWriteFails = false;
  registered.opened.length = 0;
  registered.shown.length = 0;
  registered.textDocuments.length = 0;
  registered.decorations.length = 0;
  registered.statusBarItems.length = 0;
  registered.informationReply = undefined;
  registered.warningReply = undefined;
  registered.quickPickReply = undefined;
  registered.inputReply = undefined;
  configured.clear();
}

function disposable() {
  return { dispose() {} };
}

/**
 * The listener each `onDid…` registered, so a test can fire an editor event the way VS Code
 * would. One listener per event is enough: the extension registers one of each. Unlike the
 * rest of `registered`, `reset` leaves this alone — listeners are registered when a session is
 * built, which is after a test's own `reset`.
 */
const listeners = new Map();

function event(name) {
  return (handler) => {
    listeners.set(name, handler);
    return disposable();
  };
}

/** Runs the listener registered for `name`, as an editor event landing would. */
function fire(name, ...args) {
  const handler = listeners.get(name);
  if (handler !== undefined) {
    handler(...args);
  }
}

/** Seeds a setting the way a hand-edited `settings.json` would, before `activate` runs. */
function configure(values) {
  for (const [key, value] of Object.entries(values)) {
    configured.set(key, value);
  }
}

/** The URI components an editor hands to a provider, parsed from a URI string. */
function parseUri(value) {
  const text = String(value);
  const withoutFragment = text.split('#')[0];
  const colon = withoutFragment.indexOf(':');
  const scheme = colon === -1 ? '' : withoutFragment.slice(0, colon);
  const rest = colon === -1 ? withoutFragment : withoutFragment.slice(colon + 1);
  const question = rest.indexOf('?');
  return {
    scheme,
    path: question === -1 ? rest : rest.slice(0, question),
    query: question === -1 ? '' : rest.slice(question + 1),
    toString: () => text,
  };
}

/** A read-only document stand-in: its text is whatever the guest provider serves. */
function documentFor(uri) {
  return {
    uri,
    eol: 1,
    isDirty: false,
    getText: () => {
      try {
        return new TextDecoder().decode(registered.files.readFile(uri));
      } catch {
        return '';
      }
    },
    positionAt: (offset) => offset,
    offsetAt: (position) => position,
    save: () => Promise.resolve(true),
  };
}

module.exports = {
  /** What the extension registered and did, for the tests that look. */
  registered,
  reset,
  configure,
  /**
   * Puts a `file:` document in the window, as VS Code would have it open when a session starts.
   * A host shares its own files, so a test that wants to reach that path seeds one here.
   */
  openWorkspaceDocument(uriString) {
    const document = documentFor(parseUri(uriString));
    registered.textDocuments.push(document);
    return document;
  },
  /** Fires an editor event the extension subscribed to: `fire('visibleEditors')`. */
  fire,

  EventEmitter: class {
    constructor() {
      this.event = () => disposable();
    }

    dispose() {}
  },

  Disposable: class {
    constructor(callOnDispose) {
      this.dispose = typeof callOnDispose === 'function' ? callOnDispose : () => {};
    }
  },

  StatusBarAlignment: { Left: 1, Right: 2 },

  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },

  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },

  EndOfLine: { LF: 1, CRLF: 2 },

  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },

  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },

  FileSystemError: {
    NoPermissions: (uri) => new Error(`no permissions: ${String(uri)}`),
    FileNotFound: (uri) => new Error(`not found: ${String(uri)}`),
  },

  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },

  Range: class {
    constructor(startOrLine, startCharacter, endLine, endCharacter) {
      // The real `Range` has both shapes: `(start, end)` positions and `(line, char, line,
      // char)`. The glyph-margin badge uses the second, so the stub answers both.
      if (typeof startOrLine === 'number') {
        this.start = { line: startOrLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      } else {
        this.start = startOrLine;
        this.end = startCharacter;
      }
    }
  },

  WorkspaceEdit: class {
    replace() {}

    insert() {}
  },

  commands: {
    registerCommand(id, handler) {
      registered.commands.push(id);
      registered.handlers.set(id, handler);
      return disposable();
    },
    executeCommand(id, ...args) {
      const handler = registered.handlers.get(id);
      return Promise.resolve(handler === undefined ? undefined : handler(...args));
    },
  },

  workspace: {
    get textDocuments() {
      return registered.textDocuments;
    },
    getName: () => 'selvage-stub',
    getConfiguration: () => ({
      get: (key, fallback) => (configured.has(key) ? configured.get(key) : fallback),
      update: (key, value, target) => {
        if (registered.settingWriteFails) {
          return Promise.reject(new Error('the settings file is read-only'));
        }
        configured.set(key, value);
        registered.settingWrites.push({ key, value, target });
        // VS Code fires `onDidChangeConfiguration` for a write, and the display-name
        // command routes its rename through that listener, so the stub models it.
        fire('configuration', {
          affectsConfiguration: (section) => section === 'selvage' || section === `selvage.${key}`,
        });
        return Promise.resolve();
      },
    }),
    getWorkspaceFolder: (uri) =>
      String(uri).startsWith('file:')
        ? { uri: parseUri(WORKSPACE_FOLDER), name: 'workspace', index: 0 }
        : undefined,
    asRelativePath: (uri) => {
      const text = String(uri);
      const prefix = `${WORKSPACE_FOLDER}/`;
      return text.startsWith(prefix) ? text.slice(prefix.length) : text;
    },
    openTextDocument(uri) {
      registered.opened.push(uri.toString());
      return Promise.resolve(documentFor(uri));
    },
    applyEdit: () => Promise.resolve(true),
    registerFileSystemProvider(scheme, provider) {
      registered.schemes.push(scheme);
      registered.files = provider;
      return disposable();
    },
    onDidOpenTextDocument: event('openTextDocument'),
    onDidCloseTextDocument: event('closeTextDocument'),
    onDidChangeTextDocument: event('changeTextDocument'),
    onDidChangeConfiguration: event('configuration'),
  },

  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: () => {
      const item = {
        text: '',
        tooltip: undefined,
        command: undefined,
        name: '',
        show() {},
        hide() {},
        dispose() {},
      };
      registered.statusBarItems.push(item);
      return item;
    },
    createTextEditorDecorationType: (options) => {
      const handle = disposable();
      handle.options = options;
      registered.decorations.push({ options, handle });
      return handle;
    },
    onDidChangeTextEditorSelection: event('selection'),
    onDidChangeActiveTextEditor: event('activeEditor'),
    onDidChangeVisibleTextEditors: event('visibleEditors'),
    showTextDocument: (document) => {
      registered.shown.push(document.uri.toString());
      return Promise.resolve({ document });
    },
    showInformationMessage: (message, ...rest) => {
      registered.information.push(message);
      registered.informationItems.push(rest);
      return Promise.resolve(registered.informationReply);
    },
    showWarningMessage: (message, ...rest) => {
      registered.warnings.push(message);
      void rest;
      return Promise.resolve(registered.warningReply);
    },
    showErrorMessage: (message) => {
      registered.errors.push(message);
      return Promise.resolve(undefined);
    },
    showQuickPick: (items, options) => {
      registered.quickPicks.push({ items, options });
      return Promise.resolve(registered.quickPickReply);
    },
    showInputBox: (options) => {
      registered.inputs.push(options);
      return Promise.resolve(registered.inputReply);
    },
  },

  Uri: {
    parse: parseUri,
    file: (value) => parseUri(`file://${value}`),
  },

  env: {
    clipboard: {
      readText: () => Promise.resolve(registered.clipboard),
      writeText: (value) => {
        registered.clipboard = value;
        registered.clipboardWrites.push(value);
        return Promise.resolve();
      },
    },
  },
};
