// Renewals and recurring costs (D6): registers the `recurring_cost` record type with sync (with the
// module's own checks), reads costs for other modules (the overview's monthly totals — D15 —, the
// Friday review's renewals), and registers the two renewal-reminder automations (reminders.js).
// It never writes its table itself: devices write through sync steps, the suite (rolling an
// auto-renewing cost forward) through sync.applyLocal — the sync module's guard makes any other
// write fail. It reads only its own table; CRM and planner records through their services.
import { isCurrency, costTotals, costsRenewingBetween } from '@suite/shared/costs';
import { COST_ENTITY } from './entities.js';
import { registerRenewalAutomations } from './reminders.js';

/**
 * Rules for a cost step that are right in any arrival order (only the step's own values): the
 * currency is three capital letters (ISO 4217's shape), amounts are 0 or more.
 */
export function checkCost({ op, fields }) {
  if (op === 'delete' || !fields) return null;
  const has = (k) => Object.hasOwn(fields, k) && fields[k] !== null;
  if (has('currency') && !isCurrency(fields.currency)) return { code: 'invalid_value', reason: 'currency: three capital letters, like CAD or USD' };
  for (const k of ['amount_cents', 'resold_amount_cents']) {
    if (has(k) && !(fields[k] >= 0)) return { code: 'invalid_value', reason: `${k}: 0 or more` };
  }
  return null;
}

const SUM_FIELDS = ['count', 'monthly_cents', 'yearly_cents', 'resold_monthly_cents', 'resold_yearly_cents'];
const currencyOrder = (a, b) => (a === 'CAD' ? -1 : b === 'CAD' ? 1 : a.localeCompare(b));
const row = (currency, sum) => ({ currency, ...Object.fromEntries(SUM_FIELDS.map((k) => [k, sum[k]])) });

export function createCostsService({ db, services }) {
  const { sync, crm, planner } = services;
  if (!sync) throw new Error('costs needs the sync module registered before it (modules/index.js)');
  if (!crm || !planner) throw new Error('costs needs the crm and planner modules registered before it (its costs belong to our businesses; its reminders are tasks)');
  sync.registerEntity({ module: 'costs', ...COST_ENTITY, check: checkCost });

  const q = {
    live: db.prepare('SELECT * FROM costs_recurring WHERE deleted_at IS NULL ORDER BY next_renewal, id'),
    one: db.prepare('SELECT * FROM costs_recurring WHERE id = ? AND deleted_at IS NULL'),
    renewing: db.prepare(`SELECT * FROM costs_recurring WHERE deleted_at IS NULL AND (status IS NULL OR status = 'active')
      AND next_renewal BETWEEN ? AND ? ORDER BY next_renewal, id`),
    passed: db.prepare(`SELECT * FROM costs_recurring WHERE deleted_at IS NULL AND (status IS NULL OR status = 'active')
      AND auto_renews = 1 AND period <> 'once' AND next_renewal < ? ORDER BY next_renewal, id`),
  };
  const asCost = (r) => (r ? { ...r, auto_renews: r.auto_renews === null ? null : r.auto_renews === 1 } : null);

  const reads = {
    /** One live cost (booleans as true/false), or null. */
    cost: (id) => asCost(q.one.get(id)),
    /** Active costs whose next renewal is from..to ("YYYY-MM-DD", inclusive), soonest first. */
    renewingBetween: (from, to) => costsRenewingBetween(q.renewing.all(from, to).map(asCost), from, to),
    /** Active auto-renewing costs (not once) whose next renewal is before `today` (to roll forward). */
    autoRenewingPassed: (today) => q.passed.all(today).map(asCost),
  };

  const service = {
    ...reads,
    /** Every live cost (any status), soonest renewal first. */
    liveCosts: () => q.live.all().map(asCost),
    /**
     * For the overview (D15): the monthly equivalent (yearly ÷ 12, quarterly ÷ 3; once left out) and
     * yearly total of ACTIVE costs, per business and overall, per currency (never added across
     * currencies). Businesses in their usual order (position), CAD first.
     * → { businesses: [{ business_id, name, currency, count, monthly_cents, yearly_cents,
     *       resold_monthly_cents, resold_yearly_cents }], overall: [{ currency, … }] }
     * resold_* = what clients pay us for the resold ones among them (same periods).
     */
    monthlyTotals() {
      const { byBusiness, overall } = costTotals(service.liveCosts());
      const order = new Map(crm.listBusinesses().map((b, i) => [b.id, { i, name: b.name }]));
      const businesses = [...byBusiness.entries()]
        .sort(([a], [b]) => (order.get(a)?.i ?? 1e9) - (order.get(b)?.i ?? 1e9) || (a < b ? -1 : 1))
        .flatMap(([id, sums]) => [...sums.keys()].sort(currencyOrder)
          .map((cur) => ({ business_id: id, name: order.get(id)?.name ?? null, ...row(cur, sums.get(cur)) })));
      return { businesses, overall: [...overall.keys()].sort(currencyOrder).map((cur) => row(cur, overall.get(cur))) };
    },
  };

  // The renewal reminders (when the automations module is registered).
  if (services.automations) registerRenewalAutomations({ automations: services.automations, crm, planner, reads });
  return service;
}
