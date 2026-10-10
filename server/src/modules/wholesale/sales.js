// Wholesale as a sales source (D11): the Order Manager's sales per day — worked out from the holding area with the
// Order Manager's own P&L rules (salesDays.js) — written into the shared daily sales totals (the sales module,
// source `wholesale`, store `wholesale`, business wholesale, CAD, the business's local days). Every held change marks the days it can
// move (the order's own day and each of its refunds' / credit notes' days, before and after the change); after each
// request from the Order Manager those days are worked out again and written (upserts: nothing is ever counted twice).
// At start every day is written again from the holding area (the backfill on the first start after deploying, and
// after a restore: the holding area is kept across restores, the sales totals are not). Unlinked customers' and guest
// sales count too: sales are sales, linking is the CRM's business. Reads and writes only the wholesale tables; the
// totals go through ctx.services.sales. See CLAUDE.md, "Wholesale sales (D11)".
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import {
  salesDays, localDayOf, orderDayOf, WHOLESALE_STORE, WHOLESALE_SALES_ZONE, WHOLESALE_CURRENCY,
} from './salesDays.js';
import { SALES_FIGURES } from '@suite/shared/sales';

export const WHOLESALE_SOURCE = 'wholesale';
export const WHOLESALE_STORE_NAME = 'Wholesale Order Manager';

export function createWholesaleSales({ db, log, services, isPaused = () => false, isSetUp = () => false, lastReceivedAt = () => null }) {
  const ORDER_COLS = 'uid, status, deleted, snapshot, placed_at, goods_cents, tax_cents';
  const q = {
    order: db.prepare(`SELECT ${ORDER_COLS} FROM wholesale_held_orders WHERE uid = ?`),
    money: db.prepare('SELECT * FROM wholesale_held_money WHERE uid = ?'),
    moneyDaysOfOrder: db.prepare('SELECT at FROM wholesale_held_money WHERE order_uid = ?'),
    moneyDaysOfReturn: db.prepare('SELECT at FROM wholesale_held_money WHERE return_uid = ?'),
    ordersOn: db.prepare(`SELECT ${ORDER_COLS} FROM wholesale_held_orders WHERE placed_at >= ? AND placed_at < ?`),
    moneyOn: db.prepare("SELECT * FROM wholesale_held_money WHERE kind IN ('refund', 'credit_note') AND at >= ? AND at < ?"),
    allOrders: db.prepare(`SELECT ${ORDER_COLS} FROM wholesale_held_orders`),
    allMoney: db.prepare("SELECT * FROM wholesale_held_money WHERE kind IN ('refund', 'credit_note', 'return')"),
    anyOrder: db.prepare('SELECT 1 AS x FROM wholesale_held_orders WHERE snapshot IS NOT NULL LIMIT 1'),
  };
  /** Days whose totals may have moved since they were last written (local "YYYY-MM-DD"). In memory: a start rewrites all. */
  const dirty = new Set();
  const add = (day) => {
    if (day) dirty.add(day);
  };

  /** An order is about to change, or just changed: its own day and its refunds' and credit notes' days may move. */
  function touchOrder(uid) {
    if (!uid) return;
    const o = q.order.get(uid);
    if (o) add(orderDayOf(o));
    for (const m of q.moneyDaysOfOrder.all(uid)) add(localDayOf(m.at));
  }
  /** A payment, refund, return or credit note is about to change, or just changed: its day (and, for a return, its refunds'). */
  function touchMoney(uid) {
    if (!uid) return;
    const m = q.money.get(uid);
    if (!m) return;
    add(localDayOf(m.at));
    if (m.kind === 'return') for (const r of q.moneyDaysOfReturn.all(uid)) add(localDayOf(r.at));
  }

  const sales = () => services.sales ?? null;
  const storeInfo = () => ({
    store: WHOLESALE_STORE, name: WHOLESALE_STORE_NAME, businessId: BUSINESS_IDS.wholesale, currency: WHOLESALE_CURRENCY,
    timeZone: WHOLESALE_SALES_ZONE,
  });
  function write(rows) {
    if (!rows.length) return 0;
    return sales().putDays({ source: WHOLESALE_SOURCE, ...storeInfo(), days: rows });
  }

  /** Work the marked days out again and write them (one transaction, through the sales service). → days written. */
  function flush() {
    if (!dirty.size || !sales()) return 0;
    const days = [...dirty].sort();
    const orders = new Map();
    const orderOf = (uid) => {
      if (!orders.has(uid)) orders.set(uid, q.order.get(uid) ?? null);
      return orders.get(uid);
    };
    const returnOf = (uid) => q.money.get(uid) ?? null;
    const heldOrders = [];
    const heldMoney = [];
    // A local day lies within the UTC days around it (Toronto is 4–5 hours behind UTC; a history-only order is stamped
    // at noon UTC on its date): read a day either side, salesDays keeps what is on the day asked.
    for (const d of days) {
      const from = addDays(d, -1);
      const to = addDays(d, 2);
      heldOrders.push(...q.ordersOn.all(from, to));
      heldMoney.push(...q.moneyOn.all(from, to));
    }
    const figures = salesDays({ orders: heldOrders, money: heldMoney, days, orderOf, returnOf });
    const n = write([...figures].map(([day, f]) => ({ day, ...f })));
    for (const d of days) dirty.delete(d);
    return n;
  }
  /** flush() that never throws (the days stay marked and are written after the next request, or the next minute). */
  function flushSafely() {
    try {
      return flush();
    } catch (err) {
      log?.error?.('writing wholesale sales days failed (tried again soon):', err);
      return 0;
    }
  }

  /**
   * Every day again from the whole holding area (at start: the first start after deploying is the backfill; after a
   * restore the totals were rolled back but the holding area wasn't). Days written before that now have nothing are
   * written as zeros. → days written.
   */
  function rebuildAll() {
    if (!sales()) return 0;
    const money = q.allMoney.all();
    const figures = salesDays({ orders: q.allOrders.all(), money });
    const stored = new Map((sales().storeRows?.({ source: WHOLESALE_SOURCE, store: WHOLESALE_STORE }) ?? []).map((r) => [r.day, r]));
    for (const d of stored.keys()) {
      if (!figures.has(d)) figures.set(d, salesDays({ orders: [], money: [], days: [d] }).get(d));
    }
    dirty.clear();
    // Only days whose figures differ from what is stored (review fix): an unchanged day keeps its "updated" time.
    const same = (row, f) => row && row.currency === WHOLESALE_CURRENCY && row.business_id === BUSINESS_IDS.wholesale
      && SALES_FIGURES.every((k) => row[k] === f[k]) && (row.raw ?? null) === JSON.stringify(f.raw);
    return write([...figures].filter(([day, f]) => !same(stored.get(day), f)).map(([day, f]) => ({ day, ...f })));
  }

  /** Registers the source with the sales module (from the start hook: sales comes after wholesale in the list). */
  function register() {
    sales()?.registerSource({
      source: WHOLESALE_SOURCE,
      label: 'Order Manager',
      stores: () => {
        // Listed once the connection is set up or anything was received (a removed secret keeps the totals listed).
        const has = Boolean(q.anyOrder.get());
        if (!isSetUp() && !has) return [];
        const paused = isPaused();
        return [{
          ...storeInfo(),
          state: paused ? 'paused' : has ? null : 'nothing_yet',
          lastSuccessAt: lastReceivedAt(),
          lastError: null,
          link: '/wholesale',
          note: 'Counted as the Order Manager’s P&L counts them: active orders on their day here (Toronto), refunds and credit notes on theirs',
        }];
      },
    });
  }

  return { touchOrder, touchMoney, flush, flushSafely, rebuildAll, register, pending: () => dirty.size };
}
