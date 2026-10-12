// The goals scorecard (D15): each business's monthly targets (the synced `target` records of this module, set on the
// monthly plan) against what the calendar month has brought so far, with the pace — and beside them that business's
// month priorities from the planner (C4b), so the numbers and the work meant to reach them are seen together.
//
// Actuals, per measure (MEASURE_HELP in @suite/shared/targets):
//   sales        Σ `total` of the business's sales months in the target's currency — sales.monthly(): every store, the
//                Order Manager, eBay (or its month entered by hand), sales entered by hand. Total is always known.
//   net_sales    Σ `net` there — unknown (null, reason total_only) when any of those rows is total-only (entered by hand:
//                only its total and orders are known; D13b's `totalOnly`).
//   orders       Σ `orders` there (every currency); `partial` when a total-only row is in it (orders by hand are optional).
//   new_clients  clients (live) whose FIRST relationship with the business (any status) has its start_date in the
//                month — each client once; relationships with no start_date don't count (C7's imports make none), so
//                an import of an old client list doesn't count as a month of new clients.
//   won_leads    the business's leads won in the month (stage won, closed_at's local month).
import { localDate } from '@suite/shared/time';
import { addMonthStarts } from '@suite/shared/planner';
import { pickTargets, targetPace, isMoneyMeasure, monthFirst } from '@suite/shared/targets';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (m) => typeof m === 'string' && MONTH_RE.test(m);
/** "YYYY-MM" n months from `month`. */
export const shiftMonth = (month, n) => addMonthStarts(`${month}-01`, n).slice(0, 7);
const localDayOf = (iso) => (iso ? localDate(new Date(iso)) : null);

/** Clients whose first relationship with `businessId` (by start_date; none = not counted) started in `month`. */
export function newClientsIn(relationships, businessId, month) {
  const first = new Map();
  for (const r of relationships) {
    if (r.business_id !== businessId || !r.start_date) continue;
    const cur = first.get(r.client_id);
    if (!cur || r.start_date < cur) first.set(r.client_id, r.start_date);
  }
  let n = 0;
  for (const d of first.values()) if (d.slice(0, 7) === month) n += 1;
  return n;
}

export function createScorecard({ db, services }) {
  const q = {
    month: db.prepare(`SELECT * FROM overview_targets WHERE deleted_at IS NULL AND month = ? ORDER BY business_id, measure, id`),
  };
  const hasTable = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'overview_targets'").get());

  /** Per business and currency, the month's sales rows added up: Map<business|currency, { total, net, orders, totalOnly }>. */
  function salesOf(reads, month) {
    const out = new Map();
    // The cards' months (this one and the two before) when the month is among them: one read for the whole page.
    const inWindow = reads.window && month <= reads.day.slice(0, 7) && month >= shiftMonth(reads.day.slice(0, 7), -2);
    const rows = (inWindow ? reads.window() : reads.monthly(month, month))?.months ?? null;
    if (!rows) return null;
    for (const r of rows) {
      if (r.month !== month) continue;
      const k = `${r.business_id ?? ''}|${r.currency}`;
      const s = out.get(k) ?? { total: 0, net: 0, orders: 0, totalOnly: false };
      s.total += r.total ?? 0;
      s.net += r.net ?? 0;
      s.orders += r.orders ?? 0;
      s.totalOnly ||= Boolean(r.totalOnly) || r.from === 'manual';
      out.set(k, s);
    }
    return out;
  }

  function actualOf(t, month, ctx) {
    const { sales } = ctx;
    switch (t.measure) {
      case 'sales':
      case 'net_sales':
      case 'orders': {
        if (!sales) return { actual: null, reason: 'not_available' };
        if (t.measure === 'orders') {
          const rows = [...sales].filter(([k]) => k.startsWith(`${t.business_id}|`)).map(([, v]) => v);
          return { actual: rows.reduce((a, r) => a + r.orders, 0), partial: rows.some((r) => r.totalOnly) };
        }
        const s = sales.get(`${t.business_id}|${t.currency ?? 'CAD'}`) ?? { total: 0, net: 0, totalOnly: false };
        if (t.measure === 'sales') return { actual: s.total };
        return s.totalOnly ? { actual: null, reason: 'total_only' } : { actual: s.net };
      }
      case 'new_clients': {
        if (!ctx.relationships) return { actual: null, reason: 'not_available' };
        return { actual: newClientsIn(ctx.relationships, t.business_id, month) };
      }
      case 'won_leads': {
        if (!ctx.leads) return { actual: null, reason: 'not_available' };
        return { actual: ctx.leads.filter((l) => l.business_id === t.business_id && l.stage === 'won' && (localDayOf(l.closed_at) ?? '').slice(0, 7) === month).length };
      }
      default:
        return { actual: null, reason: 'not_available' };
    }
  }

  /**
   * The scorecard of calendar month `month` ("YYYY-MM") on `today`: { state, month, today, businesses: [{ businessId,
   * name, color, archived, targets: [{ id, measure, amount, currency, notes, actual, partial, reason, pace, extras }],
   * priorities: [{ id, title, target, progress, done_at, owner }] }] } — businesses with a target or a priority that
   * month, in our order. A month that isn't "YYYY-MM" → state bad_month.
   */
  function month(m, today, { reads, byId }) {
    if (!isMonth(m)) return { state: 'bad_month', month: m, today, businesses: [] };
    if (!services.crm || !hasTable()) return { state: 'not_available', month: m, today, businesses: [] };
    const { current, extras } = pickTargets(q.month.all(monthFirst(m)));
    const need = new Set(current.map((t) => t.measure));
    const ctx = {
      sales: [...need].some((x) => ['sales', 'net_sales', 'orders'].includes(x)) ? salesOf(reads, m) : null,
      relationships: need.has('new_clients') ? reads.relationships() : null,
      leads: need.has('won_leads') ? reads.leads() : null,
    };
    const byBusiness = new Map();
    const entry = (id) => {
      if (!byBusiness.has(id)) {
        const b = byId.get(id);
        byBusiness.set(id, { businessId: id, name: b?.name ?? 'Unknown business', color: b?.color ?? null, archived: Boolean(b?.archived), order: b?.order ?? 1e9, targets: [], priorities: [] });
      }
      return byBusiness.get(id);
    };
    for (const t of current) {
      const a = actualOf(t, m, ctx);
      entry(t.business_id).targets.push({
        id: t.id, measure: t.measure, amount: t.amount, currency: isMoneyMeasure(t.measure) ? (t.currency ?? 'CAD') : null, notes: t.notes ?? null,
        actual: a.actual, partial: Boolean(a.partial), reason: a.reason ?? null,
        pace: targetPace({ amount: t.amount, actual: a.actual, month: m, today }),
        extras: (extras.get(t.id) ?? []).map((x) => x.id),
      });
    }
    for (const g of services.planner?.goals?.('month', monthFirst(m)) ?? []) {
      entry(g.business_id).priorities.push({ id: g.id, title: g.title, target: g.target, progress: g.progress, done_at: g.done_at, owner: g.owner ?? null });
    }
    const businesses = [...byBusiness.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(({ order, ...b }) => b);
    return { state: 'ok', month: m, today, previous: shiftMonth(m, -1), next: shiftMonth(m, 1), businesses };
  }

  return { month };
}
