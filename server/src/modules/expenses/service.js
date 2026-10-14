// The expenses module: registers expenses and their business shares with sync, with the module's own
// rules. It never writes its tables itself (every change is a sync step or sync.applyLocal) and reads
// nothing: the split is worked out on devices and in code from @suite/shared/expenses.
import { BUSINESS_IDS } from '@suite/shared/crm';
import { EXPENSE_AMOUNT_MAX_CENTS } from '@suite/shared/expenses';
import { EXPENSES_ENTITIES } from './entities.js';

const OUR_BUSINESS_IDS = new Set(Object.values(BUSINESS_IDS));

/**
 * An expense's amount is a whole number of cents above zero, and not more than 10 million dollars.
 * Only the step's own fields are looked at (right in any arrival order).
 */
export function checkExpense({ op, fields }) {
  if (op === 'delete' || !fields || !Object.hasOwn(fields, 'amount_cents') || fields.amount_cents === null) return null;
  const cents = fields.amount_cents;
  if (!(Number.isSafeInteger(cents) && cents >= 1 && cents <= EXPENSE_AMOUNT_MAX_CENTS)) {
    return { code: 'invalid_value', reason: `amount_cents: a whole number of cents from 1 to ${EXPENSE_AMOUNT_MAX_CENTS}` };
  }
  return null;
}

/**
 * A share names one of our businesses (Personal included). Two offline devices tagging the same
 * business are both kept: the split counts it once.
 */
export function checkExpenseShare({ op, fields }) {
  if (op !== 'create' || !fields) return null;
  if (!OUR_BUSINESS_IDS.has(fields.business_id)) return { code: 'invalid_value', reason: 'business_id: one of our businesses' };
  return null;
}

export function createExpensesService({ services }) {
  const sync = services.sync;
  if (!sync) throw new Error('expenses needs the sync module registered before it (modules/index.js)');
  if (!services.crm) throw new Error('expenses needs the crm module registered before it (shares point at its businesses)');

  const checks = { expense: checkExpense, expense_share: checkExpenseShare };
  for (const def of EXPENSES_ENTITIES) {
    sync.registerEntity({ module: 'expenses', ...def, ...(checks[def.entity] ? { check: checks[def.entity] } : {}) });
  }
  return {};
}
