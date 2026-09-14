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
  warnings: [],
  errors: [],
  quickPicks: [],
  inputs: [],
  /** The URI strings `workspace.openTextDocument` was asked for, in order. */
  opened: [],
  /** The URI strings `window.showTextDocument` was given, in order. */
  shown: [],
  informationReply: undefined,
  warningReply: undefined,
  quickPickReply: undefined,
  inputReply: undefined,
};

/** Clears everything a test observed, leaving registration and configuration in place. */
function reset() {
  registered.clipboard = '';
  registered.clipboardWrites.length = 0;
  registered.information.length = 0;
  registered.warnings.length = 0;
  registered.errors.length = 0;
  registered.quickPicks.length = 0;
  registered.inputs.length = 0;
  registered.opened.length = 0;
  registered.shown.length = 0;
  registered.informationReply = undefined;
  registered.warningReply = undefined;
  registered.quickPickReply = undefined;
  registered.inputReply = undefined;
}

function disposable() {
  return { dispose() {} };
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
    constructor(start, end) {
      this.start = start;
      this.end = end;
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
    textDocuments: [],
    getName: () => 'selvage-stub',
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    getWorkspaceFolder: () => undefined,
    asRelativePath: (uri) => String(uri),
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
    onDidOpenTextDocument: () => disposable(),
    onDidCloseTextDocument: () => disposable(),
    onDidChangeTextDocument: () => disposable(),
    onDidChangeConfiguration: () => disposable(),
  },

  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: () => ({
      text: '',
      tooltip: undefined,
      command: undefined,
      name: '',
      show() {},
      hide() {},
      dispose() {},
    }),
    createTextEditorDecorationType: () => disposable(),
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    onDidChangeVisibleTextEditors: () => disposable(),
    showTextDocument: (document) => {
      registered.shown.push(document.uri.toString());
      return Promise.resolve({ document });
    },
    showInformationMessage: (message, ...rest) => {
      registered.information.push(message);
      void rest;
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
