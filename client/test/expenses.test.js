// Expenses (C9), the screens' logic without React: the expense form's values and what is saved
// (only what changed), the business tags' changes, and the month and business summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { expenseFormValues, expenseFieldsFrom, tagChanges, summarize, monthOf, monthLabel } from '../src/modules/expenses/logic.js';

const W = BUSINESS_IDS.wholesale;
const A = BUSINESS_IDS.agency;
const C = BUSINESS_IDS.consulting;

test('a new expense: the form starts empty; saving checks the description, the amount and the date', () => {
  const v = expenseFormValues(null);
  assert.equal(v.spent_on, '');
  assert.equal(expenseFieldsFrom(v).error, 'Describe the expense.');
  const ok = expenseFieldsFrom({ ...v, description: ' Invented ink ', amount: '1,234.5', spent_on: '2026-10-03', businesses: [W] });
  assert.equal(ok.error, null);
  assert.deepEqual(ok.fields, {
    description: 'Invented ink', amount_cents: 123450, spent_on: '2026-10-03', paid_by: null, category: null, notes: null,
  });
  assert.match(expenseFieldsFrom({ ...v, description: 'x', amount: '12.345', spent_on: '2026-10-03' }).error, /amount/i);
  assert.match(expenseFieldsFrom({ ...v, description: 'x', amount: '0', spent_on: '2026-10-03' }).error, /amount/i);
  assert.match(expenseFieldsFrom({ ...v, description: 'x', amount: '5', spent_on: '2026-02-30' }).error, /date/i);
});

test('an edit saves only what changed, and a business-free expense is allowed', () => {
  const record = { id: 'e1', description: 'Hosting', amount_cents: 2400, spent_on: '2026-10-01', paid_by: 'owner', category: 'Web', notes: '' };
  const v = expenseFormValues(record, [W]);
  assert.equal(v.amount, '24');
  const unchanged = expenseFieldsFrom(v, record);
  assert.deepEqual(unchanged.changed, {}); // nothing typed: nothing sent
  const edited = expenseFieldsFrom({ ...v, amount: '25.50', businesses: [] }, record);
  assert.deepEqual(edited.changed, { amount_cents: 2550 });
  assert.equal(edited.error, null);
});

test('business tags: the ones added and removed, nothing for the ones kept', () => {
  const shares = [{ id: 's1', business_id: W }, { id: 's2', business_id: A }];
  assert.deepEqual(tagChanges(shares, [A, C]), { add: [C], remove: ['s1'] });
  assert.deepEqual(tagChanges(shares, [W, A]), { add: [], remove: [] });
  assert.deepEqual(tagChanges([], []), { add: [], remove: [] });
});

test('the summary: all businesses shows the true total; a business shows its own share', () => {
  const expenses = [
    { id: 'shared', description: 'Shared', amount_cents: 10000, spent_on: '2026-10-03', paid_by: null },
    { id: 'alone', description: 'Alone', amount_cents: 2500, spent_on: '2026-10-09', paid_by: null },
    { id: 'none', description: 'None', amount_cents: 700, spent_on: '2026-09-30', paid_by: null },
  ];
  const shares = [{ expense_id: 'shared', business_id: W }, { expense_id: 'shared', business_id: A }, { expense_id: 'alone', business_id: A }];
  const all = summarize(expenses, shares, { month: '2026-10' });
  assert.deepEqual(all.rows.map((r) => r.id), ['alone', 'shared']); // newest first
  assert.equal(all.total, 12500);
  assert.equal(all.unassigned, 0);
  const wholesale = summarize(expenses, shares, { month: '2026-10', business: W });
  assert.equal(wholesale.total, 5000);
  assert.deepEqual(wholesale.rows.map((r) => r.id), ['shared']);
});

test('months: "YYYY-MM" of a day, and a readable label', () => {
  assert.equal(monthOf('2026-10-13'), '2026-10');
  assert.equal(monthLabel('2026-10'), 'October 2026');
});
