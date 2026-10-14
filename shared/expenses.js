// Expenses facts shared by the server and devices (C9): the limits of an expense's fields, and the
// rule for money that more than one of our businesses uses. An expense is one amount paid once;
// it is tagged with the businesses it is for (expense_share records). A tagged expense is split
// evenly between its businesses, to the cent: the shares always add up to the amount. Nothing
// stores a percentage — "33.3%" is only how a third is shown. See CLAUDE.md, "Expenses (C9)".

export const EXPENSE_DESCRIPTION_MAX = 200;
export const EXPENSE_CATEGORY_MAX = 80;
export const EXPENSE_NOTES_MAX = 20_000;
/** Amounts are whole cents, more than 0 and at most 10 million dollars. */
export const EXPENSE_AMOUNT_MAX_CENTS = 1_000_000_000;

/**
 * An expense's amount split evenly between the businesses it is for: [{ businessId, cents }],
 * sorted by business id (the same on every device). The cents that do not divide evenly go one
 * each to the first businesses in that order, so the parts always add up to the amount exactly
 * (100.00 over three -> 33.34, 33.33, 33.33). Duplicate ids count once. No businesses -> [].
 */
export function splitCents(amountCents, businessIds) {
  const ids = [...new Set(businessIds)].sort();
  const n = ids.length;
  if (!n) return [];
  const base = Math.floor(amountCents / n);
  let extra = amountCents - base * n;
  return ids.map((businessId) => {
    const cents = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    return { businessId, cents };
  });
}

/**
 * What one share of an even split is, as shown: 50%, or 33.3% for a third (the exact cents are
 * in splitCents). '' for no businesses.
 */
export function shareLabel(count) {
  if (!(count > 0)) return '';
  const percent = 100 / count;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * The split of every expense: Map expenseId -> [{ businessId, cents }]. `expenses` and `shares` are
 * live records ({ id, amount_cents } and { expense_id, business_id }). An expense with no shares
 * has no entry (it is not assigned to any business); a share whose expense is missing is ignored.
 */
export function splitsByExpense(expenses, shares) {
  const amounts = new Map(expenses.map((e) => [e.id, e.amount_cents]));
  const byExpense = new Map();
  for (const s of shares) {
    if (!amounts.has(s.expense_id)) continue;
    if (!byExpense.has(s.expense_id)) byExpense.set(s.expense_id, new Set());
    byExpense.get(s.expense_id).add(s.business_id);
  }
  return new Map([...byExpense].map(([id, ids]) => [id, splitCents(amounts.get(id), [...ids])]));
}

/**
 * Totals for a set of expenses (optionally one month, "YYYY-MM", and/or one business):
 *  - total: what was spent (every expense once, tagged or not, never counted twice);
 *  - byBusiness: Map businessId -> cents, each business's shares of the tagged expenses;
 *  - unassigned: cents of expenses with no business.
 * Money is exact to the cent, so byBusiness plus unassigned always equals total.
 * `business` limits the expenses to those tagged with it: total is then that business's share.
 */
export function expenseTotals(expenses, shares, { month = null, business = null } = {}) {
  const splits = splitsByExpense(expenses, shares);
  const byBusiness = new Map();
  let total = 0;
  let unassigned = 0;
  let count = 0;
  for (const e of expenses) {
    if (month && !String(e.spent_on).startsWith(month)) continue;
    const parts = splits.get(e.id) ?? [];
    if (business) {
      const mine = parts.find((p) => p.businessId === business);
      if (!mine) continue;
      total += mine.cents;
    } else {
      total += e.amount_cents;
    }
    count += 1;
    if (!parts.length) unassigned += e.amount_cents;
    for (const p of parts) byBusiness.set(p.businessId, (byBusiness.get(p.businessId) ?? 0) + p.cents);
  }
  return { total, count, byBusiness, unassigned };
}
