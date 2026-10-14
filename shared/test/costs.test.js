import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPeriods, rollForward, yearlyCents, costTotals, costState, wantsCostReminder, costsRenewingBetween, moneyText, costAmountText, splitCents, shareLabel, costBusinesses, costShareYearly,
  daysFromTo, isCurrency, costCurrency, monthlyFromYearly, dayOfMonth, isAnchorDay, effectiveAnchor,
} from '../costs.js';

test('periods: added on the calendar; once stays put', () => {
  assert.equal(addPeriods('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addPeriods('2028-01-31', 'monthly'), '2028-02-29', 'leap year');
  assert.equal(addPeriods('2026-11-15', 'quarterly'), '2027-02-15');
  assert.equal(addPeriods('2026-02-28', 'yearly', 2), '2028-02-28');
  assert.equal(addPeriods('2026-10-09', 'once'), '2026-10-09');
  assert.equal(daysFromTo('2026-10-09', '2026-11-08'), 30);
  assert.equal(daysFromTo('2026-11-01', '2026-11-02'), 1, 'across the DST change: whole days');
  assert.equal(daysFromTo('2026-10-09', '2026-10-01'), -8);
});

test('rollForward: the first renewal on or after today, counted from the old date in one go', () => {
  assert.equal(rollForward('2026-10-08', 'yearly', '2026-10-09'), '2027-10-08');
  assert.equal(rollForward('2026-10-09', 'yearly', '2026-10-09'), '2026-10-09', 'the renewal day itself: not passed yet');
  assert.equal(rollForward('2026-10-10', 'monthly', '2026-10-09'), '2026-10-10', 'not passed: unchanged');
  assert.equal(rollForward('2026-06-15', 'monthly', '2026-10-09'), '2026-10-15', 'months of downtime: one jump');
  assert.equal(rollForward('2026-01-31', 'monthly', '2026-03-01'), '2026-03-31', 'from the anchor: Jan 31 + 2 months');
  assert.equal(rollForward('2026-08-01', 'quarterly', '2026-11-01'), '2026-11-01');
  assert.equal(rollForward('2026-01-01', 'once', '2026-10-09'), '2026-01-01', 'a one-time cost never rolls');
  assert.equal(rollForward(null, 'yearly', '2026-10-09'), null);
});

test('rollForward with the billing day: daily rolls and one jump give the same dates (Feb, then Mar 31)', () => {
  // Day by day, each roll starting from the date the last one wrote, with the billing day kept.
  let date = '2027-01-31';
  const seen = [];
  for (const today of ['2027-02-01', '2027-03-01', '2027-04-01', '2027-05-01']) {
    date = rollForward(date, 'monthly', today, 31);
    seen.push(date);
  }
  assert.deepEqual(seen, ['2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  assert.equal(rollForward('2027-01-31', 'monthly', '2027-03-01', 31), '2027-03-31', 'one jump: the same');
  assert.equal(rollForward('2027-01-31', 'monthly', '2027-05-01', 31), '2027-05-31');
  assert.equal(rollForward('2028-01-30', 'monthly', '2028-02-02', 30), '2028-02-29', 'leap year');
  assert.equal(rollForward('2026-11-30', 'quarterly', '2026-12-01', 31), '2027-02-28');
  assert.equal(rollForward('2027-02-28', 'quarterly', '2027-03-01', 31), '2027-05-31');
  assert.equal(addPeriods('2027-02-28', 'monthly', 1, 31), '2027-03-31');
  assert.equal(addPeriods('2027-02-28', 'monthly', 1), '2027-03-28', 'no billing day: the date’s own');
  assert.equal(rollForward('2027-02-28', 'monthly', '2027-03-01'), '2027-03-28', 'no billing day given: the date’s own (the suite passes it)');
  assert.equal(dayOfMonth('2027-01-31'), 31);
  assert.equal(isAnchorDay(31), true);
  assert.equal(isAnchorDay(32), false);
  assert.equal(isAnchorDay(null), false);
});

test('a stale or split billing day is read from the date: trusted only on its day, or on a short month’s last day (the clamp)', () => {
  assert.equal(effectiveAnchor('2027-03-15', 31), 15, 'date set to the 15th without the anchor: the 15th wins');
  assert.equal(effectiveAnchor('2027-02-28', 31), 31, 'the clamp');
  assert.equal(effectiveAnchor('2028-02-29', 31), 31, 'the clamp, leap year');
  assert.equal(effectiveAnchor('2027-04-30', 31), 31);
  assert.equal(effectiveAnchor('2027-03-31', 15), 31, 'a later day than the anchor: the date wins');
  assert.equal(effectiveAnchor('2027-02-28', 28), 28);
  assert.equal(effectiveAnchor('2027-03-15', null), 15);
  // The reproduction: anchor 31, Jan 31 → Feb 28 (clamp), then the date set to Mar 15 alone.
  assert.equal(rollForward('2027-01-31', 'monthly', '2027-02-01', 31), '2027-02-28');
  assert.equal(rollForward('2027-02-28', 'monthly', '2027-03-01', 31), '2027-03-31', 'the clamp still holds');
  assert.equal(rollForward('2027-03-15', 'monthly', '2027-03-16', 31), '2027-04-15', 'not Apr 30');
});

test('costTotals: the resold side only for costs whose relationship is still there', () => {
  const costs = [
    { id: 'a', business_id: 'b', amount_cents: 1200, period: 'yearly', relationship_id: 'r1', resold_amount_cents: 2400 },
    { id: 'b', business_id: 'b', amount_cents: 1200, period: 'yearly', relationship_id: 'gone', resold_amount_cents: 9600 },
  ];
  const t = costTotals(costs, { resoldLive: (c) => c.relationship_id !== 'gone' });
  assert.deepEqual([t.overall.get('CAD').yearly_cents, t.overall.get('CAD').resold_yearly_cents], [2400, 2400]);
});

test('totals: monthly equivalent = yearly ÷ 12, quarterly ÷ 3; once and cancelled left out; per business and currency', () => {
  const B1 = 'b1';
  const B2 = 'b2';
  const costs = [
    { id: '1', business_id: B1, amount_cents: 2000, period: 'monthly', status: 'active' }, // 240/yr
    { id: '2', business_id: B1, amount_cents: 12000, period: 'yearly' }, // null status = active: 120/yr
    { id: '3', business_id: B1, amount_cents: 3000, period: 'quarterly', status: 'active', relationship_id: 'r', resold_amount_cents: 4500 }, // 120/yr, resold 180/yr
    { id: '4', business_id: B1, amount_cents: 50000, period: 'once', status: 'active' },
    { id: '5', business_id: B1, amount_cents: 9900, period: 'monthly', status: 'cancelled' },
    { id: '6', business_id: B2, amount_cents: 1000, period: 'yearly', currency: 'USD', status: 'active' },
    { id: '7', business_id: B2, amount_cents: null, period: 'yearly', status: 'active' },
  ];
  const t = costTotals(costs);
  const b1 = t.byBusiness.get(B1).get('CAD');
  assert.deepEqual(b1, { count: 3, yearly_cents: 48000, monthly_cents: 4000, resold_yearly_cents: 18000, resold_monthly_cents: 1500 });
  assert.deepEqual([...t.byBusiness.get(B2).keys()].sort(), ['CAD', 'USD']);
  assert.equal(t.byBusiness.get(B2).get('USD').yearly_cents, 1000);
  assert.equal(t.overall.get('CAD').yearly_cents, 48000);
  assert.equal(t.overall.get('CAD').count, 4, 'a cost with no amount is counted, adding nothing');
  assert.equal(yearlyCents({ amount_cents: 999, period: 'quarterly' }), 3996);
  assert.equal(monthlyFromYearly(1000), 83);
});

test('where a cost stands; which costs get reminders; renewing in a window', () => {
  const today = '2026-10-09';
  const c = (over) => ({ id: 'x', period: 'yearly', status: 'active', next_renewal: '2026-12-01', ...over });
  assert.equal(costState(c({ status: 'cancelled' }), today), 'cancelled');
  assert.equal(costState(c({ next_renewal: '2026-10-01', period: 'once' }), today), 'past');
  assert.equal(costState(c({ next_renewal: '2026-10-01', auto_renews: true }), today), 'rolling');
  assert.equal(costState(c({ next_renewal: '2026-10-01', auto_renews: false }), today), 'overdue');
  assert.equal(costState(c({ next_renewal: today }), today), 'today');
  assert.equal(costState(c({ next_renewal: '2026-10-23' }), today), 'soon');
  assert.equal(costState(c({ next_renewal: '2026-10-24' }), today), 'upcoming');
  assert.equal(wantsCostReminder(c({ period: 'monthly', auto_renews: true })), false, 'monthly and automatic: no monthly task');
  assert.equal(wantsCostReminder(c({ period: 'monthly', auto_renews: false })), true);
  assert.equal(wantsCostReminder(c({ period: 'yearly', auto_renews: true })), true);
  assert.equal(wantsCostReminder(c({ status: 'cancelled' })), false);
  const list = [c({ id: 'b', next_renewal: '2026-11-08' }), c({ id: 'a', next_renewal: '2026-10-09' }), c({ id: 'z', next_renewal: '2026-11-09' }),
    c({ id: 'y', next_renewal: '2026-10-20', status: 'cancelled' })];
  assert.deepEqual(costsRenewingBetween(list, today, '2026-11-08').map((x) => x.id), ['a', 'b']);
});

test('money: CAD with $, other currencies named; amounts per period', () => {
  assert.equal(moneyText(12000), '$120');
  assert.equal(moneyText(12050), '$120.50');
  assert.equal(moneyText(12000, 'USD'), 'US$120');
  assert.equal(moneyText(null), '');
  assert.equal(costAmountText({ amount_cents: 2000, period: 'monthly' }), '$20/mo');
  assert.equal(costAmountText({ amount_cents: 50000, period: 'once', currency: 'USD' }), 'US$500 once');
  assert.equal(costAmountText({ amount_cents: 6000, period: 'quarterly', resold_amount_cents: 9000 }, 'resold_amount_cents'), '$90/qtr');
  assert.equal(costAmountText({ period: 'yearly' }), '');
  assert.equal(isCurrency('CAD'), true);
  assert.equal(isCurrency('cad'), false);
  assert.equal(costCurrency({ currency: null }), 'CAD');
});

test('splitCents: an even split to the cent; the shares always add up to the whole', () => {
  assert.deepEqual(splitCents(10000, ['b', 'a']), [{ businessId: 'a', cents: 5000 }, { businessId: 'b', cents: 5000 }]);
  assert.deepEqual(splitCents(10000, ['c', 'a', 'b']).map((p) => p.cents), [3334, 3333, 3333], 'the leftover cent goes to the first id');
  assert.deepEqual(splitCents(1, ['a', 'b', 'c']).map((p) => p.cents), [1, 0, 0]);
  assert.deepEqual(splitCents(500, ['a', 'a']), [{ businessId: 'a', cents: 500 }], 'a business named twice is one');
  assert.deepEqual(splitCents(500, []), []);
  assert.deepEqual(splitCents(null, ['a']), []);
  for (const amount of [0, 1, 7, 99, 1999, 123457]) {
    for (const n of [1, 2, 3, 4, 5, 7]) {
      const ids = Array.from({ length: n }, (_, i) => `b${i}`);
      const parts = splitCents(amount, ids);
      assert.equal(parts.reduce((t, p) => t + p.cents, 0), amount, `${amount} / ${n}`);
      assert.ok(Math.max(...parts.map((p) => p.cents)) - Math.min(...parts.map((p) => p.cents)) <= 1);
    }
  }
  assert.deepEqual([1, 2, 3, 4, 6].map(shareLabel), ['100%', '50%', '33.3%', '25%', '16.7%']);
  assert.equal(shareLabel(0), '');
});

test('costTotals with shares: each tagged business shows an even share; overall is the full amount; untagged is whole', () => {
  const c = (id, over) => ({ id, name: id, business_id: 'A', period: 'yearly', amount_cents: 12000, status: 'active', next_renewal: '2026-12-01', ...over });
  const costs = [
    c('canva', { amount_cents: 1000, period: 'monthly' }), // $120/yr used by all three
    c('storage', { amount_cents: 6000, business_id: 'B' }), // no tags: whole to B
    c('qb', { amount_cents: 4000, business_id: 'C', period: 'quarterly' }), // tagged for C alone
    c('old', { status: 'cancelled', amount_cents: 99900 }),
    c('once', { period: 'once', amount_cents: 50000 }),
  ];
  const shares = new Map([['canva', ['C', 'A', 'B']], ['qb', ['C']]]);
  const t = costTotals(costs, { shares });
  const cad = (map, id) => (id ? map.get(id).get('CAD') : map.get('CAD'));
  assert.deepEqual([cad(t.overall).yearly_cents, cad(t.overall).monthly_cents, cad(t.overall).count], [12000 + 6000 + 16000, 2833, 3]);
  assert.deepEqual([cad(t.byBusiness, 'A').yearly_cents, cad(t.byBusiness, 'A').monthly_cents], [4000, 333], 'a third of $120, the extra cent to the first id: none to spare here');
  assert.equal(cad(t.byBusiness, 'B').yearly_cents, 4000 + 6000);
  assert.equal(cad(t.byBusiness, 'C').yearly_cents, 4000 + 16000);
  const sum = [...t.byBusiness.values()].reduce((n, m) => n + m.get('CAD').yearly_cents, 0);
  assert.equal(sum, cad(t.overall).yearly_cents, 'the businesses’ shares add up to the full picture');
  // Counted once in each business it is used by, once overall.
  assert.deepEqual(['A', 'B', 'C'].map((id) => cad(t.byBusiness, id).count), [1, 2, 2]);

  // Without shares, nothing changes: every cost counts whole to the business that pays.
  const plain = costTotals(costs);
  assert.equal(cad(plain.byBusiness, 'A').yearly_cents, 12000 + 0, 'canva alone, whole, to A');
  assert.equal(plain.byBusiness.has('B'), true);
  assert.deepEqual(cad(plain.overall), cad(t.overall));
  // An uneven amount: the shares still add up to the cent.
  const odd = costTotals([c('x', { amount_cents: 10001 })], { shares: new Map([['x', ['A', 'B', 'C']]]) });
  assert.deepEqual(['A', 'B', 'C'].map((id) => cad(odd.byBusiness, id).yearly_cents), [3334, 3334, 3333]);
  assert.equal(cad(odd.overall).yearly_cents, 10001);
  // The resold side splits the same way.
  const resold = costTotals([c('r', { amount_cents: 3000, relationship_id: 'rel', resold_amount_cents: 5000 })], { shares: new Map([['r', ['A', 'B']]]) });
  assert.deepEqual(['A', 'B'].map((id) => cad(resold.byBusiness, id).resold_yearly_cents), [2500, 2500]);
  assert.equal(cad(resold.overall).resold_yearly_cents, 5000);
  assert.equal(costTotals([c('r', { relationship_id: 'rel', resold_amount_cents: 5000 })], { resoldLive: () => false, shares: new Map([['r', ['A', 'B']]]) }).overall.get('CAD').resold_yearly_cents, 0);
});

test('costBusinesses and costShareYearly: the tagged businesses, else the one that pays', () => {
  const cost = { id: 'k', business_id: 'A', period: 'monthly', amount_cents: 1000 };
  assert.deepEqual(costBusinesses(cost, new Map()), ['A']);
  assert.deepEqual(costBusinesses(cost, null), ['A']);
  assert.deepEqual(costBusinesses(cost, new Map([['k', []]])), ['A'], 'an empty list is no tags');
  assert.deepEqual(costBusinesses(cost, new Map([['k', ['C', 'B', 'C']]])), ['B', 'C']);
  const shares = new Map([['k', ['A', 'B', 'C']]]);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((id) => costShareYearly(cost, id, shares)), [4000, 4000, 4000, 0]);
});
