// The expenses' synced record types (C9): an expense (one amount, paid once) and its shares (one
// per business it is for). Registered with sync at start-up; devices learn them from GET /api/sync/info.
// A share points at an expense as its parent: deleting the expense hides its shares. Money is whole
// cents (see @suite/shared/expenses for the even split).
import { EXPENSE_DESCRIPTION_MAX, EXPENSE_CATEGORY_MAX, EXPENSE_NOTES_MAX } from '@suite/shared/expenses';

export const EXPENSES_ENTITIES = [
  {
    entity: 'expense',
    table: 'expenses_items',
    // Delete is for mistakes; an expense is not edited into another one.
    ops: ['create', 'update', 'delete'],
    fields: {
      description: { type: 'text', max: EXPENSE_DESCRIPTION_MAX, required: true },
      amount_cents: { type: 'integer', required: true }, // checked by the module (checkExpense)
      spent_on: { type: 'date', required: true },
      category: { type: 'text', max: EXPENSE_CATEGORY_MAX },
      notes: { type: 'text', max: EXPENSE_NOTES_MAX },
    },
  },
  {
    // "This expense is for this business." Created or deleted, never edited (like links): an
    // expense is for a business or not, and a repeated share is harmless (it counts once).
    entity: 'expense_share',
    table: 'expenses_shares',
    ops: ['create', 'delete'],
    fields: {
      expense_id: { type: 'id', ref: 'expense', parent: true, required: true },
      business_id: { type: 'id', ref: 'business', required: true }, // one of ours (checkExpenseShare)
    },
  },
];
