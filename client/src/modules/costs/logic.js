// The Costs page's logic (D6), without React: filtering, grouping by business, totals text, where
// each cost stands, the relationship picker for resold costs, and the add/edit form's fields (only
// what changed is sent on an edit — the CRM's editChanges). Tested in client/test/costs.test.js.
import {
  costTotals, costState, costAmountText, moneyText, costCurrency, costStatus, daysFromTo, costsRenewingBetween,
  CURRENCIES, DEFAULT_CURRENCY,
} from '@suite/shared/costs';
import { addDays } from '@suite/shared/planner';
import { formatDate } from '../../ui/format.js';
import { parseDollars, centsToInput, textOrNull, KIND_LABELS, fold } from '../crm/logic.js';

export const STATUS_FILTERS = Object.freeze([
  { value: 'active', label: 'Active' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'all', label: 'All' },
]);
/** The Friday review lists costs renewing in this many days (as client services). */
export const REVIEW_DAYS = 30;

/** Costs matching the page's filters: our business ('' = all), status (active | cancelled | all), words in name, vendor or payment method. */
export function filterCosts(costs, { business = '', status = 'active', q = '' } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return costs.filter((c) => {
    if (business && c.business_id !== business) return false;
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
 * included), each with its costs (soonest first) and its totals (active ones: costTotals).
 * → { groups: [{ business, costs, totals: Map<currency, Sum> }], overall: Map<currency, Sum> }
 */
export function groupCosts(costs, businesses) {
  const order = new Map(businesses.map((b, i) => [b.id, b.position ?? 1000 + i]));
  const byBusiness = new Map();
  for (const c of costs) byBusiness.set(c.business_id, [...(byBusiness.get(c.business_id) ?? []), c]);
  const totals = costTotals(costs);
  const byId = new Map(businesses.map((b) => [b.id, b]));
  const groups = [...byBusiness.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || (a < b ? -1 : 1))
    .map(([id, list]) => ({ business: byId.get(id) ?? { id, name: 'Unknown business' }, costs: [...list].sort(compareCosts), totals: totals.byBusiness.get(id) ?? new Map() }));
  return { groups, overall: totals.overall };
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
  },
  fromRecord: (v, record) => ({
    ...v,
    currency: record ? costCurrency(record) : v.currency,
    status: record ? costStatus(record) : v.status,
    auto_renews: Boolean(record?.auto_renews ?? v.auto_renews),
    amount: centsToInput(record?.amount_cents),
    resold: centsToInput(record?.resold_amount_cents),
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
      },
    };
  },
};
