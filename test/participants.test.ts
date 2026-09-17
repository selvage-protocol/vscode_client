/**
 * The Participants view's rows and file badges, without an editor.
 *
 * Slice 1: `describeParticipants` turns membership + presence into rows that keep
 * name + state + actions only — no path text on the row, per the owner refinement —
 * and `badgeFiles` marks the room files peers are in. Both are pure, so these tests
 * import `src/adapter/participants.ts` directly. Wiring (registration, refresh,
 * actions) is slice 2, through the built bundle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { peerColour } from '../src/bridge/cursors.ts';
import {
  badgeFiles,
  describeParticipants,
  viewRows,
} from '../src/bridge/participants.ts';
import type { RosterRow } from '../src/bridge/participants.ts';

const ADA = { peerId: 'p-aaa', displayName: 'Ada', role: 'host', path: 'src/a.rs' };
const BO = { peerId: 'p-bbb', displayName: 'Bo', role: 'guest', path: 'src/b.rs' };

test('a row names the peer and carries their marker colour, with no path on it', () => {
  const [row] = describeParticipants([ADA], undefined);
  assert.equal(row?.label, 'Ada');
  assert.equal(row?.colour, peerColour('p-aaa'));
  assert.equal(row?.description, '');
  assert.ok(row?.tooltip.includes('src/a.rs'), 'the path survives in the hover, not on the row');
  assert.ok(!JSON.stringify([row?.label, row?.description]).includes('src/a.rs'));
});

test('a shared name disambiguates by the shortest unique peer-id prefix', () => {
  const rows = describeParticipants(
    [
      { peerId: 'p-3d334f', displayName: 'Ada', role: 'guest', path: 'src/a.rs' },
      { peerId: 'p-a91c02', displayName: 'Ada', role: 'guest', path: 'src/b.rs' },
    ],
    undefined,
  );
  assert.deepEqual(
    rows.map((row) => row.label).sort(),
    ['Ada (p-3)', 'Ada (p-a)'].sort(),
  );
});

test('the followed peer reads Following and stops showing follow', () => {
  const rows = describeParticipants([ADA, BO], 'p-bbb');
  assert.equal(rows.find((row) => row.peerId === 'p-bbb')?.description, 'Following');
  assert.equal(
    rows.find((row) => row.peerId === 'p-bbb')?.contextValue,
    'selvageParticipantFollowing',
  );
  assert.equal(rows.find((row) => row.peerId === 'p-aaa')?.contextValue, 'selvageParticipant');
});

test('a peer in no document reads as away, with no navigation', () => {
  const [row] = describeParticipants(
    [{ peerId: 'p-ccc', displayName: '', role: 'guest' }],
    undefined,
  );
  assert.equal(row?.label, 'p-ccc', 'a blank name falls back to the id, as the caret label does');
  assert.equal(row?.description, 'No open document');
  assert.equal(row?.contextValue, 'selvageParticipantAway');
  assert.equal(row?.canNavigate, false);
});

test('one peer in a file badges it; several badge the count, with names in the hover', () => {
  assert.deepEqual(badgeFiles([{ uri: 'file:///room/src/a.rs', names: ['Ada'] }]), [
    { uri: 'file:///room/src/a.rs', badge: '●', tooltip: 'Ada is here' },
  ]);
  assert.deepEqual(
    badgeFiles([{ uri: 'file:///room/src/a.rs', names: ['Bo', 'Ada'] }]),
    [{ uri: 'file:///room/src/a.rs', badge: '2', tooltip: 'Ada, Bo are here' }],
  );
  assert.deepEqual(badgeFiles([{ uri: 'file:///room/src/a.rs', names: [] }]), []);
});

test('the view lists peers, or which note stands in when there is nothing to list', () => {
  const ada = { peerId: 'p-aaa', displayName: 'Ada', role: 'host', path: 'src/a.rs' };
  const peered: RosterRow[] = viewRows({ entries: [ada], followingPeerId: undefined });
  assert.equal(peered.length, 1);
  assert.equal((peered[0] as { kind: string }).kind, 'peer');
  assert.deepEqual(viewRows({ entries: [], followingPeerId: undefined }), [{ kind: 'empty' }]);
  assert.deepEqual(viewRows(undefined), [{ kind: 'nosession' }]);
});
