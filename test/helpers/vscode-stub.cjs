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
  /** Every `executeCommand` call, as `{ id, args }`, handled or not. */
  executed: [],
  /** The handler each `registerCommand` was given, so `executeCommand` can run it. */
  handlers: new Map(),
  /** What the clipboard holds, as the extension last left it. */
  clipboard: '',
  clipboardWrites: [],
  /** Every clipboard read, in order: joining must leave this empty (see `commands.test.ts`). */
  clipboardReads: [],
  information: [],
  /** The buttons each information message offered, in order, beside `information`. */
  informationItems: [],
  warnings: [],
  errors: [],
  quickPicks: [],
  /** Every progress notice the extension showed, in order: a fetch in flight names its path. */
  progress: [],
  inputs: [],
  /** Every configuration write: `{ key, value, target }`, in order. */
  settingWrites: [],
  /** `true` models a settings file the editor will not write — one a config manager owns. */
  settingWriteFails: false,
  /** The URI strings `workspace.openTextDocument` was asked for, in order. */
  opened: [],
  /** The URI strings `window.showTextDocument` was given, in order. */
  shown: [],
  /** Every editor `showTextDocument` answered with, in order. */
  shownEditors: [],
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
  /**
   * How the editor answers `workspace.applyEdit`. The default applies nothing and answers
   * `true`; a test that needs an editor which refuses a change — a document whose version moved
   * under the range — replaces it, and one that needs the change to land applies the edit's own
   * ranges to its document stand-in. That is what a `WorkspaceEdit` records. See
   * `test/documents.test.ts`.
   */
  applyEditImpl: () => Promise.resolve(true),
  /** Every file system watcher the extension created, with the pattern each was given. */
  watchers: [],
  /**
   * When set, `createFileSystemWatcher` throws with this message: a window whose editor cannot
   * watch the folder it shares.
   */
  watcherFailure: undefined,
  /** Every `workspace.updateWorkspaceFolders` call, as `{ start, deleteCount, added }`. */
  folderCalls: [],
  /**
   * How the editor answers `workspace.updateWorkspaceFolders`. `false` is the API's silent
   * refusal: the call reports nothing and changes nothing, so the client reads the folders
   * back rather than trusting the answer.
   */
  updateFoldersReturn: true,
  /** When set, `vscode.openFolder` rejects with this message (see bundle.ts). */
  openFolderThrows: undefined,
  /** Every `tabGroups.close` call, as the tabs it was given, in order. */
  closedTabs: [],
  /** Every `workspace.fs.readDirectory` call, so a test can see the listing was walked again. */
  listings: 0,
  /** Every `registerTreeDataProvider` call, as `{ viewId, provider }`, in order. */
  treeDataProviders: [],
  /** Every `registerFileDecorationProvider` call, in order. */
  fileDecorationProviders: [],
  /**
   * Holds a directory read, as `(path, index) => Promise`: the read is answered when the promise
   * resolves. A real walk is slow in a large tree and faster in a small one, so a test that needs
   * two walks to overlap holds the first read of one. `index` is the read's position among all
   * reads since `reset`.
   */
  readHold: undefined,
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

/** Takes a file out of the working copy, as deleting it from the project does. */
function remove(path) {
  disk.files.delete(diskPath(path));
}

/**
 * A stand-in for `workspace.createFileSystemWatcher`, as the extension creates one per folder
 * it shares. The watcher it returns records its listeners, so a test can fire a file system
 * event the way the editor's own watcher does and see whether it was still live: a disposed
 * watcher delivers nothing, as the editor's does not. Each watcher is kept in
 * `registered.watchers`, with the pattern it was given.
 */

/** How many watchers this window may still create before `watcherFailure` starts applying. */
let watcherBudget = 0;

function createFileSystemWatcher(
  pattern,
  ignoreCreateEvents,
  ignoreChangeEvents,
  ignoreDeleteEvents,
) {
  if (registered.watcherFailure !== undefined && watcherBudget <= 0) {
    throw new Error(registered.watcherFailure);
  }
  watcherBudget -= 1;
  const watcher = {
    pattern,
    /** What the extension asked not to hear, so a test can see what it did not subscribe to. */
    ignored: {
      create: ignoreCreateEvents === true,
      change: ignoreChangeEvents === true,
      delete: ignoreDeleteEvents === true,
    },
    disposed: false,
    listeners: new Map(),
  };
  registered.watchers.push(watcher);
  const on = (kind) => (listener) => {
    const list = watcher.listeners.get(kind) ?? [];
    list.push(listener);
    watcher.listeners.set(kind, list);
    return {
      dispose() {
        watcher.listeners.set(
          kind,
          (watcher.listeners.get(kind) ?? []).filter((one) => one !== listener),
        );
      },
    };
  };
  return {
    onDidCreate: on('create'),
    onDidChange: on('change'),
    onDidDelete: on('delete'),
    dispose() {
      watcher.disposed = true;
      watcher.listeners.clear();
    },
  };
}

/** Fires a file system event on every live watcher, as an editor's own watcher arrives. */
function watchEvent(kind, path) {
  const uri = parseUri(`file://${diskPath(path)}`);
  for (const watcher of registered.watchers) {
    if (watcher.disposed) {
      continue;
    }
    for (const listener of watcher.listeners.get(kind) ?? []) {
      listener(uri);
    }
  }
}

/**
 * Makes every watcher the extension creates from here on throw, as an unwatchable folder does.
 * `after` is how many it may create first: a multi-folder session whose second folder fails is
 * the half-watched shape a test needs.
 */
function refuseWatchers(reason, after = 0) {
  registered.watcherFailure = reason ?? 'cannot watch this folder';
  watcherBudget = after;
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
 * The `globalState` memento, as the extension's activation context carries it: memory the
 * windows share, so a test can watch one window remember for the next. `reset` clears it,
 * which is the one way this stand-in differs from the editor's own — nothing here may rely
 * on a value surviving a reset except the test that deliberately avoids one.
 */
const memento = new Map();
const globalState = {
  get(key, fallback) {
    return memento.has(key) ? memento.get(key) : fallback;
  },
  update(key, value) {
    memento.set(key, value);
    return Promise.resolve();
  },
  setKeysForSync() {},
};

/**
 * Clears everything a test observed and every setting it wrote, leaving registration in place.
 * A test starts from a window configured with nothing, which is the state the settings are
 * documented against; one that needs a configured value writes it itself.
 */
function reset() {
  registered.executed.length = 0;
  registered.clipboard = '';
  registered.clipboardWrites.length = 0;
  registered.clipboardReads.length = 0;
  registered.information.length = 0;
  registered.informationItems.length = 0;
  registered.warnings.length = 0;
  registered.errors.length = 0;
  registered.quickPicks.length = 0;
  registered.progress.length = 0;
  registered.inputs.length = 0;
  registered.settingWrites.length = 0;
  registered.settingWriteFails = false;
  registered.opened.length = 0;
  registered.shown.length = 0;
  registered.shownEditors.length = 0;
  registered.textDocuments.length = 0;
  registered.decorations.length = 0;
  registered.statusBarItems.length = 0;
  registered.folderCalls.length = 0;
  registered.updateFoldersReturn = true;
  registered.openFolderThrows = undefined;
  registered.closedTabs.length = 0;
  tabGroups.all.length = 0;
  disk.files.clear();
  disk.links.clear();
  disk.unreadable.clear();
  disk.reads.length = 0;
  registered.watchers.length = 0;
  registered.watcherFailure = undefined;
  watcherBudget = 0;
  registered.treeDataProviders.length = 0;
  registered.fileDecorationProviders.length = 0;
  registered.listings = 0;
  registered.readHold = undefined;
  folders.length = 0;
  folders.push({ uri: parseUri(WORKSPACE_FOLDER), name: 'workspace', index: 0 });
  registered.informationReply = undefined;
  registered.warningReply = undefined;
  registered.quickPickReply = undefined;
  registered.inputReply = undefined;
  configured.clear();
  memento.clear();
  registered.applyEditImpl = () => Promise.resolve(true);
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

/**
 * The window's tab groups, as leaving a room finds them: the room's tabs are closed by
 * the client itself, because removing the folder leaves them open on files nobody owns.
 * One group is enough to stage that: a test seeds its tabs the way a session leaves them.
 */
const tabGroups = {
  /** The groups the window has open, each with the tabs it holds. */
  all: [],
  /** Closes tabs, recording what was closed. */
  close(tabs) {
    registered.closedTabs.push([...tabs]);
    for (const group of tabGroups.all) {
      group.tabs = group.tabs.filter((tab) => !tabs.includes(tab));
    }
    return Promise.resolve(true);
  },
};

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
function decodedPath(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseUri(value) {
  const text = String(value);
  const withoutFragment = text.split('#')[0];
  const colon = withoutFragment.indexOf(':');
  const scheme = colon === -1 ? '' : withoutFragment.slice(0, colon);
  const rest = colon === -1 ? withoutFragment : withoutFragment.slice(colon + 1);
  const question = rest.indexOf('?');
  const rawPath = question === -1 ? rest : rest.slice(0, question);
  const path = decodedPath(rawPath);
  return {
    scheme,
    path,
    /** The platform path: the decoded path under one leading slash, as `Uri.file` reads. */
    fsPath: `/${path.replace(/^\/+/, '')}`,
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
      // A `file:` document the working copy does not hold: the mirror lives on the real
      // filesystem, which this stand-in cannot read, so it opens empty and the room's
      // text arrives through the hold the open takes.
      return '';
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
  /** The `globalState` memento, for a test that activates with its own context. */
  globalState,
  configure,
  /** Seeds the window's working copy, as a folder a host opens a session on. */
  put,
  putLink,
  makeUnreadable,
  /** Deletes a file from the working copy, as removing it from the project does. */
  remove,
  /** Fires a file system event on every live watcher, as an editor's own watcher arrives. */
  watchEvent,
  /** Makes every watcher the extension creates throw, as an unwatchable folder does. */
  refuseWatchers,
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

  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },

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

  Selection: class {
    constructor(anchor, active) {
      this.anchor = anchor;
      this.active = active;
    }
  },

  TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },

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
    constructor() {
      /** Every edit, in the order it was added: what an `applyEdit` implementation applies. */
      this.edits = [];
    }

    replace(uri, range, text) {
      this.edits.push({ kind: 'replace', uri, range, text });
    }

    insert(uri, position, text) {
      this.edits.push({ kind: 'insert', uri, position, text });
    }
  },

  commands: {
    registerCommand(id, handler) {
      registered.commands.push(id);
      registered.handlers.set(id, handler);
      return disposable();
    },
    executeCommand(id, ...args) {
      // Every command call, handled or not: the reload a join stages is one the stub
      // has no handler for, and the call order is what the test asserts.
      registered.executed.push({ id, args });
      if (id === 'vscode.openFolder' && registered.openFolderThrows !== undefined) {
        return Promise.reject(new Error(registered.openFolderThrows));
      }
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
        const index = registered.listings;
        registered.listings += 1;
        if (disk.unreadable.has(resolved(path))) {
          return Promise.reject(new Error(`cannot read ${path}`));
        }
        // The listing is taken now and the answer withheld until the test says otherwise, so one
        // walk can be made to outlast the walk a later event starts.
        const entries = entriesOf(path);
        const held = registered.readHold === undefined ? undefined : registered.readHold(path, index);
        return held === undefined ? Promise.resolve(entries) : held.then(() => entries);
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
    applyEdit: (edit) => registered.applyEditImpl(edit),
    createFileSystemWatcher,
    /**
     * Adds or removes workspace folders, as establishing or leaving the room's folder
     * does. An add to a window with no folder answers `true` and changes nothing — the
     * empty-window shape only `openFolder` reaches — so joining one reloads instead.
     */
    updateWorkspaceFolders(start, deleteCount, ...added) {
      registered.folderCalls.push({
        start,
        deleteCount,
        added: added.map((folder) => folder.uri.toString()),
      });
      if (registered.updateFoldersReturn === false) {
        return false;
      }
      if (folders.length === 0 && (deleteCount ?? 0) === 0) {
        return true;
      }
      folders.splice(
        start,
        deleteCount ?? 0,
        ...added.map((folder) => ({ uri: folder.uri, name: folder.name, index: 0 })),
      );
      folders.forEach((folder, index) => {
        folder.index = index;
      });
      return true;
    },
    onDidOpenTextDocument: event('openTextDocument'),
    onDidCloseTextDocument: event('closeTextDocument'),
    onDidChangeTextDocument: event('changeTextDocument'),
    onDidSaveTextDocument: event('saveTextDocument'),
    onDidChangeWorkspaceFolders: event('workspaceFolders'),
    onDidChangeConfiguration: event('configuration'),
  },

  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups,
    /** Records the view; a test reads its rows back through the provider it kept. */
    registerTreeDataProvider(viewId, provider) {
      registered.treeDataProviders.push({ viewId, provider });
      return disposable();
    },
    /** Records the badge provider; a test asks it what a file wears. */
    registerFileDecorationProvider(provider) {
      registered.fileDecorationProviders.push(provider);
      return disposable();
    },
    createStatusBarItem: () => {
      const item = {
        text: '',
        tooltip: undefined,
        command: undefined,
        name: '',
        disposed: false,
        show() {},
        hide() {},
        dispose() {
          item.disposed = true;
        },
      };
      registered.statusBarItems.push(item);
      return item;
    },
    createTextEditorDecorationType: (options) => {
      const handle = disposable();
      handle.options = options;
      handle.disposed = false;
      const originalDispose = handle.dispose;
      handle.dispose = () => {
        handle.disposed = true;
        originalDispose();
      };
      registered.decorations.push({ options, handle });
      return handle;
    },
    onDidChangeTextEditorSelection: event('selection'),
    onDidChangeActiveTextEditor: event('activeEditor'),
    onDidChangeVisibleTextEditors: event('visibleEditors'),
    showTextDocument: (document, options) => {
      registered.shown.push(document.uri.toString());
      // The editor the call lands in: what the extension moves and reveals, and what a test
      // reads the landing back from. Left inactive, as the stub never is the editor: a test
      // seats `activeTextEditor` itself, the way the passing suites already do.
      const editor = {
        document,
        selection: options?.selection,
        revealed: [],
        revealRange(range, kind) {
          this.revealed.push({ range, kind });
        },
        setDecorations: () => undefined,
      };
      registered.shownEditors.push(editor);
      return Promise.resolve(editor);
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
    withProgress: (options, task) => {
      registered.progress.push(options);
      return Promise.resolve().then(() =>
        task({ report() {} }, { isCancellationRequested: false }),
      );
    },
  },

  MarkdownString: class {
    constructor(value = "") {
      this.value = String(value);
    }
    appendText(value) {
      this.value += String(value).replace(/([\\\`*{}\[\]()#+\-.!])/g, '\\$1');
      return this;
    }
    appendMarkdown(value) {
      this.value += String(value);
      return this;
    }
  },

  Uri: {
    parse: parseUri,
    file: (value) => parseUri(`file://${value}`),
    joinPath,
  },

  /**
   * A pattern relative to a folder. Both halves are kept as they were given, which is what a
   * test asserts the watch covers.
   */
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },

  env: {
    /** The window's own id, as the extension names the mirror's provenance with it. */
    sessionId: 'stub-session-id',
    clipboard: {
      readText: () => {
        registered.clipboardReads.push(registered.clipboard);
        return Promise.resolve(registered.clipboard);
      },
      writeText: (value) => {
        registered.clipboard = value;
        registered.clipboardWrites.push(value);
        return Promise.resolve();
      },
    },
  },
};
