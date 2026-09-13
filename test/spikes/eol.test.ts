/**
 * Spike 3 (§7 risk 3): EOL and the trailing newline.
 *
 * Both reference extensions needed an explicit policy for this (`YjsNormalizedTextDocument`
 * in OCT, Teamtype's ADR 02), and Selvage's documents say nothing about it. The experiment
 * runs two replicas whose buffers use different line endings against one CRDT, with and
 * without a policy, and measures what diverges.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from 'yjs';

type Eol = '\n' | '\r\n';
type Policy = 'none' | 'lf-in-crdt';

const LOCAL = Symbol('local');

/** An adapter that mirrors one `Y.Text` into one buffer with an EOL of its own. */
class Mirror {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  buffer: string;
  readonly eol: Eol;
  private readonly policy: Policy;
  /** Writes this adapter made to the CRDT, to count a fight rather than describe one. */
  writes = 0;

  constructor(policy: Policy, eol: Eol, initial: string, seed: boolean) {
    this.policy = policy;
    this.eol = eol;
    this.buffer = initial;
    this.text = this.doc.getText('src/main.rs');
    if (seed) {
      this.text.insert(0, this.toCrdt(initial));
    }
    this.text.observe((_event, transaction) => {
      if (transaction.origin === LOCAL) {
        return;
      }
      this.pull();
    });
  }

  /** What the buffer holds, as the CRDT holds it. */
  private toCrdt(buffer: string): string {
    return this.policy === 'lf-in-crdt' ? buffer.replaceAll('\r\n', '\n') : buffer;
  }

  /** What the CRDT holds, as this document's buffer renders it. */
  render(): string {
    const crdt = this.text.toString();
    if (this.policy === 'lf-in-crdt') {
      return crdt.replaceAll('\n', this.eol);
    }
    // No policy: the editor shows the file with the line endings it is configured for, so
    // each replica's buffer has its own EOL whatever the CRDT holds.
    const lf = crdt.replaceAll('\r\n', '\n');
    return this.eol === '\n' ? lf : lf.replaceAll('\n', '\r\n');
  }

  /** CRDT → buffer. */
  pull(): void {
    const rendered = this.render();
    if (rendered === this.buffer) {
      return;
    }
    this.buffer = rendered;
  }

  /** buffer → CRDT: a whole-buffer write, the naive adapter's shortcut. */
  pushBuffer(): void {
    const wanted = this.toCrdt(this.buffer);
    if (wanted === this.text.toString()) {
      return;
    }
    this.writes += 1;
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, wanted);
    }, LOCAL);
  }

  /** A remote peer's change, applied as a frame from the wire. */
  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, Symbol('remote'));
  }

  update(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }
}

test('spike 3: with no policy, a CRLF replica and an LF replica fight over one CRDT', () => {
  const CRLF = 'line one\r\nline two\r\n';
  const LF = 'line one\nline two\n';

  const ada = new Mirror('none', '\r\n', CRLF, true);
  const bob = new Mirror('none', '\n', LF, false);
  const follow = (from: Mirror, to: Mirror): void => {
    to.applyRemote(from.update());
  };

  // Bob follows Ada's file. His editor shows it with LF, so his buffer is now a change Ada
  // has to follow — and each round is a write the other one answers.
  follow(ada, bob);
  ada.pushBuffer();
  bob.pushBuffer();
  follow(bob, ada);
  ada.pull();
  ada.pushBuffer();
  follow(ada, bob);
  bob.pull();
  bob.pushBuffer();
  follow(bob, ada);

  const crdt = ada.text.toString();
  console.log(
    `[spike 3] no policy: writes ${ada.writes}/${bob.writes}; the CRDT ended up ` +
      `${JSON.stringify(crdt)} (LF wrote last), the CRLF editor still shows ` +
      `${JSON.stringify(ada.buffer)}`,
  );
  assert.ok(ada.writes >= 1 && bob.writes >= 1, 'both replicas rewrote the CRDT');
  assert.equal(crdt, LF, 'the last writer decides the line endings');
  assert.equal(ada.buffer, CRLF, 'the CRLF editor still shows CRLF');

  // Whoever does not write last has offsets that address a different byte: Ada's column 0 of
  // line 2 is 10 in her buffer and 9 in the CRDT she is publishing selections about.
  const adaCaret = CRLF.indexOf('line two');
  ada.pull();
  console.log(
    `[spike 3] no policy: Ada's caret at offset ${adaCaret} — her buffer says ` +
      `${JSON.stringify(ada.buffer.slice(adaCaret, adaCaret + 8))}, the CRDT says ` +
      `${JSON.stringify(crdt.slice(adaCaret, adaCaret + 8))}`,
  );
  assert.equal(ada.buffer.slice(adaCaret, adaCaret + 8), 'line two');
  assert.notEqual(
    crdt.slice(adaCaret, adaCaret + 8),
    'line two',
    "the CRLF replica's offsets do not address the CRDT text",
  );
});

test('spike 3: LF in the CRDT and the document\'s EOL restored on render converge', () => {
  const CRLF = 'line one\r\nline two\r\n';
  const LF = 'line one\nline two\n';

  const ada = new Mirror('lf-in-crdt', '\r\n', CRLF, true);
  const bob = new Mirror('lf-in-crdt', '\n', LF, false);
  bob.applyRemote(ada.update());
  ada.pushBuffer();
  bob.pushBuffer();
  ada.pull();
  bob.pull();

  console.log(
    `[spike 3] LF in the CRDT: CRDT ${JSON.stringify(ada.text.toString())}, ` +
      `Ada's buffer ${JSON.stringify(ada.buffer)}, Bob's ${JSON.stringify(bob.buffer)}`,
  );
  assert.equal(ada.text.toString(), LF, 'the CRDT is LF-only, whoever wrote it');
  assert.equal(ada.buffer, CRLF, 'a CRLF document still shows CRLF');
  assert.equal(bob.buffer, LF);

  // Bob's caret survives the round trip, because the offsets are computed on the buffer's
  // own text and the CRDT is not carrying an extra byte per line.
  const bobCaret = LF.indexOf('line two');
  const lf = ada.text.toString();
  console.log(
    `[spike 3] LF in the CRDT: Bob's offset ${bobCaret} is ` +
      `${JSON.stringify(lf.slice(bobCaret, bobCaret + 8))} in the CRDT and ` +
      `${JSON.stringify(bob.buffer.slice(bobCaret, bobCaret + 8))} in his buffer`,
  );
  assert.equal(lf.slice(bobCaret, bobCaret + 8), 'line two');
  assert.equal(bob.buffer.slice(bobCaret, bobCaret + 8), 'line two');

  // Ada's buffer offsets differ from the CRDT's by one per preceding line. An adapter that
  // publishes selections must therefore say which text it is talking about, or convert.
  const adaCaret = CRLF.indexOf('line two');
  console.log(
    `[spike 3] LF in the CRDT: Ada's own offset for the same character is ${adaCaret} ` +
      `(CRDT offset ${lf.indexOf('line two')}); the difference is one byte per CRLF line`,
  );
  assert.equal(adaCaret - lf.indexOf('line two'), 1);
});

test('spike 3: a trailing-newline invariant in the sync layer is a loop', () => {
  const FILE = 'no trailing newline';

  // Both adapters "ensure" the invariant a formatter would: a text file ends with \n.
  const ensure = (text: string): string =>
    text === '' || text.endsWith('\n') ? text : `${text}\n`;

  const ada = new Mirror('lf-in-crdt', '\n', FILE, true);
  const bob = new Mirror('lf-in-crdt', '\n', FILE, false);
  bob.applyRemote(ada.update());
  // Ada's adapter applies its invariant on the way into the CRDT; Bob's does too, on the
  // change event the first write produces.
  ada.buffer = ensure(ada.buffer);
  ada.pushBuffer();
  bob.buffer = ensure(bob.buffer);
  bob.pushBuffer();

  console.log(
    `[spike 3] trailing newline: two adapters each ensuring one newline: ` +
      `CRDT ${JSON.stringify(ada.text.toString())}`,
  );
  assert.equal(
    ada.text.toString(),
    `${FILE}\n`,
    'the invariant is idempotent only when it is applied once',
  );

  // Content is content: the sync layer imposes nothing, so a document without a final
  // newline stays without one, and whoever wants the invariant has to own it in one place.
  const plain = new Mirror('lf-in-crdt', '\n', FILE, true);
  const peer = new Mirror('lf-in-crdt', '\n', FILE, false);
  peer.applyRemote(plain.update());
  plain.pushBuffer();
  peer.pushBuffer();
  console.log(
    `[spike 3] trailing newline: with no invariant, CRDT ${JSON.stringify(plain.text.toString())} ` +
      `on both sides: ${JSON.stringify(peer.text.toString())}`,
  );
  assert.equal(plain.text.toString(), FILE);
  assert.equal(peer.text.toString(), FILE);
});
