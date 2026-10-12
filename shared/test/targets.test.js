// Monthly targets (D15): the pace rule, picking one target when two devices set the same one, and the step rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetPace, pickTargets, checkTargetStep, measuresFor, daysInMonth, monthFirst, isMonthFirst, targetKey, TARGET_MEASURES, MEASURE_LABELS, MEASURE_HELP,
} from '../targets.js';

test('months: the 1st, days in a month (leap years too)', () => {
  assert.equal(monthFirst('2026-10-14'), '2026-10-01');
  assert.equal(monthFirst('2026-10'), '2026-10-01');
  assert.ok(isMonthFirst('2026-10-01'));
  assert.ok(!isMonthFirst('2026-10-02'));
  assert.ok(!isMonthFirst('2026-13-01'));
  assert.deepEqual(['2026-02', '2028-02', '2026-10', '2026-11'].map(daysInMonth), [28, 29, 31, 30]);
  for (const m of TARGET_MEASURES) assert.ok(MEASURE_LABELS[m] && MEASURE_HELP[m]);
});

test('pace: a straight line by the days completed; too early in the first days; ahead, on pace, behind; reached; a past month missed', () => {
  // October has 31 days; on the 14th, 13 days are complete: a $3,100 target expects $1,300.
  const p = targetPace({ amount: 310000, actual: 130000, month: '2026-10-01', today: '2026-10-14' });
  assert.deepEqual([p.status, p.expected, p.projected, p.pct, p.elapsed, p.days], ['on_pace', 130000, 310000, 42, 13, 31]);
  assert.equal(targetPace({ amount: 310000, actual: 140000, month: '2026-10-01', today: '2026-10-14' }).status, 'ahead');
  assert.equal(targetPace({ amount: 310000, actual: 125000, month: '2026-10-01', today: '2026-10-14' }).status, 'on_pace', 'within 5 %');
  assert.equal(targetPace({ amount: 310000, actual: 110000, month: '2026-10-01', today: '2026-10-14' }).status, 'behind');
  assert.equal(targetPace({ amount: 10, actual: 12, month: '2026-10-01', today: '2026-10-02' }).status, 'reached');
  for (const today of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    assert.equal(targetPace({ amount: 3100, actual: 0, month: '2026-10-01', today }).status, 'too_early', today);
  }
  const first = targetPace({ amount: 3100, actual: 0, month: '2026-10-01', today: '2026-10-01' });
  assert.deepEqual([first.elapsed, first.expected, first.projected], [0, 0, null]);
  assert.equal(targetPace({ amount: 3100, actual: 0, month: '2026-10-01', today: '2026-10-04' }).status, 'behind');
  const past = targetPace({ amount: 10, actual: 7, month: '2026-09-01', today: '2026-10-14' });
  assert.deepEqual([past.status, past.pct, past.expected, past.projected], ['missed', 70, null, null]);
  assert.equal(targetPace({ amount: 10, actual: 10, month: '2026-09-01', today: '2026-10-14' }).status, 'reached');
  assert.equal(targetPace({ amount: 10, actual: 0, month: '2026-11-01', today: '2026-10-14' }).status, 'not_started');
  assert.equal(targetPace({ amount: 10, actual: null, month: '2026-10-01', today: '2026-10-14' }).status, 'unknown', 'no actual (sales entered by hand only have a total)');
});

test('two devices set the same target offline: the one changed last is used, the other offered for removal', () => {
  const a = { id: '01a', business_id: 'b1', month: '2026-10-01', measure: 'sales', amount: 100, currency: null, updated_at: '2026-10-01T10:00:00.000Z' };
  const b = { ...a, id: '01b', amount: 200, updated_at: '2026-10-01T11:00:00.000Z' };
  const usd = { ...a, id: '01c', currency: 'USD' };
  const orders = { id: '01d', business_id: 'b1', month: '2026-10-01', measure: 'orders', amount: 5, currency: 'USD' };
  const { current, extras } = pickTargets([a, b, usd, orders]);
  assert.deepEqual(current.map((t) => t.id), ['01b', '01c', '01d']);
  assert.deepEqual(extras.get('01b').map((t) => t.id), ['01a']);
  assert.equal(targetKey(orders), 'b1|2026-10-01|orders|', 'a count’s currency doesn’t matter');
  // Without a time on one of them (a device's own record not pulled back yet), the ids decide.
  const noTime = { ...a, id: '01e', updated_at: null, created_at: null };
  assert.equal(pickTargets([b, noTime]).current[0].id, '01e');
  assert.deepEqual(measuresFor('home', 'home'), ['new_clients', 'won_leads']);
  assert.equal(measuresFor('b1', 'home').length, TARGET_MEASURES.length);
});

test('steps: the month is a 1st, the amount above 0, a target’s business, month and measure never change', () => {
  assert.equal(checkTargetStep({ op: 'create', fields: { month: '2026-10-01', amount: 1, measure: 'sales' } }), null);
  assert.equal(checkTargetStep({ op: 'create', fields: { month: '2026-10-02', amount: 1 } }).code, 'invalid_value');
  assert.equal(checkTargetStep({ op: 'create', fields: { month: '2026-10-01', amount: 0 } }).code, 'invalid_value');
  assert.equal(checkTargetStep({ op: 'create', fields: { month: '2026-10-01', amount: 1.5 } }).code, 'invalid_value');
  assert.equal(checkTargetStep({ op: 'create', fields: { month: '2026-10-01', amount: 1, currency: 'cad' } }).code, 'invalid_value');
  assert.equal(checkTargetStep({ op: 'update', fields: { amount: 5 } }), null);
  assert.equal(checkTargetStep({ op: 'update', fields: { amount: null } }).code, 'invalid_value');
  assert.match(checkTargetStep({ op: 'update', fields: { measure: 'orders' } }).reason, /don’t change/);
  assert.match(checkTargetStep({ op: 'update', fields: { currency: 'USD' } }).reason, /currency/, 'a different currency is a new target');
  assert.equal(checkTargetStep({ op: 'delete', fields: null }), null);
});
