// Sales page logic (pure, tested in client/test/sales.test.js): the periods, typed amounts, the
// list of entries, and "this channel already has an entry that day".
import { addDays, weekStart, monthStart } from '@suite/shared/planner';
import { SALE_AMOUNT_MAX } from '@suite/shared/sales';

export const PERIODS = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'all', label: 'All time' },
];

function monthEnd(first) {
  const [y, m] = first.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

/** { from, to } ("YYYY-MM-DD", inclusive; null = no limit) of a period around `today`. Weeks start on Monday. */
export function periodRange(kind, today) {
  if (kind === 'week') {
    const from = weekStart(today);
    return { from, to: addDays(from, 6) };
  }
  if (kind === 'month') {
    const from = monthStart(today);
    return { from, to: monthEnd(from) };
  }
  if (kind === 'last_month') {
    const lastDay = addDays(monthStart(today), -1);
    return { from: monthStart(lastDay), to: lastDay };
  }
  return { from: null, to: null };
}

/** What a person typed for an amount ("182.50", "$1,200") -> { value } in dollars, or { error }. */
export function parseAmount(text) {
  const t = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return { error: 'Enter the amount sold' };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { error: 'Dollars and cents, like 182.50' };
  const value = Number(t);
  if (value > SALE_AMOUNT_MAX) return { error: `At most ${SALE_AMOUNT_MAX.toLocaleString('en-CA')}` };
  return { value };
}

const CAD = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
export const money = (n) => CAD.format(n ?? 0);

/** Entries of one business inside a range, newest day first (then by channel, then oldest entry first). */
export function listEntries(records, { businessId, from = null, to = null }) {
  return records
    .filter((r) => r.business_id === businessId && !(from && r.sale_date < from) && !(to && r.sale_date > to))
    .sort((a, b) => (a.sale_date === b.sale_date
      ? (a.channel === b.channel ? (a.id < b.id ? -1 : 1) : (a.channel < b.channel ? -1 : 1))
      : (a.sale_date < b.sale_date ? 1 : -1)));
}

/** What the other entries for this channel and day already add up to (null when there are none). */
export function sameDayTotal(records, { businessId, date, channel, excludeId = null }) {
  const same = records.filter((r) => r.business_id === businessId && r.sale_date === date && r.channel === channel && r.id !== excludeId);
  return same.length ? Math.round(same.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100 : null;
}
