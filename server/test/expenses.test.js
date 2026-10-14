// Expenses (C9) on the server: the two record types registered with sync (fields, parent, ops), the
// amount and business rules, the migration's tables, and applyLocal writing an expense with its
// shares as sync steps (the rows a device pulls). Invented names and amounts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { EXPENSE_AMOUNT_MAX_CENTS } from '@suite/shared/expenses';
import { checkExpense, checkExpenseShare } from '../src/modules/expenses/service.js';
import { EXPENSES_ENTITIES } from '../src/modules/expenses/entities.js';
import { tmpDir, testConfig, startApp } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const A = BUSINESS_IDS.agency;
const ID = '01a1163c-9999-7000-8000-000000000001';

test('the expense and share record types: fields, the share as a child of its expense, ops', () => {
  const expense = EXPENSES_ENTITIES.find((e) => e.entity === 'expense');
  const share = EXPENSES_ENTITIES.find((e) => e.entity === 'expense_share');
  assert.equal(expense.table, 'expenses_items');
  assert.equal(share.table, 'expenses_shares');
  assert.equal(expense.fields.amount_cents.type, 'integer');
  assert.equal(expense.fields.spent_on.type, 'date');
  assert.deepEqual(share.ops, ['create', 'delete']); // never edited, like links
  assert.equal(share.fields.expense_id.parent, true);
  assert.equal(share.fields.business_id.ref, 'business');
});

test('an amount is whole cents from 1 to the limit; a delete or a step without an amount is not looked at', () => {
  assert.equal(checkExpense({ op: 'create', fields: { amount_cents: 1 } }), null);
  assert.equal(checkExpense({ op: 'create', fields: { amount_cents: EXPENSE_AMOUNT_MAX_CENTS } }), null);
  assert.equal(checkExpense({ op: 'update', fields: { description: 'Only the text' } }), null);
  assert.equal(checkExpense({ op: 'delete' }), null);
  for (const bad of [0, -5, 12.5, EXPENSE_AMOUNT_MAX_CENTS + 1, '100']) {
    assert.equal(checkExpense({ op: 'create', fields: { amount_cents: bad } })?.code, 'invalid_value', String(bad));
  }
});

test('a share names one of our businesses (Personal and the seeded ones), and is only created', () => {
  assert.equal(checkExpenseShare({ op: 'create', fields: { expense_id: ID, business_id: W } }), null);
  assert.equal(checkExpenseShare({ op: 'create', fields: { expense_id: ID, business_id: BUSINESS_IDS.personal } }), null);
  assert.equal(checkExpenseShare({ op: 'create', fields: { expense_id: ID, business_id: ID } })?.code, 'invalid_value');
  assert.equal(checkExpenseShare({ op: 'delete' }), null);
});

test('the migration makes both tables, and an expense with its shares is written as sync steps', async (t) => {
  const env = await startApp(t, testConfig(tmpDir(t)));
  const tables = env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'expenses_%' ORDER BY name").all();
  assert.deepEqual(tables.map((r) => r.name), ['expenses_items', 'expenses_shares']);

  const sync = env.ctx.services.sync;
  const made = sync.applyLocal({
    actor: 'owner', entity: 'expense', op: 'create',
    fields: { description: 'Invented printer toner', amount_cents: 10000, spent_on: '2026-10-03', category: 'Office' },
  });
  assert.equal(made.status, 'applied');
  for (const business_id of [W, A]) {
    const share = sync.applyLocal({ actor: 'owner', entity: 'expense_share', op: 'create', fields: { expense_id: made.recordId, business_id } });
    assert.equal(share.status, 'applied');
  }
  const row = env.db.prepare('SELECT description, amount_cents, spent_on, category, created_by FROM expenses_items WHERE id = ?').get(made.recordId);
  assert.deepEqual({ ...row }, {
    description: 'Invented printer toner', amount_cents: 10000, spent_on: '2026-10-03', category: 'Office', created_by: 'owner',
  });
  const shares = env.db.prepare('SELECT business_id FROM expenses_shares WHERE expense_id = ? AND deleted_at IS NULL ORDER BY business_id').all(made.recordId);
  assert.deepEqual(shares.map((r) => r.business_id), [W, A].sort());

  // A refused amount is refused as a step, and nothing is written.
  const bad = sync.applyLocal({ actor: 'owner', entity: 'expense', op: 'create', fields: { description: 'Zero', amount_cents: 0, spent_on: '2026-10-03' } });
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.code, 'invalid_value');
  assert.equal(env.db.prepare("SELECT count(*) AS n FROM expenses_items WHERE description = 'Zero'").get().n, 0);
});
