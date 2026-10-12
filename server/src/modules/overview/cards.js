// The overview's business cards (D15), below the sales strip and "To deal with". Each card is worked out on its own
// (guarded: one failing says "couldn't be read", never breaks the page) from the other modules' services only, and
// says "not connected" when its source isn't there. Items are data (counts, cents, days); the device words them
// (client/src/modules/overview/cards.js).
//
//   wholesale      this month's and last month's sales (the Order Manager's, as Money → Sales), what is owed and what
//                  is owed over 30 days (the Balances page's rules), payments received this month (shown only — the
//                  suite never records one), linked regulars gone quiet, orders packed and not shipped
//   stock          Stockroom's last answers: the last full count and spot check (and whether a count is due), open
//                  count differences and their value, products to reorder (and from how many suppliers), deliveries
//                  expected — read-only, from what the stockroom module already pulled
//   web            Great White North Design (website and social): active relationships by kind, active services and
//                  what they bring in a month, renewals in 30 days, the open pipeline and its first-year value
//   consulting     Business consulting, the same (kept thin: consulting engagements, D7, were skipped)
//   savePoint      Save Point Shop: eBay's sales (today, this week, this month — or the month entered by hand) and the
//                  orders waiting to ship
//   clients        active clients, new this month, gone quiet (the Friday review's rule), open leads
//   allBusinesses  each business's sales for the last three months beside its recurring costs a month (D6's monthly
//                  equivalent), per currency; Personal (the home) on its own line, left out of the together line
//   retail         each WooCommerce store's sales and state (and the retail stores' sales entered by hand), and open
//                  support tickets per store once the helpdesk (D14) is there
// Each card: { id, state, businessId?, … }; state ok | not_connected | not_available | paused | revoked | not_read |
// not_set_up | not_signed_in | signed_out | failing | error.
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { localDate } from '@suite/shared/time';
import { yearlyCents, monthlyFromYearly } from '@suite/shared/costs';
import { pipelineTotals, OPEN_LEAD_STAGES } from '@suite/shared/leads';
import { shiftMonth } from './scorecard.js';

export const CARD_IDS = Object.freeze(['wholesale', 'stock', 'web', 'consulting', 'savePoint', 'clients', 'allBusinesses', 'retail']);
/** Renewals counted on the web and consulting cards: the next 30 days (as "To deal with"). */
export const CARD_RENEWAL_DAYS = 30;
/** Months of sales on the all-businesses card (this one and the two before). */
export const ALL_BUSINESS_MONTHS = 3;

const B = BUSINESS_IDS;
const fig = (f) => ({ currency: f.currency, total: f.total ?? 0, orders: f.orders ?? 0, totalOnly: Boolean(f.totalOnly) });
const mapToList = (m) => [...m].map(([currency, cents]) => ({ currency, cents }))
  .sort((a, b) => (a.currency === 'CAD' ? -1 : b.currency === 'CAD' ? 1 : a.currency.localeCompare(b.currency)));

export function createCards({ services, log, now }) {
  const clock = now ?? Date.now;
  const card = (id, state, rest = {}) => ({ id, state, ...rest });

  /** A business's sales per currency in one month, from sales.monthly() (stores' own calendar months). */
  function monthSales(reads, businessId, month) {
    const rows = reads.window()?.months ?? [];
    const out = new Map();
    for (const r of rows) {
      if (r.month !== month || (r.business_id ?? null) !== businessId) continue;
      const s = out.get(r.currency) ?? { currency: r.currency, total: 0, orders: 0, totalOnly: false };
      s.total += r.total ?? 0;
      s.orders += r.orders ?? 0;
      s.totalOnly ||= Boolean(r.totalOnly) || r.from === 'manual';
      out.set(r.currency, s);
    }
    return [...out.values()].sort((a, b) => (a.currency === 'CAD' ? -1 : b.currency === 'CAD' ? 1 : a.currency.localeCompare(b.currency)));
  }
  /** A business's recurring costs a month, per currency (D6's monthlyTotals; active costs, once left out). */
  function costsOf(reads, businessId) {
    const t = reads.costs();
    if (!t) return null;
    return t.businesses.filter((b) => b.business_id === businessId)
      .map((b) => ({ currency: b.currency, monthlyCents: b.monthly_cents, resoldMonthlyCents: b.resold_monthly_cents, count: b.count }));
  }

  function wholesale(reads) {
    const state = reads.womState();
    if (state === 'not_available' || state === 'not_connected') return card('wholesale', state, { businessId: B.wholesale });
    const month = reads.day.slice(0, 7);
    const { overdue, totals } = reads.lines();
    const ship = services.wholesale.readyToShip?.() ?? null;
    return card('wholesale', state, {
      businessId: B.wholesale,
      month: monthSales(reads, B.wholesale, month),
      lastMonth: monthSales(reads, B.wholesale, shiftMonth(month, -1)),
      owing: { cents: totals?.owingCents ?? 0, customers: totals?.owingCustomers ?? 0 },
      overdue: { cents: overdue.reduce((a, r) => a + r.overdueCents, 0), customers: overdue.length },
      paidThisMonth: { cents: totals?.paidThisMonthCents ?? 0, payments: totals?.paymentsThisMonth ?? 0 },
      quietRegulars: totals?.quietRegulars ?? 0,
      toShip: ship,
      costs: costsOf(reads, B.wholesale),
    });
  }

  function stock() {
    const s = services.stockroom;
    if (!s?.stockCard) return card('stock', 'not_available');
    const r = s.stockCard();
    return card('stock', r.state, { businessId: B.wholesale, ...r });
  }

  /** The agency's (web and social) or consulting's card: relationships, services, renewals, pipeline, sales, costs. */
  function serviceBusiness(id, businessId, kinds, reads) {
    const { crm } = services;
    if (!crm?.liveRelationships) return card(id, 'not_available', { businessId });
    const day = reads.day;
    const rels = crm.liveRelationships().filter((r) => r.business_id === businessId && r.status === 'active' && r.client_status === 'active');
    const byKind = {};
    for (const k of kinds) byKind[k] = 0;
    let other = 0;
    for (const r of rels) {
      if (Object.hasOwn(byKind, r.kind)) byKind[r.kind] += 1;
      else other += 1;
    }
    const services_ = (crm.liveServices?.() ?? []).filter((x) => x.business_id === businessId && x.status === 'active'
      && x.relationship_status !== 'ended' && x.client_status === 'active');
    const recurring = services_.filter((x) => x.billing !== 'hourly' && x.period && x.period !== 'once');
    const renewals = (crm.renewalsBetween?.(day, addDays(day, CARD_RENEWAL_DAYS)) ?? []).filter((x) => x.business_id === businessId);
    const leads = (crm.liveLeads?.() ?? []).filter((l) => l.business_id === businessId);
    const p = pipelineTotals(leads, { today: day });
    const open = OPEN_LEAD_STAGES.map((stage) => ({ stage, count: p.stages[stage].count }));
    const openValue = new Map();
    for (const stage of OPEN_LEAD_STAGES) for (const [cur, v] of p.stages[stage].value) openValue.set(cur, (openValue.get(cur) ?? 0) + v);
    return card(id, 'ok', {
      businessId,
      relationships: { total: rels.length, byKind, other },
      services: { active: services_.length, monthlyCents: monthlyFromYearly(recurring.reduce((a, x) => a + yearlyCents(x), 0)), hourly: services_.filter((x) => x.billing === 'hourly').length },
      renewals: { count: renewals.length, days: CARD_RENEWAL_DAYS, next: renewals[0] ? { name: renewals[0].name, date: renewals[0].renewal_date, accountName: renewals[0].account_name ?? null } : null },
      pipeline: { open, openCount: open.reduce((a, s) => a + s.count, 0), value: mapToList(openValue), wonThisMonth: p.wonThisMonth, lostThisMonth: p.lostThisMonth },
      month: monthSales(reads, businessId, day.slice(0, 7)),
      costs: costsOf(reads, businessId),
    });
  }

  function savePoint(reads) {
    const e = services.ebay;
    const sum = reads.summary();
    const stores = (sum?.stores ?? []).filter((s) => s.businessId === B.save_point);
    const biz = (sum?.businesses ?? []).find((b) => b.businessId === B.save_point) ?? null;
    if (!e?.info) {
      return card('savePoint', stores.length ? 'ok' : 'not_available', { businessId: B.save_point, today: (biz?.today ?? []).map(fig), week: (biz?.week ?? []).map(fig), month: (biz?.month ?? []).map(fig), toShip: null });
    }
    const info = e.info();
    const waiting = e.store?.waiting?.() ?? [];
    const nowMs = clock();
    const shipBy = waiting.map((w) => w.ship_by).filter(Boolean).sort();
    const main = stores.find((s) => s.source === 'ebay' && s.manualStore) ?? null;
    return card('savePoint', info.state === 'on' ? 'ok' : info.state, {
      businessId: B.save_point, account: info.account ?? null, lastSuccessAt: info.lastSuccessAt ?? null,
      today: (biz?.today ?? []).map(fig), week: (biz?.week ?? []).map(fig), month: (biz?.month ?? []).map(fig),
      monthFromManual: Boolean(main?.monthFromManual),
      toShip: info.set ? { orders: waiting.length, nextShipBy: shipBy[0] ?? null, late: shipBy.filter((d) => Date.parse(d) < nowMs).length } : null,
      costs: costsOf(reads, B.save_point),
    });
  }

  function clients(reads) {
    const { crm } = services;
    if (!crm?.activeClientsWithLastActivity) return card('clients', 'not_available');
    const month = reads.day.slice(0, 7);
    const active = crm.activeClientsWithLastActivity();
    const newThisMonth = active.filter((c) => c.created_at && localDate(new Date(c.created_at)).slice(0, 7) === month).length;
    let quiet = null;
    try {
      quiet = services.planner?.quietClients ? reads.quietClients().length : null;
    } catch (err) {
      log?.error?.('overview: quiet clients failed:', err);
    }
    const leads = crm.liveLeads?.() ?? [];
    return card('clients', 'ok', {
      active: active.length, newThisMonth, quiet, quietDays: services.planner?.quietDays ?? 60,
      openLeads: leads.filter((l) => OPEN_LEAD_STAGES.includes(l.stage)).length,
    });
  }

  function allBusinesses(reads, byId) {
    if (!services.sales?.monthly) return card('allBusinesses', 'not_available');
    const to = reads.day.slice(0, 7);
    const months = Array.from({ length: ALL_BUSINESS_MONTHS }, (_, i) => shiftMonth(to, i - (ALL_BUSINESS_MONTHS - 1)));
    const rows = reads.window()?.months ?? [];
    const costs = reads.costs();
    const ids = new Set([...rows.map((r) => r.business_id ?? null), ...(costs?.businesses ?? []).map((b) => b.business_id)]);
    const rank = (id) => byId.get(id)?.order ?? 1e9;
    const businesses = [...ids].filter(Boolean).sort((a, b) => rank(a) - rank(b))
      .map((id) => ({
        businessId: id, name: byId.get(id)?.name ?? 'Unknown business', color: byId.get(id)?.color ?? null, personal: id === B.personal,
        months: months.map((m) => ({ month: m, sales: monthSales(reads, id, m) })),
        costs: costsOf(reads, id) ?? [],
      }));
    // Together: every business but Personal (the home's costs aren't the businesses'), per currency.
    const add = (map, cur, k, v) => {
      const e = map.get(cur) ?? { currency: cur, total: 0, totalOnly: false, monthlyCents: 0 };
      e[k] += v;
      map.set(cur, e);
    };
    const together = months.map((m) => {
      const t = new Map();
      for (const b of businesses) {
        if (b.personal) continue;
        for (const f of b.months.find((x) => x.month === m).sales) {
          add(t, f.currency, 'total', f.total);
          if (f.totalOnly) t.get(f.currency).totalOnly = true;
        }
      }
      return { month: m, sales: [...t.values()].map(({ monthlyCents, ...f }) => f) };
    });
    const costTotal = new Map();
    for (const b of businesses) if (!b.personal) for (const c of b.costs) add(costTotal, c.currency, 'monthlyCents', c.monthlyCents);
    return card('allBusinesses', 'ok', {
      months, businesses, together: { months: together, costs: [...costTotal.values()].map((c) => ({ currency: c.currency, monthlyCents: c.monthlyCents })) },
      costsKnown: Boolean(costs),
    });
  }

  function retail(reads) {
    const sum = reads.summary();
    const stores = (sum?.stores ?? []).filter((s) => s.businessId === B.retail)
      .map((s) => ({
        store: s.store, source: s.source, name: s.name, state: s.state ?? null, link: s.link ?? null, lastFetchedAt: s.lastFetchedAt ?? null,
        today: (s.today ?? []).map(fig), week: (s.week ?? []).map(fig), month: (s.month ?? []).map(fig), tickets: null,
      }));
    // D14 (the helpdesk) adds open tickets per store; until it is there the line says it isn't connected yet.
    const helpdesk = services.helpdesk;
    let support = { state: 'not_connected', comesWith: 'the helpdesk (D14)' };
    if (helpdesk?.openTicketsByStore) {
      const byStore = helpdesk.openTicketsByStore();
      support = { state: 'ok', total: 0, unmatched: 0 };
      for (const [key, n] of Object.entries(byStore ?? {})) {
        const s = stores.find((x) => x.store === key || x.name === key);
        if (s) s.tickets = n;
        else support.unmatched += n;
        support.total += n;
      }
    }
    const woo = stores.filter((s) => s.source === 'woo');
    const state = !services.woocommerce ? (stores.length ? 'ok' : 'not_available') : woo.length ? 'ok' : stores.length ? 'ok' : 'not_connected';
    const biz = (sum?.businesses ?? []).find((b) => b.businessId === B.retail) ?? null;
    return card('retail', state, {
      businessId: B.retail, stores, month: (biz?.month ?? []).map(fig), support, costs: costsOf(reads, B.retail),
    });
  }

  const builders = {
    wholesale: (r) => wholesale(r),
    stock: () => stock(),
    web: (r) => serviceBusiness('web', B.agency, ['website', 'social'], r),
    consulting: (r) => serviceBusiness('consulting', B.consulting, ['consulting'], r),
    savePoint: (r) => savePoint(r),
    clients: (r) => clients(r),
    allBusinesses: (r, byId) => allBusinesses(r, byId),
    retail: (r) => retail(r),
  };

  /** Every card, each on its own: one that throws comes back as { id, state: 'error' }. */
  function all(reads, byId) {
    return CARD_IDS.map((id) => {
      try {
        return builders[id](reads, byId);
      } catch (err) {
        log?.error?.(`overview: the ${id} card failed:`, err);
        return card(id, 'error');
      }
    });
  }

  return { all };
}
