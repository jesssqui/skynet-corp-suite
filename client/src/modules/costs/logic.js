// The Costs page's logic (D6), without React: filtering, grouping by business, totals text, where
// each cost stands, the relationship picker for resold costs, and the add/edit form's fields (only
// what changed is sent on an edit — the CRM's editChanges). Tested in client/test/costs.test.js.
import {
  costTotals, costState, costAmountText, moneyText, costCurrency, costStatus, daysFromTo, costsRenewingBetween,
  CURRENCIES, DEFAULT_CURRENCY, dayOfMonth, costBusinesses, costShareYearly, shareLabel, monthlyFromYearly,
} from '@suite/shared/costs';
import { addDays } from '@suite/shared/planner';
import { formatDate } from '../../ui/format.js';
import { parseDollars, centsToInput, textOrNull, KIND_LABELS, fold } from '../crm/logic.js';

export const STATUS_FILTERS = Object.freeze([
  { value: 'active', label: 'Active' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' },
]);
/** The Friday review lists costs renewing in this many days (as client services). */
export const REVIEW_DAYS = 30;

/**
 * D6b: which businesses use each cost, from the device's `cost_share` rows: Map<cost id, business ids>
 * (sorted, no repeats — two devices tagging the same business offline leave two rows). No tags = not in the map.
 */
export function sharesByCost(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    if (!r.cost_id || !r.business_id) continue;
    const list = out.get(r.cost_id) ?? [];
    if (!list.includes(r.business_id)) list.push(r.business_id);
    out.set(r.cost_id, list.sort());
  }
  return out;
}

/**
 * Costs matching the page's filters: one of our businesses ('' = all) — a cost counts for each business it is
 * tagged "used by", else for the one that pays —, status (active | cancelled | all), words in name, vendor or
 * payment method.
 */
export function filterCosts(costs, { business = '', status = 'active', q = '', shares = null } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return costs.filter((c) => {
    if (business && !costBusinesses(c, shares).includes(business)) return false;
    if (status !== 'all' && costStatus(c) !== status) return false;
    if (!words.length) return true;
    const text = fold([c.name, c.vendor, c.payment_method].filter(Boolean).join(' '));
    return words.every((w) => text.includes(w));
  });
}

/** Soonest renewal first; cancelled ones after the active ones. */
export function compareCosts(a, b) {
  const ca = costStatus(a) === 'cancelled';
  const cb = costStatus(b) === 'cancelled';
  if (ca !== cb) return ca ? 1 : -1;
  return String(a.next_renewal ?? '').localeCompare(String(b.next_renewal ?? '')) || String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1);
}

/**
 * The page's sections: one per business that has costs (in our businesses' order, Personal
 * included), each with its costs (soonest first) and its totals (active ones: costTotals; `resoldLive(cost)`
 * leaves out the resold side of a cost whose relationship, account or client isn't on the device).
 * D6b: a cost used by several businesses is listed under each of them (`shares`: Map<cost id, business ids>)
 * and each total is that business's even share; `overall` is the full amount once. A cost with no tags is
 * listed under the business that pays, whole.
 * → { groups: [{ business, costs, totals: Map<currency, Sum> }], overall: Map<currency, Sum> }
 */
export function groupCosts(costs, businesses, { resoldLive, shares = null } = {}) {
  const order = new Map(businesses.map((b, i) => [b.id, b.position ?? 1000 + i]));
  const byBusiness = new Map();
  for (const c of costs) {
    for (const id of costBusinesses(c, shares)) byBusiness.set(id, [...(byBusiness.get(id) ?? []), c]);
  }
  const totals = costTotals(costs, { ...(resoldLive ? { resoldLive } : {}), shares });
  const byId = new Map(businesses.map((b) => [b.id, b]));
  const groups = [...byBusiness.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || (a < b ? -1 : 1))
    .map(([id, list]) => ({ business: byId.get(id) ?? { id, name: 'Unknown business' }, costs: [...list].sort(compareCosts), totals: totals.byBusiness.get(id) ?? new Map() }));
  return { groups, overall: totals.overall };
}

/**
 * One business's share of a cost, for its row: { count, label, text } — "1 of 3 · 33.3%" and the share as
 * money per the cost's own period ("$1.67/mo" style via costAmountText on a copy); null when the cost is not
 * shared (one business: the whole amount is shown as it is) or has no amount or is a one-time cost.
 */
export function shareLine(cost, businessId, shares) {
  const who = costBusinesses(cost, shares);
  if (who.length < 2 || !who.includes(businessId)) return null;
  const yearly = costShareYearly(cost, businessId, shares);
  const perPeriod = { monthly: 12, quarterly: 4, yearly: 1 }[cost.period];
  const out = { count: who.length, label: `${shareLabel(who.length)} of ${cost.name}`, percent: shareLabel(who.length), text: null };
  if (perPeriod && Number.isFinite(cost.amount_cents)) {
    const cur = costCurrency(cost);
    const monthly = monthlyFromYearly(yearly);
    out.text = `${moneyText(monthly, cur)}/mo · ${moneyText(yearly, cur)}/yr`;
  }
  return out;
}

/**
 * Totals in one line: "$37/mo · $444/yr", other currencies after ("· US$5/mo · US$60/yr"); '' when none.
 * Monthly equivalent = yearly ÷ 12 (quarterly ÷ 3); one-time costs are left out.
 */
export function totalsText(sums) {
  if (!sums?.size) return '';
  const order = [...sums.keys()].sort((a, b) => (a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)));
  return order.map((cur) => {
    const s = sums.get(cur);
    return `${moneyText(s.monthly_cents, cur)}/mo · ${moneyText(s.yearly_cents, cur)}/yr`;
  }).join(' · ');
}

/** What clients pay us for the resold costs among them, in one line ("$40/mo · $480/yr resold"); '' when none. */
export function resoldTotalsText(sums) {
  if (!sums?.size) return '';
  return [...sums.entries()].filter(([, s]) => s.resold_yearly_cents)
    .map(([cur, s]) => `${moneyText(s.resold_monthly_cents, cur)}/mo · ${moneyText(s.resold_yearly_cents, cur)}/yr`).join(' · ');
}

/**
 * Where a cost stands, for its row: { text, tone } (tone for a Badge).
 * Overdue = its date has passed and it doesn't renew on its own: "Overdue — renewed?" (set the next date).
 */
export function renewalLabel(cost, today) {
  const date = formatDate(cost.next_renewal);
  switch (costState(cost, today)) {
    case 'cancelled': return { text: 'Cancelled', tone: 'neutral' };
    case 'past': return { text: `Paid once · ${date}`, tone: 'neutral' };
    case 'rolling': return { text: `Renewed on its own ${date} · the suite moves it to the next date tomorrow morning`, tone: 'neutral' };
    case 'overdue': return { text: `Overdue — renewed? (was due ${date})`, tone: 'warn' };
    case 'today': return { text: 'Renews today', tone: 'warn' };
    case 'soon': {
      const n = daysFromTo(today, cost.next_renewal);
      return { text: n === 1 ? 'Renews tomorrow' : `Renews in ${n} days`, tone: 'accent' };
    }
    default: return { text: `Renews ${date}`, tone: 'neutral' };
  }
}

/** "Hosting — we pay $300/yr, they pay $480/yr" (a resold cost on the client page). */
export function resoldLine(cost) {
  const we = costAmountText(cost);
  const they = costAmountText(cost, 'resold_amount_cents');
  const parts = [we ? `we pay ${we}` : null, they ? `they pay ${they}` : null].filter(Boolean);
  return `${cost.name}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
}

/** Active costs renewing today … in 30 days (the Friday review), soonest first. */
export function costRenewalsDue(costs, today, days = REVIEW_DAYS) {
  return costsRenewingBetween(costs, today, addDays(today, days));
}

/**
 * Relationships a cost can be resold on: of live accounts and clients, active clients first,
 * grouped by client — and the cost's own one even if it is no longer pickable.
 * → [{ value, label, group }]
 */
export function relationshipOptions({ relationships, accounts, clients, businesses }, keep = null) {
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const businessesById = new Map(businesses.map((b) => [b.id, b]));
  const rows = [];
  for (const r of relationships) {
    const account = accountsById.get(r.account_id);
    const client = account ? clientsById.get(account.client_id) : null;
    if (!client) continue;
    if (r.id !== keep && (client.status === 'closed' || r.status === 'ended')) continue;
    const business = businessesById.get(r.business_id);
    rows.push({
      value: r.id,
      group: client.name,
      label: `${account.name !== client.name ? `${account.name} — ` : ''}${business?.name ?? 'Unknown business'} · ${KIND_LABELS[r.kind] ?? r.kind}`,
      sort: `${client.name}\u0000${account.name}`,
    });
  }
  if (keep && !rows.some((r) => r.value === keep)) rows.push({ value: keep, group: 'Other', label: '(a relationship this device doesn’t have)', sort: '￿' });
  return rows.sort((a, b) => a.sort.localeCompare(b.sort, undefined, { sensitivity: 'base' }) || a.label.localeCompare(b.label)).map(({ sort, ...o }) => o);
}

export const currencyOptions = (current) => [...new Set([...CURRENCIES, ...(current ? [current] : [])])].map((c) => ({ value: c, label: c }));

/** The add/edit form (the CRM's useForm shape: defaults, fromRecord, toFields). Money typed in dollars. */
export const costForm = {
  defaults: {
    name: '', business_id: '', vendor: '', amount: '', currency: DEFAULT_CURRENCY, period: 'yearly', next_renewal: '', payment_method: '',
    auto_renews: false, status: 'active', notes: '', relationship_id: '', resold: '',
    // The billing day (anchor_day) goes with the date: kept as stored while the date isn't changed,
    // else the new date's day (date0 = the date the form opened with).
    anchor_day: '', date0: '',
    // D6b: the businesses that use it, as sorted ids joined by commas (a string, so the form's "changed?" check
    // compares it like any other input). Not a field of the cost: saved as cost_share rows (shareChanges).
    used_by: '',
  },
  fromRecord: (v, record) => ({
    ...v,
    currency: record ? costCurrency(record) : v.currency,
    status: record ? costStatus(record) : v.status,
    auto_renews: Boolean(record?.auto_renews ?? v.auto_renews),
    amount: centsToInput(record?.amount_cents),
    resold: centsToInput(record?.resold_amount_cents),
    anchor_day: record?.anchor_day ?? '',
    date0: record?.next_renewal ?? '',
  }),
  toFields(v) {
    const amount = parseDollars(v.amount);
    const resold = v.relationship_id ? parseDollars(v.resold) : null;
    const problems = {};
    if (!textOrNull(v.name)) problems.name = 'Give it a name';
    if (!v.business_id) problems.business_id = 'Pick one of our businesses (Personal for the home)';
    if (!v.next_renewal) problems.next_renewal = 'When does it renew (or get paid)?';
    if (Number.isNaN(amount)) problems.amount = 'Enter dollars, like 120 or 19.99';
    if (Number.isNaN(resold)) problems.resold = 'Enter dollars, like 180';
    return {
      problems,
      fields: {
        name: textOrNull(v.name), business_id: v.business_id || null, vendor: textOrNull(v.vendor), amount_cents: amount,
        currency: v.currency || DEFAULT_CURRENCY, period: v.period, next_renewal: v.next_renewal || null,
        payment_method: textOrNull(v.payment_method), auto_renews: Boolean(v.auto_renews), status: v.status || 'active',
        notes: textOrNull(v.notes), relationship_id: v.relationship_id || null, resold_amount_cents: resold,
        anchor_day: !v.next_renewal ? null
          : v.next_renewal === v.date0 && v.anchor_day !== '' && v.anchor_day !== null ? Number(v.anchor_day) : dayOfMonth(v.next_renewal),
      },
    };
  },
};

/** The form's "used by" value (sorted ids joined by commas) <-> a list of business ids. */
export const usedByList = (value) => [...new Set(String(value ?? '').split(',').filter(Boolean))].sort();
export const usedByValue = (ids) => usedByList((ids ?? []).join(',')).join(',');
export const toggleUsedBy = (value, businessId, on) => {
  const set = new Set(usedByList(value));
  if (on) set.add(businessId); else set.delete(businessId);
  return [...set].sort().join(',');
};

/**
 * What saving "used by" must do, from the share rows now on the device for this cost and the ids ticked:
 * { add: [business ids with no row], remove: [row ids to delete — every copy of an unticked business, and
 * rows for a business named twice beyond the first] }. Nothing to do when they already agree.
 */
export function shareChanges(rows, wanted) {
  const want = new Set(usedByList(Array.isArray(wanted) ? wanted.join(',') : wanted));
  const seen = new Set();
  const remove = [];
  for (const r of rows) {
    if (!want.has(r.business_id) || seen.has(r.business_id)) remove.push(r.id);
    else seen.add(r.business_id);
  }
  return { add: [...want].filter((id) => !seen.has(id)), remove };
}

/**
 * Make a cost's "used by" rows match `wanted` (the form's value): add the missing, delete the unticked and
 * any repeat. `store` is the offline store (or an engine in tests). It works from the rows on the device now,
 * so Save again after a failure part-way only does what is left.
 */
export async function applyUsedBy(store, costId, wanted) {
  const rows = await store.list('cost_share', { where: { cost_id: costId } });
  const { add, remove } = shareChanges(rows, wanted);
  for (const businessId of add) await store.create('cost_share', { cost_id: costId, business_id: businessId });
  for (const id of remove) await store.remove('cost_share', id);
  return { added: add.length, removed: remove.length };
}
