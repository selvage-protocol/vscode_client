/**
 * The peer corpus replayed against this engine: `CANONICAL.md` §6.1's bytes, and `PROTOCOL.md`
 * §13's decisions.
 *
 * `specification/vectors/peer/` holds two kinds of vector. A **frame** vector is about the byte
 * layer: this test seals each recipe with this engine's own `seal` and checks the bytes against
 * the `hex` the vector pins, then replays every frame through a `Reader` and asserts the verdict.
 * A **decision** vector is about what a whole client did with a frame it received — what it
 * applied, what it dropped and why, what it published, whether it ended — and is driven through
 * the subject this repository exposes for exactly that:
 * `test/helpers/selvage-subject.ts`, the program
 * `specification/runner/run_peer.py --subject` drives.
 *
 * It needs the sibling `specification` checkout, so it is not in CI and not in `test:fast`:
 * `npm run test:peer-corpus` runs it, and so does `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

import { nodeCrypto } from '../src/node/crypto.ts';
import { parseEnvelope, Reader, opens, authentic } from '../src/engine/sealed.ts';
import { applyFrame } from '../src/engine/sync.ts';
import {
  CORPUS_HINT,
  Subject,
  bytesOf,
  fixtureKey,
  loadFixture,
  requireCorpus,
  sealRecipe,
  spaced,
  until,
} from './helpers/peer-corpus.ts';
import type { Fixture, SubjectReport } from './helpers/peer-corpus.ts';

/** The seat the runner seats a subject under (`run_peer.py`'s `DECISION_SEAT`). */
const DECISION_SEAT = 'p-subject';

/** The invite's token: a decision vector never reaches a server. */
const DECISION_TOKEN = 't-corpus-decision';

/** How long one subject reply may take; the runner's own default is ten seconds. */
const SUBJECT_TIMEOUT_MS = 10_000;

/** The vectors of one kind, in file order, with the file they came from. */
function vectors(kind: string): Array<Record<string, unknown>> {
  const dir = resolve(requireCorpus(), 'peer');
  const found: Array<Record<string, unknown>> = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const vector = JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as Record<string, unknown>;
    if (vector['kind'] === kind) {
      vector['_file'] = name;
      found.push(vector);
    }
  }
  return found;
}

// --- the frame layer ------------------------------------------------------------

/** One `corrupt` step: the bytes a vector writes for a frame it damaged on purpose. */
function corrupt(source: Uint8Array, step: Record<string, unknown>): Uint8Array {
  const how = step['as'];
  if (how === 'tampered') {
    const out = Uint8Array.from(source);
    out[Number(step['at'])] ^= Number(step['xor']);
    return out;
  }
  if (how === 'trailing') {
    return Uint8Array.from([...source, ...bytesOf(step['append'])]);
  }
  if (how === 'short') {
    return source.slice(0, source.length - Number(step['truncate']));
  }
  throw new Error(`\`corrupt\` as ${JSON.stringify(how)} is not a step this driver knows`);
}

async function replayFrameVector(
  fixture: Fixture,
  vector: Record<string, unknown>,
): Promise<number> {
  const steps = vector['steps'] as Array<Record<string, unknown>>;
  const reader = await Reader.create({
    roomId: fixture.roomId,
    roomKey: fixture.roomKey,
    hostKey: fixture.host.public,
    crypto: nodeCrypto,
  });
  assert.ok(reader !== undefined, 'a reader is built from the fixture');
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const frames = new Map<string, Uint8Array>();
  let assertions = 0;
  const frame = (step: Record<string, unknown>): Uint8Array => {
    const raw = frames.get(String(step['frame']));
    if (raw === undefined) {
      throw new Error(`no frame is named ${JSON.stringify(step['frame'])}`);
    }
    return raw;
  };

  for (const [index, step] of steps.entries()) {
    const where = `${String(vector['_file'])} step ${index} (\`${String(step['op'])}\`)`;
    switch (step['op']) {
      case 'seal': {
        const raw = await sealRecipe(
          fixture,
          nodeCrypto,
          step['recipe'] as Record<string, unknown>,
        );
        assert.equal(
          spaced(raw),
          String(step['hex']).trim().toLowerCase(),
          `${where}: this engine's seal does not produce the vector's bytes`,
        );
        frames.set(String(step['frame']), raw);
        break;
      }
      case 'corrupt': {
        const raw = corrupt(frame(step), step);
        assert.equal(
          spaced(raw),
          String(step['hex']).trim().toLowerCase(),
          `${where}: this driver's corruption is not the vector's`,
        );
        frames.set(String(step['as']), raw);
        break;
      }
      case 'expectVerify': {
        assertions += 1;
        const raw = frame(step);
        const verdict = await reader.read(raw);
        assert.ok(
          verdict.ok,
          `${where}: the reader refused \`${String(step['frame'])}\` with \`${String(verdict.reason)}\``,
        );
        if (verdict.kind === 0) {
          applyFrame(verdict.plaintext, doc, awareness, 'corpus');
        }
        break;
      }
      case 'expectReject': {
        assertions += 1;
        const verdict = await reader.read(frame(step));
        assert.equal(
          verdict.ok,
          false,
          `${where}: the reader applied \`${String(step['frame'])}\``,
        );
        assert.equal(
          verdict.reason,
          step['reason'],
          `${where}: \`${String(step['frame'])}\` was refused with the wrong reason`,
        );
        break;
      }
      case 'expectPlaintext': {
        assertions += 1;
        const envelope = parseEnvelope(frame(step));
        assert.ok(envelope !== undefined, `${where}: not an envelope`);
        const plaintext = await opens(nodeCrypto, fixture.frameKey, fixture.roomId, envelope);
        assert.ok(plaintext !== undefined, `${where}: the frame does not open`);
        if (step['signed_by'] !== undefined) {
          assert.ok(
            await authentic(
              nodeCrypto,
              fixture.roomId,
              envelope,
              fixtureKey(fixture, step['signed_by']).public,
            ),
            `${where}: the signature does not verify against \`${String(step['signed_by'])}\``,
          );
        }
        if (step['plaintext'] !== undefined) {
          assert.equal(spaced(plaintext), spaced(bytesOf(step['plaintext'])), where);
        }
        if (step['payload'] !== undefined) {
          assert.deepEqual(JSON.parse(new TextDecoder().decode(plaintext)), step['payload']);
        }
        break;
      }
      case 'expectListing': {
        assertions += 1;
        assert.deepEqual(reader.listing, step['listing'], where);
        break;
      }
      case 'expectHolds': {
        assertions += 1;
        const id = fixtureKey(fixture, step['sign']).hexId;
        assert.deepEqual(reader.holds.get(id) ?? [], step['holds'], where);
        break;
      }
      case 'expectDoc': {
        assertions += 1;
        assert.equal(doc.getText(String(step['path'])).toString(), step['text'], where);
        break;
      }
      default:
        throw new Error(`${where}: \`${String(step['op'])}\` is not a step of a frame vector`);
    }
  }
  return assertions;
}

// --- the decision layer ---------------------------------------------------------

/** The invite a `start` hands a subject: the vector's template, substituted. */
function inviteOf(fixture: Fixture, step: Record<string, unknown>): string {
  const values: Record<string, string> = {
    $room: fixture.roomId,
    $token: DECISION_TOKEN,
    $room_key: Buffer.from(fixture.roomKey).toString('base64url'),
    $host_key: Buffer.from(fixture.host.public).toString('base64url'),
  };
  let invite = String(step['invite']);
  // Longest name first: `$room` is a prefix of `$room_key`.
  for (const name of Object.keys(values).sort((left, right) => right.length - left.length)) {
    invite = invite.split(name).join(values[name] ?? '');
  }
  assert.doesNotMatch(invite, /\$/, `\`invite\` names a value nothing substitutes: ${invite}`);
  return invite;
}

/** The seats the server shows as present, taken from the vector's own states. */
function rosterOf(vector: Record<string, unknown>): string[] {
  const seats: string[] = [];
  for (const step of vector['steps'] as Array<Record<string, unknown>>) {
    if (step['op'] !== 'deliver') {
      continue;
    }
    const recipe = step['recipe'] as Record<string, unknown> | undefined;
    const payload = recipe?.['payload'] as Record<string, unknown> | undefined;
    const peers = payload?.['peers'];
    if (typeof peers !== 'object' || peers === null) {
      continue;
    }
    for (const entry of Object.values(peers as Record<string, unknown>)) {
      const seat = (entry as Record<string, unknown>)['peer_id'];
      if (typeof seat === 'string' && !seats.includes(seat)) {
        seats.push(seat);
      }
    }
  }
  return seats;
}

/** Every member an `expectSubject` asserts that the report does not satisfy. */
function unmet(
  step: Record<string, unknown>,
  report: SubjectReport,
  fixture: Fixture,
): string[] {
  const failures: string[] = [];
  const exact: Array<[string, unknown, unknown]> = [
    ['applied', step['applied'], report.applied],
    ['dropped', step['dropped'], report.dropped],
    ['published', step['published'], report.published],
    ['handshake', step['handshake'], report.handshake],
    ['ended', step['ended'], report.ended],
    ['listing', step['listing'], report.listing],
    ['text', step['text'], report.text],
  ];
  for (const [member, want, actual] of exact) {
    if (want === undefined) {
      continue;
    }
    if (JSON.stringify(want) !== JSON.stringify(actual)) {
      failures.push(
        `\`${member}\` is ${JSON.stringify(want)} in the vector and ${JSON.stringify(actual)} in the report`,
      );
    }
  }
  const holds = step['holds'] as Record<string, string[]> | undefined;
  if (holds !== undefined) {
    for (const [name, paths] of Object.entries(holds)) {
      const key = fixtureKey(fixture, name);
      const actual = report.holds[key.spelling] ?? report.holds[key.hexId] ?? [];
      if (JSON.stringify([...paths].sort()) !== JSON.stringify([...actual].sort())) {
        failures.push(
          `\`holds[${name}]\` is ${JSON.stringify(paths)} in the vector and ${JSON.stringify(actual)} in the report`,
        );
      }
    }
  }
  const bounds = (step['at_least'] ?? {}) as Record<string, number>;
  for (const [member, bound] of Object.entries(bounds)) {
    const actual = (report as unknown as Record<string, unknown>)[member];
    if (typeof actual !== 'number' || actual < bound) {
      failures.push(`\`${member}\` must be at least ${bound} and is ${JSON.stringify(actual)}`);
    }
  }
  return failures;
}

/** One `expectSubject`: the exact members, the bounds, and the frozen window. */
async function expectSubject(
  subject: Subject,
  fixture: Fixture,
  step: Record<string, unknown>,
  where: string,
): Promise<SubjectReport> {
  const within = typeof step['within_ms'] === 'number' ? step['within_ms'] : undefined;
  if (within === undefined) {
    const report = await subject.report();
    const failures = unmet(step, report, fixture);
    assert.equal(failures.length, 0, `${where}: ${failures.join('; ')}`);
    return report;
  }
  // `within_ms` bounds two waits and both are the vector's own number: the poll for the members
  // the step asserts, which may not hold yet, and — when `frozen` is there — one window in which
  // the named members must not move. The window starts where the poll ends.
  const deadline = Date.now() + within;
  let settled: SubjectReport | undefined;
  await until(
    where,
    async () => {
      settled = await subject.report();
      return unmet(step, settled, fixture);
    },
    within,
  );
  const report = settled as SubjectReport;
  const frozen = step['frozen'] as string[] | undefined;
  if (frozen === undefined) {
    return report;
  }
  const left = deadline - Date.now();
  if (left > 0) {
    await delay(left);
  }
  const after = await subject.report();
  for (const member of frozen) {
    assert.equal(
      JSON.stringify((after as unknown as Record<string, unknown>)[member]),
      JSON.stringify((report as unknown as Record<string, unknown>)[member]),
      `${where}: \`${member}\` moved over the window`,
    );
  }
  return report;
}

async function driveDecisionVector(
  fixture: Fixture,
  vector: Record<string, unknown>,
  subjectCommand: string[],
  mutation?: string,
): Promise<number> {
  const steps = vector['steps'] as Array<Record<string, unknown>>;
  const scenario = vector['scenario'] as Record<string, unknown>;
  const subject = new Subject(subjectCommand, SUBJECT_TIMEOUT_MS);
  let assertions = 0;
  let frames = 0;
  try {
    for (const [index, step] of steps.entries()) {
      const where = `${String(vector['_file'])} step ${index} (\`${String(step['op'])}\`)`;
      switch (step['op']) {
        case 'start': {
          const seed = fixtureKey(fixture, step['key']);
          await subject.join({
            invite: inviteOf(fixture, step),
            offline: true,
            keepalive: scenario['keepalive'],
            seat: DECISION_SEAT,
            roster: rosterOf(vector),
            session_key: Buffer.from(seed.private).toString('hex'),
            ...(step['path'] === undefined ? {} : { path: step['path'] }),
          });
          if (mutation !== undefined) {
            await subject.mutate(mutation);
          }
          break;
        }
        case 'deliver': {
          const raw = await sealRecipe(
            fixture,
            nodeCrypto,
            step['recipe'] as Record<string, unknown>,
          );
          assert.equal(
            spaced(raw),
            String(step['hex']).trim().toLowerCase(),
            `${where}: this engine's seal does not produce the vector's bytes`,
          );
          const report = await subject.deliver(raw);
          frames += 1;
          assert.equal(
            report.frames,
            frames,
            `${where}: the subject counts ${report.frames} frames received and this is the ${frames}th`,
          );
          break;
        }
        case 'wait': {
          await delay(Number(step['ms']));
          break;
        }
        case 'expectSubject': {
          assertions += 1;
          await expectSubject(subject, fixture, step, where);
          break;
        }
        case 'stop': {
          await subject.quit();
          break;
        }
        default:
          throw new Error(`${where}: \`${String(step['op'])}\` is not a step of a decision vector`);
      }
    }
  } finally {
    subject.stop();
  }
  return assertions;
}

// --- the corpus -----------------------------------------------------------------

const subjectCommand = ['node', resolve(import.meta.dirname, 'helpers', 'selvage-subject.ts')];

test('the frame layer: every peer frame vector, sealed and read by this engine', async () => {
  const fixture = await loadFixture(nodeCrypto);
  const corpus = vectors('frame');
  assert.ok(corpus.length >= 17, `expected the frame vectors, found ${corpus.length}`);
  for (const vector of corpus) {
    const assertions = await replayFrameVector(fixture, vector);
    assert.ok(assertions > 0, `${String(vector['id'])} asserts nothing`);
  }
  assert.ok(CORPUS_HINT.length > 0, 'the corpus location is named for a reader without it');
});

for (const id of ['151', '152', '153', '154', '155', '156']) {
  test(`the decision layer: a subject at vector ${id}`, async () => {
    const fixture = await loadFixture(nodeCrypto);
    const vector = vectors('decision').find((entry) => entry['id'] === id);
    assert.ok(vector !== undefined, `the corpus has no decision vector ${id}`);
    const assertions = await driveDecisionVector(fixture, vector, subjectCommand);
    assert.ok(assertions > 0, `${id} asserts nothing`);
  });
}

// The mutation census over the same six: each vector's own `catches` names the one guard whose
// removal must turn it red, and a vector that stays green under it does not test the rule it
// says it tests.
for (const id of ['151', '152', '153', '154', '155', '156']) {
  const mutation = {
    '151': 'ignore-roles',
    '152': 'ignore-issued',
    '153': 'announce-once',
    '154': 'no-lease',
    '155': 'any-closing',
    '156': 'wait-for-ever',
  }[id] as string;
  test(`the census: vector ${id} goes red under \`${mutation}\``, async () => {
    const fixture = await loadFixture(nodeCrypto);
    const vector = vectors('decision').find((entry) => entry['id'] === id);
    assert.ok(vector !== undefined, `the corpus has no decision vector ${id}`);
    assert.equal(
      vector['catches'],
      mutation,
      `${id} declares the mutation it catches, and it changed`,
    );
    await assert.rejects(
      driveDecisionVector(fixture, vector, subjectCommand, mutation),
      (error: unknown) => error instanceof Error,
      `${id} stays green under \`${mutation}\`, the mutation it declares it catches`,
    );
  });
}
