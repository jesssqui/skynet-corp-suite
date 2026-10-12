// The monthly target sheet's values and the fields it saves (D15), no React (client/test/overview-cards.test.js).
// A new target: a measure, an amount (dollars for the money measures, a whole number for the counts), a currency (money
// only) and notes. An edit sends only what the person changed (amount, currency, notes) — business, month and measure
// never change: a different one is a new target.
import { MEASURE_LABELS, TARGET_MEASURES, isMoneyMeasure, pickTargets, measuresFor, TARGET_NOTES_MAX } from '@suite/shared/targets';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { parseDollars, centsToInput } from '../crm/logic.js';

export const MEASURE_OPTIONS = TARGET_MEASURES.map((m) => ({ value: m, label: MEASURE_LABELS[m] }));
/** What a business's target may measure (Personal — the home — doesn't sell: no sales, net sales or orders). */
export const measureOptionsFor = (businessId) => measuresFor(businessId, BUSINESS_IDS.personal).map((m) => ({ value: m, label: MEASURE_LABELS[m] }));
export const TARGET_CURRENCIES = Object.freeze(['CAD', 'USD', 'EUR', 'GBP']);

/** The sheet's values from a target (or a new one's defaults). */
export function targetValues(record = null, { measure = 'sales' } = {}) {
  if (!record) return { measure, amount: '', currency: 'CAD', notes: '' };
  return {
    measure: record.measure,
    amount: isMoneyMeasure(record.measure) ? centsToInput(record.amount) : String(record.amount ?? ''),
    currency: record.currency ?? 'CAD',
    notes: record.notes ?? '',
  };
}

/** Values → { fields, problems }: amount above 0 (dollars → cents for money), currency only for money (CAD → null). */
export function targetFields(v) {
  const problems = {};
  const money = isMoneyMeasure(v.measure);
  let amount = null;
  if (money) {
    amount = parseDollars(v.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0) problems.amount = 'An amount in dollars, like 12,000';
  } else {
    const s = String(v.amount ?? '').trim().replace(/,/g, '');
    amount = /^\d+$/.test(s) ? Number(s) : Number.NaN;
    if (!Number.isSafeInteger(amount) || amount <= 0) problems.amount = 'A whole number above 0';
  }
  if (!TARGET_MEASURES.includes(v.measure)) problems.measure = 'Choose what to measure';
  const notes = String(v.notes ?? '').trim();
  if (notes.length > TARGET_NOTES_MAX) problems.notes = `At most ${TARGET_NOTES_MAX} characters`;
  const fields = { amount, currency: money && v.currency && v.currency !== 'CAD' ? v.currency : null, notes: notes || null };
  return { fields, problems };
}

/** A new target's fields (business and month from where it is made). */
export function newTargetFields(v, { businessId, month }) {
  const r = targetFields(v);
  return { fields: { business_id: businessId, month, measure: v.measure, ...r.fields }, problems: r.problems };
}

/** An edit: only what changed since the sheet opened (`start`) — the amount and notes; the currency is fixed. */
export function targetEditChanges(start, v) {
  const now = targetFields({ ...v, currency: start.currency });
  if (Object.keys(now.problems).length) return { fields: {}, problems: now.problems };
  const before = targetFields(start).fields;
  const fields = {};
  for (const [k, val] of Object.entries(now.fields)) if (k !== 'currency' && before[k] !== val) fields[k] = val;
  return { fields, problems: {} };
}

/**
 * A device's targets of one business and month, one per measure (and currency): the one changed last when two devices
 * set the same one offline, with the others to remove. Device records carry who/when in `_sync`; one with a change
 * waiting to be sent counts as the newest.
 */
export function businessTargets(records, businessId) {
  // A change waiting to be sent from here is the newest; otherwise the pulled times, and without one the ids decide.
  const mine = (records ?? []).filter((r) => r.business_id === businessId)
    .map((r) => ({ ...r, updated_at: r._sync?.pending ? '9999' : (r._sync?.updatedAt ?? r._sync?.createdAt ?? null), created_at: null }));
  return pickTargets(mine);
}

/** Measures not set yet for this business this month (the "+ Target" sheet offers these first). */
export function freeMeasure(current, businessId = null) {
  const used = new Set(current.filter((t) => !isMoneyMeasure(t.measure) || !t.currency).map((t) => t.measure));
  const allowed = measuresFor(businessId, BUSINESS_IDS.personal);
  return allowed.find((m) => !used.has(m)) ?? allowed[0];
}
