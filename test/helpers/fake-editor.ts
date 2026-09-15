/**
 * A stand-in for the editor half of the bridge, with the timing that matters.
 *
 * A change this adapter applies itself reports back as a change event after a few
 * macrotasks — which is how a coalesced editor event arrives after the call that caused it
 * returned — while a keystroke reports before its own call returns. That difference is the
 * whole of `SPIKES.md` spike 2, and modelling it is what makes the echo guard testable
 * without an editor.
 */

import type { EditorHost, Report, SessionBridge } from '../../src/bridge/bridge.ts';
import type { Cursor } from '../../src/bridge/cursors.ts';
import { applyChange as applyToText } from '../../src/bridge/editing.ts';
import type { LineEnding, TextChange } from '../../src/bridge/editing.ts';

export interface FakeDocument {
  text: string;
  eol: LineEnding;
}

export class FakeEditor implements EditorHost {
  readonly documents = new Map<string, FakeDocument>();
  /** The changes this editor was asked to apply, per path, in order. */
  readonly changes = new Map<string, TextChange[]>();
  readonly saves: string[] = [];
  readonly reports: Report[] = [];
  /** The last cursors drawn. */
  cursors: Cursor[] = [];
  /** Macrotasks between an applied change and its change event. */
  eventDelayTicks = 1;
  /** `false` models `workspace.applyEdit` answering `false` and leaving the buffer alone. */
  accepts = true;
  /**
   * `true` models an editor that reports an apply as landed while the buffer still holds what
   * it held before — the window between `applyEdit` resolving and the editor's own text
   * catching up, which is what a virtual document looks like while it materialises.
   */
  stallApply = false;
  /** `false` models `document.save()` resolving `false`: the write failed and the file is stale. */
  saveFails = false;
  /** Paths whose change this editor refused, for the reconcile-again path. */
  readonly refused: string[] = [];
  /**
   * The working copy a host reads a granted path from, and the paths it was asked for. A path
   * absent here is one this editor will not serve: a directory, a binary, one over the size a
   * session will carry, or one outside the folder this window shares.
   */
  readonly disk = new Map<string, string>();
  readonly reads: string[] = [];

  private bridge?: SessionBridge;

  attach(bridge: SessionBridge): void {
    this.bridge = bridge;
  }

  /** Opens a document, as `workspace.openTextDocument` does before the adapter is told. */
  open(path: string, text: string, eol: LineEnding = '\n'): void {
    this.documents.set(path, { text, eol });
    this.changes.set(path, []);
  }

  close(path: string): void {
    this.documents.delete(path);
  }

  /** A user's edit: the text changes and the change event is dispatched before returning. */
  type(path: string, text: string): void {
    const document = this.documents.get(path);
    if (document === undefined) {
      return;
    }
    document.text = text;
    this.bridge?.documentChanged(path);
  }

  text(path: string): string | undefined {
    return this.documents.get(path)?.text;
  }

  lineEnding(path: string): LineEnding {
    return this.documents.get(path)?.eol ?? '\n';
  }

  applyChange(path: string, change: TextChange): Promise<boolean> {
    const document = this.documents.get(path);
    if (document === undefined) {
      return Promise.resolve(false);
    }
    if (!this.accepts) {
      this.refused.push(path);
      return Promise.resolve(false);
    }
    if (this.stallApply) {
      return Promise.resolve(true);
    }
    document.text = applyToText(document.text, change);
    const applied = this.changes.get(path) ?? [];
    applied.push(change);
    this.changes.set(path, applied);
    this.notify(path);
    return Promise.resolve(true);
  }

  save(path: string): Promise<boolean> {
    this.saves.push(path);
    return Promise.resolve(!this.saveFails);
  }

  readGrantedFile(path: string): Promise<string | undefined> {
    this.reads.push(path);
    return Promise.resolve(this.disk.get(path));
  }

  renderCursors(cursors: Cursor[]): void {
    this.cursors = cursors;
  }

  report(report: Report): void {
    this.reports.push(report);
  }

  /** Every report of one kind, for assertions that do not care about the others. */
  reportsOf<K extends Report['kind']>(kind: K): Array<Extract<Report, { kind: K }>> {
    return this.reports.filter(
      (report): report is Extract<Report, { kind: K }> => report.kind === kind,
    );
  }

  /** Lets the queued change events land. */
  async settle(turns = 8): Promise<void> {
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private notify(path: string): void {
    const land = (left: number): void => {
      if (left <= 0) {
        this.bridge?.documentChanged(path);
        return;
      }
      setTimeout(() => {
        land(left - 1);
      }, 0);
    };
    land(this.eventDelayTicks);
  }
}

/**
 * An editor whose `applyEdit` is a macrotask behind the typing, as VS Code's is.
 *
 * The change is queued and lands when `pump` runs, and the change event fires before the
 * promise resolves — which is the ordering the bridge's serialisation is written against.
 * `FakeEditor` applies synchronously and models only the delayed echo.
 */
export class QueuedEditor implements EditorHost {
  readonly documents = new Map<string, FakeDocument>();
  readonly saves: string[] = [];
  readonly savedText: string[] = [];
  readonly reports: Report[] = [];
  readonly refused: string[] = [];
  cursors: Cursor[] = [];
  accepts = true;
  /** A working copy to read a requested path from, as `FakeEditor` has it. */
  readonly disk = new Map<string, string>();
  readonly reads: string[] = [];

  private queue: Array<() => void> = [];
  private bridge?: SessionBridge;

  attach(bridge: SessionBridge): void {
    this.bridge = bridge;
  }

  open(path: string, text: string, eol: LineEnding = '\n'): void {
    this.documents.set(path, { text, eol });
  }

  close(path: string): void {
    this.documents.delete(path);
  }

  /** A user's keystroke, dispatched before the queued apply runs. */
  type(path: string, text: string): void {
    const document = this.documents.get(path);
    if (document === undefined) {
      return;
    }
    document.text = text;
    this.bridge?.documentChanged(path);
  }

  text(path: string): string | undefined {
    return this.documents.get(path)?.text;
  }

  lineEnding(path: string): LineEnding {
    return this.documents.get(path)?.eol ?? '\n';
  }

  applyChange(path: string, change: TextChange): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue.push(() => {
        const document = this.documents.get(path);
        if (!this.accepts || document === undefined) {
          this.refused.push(path);
          resolve(false);
          return;
        }
        document.text = applyToText(document.text, change);
        this.bridge?.documentChanged(path);
        resolve(true);
      });
    });
  }

  /** Lands the queued applies, in order, as the editor host applies them. */
  pump(): void {
    const queued = this.queue;
    this.queue = [];
    for (const run of queued) {
      run();
    }
  }

  save(path: string): Promise<boolean> {
    this.saves.push(path);
    this.savedText.push(this.text(path) ?? '<closed>');
    return Promise.resolve(true);
  }

  readGrantedFile(path: string): Promise<string | undefined> {
    this.reads.push(path);
    return Promise.resolve(this.disk.get(path));
  }

  renderCursors(cursors: Cursor[]): void {
    this.cursors = cursors;
  }

  report(report: Report): void {
    this.reports.push(report);
  }

  /** Every report of one kind, for assertions that do not care about the others. */
  reportsOf<K extends Report['kind']>(kind: K): Array<Extract<Report, { kind: K }>> {
    return this.reports.filter(
      (report): report is Extract<Report, { kind: K }> => report.kind === kind,
    );
  }
}
