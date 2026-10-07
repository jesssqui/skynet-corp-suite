import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, isId, idTime } from '../ids.js';
import { localDate, parseLocalDate, nowIso } from '../time.js';

test('newId makes valid, unique UUIDv7 strings', () => {
  const seen = new Set();
  for (let i = 0; i < 20000; i++) {
    const id = newId();
    assert.ok(isId(id), `invalid id ${id}`);
    assert.equal(id[14], '7', 'version nibble');
    assert.ok('89ab'.includes(id[19]), 'variant');
    seen.add(id);
  }
  assert.equal(seen.size, 20000);
});

test('IDs from one device sort in creation order, even within one millisecond', () => {
  const ids = [];
  for (let i = 0; i < 5000; i++) ids.push(newId());
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
});

test('IDs keep increasing when the clock goes backwards', () => {
  const a = newId(Date.now() + 60_000);
  const b = newId(Date.now());
  assert.ok(b > a);
});

test('idTime reads back the creation time', () => {
  const ms = Date.UTC(2100, 0, 1, 12, 30, 0, 123); // later than any earlier ID in this run
  const id = newId(ms);
  assert.equal(idTime(id).getTime(), ms);
  assert.throws(() => idTime('nope'));
});

test('isId rejects other formats', () => {
  assert.equal(isId(crypto.randomUUID()), false); // v4
  assert.equal(isId(newId().toUpperCase()), false);
  assert.equal(isId(null), false);
});

test('time helpers', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const d = parseLocalDate('2026-03-09');
  assert.equal(d.getDate(), 9);
  assert.equal(localDate(d), '2026-03-09');
  assert.throws(() => parseLocalDate('2026-3-9'));
});
