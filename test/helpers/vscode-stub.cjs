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
  /** Every tree view the extension created, with the provider it was given. */
  treeViews: [],
  informationReply: undefined,
  warningReply: undefined,
  quickPickReply: undefined,
  inputReply: undefined,
  /** The window's open documents, as a test seeded them before the session started. */
  textDocuments: [],
};

/**
 * The one folder the stub says every `file:` document belongs to; a host shares under it, and
 * a session captures it at invite time.
 */
const WORKSPACE_FOLDER = 'file:///workspace';
const FOLDER = { uri: parseUri(WORKSPACE_FOLDER), name: 'workspace', index: 0, toString: () => WORKSPACE_FOLDER };

/**
 * A stand-in for `vscode.workspace.fs`: a working copy a test seeds, as a host's folder is. A
 * directory exists because a file is inside it, which is also how a listing carries one.
 */
const disk = {
  /** `path` → `{ bytes, size }`; `size` is settable so a file can be declared larger. */
  files: new Map(),
  /** `path` → `{ type, target }` for a symbolic link: `target` is the directory it names, when
   * it has one. A link reports its own type, and a path *through* it reaches the target. */
  links: new Map(),
  /** Directories whose `readDirectory` throws, for the unreadable-tree path. */
  unreadable: new Set(),
  /** `readFile` calls, in order. */
  reads: [],
};

function pathOf(uri) {
  return String(uri).replace(/^file:\/\//, '');
}

function joinPath(base, ...parts) {
  // Joined on the URI's path, not on its string form: `file:///workspace` and `/workspace`
  // have to name the same place, as the real `Uri.joinPath` has it. The stub's own URI keeps
  // the authority's slashes, so they are normalised away here rather than left in the path.
  const basePath = `/${parseUri(base).path.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  const path = [basePath, ...parts.map((part) => String(part).replace(/^\/+/, ''))].join('/');
  return parseUri(`file://${path}`);
}

/** A seeded path is relative to the window's folder unless it is written as an absolute one. */
function diskPath(path) {
  const text = String(path);
  return text.startsWith('/') ? text : `/workspace/${text}`;
}

/** Puts a file in the working copy. `content` is a string or the bytes themselves. */
function put(path, content, options = {}) {
  const bytes =
    typeof content === 'string' ? new TextEncoder().encode(content) : content;
  disk.files.set(diskPath(path), {
    bytes,
    size: options.size ?? bytes.length,
  });
}

/**
 * Puts a symbolic link in the working copy: `kind` is `'file'` or `'directory'`. A link with a
 * `target` names a file or directory elsewhere — outside the folder, in the cases that matter —
 * and a path through it reaches what it names, as the editor's own file system follows a link.
 */
function putLink(path, kind, target) {
  disk.links.set(diskPath(path), {
    type: kind === 'directory' ? 70 : 65,
    target: target === undefined ? undefined : diskPath(target),
  });
}

/**
 * `path` after following every symbolic link along it, as a `readFile` or a `readDirectory`
 * through a link does — the nested-prefix case included. The hop bound only stops a link chain
 * that names itself; a link into a link resolves.
 */
function resolved(path) {
  let current = path;
  for (let hop = 0; hop < 8; hop += 1) {
    const candidates = [...disk.links.entries()].filter(
      ([at, link]) => link.target !== undefined && (current === at || current.startsWith(`${at}/`)),
    );
    if (candidates.length === 0) {
      return current;
    }
    // The longest matching link is the innermost one, which is the one a real file system
    // resolves first.
    const [at, link] = candidates.sort(([left], [right]) => right.length - left.length)[0];
    current = `${link.target}${current.slice(at.length)}`;
  }
  return current;
}

/** A directory whose listing the editor refuses, as an unreadable folder is. */
function makeUnreadable(path) {
  disk.unreadable.add(diskPath(path));
}

/** Every file and link in the working copy, keyed by path, with the type it reports. */
function allEntries() {
  const all = new Map();
  for (const path of disk.files.keys()) {
    all.set(path, 1);
  }
  for (const [path, link] of disk.links) {
    all.set(path, link.type);
  }
  return all;
}

/** The immediate children of a directory, from the files and links under it. */
function entriesOf(directory) {
  const real = resolved(directory);
  const prefix = real === '/' ? '/' : `${real}/`;
  const found = new Map();
  for (const [path, type] of allEntries()) {
    if (!path.startsWith(prefix) || path === real) {
      continue;
    }
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      found.set(rest, type);
    } else if (!found.has(rest.slice(0, slash))) {
      found.set(rest.slice(0, slash), 2);
    }
  }
  return [...found.entries()];
}

/** True when some file or link is inside this directory. */
function isDirectory(path) {
  const real = resolved(path);
  const prefix = real === '/' ? '/' : `${real}/`;
  return [...allEntries().keys()].some((entry) => entry.startsWith(prefix));
}

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
  disk.files.clear();
  disk.links.clear();
  disk.unreadable.clear();
  disk.reads.length = 0;
  folders.length = 0;
  folders.push({ uri: parseUri(WORKSPACE_FOLDER), name: 'workspace', index: 0 });
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

/** The folders the window is opened on; a session captures these at invite time. */
const folders = [{ uri: parseUri(WORKSPACE_FOLDER), name: 'workspace', index: 0 }];

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
      // A `file:` document is the host's own working copy, which is the disk a test seeded.
      if (uri.scheme === 'file') {
        const file = disk.files.get(pathOf(uri));
        if (file !== undefined) {
          return new TextDecoder().decode(file.bytes);
        }
      }
      try {
        const bytes = registered.files.readFile(uri);
        // A read that has to ask the room answers with a promise; a document stand-in cannot
        // hold a promise as text, and reads again when it settles.
        return bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : '';
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
  /** Seeds the window's working copy, as a folder a host opens a session on. */
  put,
  putLink,
  makeUnreadable,
  /** Replaces the folders the window is open on, as adding one mid-session would. */
  setWorkspaceFolders(paths) {
    folders.length = 0;
    paths.forEach((path, index) => {
      const text = path.startsWith('file://') ? path : `file://${path}`;
      const name = String(path).replace(/\/+$/, '').split('/').pop();
      folders.push({ uri: parseUri(text), name, index });
    });
  },
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
      this.listeners = [];
      this.event = (handler) => {
        this.listeners.push(handler);
        return disposable();
      };
    }

    /** Fires the event, as the extension asking a view to redraw does. */
    fire(value) {
      for (const handler of [...this.listeners]) {
        handler(value);
      }
    }

    dispose() {
      this.listeners.length = 0;
    }
  },

  Disposable: class {
    constructor(callOnDispose) {
      this.dispose = typeof callOnDispose === 'function' ? callOnDispose : () => {};
    }
  },

  StatusBarAlignment: { Left: 1, Right: 2 },

  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },

  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },

  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },

  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },

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
    /** The folders the window is opened on; a test can replace them mid-session. */
    get workspaceFolders() {
      return folders.length === 0 ? undefined : [...folders];
    },
    getName: () => 'selvage-stub',
    /** A working copy for a host to enumerate and read: only what the adapter uses. */
    fs: {
      readDirectory: (uri) => {
        const path = pathOf(uri);
        if (disk.unreadable.has(resolved(path))) {
          return Promise.reject(new Error(`cannot read ${path}`));
        }
        return Promise.resolve(entriesOf(path));
      },
      stat: (uri) => {
        const path = pathOf(uri);
        // A link reports the link: the final component of a stat is not followed, which is how
        // a host sees that what a peer named is a link at all. Everything before it is.
        const link = disk.links.get(path);
        if (link !== undefined) {
          return Promise.resolve({ type: link.type, ctime: 0, mtime: 0, size: 0 });
        }
        const file = disk.files.get(resolved(path));
        if (file !== undefined) {
          return Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: file.size });
        }
        if (isDirectory(path)) {
          return Promise.resolve({ type: 2, ctime: 0, mtime: 0, size: 0 });
        }
        return Promise.reject(new Error(`not found: ${path}`));
      },
      readFile: (uri) => {
        const path = pathOf(uri);
        disk.reads.push(path);
        const file = disk.files.get(resolved(path));
        if (file === undefined) {
          return Promise.reject(new Error(`not found: ${path}`));
        }
        return Promise.resolve(file.bytes);
      },
    },
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
    /** A tree view, with the provider the extension registered for it. */
    createTreeView: (id, options) => {
      // One view per id, as the editor has: activating again replaces it rather than adding a
      // second, which is what makes the recorded view the one a session is bound to.
      const existing = registered.treeViews.findIndex((entry) => entry.id === id);
      const entry = { id, options };
      if (existing === -1) {
        registered.treeViews.push(entry);
      } else {
        registered.treeViews[existing] = entry;
      }
      return {
        title: undefined,
        message: undefined,
        dispose() {},
      };
    },
  },

  Uri: {
    parse: parseUri,
    file: (value) => parseUri(`file://${value}`),
    joinPath,
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
