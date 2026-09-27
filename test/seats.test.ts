/**
 * The room's seats and the roster's names, without an editor.
 *
 * `seatColours` hands the thirteen accents out in seat order, host first, and leaves a fourteenth
 * seat to `peerColour`. `rosterLabel` keeps a name plain until another peer shares it. Both are the
 * web client's rules, so every client draws a person in the same colour under the same name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SEAT_LIMIT, SEAT_PALETTE, rosterLabel, seatColours } from '../src/bridge/index.ts';
import type { Seat } from '../src/bridge/index.ts';

test('the palette is the thirteen accents in seat order, with no yellow', () => {
  assert.deepEqual(
    [...SEAT_PALETTE],
    [
      '#cba6f7',
      '#94e2d5',
      '#f5e0dc',
      '#f2cdcd',
      '#f5c2e7',
      '#f38ba8',
      '#eba0ac',
      '#fab387',
      '#a6e3a1',
      '#89dceb',
      '#74c7ec',
      '#89b4fa',
      '#b4befe',
    ],
  );
  assert.equal(SEAT_LIMIT, 13);
  // Yellow is the host's crown, and a face filled with it would swallow the mark.
  assert.ok(!(SEAT_PALETTE as readonly string[]).includes('#f9e2af'));
});

test('the host takes Mauve and the seat beside it Teal', () => {
  const colours = seatColours([
    { peerId: 'peer-self', role: 'host' },
    { peerId: 'peer-ada', role: 'guest' },
    { peerId: 'peer-bo', role: 'guest' },
  ]);
  assert.equal(colours.get('peer-self'), '#cba6f7');
  assert.equal(colours.get('peer-ada'), '#94e2d5');
  assert.equal(colours.get('peer-bo'), '#f5e0dc');
});

test('the host leads wherever it stands in the list, and the rest keep their order', () => {
  const colours = seatColours([
    { peerId: 'peer-self', role: 'guest' },
    { peerId: 'peer-bo', role: 'guest' },
    { peerId: 'peer-ada', role: 'host' },
  ]);
  assert.equal(colours.get('peer-ada'), '#cba6f7', 'the host does not take Mauve');
  assert.equal(colours.get('peer-self'), '#94e2d5', 'your own seat does not follow the host');
  assert.equal(colours.get('peer-bo'), '#f5e0dc');
});

test('with no host in the list, the first seat takes Mauve', () => {
  const colours = seatColours([
    { peerId: 'peer-self', role: 'guest' },
    { peerId: 'peer-bo', role: 'guest' },
  ]);
  assert.equal(colours.get('peer-self'), '#cba6f7');
  assert.equal(colours.get('peer-bo'), '#94e2d5');
});

test('thirteen seats take thirteen fills and a fourteenth is left to peerColour', () => {
  const seats: Seat[] = Array.from({ length: 14 }, (_, index) => ({
    peerId: `peer-${index}`,
    role: index === 5 ? 'host' : 'guest',
  }));
  const colours = seatColours(seats);
  assert.equal(colours.size, SEAT_LIMIT);
  assert.equal(new Set(colours.values()).size, SEAT_LIMIT, 'a fill repeated');
  assert.equal(colours.get('peer-5'), '#cba6f7');
  assert.equal(colours.has('peer-13'), false, 'a fourteenth seat was given a fill of its own');
});

test('an empty room has no colours', () => {
  assert.equal(seatColours([]).size, 0);
});

test('a roster name stays plain while nobody else has it', () => {
  const solo = [{ displayName: 'sam', peerId: 'p-0000' }];
  assert.equal(rosterLabel(solo[0], solo), 'sam');
  const two = [
    { displayName: 'Ada', peerId: 'p-aaaa' },
    { displayName: 'Bo', peerId: 'p-bbbb' },
  ];
  assert.equal(rosterLabel(two[0], two), 'Ada');
});

test('a shared roster name takes the last four characters of each peer id', () => {
  const pair = [
    { displayName: 'guest-one', peerId: 'peer-1111' },
    { displayName: 'guest-one', peerId: 'peer-2222' },
  ];
  assert.equal(rosterLabel(pair[0], pair), 'guest-one · 1111');
  assert.equal(rosterLabel(pair[1], pair), 'guest-one · 2222');
});
