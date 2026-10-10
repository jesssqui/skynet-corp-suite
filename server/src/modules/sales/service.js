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
import { addMonths } from '@suite/shared/crm';
import { SALES_SOURCES, SALES_FIGURES, sumByCurrency, localDateIn, salesPeriods, zeroFigures } from '@suite/shared/sales';
import { HttpError } from '../../lib/httpError.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** How many months the months() list shows (this one and the 12 before: a year to compare with). */
export const MONTHS_SHOWN = 13;
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
    monthHasDays: db.prepare('SELECT COUNT(*) AS n FROM sales_daily WHERE source = ? AND store = ? AND day >= ? AND day <= ?'),
    manual: db.prepare('SELECT * FROM sales_manual_months WHERE store = ? AND month = ?'),
    manualOf: db.prepare('SELECT * FROM sales_manual_months WHERE store = ? AND month >= ? AND month <= ? ORDER BY month'),
    putManual: db.prepare(`INSERT INTO sales_manual_months (store, month, currency, total, orders, note, entered_at, entered_by, entered_device)
      VALUES (@store, @month, @currency, @total, @orders, @note, @at, @actor, @device)
      ON CONFLICT (store, month) DO UPDATE SET currency = excluded.currency, total = excluded.total, orders = excluded.orders,
      note = excluded.note, entered_at = excluded.entered_at, entered_by = excluded.entered_by, entered_device = excluded.entered_device,
      replaced_at = NULL`),
    markReplaced: db.prepare('UPDATE sales_manual_months SET replaced_at = ? WHERE store = ? AND month = ? AND replaced_at IS NULL'),
    dropManual: db.prepare('DELETE FROM sales_manual_months WHERE store = ? AND month = ?'),
    lastFetched: db.prepare('SELECT source, store, MAX(fetched_at) AS fetched_at, MIN(day) AS first_day, MAX(day) AS last_day FROM sales_daily GROUP BY source, store'),
  };
  const sources = new Map();

  /**
   * A source registers its live store list (see the top of this file). D13: a store may name `manualStore` — the
   * target of months entered by hand ('ebay') that fill its card for months it has no days for; `manualStores` lists
   * the targets this source accepts entries for even before it lists a store (not set up yet).
   */
  function registerSource({ source, label, stores, manualStores = [] }) {
    if (!SALES_SOURCES.includes(source) || source === 'manual') throw new Error(`sales: unknown source "${source}"`);
    if (typeof stores !== 'function') throw new Error(`sales: ${source} needs stores()`);
    sources.set(source, { source, label: label ?? source, stores, manualStores });
  }
  const liveStores = (src) => {
    try {
      return src.stores() ?? [];
    } catch {
      return [];
    }
  };

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
      // D13 re-check: a hand-entered month this store's own days now count for is replaced for good (until saved again).
      markReplacedFor(source, store, [...new Set(days.map((d) => d.day.slice(0, 7)))], fetchedAt);
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
      for (const s of liveStores(src)) {
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
        let rows = filtered({ from, to, store: s.store, source: s.source });
        let totalOnly = false;
        // D13: a month the connection has no days for is filled by a month entered by hand (its manual target).
        if (p === 'month' && s.manualStore) {
          const m = q.manual.get(s.manualStore, today.slice(0, 7));
          if (manualCounts(m, s, today.slice(0, 7))) {
            rows = [manualRow(m, s.businessId)];
            out.monthFromManual = true;
            out.manualEntry = manualView(m);
            totalOnly = true;
          }
        }
        periodRows[p].push(...rows);
        // D13b: a period filled by a month entered by hand knows only its total and orders (its other figures are 0,
        // not known): `totalOnly` says so, so no breakdown is shown for it. Otherwise every figure is the store's own.
        out[p] = figures(sumByCurrency(rows)).map((f) => (totalOnly ? { ...f, totalOnly: true } : f));
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

  // ---- months entered by hand (D13) --------------------------------------------------------------------
  const monthEnd = (month) => addDays1(addMonths(`${month}-01`, 1), -1);
  function addDays1(ymd, n) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /** Does this store (source + store) have any day in this month? (then its days win over a hand-entered month) */
  function hasDays({ source, store }, month) {
    if (!store) return false;
    return q.monthHasDays.get(source, store, `${month}-01`, monthEnd(month)).n > 0;
  }
  /** Has the store a day for every day of the month so far (to its today, in its own zone)? */
  function covered(st, month) {
    const today = localDateIn(st.timeZone ?? null, new Date(clock()));
    const to = [monthEnd(month), today].sort()[0];
    const from = `${month}-01`;
    if (to < from) return true;
    const want = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    return q.monthHasDays.get(st.source, st.store, from, to).n >= want;
  }
  /**
   * Do the connection's own days count for this month (over a month entered by hand)? Yes when it has days there and
   * either it is reading now (`delivering`, the default for sources that don't say) or it read the whole month so far.
   * So a month the connection stopped reading part way (signed out, switched off, forgotten mid-month) can be entered by
   * hand and counts, until the connection is back and has read it all (review fix).
   */
  function realWins(st, month) {
    if (!st?.store || !hasDays(st, month)) return false;
    return st.delivering !== false || covered(st, month);
  }
  /** Mark the hand-entered months of this store that its own days now count for (inside putDays' transaction). */
  function markReplacedFor(source, store, monthsTouched, when) {
    for (const t of manualTargets().values()) {
      if (!t.store || t.source !== source || t.store.store !== store) continue;
      const st = { ...t.store, source };
      for (const month of monthsTouched) if (realWins(st, month)) q.markReplaced.run(when, t.target, month);
    }
  }
  /** Does this hand-entered month count? Not once replaced (for good), nor while the connection's days count. */
  const manualCounts = (m, st, month) => Boolean(m && !m.replaced_at && !realWins(st, month));
  const manualRow = (m, businessId = null) => ({ ...zeroFigures(), currency: m.currency, total: m.total, orders: m.orders ?? 0, business_id: businessId });
  const manualView = (m) => ({
    store: m.store, month: m.month, currency: m.currency, total: m.total, orders: m.orders, note: m.note,
    enteredAt: m.entered_at, enteredBy: m.entered_by, replacedAt: m.replaced_at ?? null,
  });
  /** The manual targets some source accepts ('ebay'), and the live store each one fills (if listed now). */
  function manualTargets() {
    const out = new Map();
    for (const src of sources.values()) {
      for (const t of src.manualStores ?? []) if (!out.has(t)) out.set(t, { target: t, source: src.source, label: src.label, store: null });
      for (const s of liveStores(src)) {
        if (s.manualStore) out.set(s.manualStore, { target: s.manualStore, source: src.source, label: src.label, store: s });
      }
    }
    return out;
  }
  const mustTarget = (store) => {
    const t = manualTargets().get(store);
    if (!t) throw new HttpError(404, 'No store takes months entered by hand under that name', undefined, { code: 'not_found' });
    return t;
  };
  const thisMonth = (t) => localDateIn(t.store?.timeZone ?? null, new Date(clock())).slice(0, 7);

  /**
   * Enter (or correct) a month by hand: { total (cents, ≥ 0), currency, orders?, note? } for a month up to this one.
   * Refused for a month the connection already has days for (its own figures are there: 409 has_data).
   */
  function putManualMonth(store, month, { total, currency = 'CAD', orders = null, note = null } = {}, { actor, deviceId = null }) {
    const t = mustTarget(store);
    if (!MONTH_RE.test(month ?? '')) throw new HttpError(400, 'A month is YYYY-MM', undefined, { code: 'bad_month' });
    if (month > thisMonth(t)) throw new HttpError(400, 'That month hasn’t started yet', undefined, { code: 'bad_month' });
    if (!Number.isSafeInteger(total) || total < 0) throw new HttpError(400, 'The total is a whole number of cents, 0 or more', undefined, { code: 'bad_total' });
    const cur = String(currency ?? '').toUpperCase();
    if (!CURRENCY_RE.test(cur)) throw new HttpError(400, 'A currency is three letters (CAD, USD)', undefined, { code: 'bad_currency' });
    if (orders !== null && orders !== undefined && !(Number.isSafeInteger(orders) && orders >= 0)) throw new HttpError(400, 'Orders is a whole number', undefined, { code: 'bad_orders' });
    if (realWins(t.store ? { ...t.store, source: t.source } : null, month)) {
      throw new HttpError(409, `${t.label} already has its own figures for that month`, undefined, { code: 'has_data' });
    }
    q.putManual.run({
      store, month, currency: cur, total, orders: orders ?? null, note: note ? String(note).trim().slice(0, 500) || null : null,
      at: nowIso(new Date(clock())), actor, device: deviceId,
    });
    return months(store);
  }
  function deleteManualMonth(store, month) {
    mustTarget(store);
    q.dropManual.run(store, month);
    return months(store);
  }

  /**
   * The last MONTHS_SHOWN months of a manual target's store, newest first: each with the connection's own figures
   * (`real`, per currency; null when it has no days that month), the month entered by hand (`manual`), which one
   * counts (`shown`: real | manual | null) and `replaced` (a hand-entered month the connection now has days for).
   */
  function months(store) {
    const t = mustTarget(store);
    const latest = thisMonth(t);
    const list = [];
    for (let i = 0; i < MONTHS_SHOWN; i += 1) list.push(addMonths(`${latest}-01`, -i).slice(0, 7));
    const manual = new Map(q.manualOf.all(store, list.at(-1), latest).map((m) => [m.month, m]));
    return {
      store, source: t.source, label: t.label, state: t.store?.state ?? 'not_set_up', liveStore: t.store?.store ?? null,
      thisMonth: latest,
      months: list.map((month) => {
        const st = t.store ? { ...t.store, source: t.source } : null;
        const rows = st ? filtered({ from: `${month}-01`, to: monthEnd(month), store: st.store, source: st.source }) : [];
        const real = rows.length ? figures(sumByCurrency(rows)) : null;
        const m = manual.get(month) ?? null;
        const wins = realWins(st, month);
        const counts = manualCounts(m, st, month);
        return {
          month, real, manual: m ? manualView(m) : null,
          shown: counts ? 'manual' : real ? 'real' : null,
          // Replaced: eBay's figure counts now, or did once (then for good, until the month is saved again by hand).
          replaced: Boolean(m && (wins || m.replaced_at)),
          // The connection read only part of it and isn't reading now: a hand-entered month may count instead.
          partial: Boolean(real && !wins && !covered(st, month)),
          canEnter: !wins,
        };
      }),
    };
  }

  /**
   * D15's monthly read: per store and month, its own figures or — for months it has no days for — the month entered by
   * hand (`from: 'manual'`, only `total` and `orders` known). { months: [{ month, source, store, currency, from, …figures }] }
   */
  function monthly({ fromMonth, toMonth }) {
    const out = [];
    for (let month = fromMonth; month <= toMonth; month = addMonths(`${month}-01`, 1).slice(0, 7)) {
      const rows = filtered({ from: `${month}-01`, to: monthEnd(month) });
      const replacedByHand = new Set();
      for (const t of manualTargets().values()) {
        const m = q.manual.get(t.target, month);
        const st = t.store ? { ...t.store, source: t.source } : null;
        if (!manualCounts(m, st, month)) continue;
        if (st) replacedByHand.add(`${st.source}|${st.store}`);
        out.push({ month, source: 'manual', store: t.target, business_id: t.store?.businessId ?? null, from: 'manual', ...manualRow(m), days: 0 });
      }
      for (const [key, rs] of group(rows, (r) => `${r.source}|${r.store}`)) {
        if (replacedByHand.has(key)) continue;
        for (const f of figures(sumByCurrency(rs))) out.push({ month, source: rs[0].source, store: rs[0].store, business_id: rs[0].business_id, from: 'real', ...f, key });
      }
    }
    return { months: out.map(({ key, ...r }) => r) };
  }

  return { registerSource, putDays, setStore, dayCount, totals, summary, putManualMonth, deleteManualMonth, months, monthly, hasDays };
}
