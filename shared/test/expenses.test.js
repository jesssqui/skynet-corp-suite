// Expenses (C9), shared rules: the even split to the cent, the share label, and the totals of a
// month or a business (every expense counted once, what is not assigned shown on its own).
// Invented names and amounts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCents, shareLabel, splitsByExpense, expenseTotals } from '../expenses.js';
import { BUSINESS_IDS } from '../crm.js';

const W = BUSINESS_IDS.wholesale;
const A = BUSINESS_IDS.agency;
const C = BUSINESS_IDS.consulting;
const sum = (parts) => parts.reduce((n, p) => n + p.cents, 0);

test('an even split is exact to the cent: the parts always add up to the amount', () => {
  assert.deepEqual(splitCents(10000, [A]), [{ businessId: A, cents: 10000 }]);
  assert.deepEqual(splitCents(10000, [W, A]), [
    { businessId: A, cents: 5000 }, { businessId: W, cents: 5000 },
  ].sort((x, y) => (x.businessId < y.businessId ? -1 : 1)));
  // 100.00 over three: the leftover cent goes to the first id in order, nothing is lost.
  const third = splitCents(10000, [W, A, C]);
  assert.equal(sum(third), 10000);
  assert.deepEqual(third.map((p) => p.cents).sort((x, y) => y - x), [3334, 3333, 3333]);
  for (let amount = 1; amount <= 500; amount += 1) {
    for (const ids of [[W, A], [W, A, C], [A, C, W, BUSINESS_IDS.retail]]) {
      assert.equal(sum(splitCents(amount, ids)), amount, `${amount} over ${ids.length}`);
    }
  }
});

test('the split is the same whatever order the businesses come in, and a duplicate counts once', () => {
  assert.deepEqual(splitCents(1001, [C, W, A]), splitCents(1001, [A, C, W]));
  assert.deepEqual(splitCents(1001, [W, W, A]), splitCents(1001, [W, A]));
  assert.deepEqual(splitCents(1001, []), []);
});

test('the share label: 50%, or 33.3% for a third', () => {
  assert.equal(shareLabel(1), '100%');
  assert.equal(shareLabel(2), '50%');
  assert.equal(shareLabel(3), '33.3%');
  assert.equal(shareLabel(0), '');
});

test('splits by expense: no businesses means no split (unassigned); a share of a missing expense is ignored', () => {
  const expenses = [{ id: 'e1', amount_cents: 900 }, { id: 'e2', amount_cents: 500 }];
  const shares = [
    { expense_id: 'e1', business_id: W }, { expense_id: 'e1', business_id: A }, { expense_id: 'e1', business_id: A },
    { expense_id: 'gone', business_id: C },
  ];
  const splits = splitsByExpense(expenses, shares);
  assert.equal(splits.has('e2'), false);
  assert.equal(sum(splits.get('e1')), 900);
  assert.equal(splits.get('e1').length, 2);
});

test('totals: an all-businesses total counts each expense once, and the parts plus unassigned equal it', () => {
  const expenses = [
    { id: 'shared', amount_cents: 10000, spent_on: '2026-10-03' }, // three ways
    { id: 'mine', amount_cents: 2500, spent_on: '2026-10-09' }, // agency only
    { id: 'none', amount_cents: 700, spent_on: '2026-10-11' }, // not assigned
    { id: 'lastmonth', amount_cents: 4000, spent_on: '2026-09-30' },
  ];
  const shares = [
    { expense_id: 'shared', business_id: W }, { expense_id: 'shared', business_id: A }, { expense_id: 'shared', business_id: C },
    { expense_id: 'mine', business_id: A }, { expense_id: 'lastmonth', business_id: W },
  ];
  const totals = expenseTotals(expenses, shares, { month: '2026-10' });
  assert.equal(totals.total, 10000 + 2500 + 700);
  assert.equal(totals.count, 3);
  assert.equal(totals.unassigned, 700);
  const parts = [...totals.byBusiness.values()].reduce((n, c) => n + c, 0);
  assert.equal(parts + totals.unassigned, totals.total);
  const aShare = splitCents(10000, [W, A, C]).find((p) => p.businessId === A).cents;
  assert.equal(totals.byBusiness.get(A), aShare + 2500);
});

test('totals for one business: only its share of the expenses it is tagged to', () => {
  const expenses = [{ id: 'shared', amount_cents: 10000, spent_on: '2026-10-03' }, { id: 'other', amount_cents: 999, spent_on: '2026-10-04' }];
  const shares = [{ expense_id: 'shared', business_id: W }, { expense_id: 'shared', business_id: A }, { expense_id: 'other', business_id: C }];
  const totals = expenseTotals(expenses, shares, { business: W });
  assert.equal(totals.total, 5000);
  assert.equal(totals.count, 1);
});
