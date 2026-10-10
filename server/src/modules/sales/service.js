// Sales totals (D12): the one daily-totals table every sales source writes and every reader reads.
//
//   sources   a module that brings sales in (D12 `woocommerce`, D13 `ebay`) registers itself once:
//               sales.registerSource({ source: 'woo', label: 'WooCommerce', stores: () => [{ store, name, businessId,
//                 currency, timeZone, state, lastSuccessAt, lastError, link }] })
//             and writes days with putDays (upserts by source + store + day: re-reading a day replaces it, so a late
//             refund or a status change lands on the day WooCommerce puts it, and a backfill run twice is harmless).
//   readers   totals({ from, to, business?, store?, source? }) — sums per currency (never across currencies) per
//             store, per business and overall; summary() — the Sales page: each store's today / this week / this
//             month in its own calendar.
//
// Totals only: no order, item, customer, email or address ever reaches these tables (the stores' order lookups are
// live and never stored — woocommerce/service.js). Not synced: devices read the API (the page needs a connection).
// It reads and writes only its own tables; our businesses' names come through the CRM's service.
import { nowIso } from '@suite/shared/time';
import { SALES_SOURCES, SALES_FIGURES, sumByCurrency, localDateIn, salesPeriods } from '@suite/shared/sales';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const COLS = SALES_FIGURES.join(', ');

export function createSalesService(ctx) {
  const { db, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const q = {
    put: db.prepare(`INSERT INTO sales_daily (source, store, day, business_id, currency, ${COLS}, fetched_at)
      VALUES (@source, @store, @day, @business_id, @currency, ${SALES_FIGURES.map((k) => `@${k}`).join(', ')}, @fetched_at)
      ON CONFLICT (source, store, day) DO UPDATE SET business_id = excluded.business_id, currency = excluded.currency,
      ${SALES_FIGURES.map((k) => `${k} = excluded.${k}`).join(', ')}, fetched_at = excluded.fetched_at`),
    putStore: db.prepare(`INSERT INTO sales_stores (source, store, name, business_id, currency, time_zone, updated_at)
      VALUES (@source, @store, @name, @business_id, @currency, @time_zone, @at)
      ON CONFLICT (source, store) DO UPDATE SET name = excluded.name, business_id = excluded.business_id,
      currency = COALESCE(excluded.currency, sales_stores.currency), time_zone = COALESCE(excluded.time_zone, sales_stores.time_zone),
      updated_at = excluded.updated_at`),
    knownStores: db.prepare('SELECT * FROM sales_stores ORDER BY source, name'),
    rowsStore: db.prepare('UPDATE sales_daily SET business_id = ? WHERE source = ? AND store = ?'),
    dayCount: db.prepare('SELECT COUNT(*) AS n FROM sales_daily WHERE source = ? AND store = ? AND day >= ? AND day <= ?'),
    lastFetched: db.prepare('SELECT source, store, MAX(fetched_at) AS fetched_at, MIN(day) AS first_day, MAX(day) AS last_day FROM sales_daily GROUP BY source, store'),
  };
  const sources = new Map();

  /** A source registers its live store list (see the top of this file). */
  function registerSource({ source, label, stores }) {
    if (!SALES_SOURCES.includes(source)) throw new Error(`sales: unknown source "${source}"`);
    if (typeof stores !== 'function') throw new Error(`sales: ${source} needs stores()`);
    sources.set(source, { source, label: label ?? source, stores });
  }

  /**
   * Write a store's days (one transaction): each { day, orders, items, gross, discounts, refunds, net, tax, shipping,
   * total } in integer cents, replacing what was there for that day. Also remembers the store's name, business,
   * currency and zone. → number of days written.
   */
  function putDays({ source, store, name, businessId = null, currency, timeZone = null, days, fetchedAt = nowIso(new Date(clock())) }) {
    if (!SALES_SOURCES.includes(source)) throw new Error(`sales: unknown source "${source}"`);
    if (!store || typeof store !== 'string') throw new Error('sales: a store key is needed');
    if (!CURRENCY_RE.test(currency ?? '')) throw new Error(`sales: bad currency "${currency}"`);
    for (const d of days) {
      if (!DAY_RE.test(d.day ?? '')) throw new Error(`sales: bad day "${d.day}"`);
      for (const k of SALES_FIGURES) if (!Number.isSafeInteger(d[k] ?? 0)) throw new Error(`sales: ${k} must be whole (cents)`);
    }
    db.transaction(() => {
      q.putStore.run({ source, store, name: name || store, business_id: businessId, currency, time_zone: timeZone, at: fetchedAt });
      for (const d of days) {
        q.put.run({ source, store, day: d.day, business_id: businessId, currency, fetched_at: fetchedAt, ...Object.fromEntries(SALES_FIGURES.map((k) => [k, d[k] ?? 0])) });
      }
    })();
    return days.length;
  }

  /** A store's name / business / zone changed (its rows follow its business). */
  function setStore({ source, store, name, businessId = null, currency = null, timeZone = null }) {
    db.transaction(() => {
      q.putStore.run({ source, store, name: name || store, business_id: businessId, currency, time_zone: timeZone, at: nowIso(new Date(clock())) });
      q.rowsStore.run(businessId, source, store);
    })();
  }

  /** How many days from…to a store has rows for (a source checks its backfill has no gaps, e.g. after a restore). */
  const dayCount = ({ source, store, from, to }) => q.dayCount.get(source, store, from, to).n;

  const filtered = ({ from, to, business = null, store = null, source = null }) => {
    const where = ['day >= ?', 'day <= ?'];
    const args = [from, to];
    if (business) { where.push('business_id = ?'); args.push(business); }
    if (store) { where.push('store = ?'); args.push(store); }
    if (source) { where.push('source = ?'); args.push(source); }
    return db.prepare(`SELECT * FROM sales_daily WHERE ${where.join(' AND ')}`).all(...args);
  };
  const figures = (m) => [...m].map(([currency, f]) => ({ currency, ...f }))
    .sort((a, b) => (a.currency === 'CAD' ? -1 : b.currency === 'CAD' ? 1 : a.currency.localeCompare(b.currency)));
  const group = (rows, keyOf) => {
    const g = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    return g;
  };

  /**
   * Sums over days `from`…`to` (inclusive; each store's own calendar days), optionally for one business, store or
   * source: { from, to, overall: [{ currency, …figures, days }], businesses: [{ business_id, currency, … }],
   * stores: [{ source, store, name, business_id, currency, …figures, days }] }. Per currency, never added across.
   */
  function totals({ from, to, business = null, store = null, source = null }) {
    const rows = filtered({ from, to, business, store, source });
    const names = new Map(q.knownStores.all().map((s) => [`${s.source}|${s.store}`, s.name]));
    const stores = [...group(rows, (r) => `${r.source}|${r.store}`)].flatMap(([key, rs]) => figures(sumByCurrency(rs)).map((f) => ({
      source: rs[0].source, store: rs[0].store, name: names.get(key) ?? rs[0].store, business_id: rs[0].business_id, ...f,
    })));
    const businesses = [...group(rows, (r) => r.business_id ?? '')].flatMap(([b, rs]) => figures(sumByCurrency(rs)).map((f) => ({ business_id: b || null, ...f })));
    return { from, to, overall: figures(sumByCurrency(rows)), businesses, stores };
  }

  /**
   * The Sales page: every store a source lists now, plus any with totals here but no longer connected — each with
   * `date` (its own today) and today / this week / this month (figures per currency) in its own calendar, when it was last read and its state; then per business and
   * overall per currency (each store's own periods added up). → { stores, businesses, overall, sources }
   */
  function summary() {
    const now = new Date(clock());
    const known = new Map(q.knownStores.all().map((s) => [`${s.source}|${s.store}`, s]));
    const fetched = new Map(q.lastFetched.all().map((r) => [`${r.source}|${r.store}`, r]));
    const list = [];
    const seen = new Set();
    for (const src of sources.values()) {
      let live = [];
      try {
        live = src.stores() ?? [];
      } catch {
        live = [];
      }
      for (const s of live) {
        const key = `${src.source}|${s.store}`;
        seen.add(key);
        list.push({ source: src.source, sourceLabel: src.label, connected: true, ...s, timeZone: s.timeZone ?? known.get(key)?.time_zone ?? null });
      }
    }
    for (const [key, s] of known) {
      if (seen.has(key)) continue;
      list.push({
        source: s.source, sourceLabel: sources.get(s.source)?.label ?? s.source, connected: false, store: s.store, name: s.name,
        businessId: s.business_id, currency: s.currency, timeZone: s.time_zone, state: 'removed', lastSuccessAt: null, lastError: null, link: null,
      });
    }
    const periodRows = { today: [], week: [], month: [] };
    const stores = list.map((s) => {
      const today = localDateIn(s.timeZone, now);
      const periods = salesPeriods(today);
      const out = { ...s, date: today, lastFetchedAt: fetched.get(`${s.source}|${s.store}`)?.fetched_at ?? null, firstDay: fetched.get(`${s.source}|${s.store}`)?.first_day ?? null };
      for (const [p, { from, to }] of Object.entries(periods)) {
        const rows = filtered({ from, to, store: s.store, source: s.source });
        periodRows[p].push(...rows);
        out[p] = figures(sumByCurrency(rows));
      }
      return out;
    });
    const businessIds = [...new Set(stores.map((s) => s.businessId ?? null))];
    const businesses = businessIds.map((id) => {
      const b = id ? services.crm?.getBusiness?.(id) : null;
      const pick = (rows) => figures(sumByCurrency(rows.filter((r) => (r.business_id ?? null) === id)));
      return { businessId: id, name: b?.name ?? (id ? 'Unknown business' : 'No business'), today: pick(periodRows.today), week: pick(periodRows.week), month: pick(periodRows.month) };
    });
    const overall = { today: figures(sumByCurrency(periodRows.today)), week: figures(sumByCurrency(periodRows.week)), month: figures(sumByCurrency(periodRows.month)) };
    return { at: nowIso(now), stores, businesses, overall, sources: [...sources.values()].map((s) => ({ source: s.source, label: s.label })) };
  }

  return { registerSource, putDays, setStore, dayCount, totals, summary };
}
