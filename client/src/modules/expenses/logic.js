// The expenses screens' logic (C9), without React: the form's values and what is saved (only what
// changed), the business tags' changes, and the summary of a month or one business. The money rules
// (the even split to the cent) are in @suite/shared/expenses.
import { parseDollars, centsToInput } from '../crm/logic.js';
import {
  EXPENSE_DESCRIPTION_MAX, EXPENSE_CATEGORY_MAX, EXPENSE_NOTES_MAX, EXPENSE_AMOUNT_MAX_CENTS,
  splitsByExpense, expenseTotals,
} from '@suite/shared/expenses';

/** "YYYY-MM" of a "YYYY-MM-DD" day. */
export function monthOf(ymd) {
  return String(ymd ?? '').slice(0, 7);
}

/** "October 2026" for "2026-10". */
export function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** A real calendar day as "YYYY-MM-DD" (2026-02-30 is not one). */
export function isDay(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const textOrNull = (value) => {
  const t = String(value ?? '').trim();
  return t === '' ? null : t;
};

/** The form's starting values: an expense's own, or empty; `businessIds` are the ones it is tagged to. */
export function expenseFormValues(record, businessIds = []) {
  return {
    description: record?.description ?? '',
    amount: record ? centsToInput(record.amount_cents) : '',
    spent_on: record?.spent_on ?? '',
    paid_by: record?.paid_by ?? '',
    category: record?.category ?? '',
    notes: record?.notes ?? '',
    businesses: [...businessIds],
  };
}

/**
 * The form's values as the record's fields. `error` is what to tell the person (or null). With a
 * `record`, `changed` holds only the fields that differ from it: an edit sends what was changed,
 * never the whole form, so a change by the other person survives (CLAUDE.md, the CRM's forms).
 */
export function expenseFieldsFrom(values, record = null) {
  const description = textOrNull(values.description);
  if (!description) return { error: 'Describe the expense.', fields: null, changed: null };
  if (description.length > EXPENSE_DESCRIPTION_MAX) {
    return { error: `The description is longer than ${EXPENSE_DESCRIPTION_MAX} characters.`, fields: null, changed: null };
  }
  const cents = parseDollars(values.amount);
  if (cents === null || Number.isNaN(cents) || cents < 1 || cents > EXPENSE_AMOUNT_MAX_CENTS) {
    return { error: 'Type the amount in dollars, more than 0, like 12.50.', fields: null, changed: null };
  }
  if (!isDay(values.spent_on)) return { error: 'Pick the date it was spent.', fields: null, changed: null };
  const category = textOrNull(values.category);
  if (category && category.length > EXPENSE_CATEGORY_MAX) {
    return { error: `The category is longer than ${EXPENSE_CATEGORY_MAX} characters.`, fields: null, changed: null };
  }
  const notes = textOrNull(values.notes);
  if (notes && notes.length > EXPENSE_NOTES_MAX) return { error: 'The notes are too long.', fields: null, changed: null };
  const fields = {
    description,
    amount_cents: cents,
    spent_on: values.spent_on,
    paid_by: textOrNull(values.paid_by),
    category,
    notes,
  };
  if (!record) return { error: null, fields, changed: fields };
  const before = {
    description: record.description,
    amount_cents: record.amount_cents,
    spent_on: record.spent_on,
    paid_by: textOrNull(record.paid_by),
    category: textOrNull(record.category),
    notes: textOrNull(record.notes),
  };
  const changed = {};
  for (const key of Object.keys(fields)) if (before[key] !== fields[key]) changed[key] = fields[key];
  return { error: null, fields, changed };
}

/**
 * The business tags to add and remove, given the expense's current shares ({ id, business_id }) and
 * the businesses the form has ticked. A tag already there is kept as it is.
 */
export function tagChanges(shares, wanted) {
  const want = new Set(wanted);
  const have = new Set(shares.map((s) => s.business_id));
  return {
    add: [...want].filter((id) => !have.has(id)).sort(),
    remove: shares.filter((s) => !want.has(s.business_id)).map((s) => s.id),
  };
}

const newestFirst = (a, b) => (b.spent_on < a.spent_on ? -1 : b.spent_on > a.spent_on ? 1 : (a.id < b.id ? -1 : 1));

/**
 * The expenses list and its totals for one month and/or one business: `rows` newest first, each
 * with its `splits` (from splitsByExpense), and the totals of expenseTotals.
 */
export function summarize(expenses, shares, { month = null, business = null } = {}) {
  const splits = splitsByExpense(expenses, shares);
  const rows = expenses
    .filter((e) => !month || String(e.spent_on).startsWith(month))
    .filter((e) => !business || (splits.get(e.id) ?? []).some((p) => p.businessId === business))
    .sort(newestFirst);
  return { ...expenseTotals(expenses, shares, { month, business }), rows, splits };
}
