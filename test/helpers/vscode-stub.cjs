/**
 * A stand-in for the `vscode` module: enough of it to activate the built extension in a
 * plain Node process, and a record of what the extension registered while it did.
 *
 * It is a `.cjs` file because the bundle requires it as CommonJS, and it deliberately
 * implements the four calls `activate` makes and nothing else — anything the adapter
 * reaches for that is not here fails loudly, which is the point.
 */

const registered = { commands: [], schemes: [] };

function disposable() {
  return { dispose() {} };
}

module.exports = {
  /** What the extension registered, for the test that compares it with the manifest. */
  registered,

  EventEmitter: class {
    constructor() {
      this.event = () => disposable();
    }

    dispose() {}
  },

  StatusBarAlignment: { Left: 1, Right: 2 },

  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },

  FileSystemError: {
    NoPermissions: (uri) => new Error(`no permissions: ${String(uri)}`),
    FileNotFound: (uri) => new Error(`not found: ${String(uri)}`),
  },

  commands: {
    registerCommand(id) {
      registered.commands.push(id);
      return disposable();
    },
    executeCommand() {
      return Promise.resolve(undefined);
    },
  },

  workspace: {
    textDocuments: [],
    getName: () => 'selvage-stub',
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    getWorkspaceFolder: () => undefined,
    asRelativePath: (uri) => String(uri),
    registerFileSystemProvider(scheme) {
      registered.schemes.push(scheme);
      return disposable();
    },
    onDidOpenTextDocument: () => disposable(),
    onDidCloseTextDocument: () => disposable(),
    onDidChangeTextDocument: () => disposable(),
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
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    onDidChangeVisibleTextEditors: () => disposable(),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve({}),
  },

  Uri: { parse: (value) => ({ toString: () => value }) },

  env: { clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() } },
};
