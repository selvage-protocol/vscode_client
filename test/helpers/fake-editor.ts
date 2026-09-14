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
  /** Paths whose change this editor refused, for the reconcile-again path. */
  readonly refused: string[] = [];

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

  applyChange(path: string, change: TextChange): void {
    const document = this.documents.get(path);
    if (document === undefined) {
      return;
    }
    if (!this.accepts) {
      this.refused.push(path);
      return;
    }
    document.text = applyToText(document.text, change);
    const applied = this.changes.get(path) ?? [];
    applied.push(change);
    this.changes.set(path, applied);
    this.notify(path);
  }

  save(path: string): void {
    this.saves.push(path);
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
