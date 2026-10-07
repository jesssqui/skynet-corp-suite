import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../ids.js';
import { createHlc, parseHlc, isHlc, encodeHlc, compareHlc } from '../hlc.js';

const A = newId();
const B = newId();

test('stamps round-trip and sort as text', () => {
  const s = encodeHlc({ ms: 1759760000000, counter: 3, node: A });
  assert.ok(isHlc(s));
  assert.deepEqual(parseHlc(s), { ms: 1759760000000, counter: 3, node: A });
  assert.equal(parseHlc('nope'), null);
  assert.equal(parseHlc(`1759760000000-000000-${A}`), null, 'ms must be 15 digits');
  assert.equal(parseHlc(encodeHlc({ ms: 1, counter: 0, node: 'not-an-id' })), null);
  const earlier = encodeHlc({ ms: 999, counter: 999999, node: B });
  const later = encodeHlc({ ms: 1000, counter: 0, node: A });
  assert.ok(earlier < later);
  assert.equal(compareHlc(earlier, later), -1);
});

test('a clock never goes backwards, even when the wall clock does', () => {
  let wall = 5000;
  const clock = createHlc(A, { wallClock: () => wall });
  const a = clock.now();
  wall = 1000; // clock moved back
  const b = clock.now();
  const c = clock.now();
  assert.ok(a < b && b < c);
  assert.equal(parseHlc(b).ms, 5000);
});

test('after receiving a stamp, local stamps sort after it even with a slow wall clock', () => {
  const slow = createHlc(A, { wallClock: () => 1000 });
  const fast = createHlc(B, { wallClock: () => 9_000_000 });
  const theirs = fast.now();
  slow.receive(theirs);
  const mine = slow.now();
  assert.ok(mine > theirs, `${mine} should sort after ${theirs}`);
  assert.equal(parseHlc(mine).node, A);
});

test('resumes from a persisted stamp', () => {
  const first = createHlc(A, { wallClock: () => 10 });
  first.now();
  const saved = first.now();
  const again = createHlc(A, { last: saved, wallClock: () => 5 });
  assert.ok(again.now() > saved);
  assert.throws(() => createHlc(A, { last: 'garbage' }), /Not an HLC/);
});
