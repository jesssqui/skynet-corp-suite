// The overview (D11): what the home screen of the business shows, read in one go from the other modules' services —
// it has no tables of its own and writes nothing. See CLAUDE.md, "The overview (D11)".
//
//   sales      each of our businesses that has sales (a store, the Order Manager, eBay, or entries made by hand), in our
//              businesses' order: today, this week and this month (each store in its own calendar, as Money → Sales),
//              and the combined total of all businesses underneath — per currency, never added across currencies.
//              Straight from sales.summary().
//   attention  one list of what needs dealing with, in the plan's order: overdue tasks (both people and the shared
//              list), wholesale balances owing over 30 days, renewals and retainers in the next 30 days, low stock,
//              support emails (not connected yet: D14), payments with no order to go against, relationships and leads
//              with no next step, clients gone quiet. Each section: { id, count, items (at most MAX_ITEMS), state }.
//              Items are data (ids, names, days, cents); the device words them (client/src/modules/overview/logic.js).
//
// Decision: worked out on the server, in one GET. Sales and the wholesale money live only on the server (not synced),
// Stockroom's answers too, and the Friday review's server numbers already read the same services — so the overview
// shows one consistent picture, and needs a connection to the suite like Money → Sales. Personal data stays on the
// tailnet like every other signed-in read.
import { nowIso, localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';

/** At most this many items per section are sent (the count is always the full number). */
export const MAX_ITEMS = 100;
/** Renewals and retainers due within this many days (the Friday review's window). */
export const RENEWAL_DAYS = 30;
export const ATTENTION_SECTIONS = Object.freeze(['overdue', 'balances', 'renewals', 'lowStock', 'support', 'payments', 'noNextStep', 'quiet']);
/**
 * Review fix: the sections the page's headline adds up — the urgent ones. "No next step" and "Clients gone quiet" are
 * standing lists (thousands at scale) shown with their own counts but left out of the headline.
 */
export const URGENT_SECTIONS = Object.freeze(['overdue', 'balances', 'renewals', 'lowStock', 'support', 'payments']);

export function createOverviewService(ctx) {
  const { services, log } = ctx;
  const clock = ctx.now ?? Date.now;

  const businessesById = () => {
    const list = services.crm?.listBusinesses?.() ?? [];
    return new Map(list.map((b, i) => [b.id, { id: b.id, name: b.name, color: b.color ?? null, archived: Boolean(b.archived), order: b.position ?? i }]));
  };

  /** Sales per business (only those with any source or entries), in our order, and the combined total. */
  function salesStrip(byId) {
    const sum = services.sales?.summary?.();
    if (!sum) return null;
    const storesOf = new Map();
    for (const s of sum.stores) {
      const k = s.businessId ?? null;
      storesOf.set(k, [...(storesOf.get(k) ?? []), { name: s.name, source: s.source, state: s.state ?? null, lastError: s.lastError ?? null }]);
    }
    const rank = (id) => byId.get(id)?.order ?? Number.MAX_SAFE_INTEGER;
    // Only businesses with sales: a store that is set up (connected, paused, failing, removed with its totals, entries
    // made by hand) or any figure — not one whose only card is a connection nobody has set up (eBay's always-listed card).
    const unset = new Set(['not_set_up', 'not_signed_in']);
    const hasSales = (b) => (storesOf.get(b.businessId ?? null) ?? []).some((s) => !unset.has(s.state))
      || ['today', 'week', 'month'].some((p) => b[p]?.length);
    const businesses = sum.businesses.filter(hasSales)
      .map((b) => ({
        businessId: b.businessId, name: b.name, color: byId.get(b.businessId)?.color ?? null,
        today: b.today, week: b.week, month: b.month, stores: storesOf.get(b.businessId ?? null) ?? [],
      }))
      .sort((a, b) => rank(a.businessId) - rank(b.businessId) || String(a.name).localeCompare(String(b.name)));
    return { at: sum.at, businesses, overall: sum.overall };
  }

  const section = (id, { count, items = [], state = 'ok', ...rest }) => ({ id, count, items: items.slice(0, MAX_ITEMS), state, ...rest });
  // A section that failed to read says so instead of breaking the page.
  const guarded = (id, fn) => {
    try {
      return fn();
    } catch (err) {
      log?.error?.(`overview: ${id} failed:`, err);
      return section(id, { count: null, state: 'error' });
    }
  };

  function overdue(today, actor, byId) {
    const p = services.planner;
    if (!p?.overdueTasks) return section('overdue', { count: null, state: 'not_available' });
    const whose = (owner) => (owner === 'shared' ? 'shared' : owner === actor ? 'mine' : 'partner');
    return section('overdue', {
      count: p.overdueCount(today),
      items: p.overdueTasks(today, MAX_ITEMS).map((t) => ({
        id: t.id, title: t.title, whose: whose(t.owner), dueDate: t.due_date, dueTime: t.due_time,
        business: byId.get(t.business_id)?.name ?? null, clientId: t.client_id ?? null,
      })),
    });
  }

  /** The Order Manager's state for the wholesale lines: not_connected (no secret, nothing received), paused or ok. */
  function womState() {
    const w = services.wholesale;
    if (!w?.moneyLines) return 'not_available';
    const set = Boolean(w.secretState?.()?.set);
    const counts = w.waitingCounts?.() ?? {};
    const any = (counts.customers ?? 0) + (counts.linked ?? 0) > 0;
    if (!set && !any) return 'not_connected';
    return w.isPaused?.() ? 'paused' : 'ok';
  }

  // The two wholesale money lines are worked out in one pass over the held customers, once a request.
  function balances(lines) {
    const state = womState();
    if (state === 'not_available' || state === 'not_connected') return section('balances', { count: null, state });
    const rows = lines().overdue;
    return section('balances', {
      count: rows.length, state,
      totalCents: rows.reduce((a, r) => a + r.overdueCents, 0),
      items: rows.map((r) => ({ id: r.uid, name: r.name, overdueCents: r.overdueCents, orders: r.orders, oldestDate: r.oldestDate, clientId: r.clientId })),
    });
  }

  function renewals(today, byId) {
    const to = addDays(today, RENEWAL_DAYS);
    const services_ = (services.crm?.renewalsBetween?.(today, to) ?? []).map((s) => ({
      kind: 'service', id: s.id, name: s.name, date: s.renewal_date, accountName: s.account_name ?? null, clientId: s.client_id ?? null,
      business: byId.get(s.business_id)?.name ?? null, amountCents: s.amount_cents ?? null, period: s.period ?? null, currency: 'CAD',
    }));
    const costs = (services.costs?.renewingBetween?.(today, to) ?? []).map((c) => ({
      kind: 'cost', id: c.id, name: c.name, date: c.next_renewal, business: byId.get(c.business_id)?.name ?? null,
      amountCents: c.amount_cents ?? null, period: c.period ?? null, currency: c.currency ?? 'CAD', autoRenews: Boolean(c.auto_renews),
    }));
    const items = [...services_, ...costs].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.name).localeCompare(String(b.name)));
    return section('renewals', { count: items.length, items, services: services_.length, costs: costs.length, days: RENEWAL_DAYS });
  }

  function lowStock() {
    const s = services.stockroom;
    if (!s?.lowStock) return section('lowStock', { count: null, state: 'not_available' });
    const r = s.lowStock();
    if (r.state === 'not_connected' || r.state === 'revoked' || r.state === 'not_read') return section('lowStock', { count: null, state: r.state });
    return section('lowStock', {
      count: r.items.length, state: r.state, asOf: r.asOf, fetchedAt: r.fetchedAt,
      items: r.items.map((i) => ({ id: i.sku ?? i.name, ...i })),
    });
  }

  // The helpdesk is D14: nothing reads a support mailbox yet.
  const support = () => section('support', { count: null, state: 'not_connected', comesWith: 'the helpdesk (D14)' });

  /**
   * Payments with no matching order — both kinds (owner's decision): the Order Manager's e-Transfers that matched no
   * customer or order (its A19 `payments.unmatched`: a count, a total and the oldest one's time — they are dealt with
   * there, on `page`), and customers whose payments come to more than their orders here (wholesale.moneyLines' credit,
   * regular depositors left out). count = the e-Transfers + those customers.
   */
  function payments(lines) {
    const state = womState();
    if (state === 'not_available' || state === 'not_connected') return section('payments', { count: null, state });
    const rows = lines().credit;
    const unmatched = services.wholesale.unmatchedState?.() ?? null;
    return section('payments', {
      count: rows.length + (unmatched?.count ?? 0), state,
      unmatched, customers: rows.length,
      items: rows.map((r) => ({ id: r.uid, name: r.name, unusedCents: r.unusedCents, clientId: r.clientId, lastPaymentAt: r.lastPaymentAt })),
    });
  }

  function noNextStep(byId) {
    const { planner } = services;
    if (!planner?.noNextStep) return section('noNextStep', { count: null, state: 'not_available' });
    // The same rule as Today and the Friday review (planner.noNextStep), so the three counts agree.
    const found = planner.noNextStep();
    const rels = found.relationships.map((r) => ({
      kind: 'relationship', id: r.id, accountName: r.account_name, clientId: r.client_id, clientName: r.client_name,
      business: r.business_name, relationshipKind: r.kind,
    }));
    const leads = found.leads.map((l) => ({ kind: 'lead', id: l.id, name: l.name, stage: l.stage, business: byId.get(l.business_id)?.name ?? null }));
    return section('noNextStep', { count: rels.length + leads.length, items: [...rels, ...leads], relationships: rels.length, leads: leads.length });
  }

  function quiet(today) {
    if (!services.planner?.quietClients) return section('quiet', { count: null, state: 'not_available' });
    const rows = services.planner.quietClients(today);
    return section('quiet', { count: rows.length, days: services.planner.quietDays, items: rows.map((c) => ({ id: c.id, name: c.name, since: c.since })) });
  }

  /** The whole overview for one person (`actor`: whose overdue tasks are "mine") on `today` (the device's day). */
  function overview({ today = null, actor = 'owner' } = {}) {
    const day = today ?? localDate(new Date(clock()));
    const byId = businessesById();
    let sales = null;
    try {
      sales = salesStrip(byId);
    } catch (err) {
      log?.error?.('overview: sales failed:', err);
    }
    let memo = null;
    const lines = () => (memo ??= services.wholesale.moneyLines(day));
    const attention = [
      guarded('overdue', () => overdue(day, actor, byId)),
      guarded('balances', () => balances(lines)),
      guarded('renewals', () => renewals(day, byId)),
      guarded('lowStock', () => lowStock()),
      support(),
      guarded('payments', () => payments(lines)),
      guarded('noNextStep', () => noNextStep(byId)),
      guarded('quiet', () => quiet(day)),
    ];
    return { at: nowIso(new Date(clock())), today: day, sales, attention, urgent: URGENT_SECTIONS };
  }

  return { overview };
}
