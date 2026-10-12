// The monthly target sheet's values and the fields it saves (D15), no React (client/test/overview-cards.test.js).
// A new target: a measure, an amount (dollars for the money measures, a whole number for the counts), a currency (money
// only) and notes. An edit sends only what the person changed (amount, currency, notes) — business, month and measure
// never change: a different one is a new target.
import { MEASURE_LABELS, TARGET_MEASURES, isMoneyMeasure, pickTargets, TARGET_NOTES_MAX } from '@suite/shared/targets';
import { parseDollars, centsToInput } from '../crm/logic.js';

export const MEASURE_OPTIONS = TARGET_MEASURES.map((m) => ({ value: m, label: MEASURE_LABELS[m] }));
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

/** An edit: only what changed since the sheet opened (`start`). */
export function targetEditChanges(start, v) {
  const now = targetFields(v);
  if (Object.keys(now.problems).length) return { fields: {}, problems: now.problems };
  const before = targetFields(start).fields;
  const fields = {};
  for (const [k, val] of Object.entries(now.fields)) if (before[k] !== val) fields[k] = val;
  return { fields, problems: {} };
}

/**
 * A device's targets of one business and month, one per measure (and currency): the one changed last when two devices
 * set the same one offline, with the others to remove. Device records carry who/when in `_sync`; one made here and not
 * sent yet counts as the newest.
 */
export function businessTargets(records, businessId) {
  const mine = (records ?? []).filter((r) => r.business_id === businessId)
    .map((r) => ({ ...r, updated_at: r._sync?.updatedAt ?? r._sync?.createdAt ?? ((r._sync?.local || r._sync?.pending) ? '9999' : '') }));
  return pickTargets(mine);
}

/** Measures not set yet for this business this month (the "+ Target" sheet offers these first). */
export function freeMeasure(current) {
  const used = new Set(current.filter((t) => !isMoneyMeasure(t.measure) || !t.currency).map((t) => t.measure));
  return TARGET_MEASURES.find((m) => !used.has(m)) ?? 'sales';
}
