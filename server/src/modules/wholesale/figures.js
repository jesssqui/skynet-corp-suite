// A wholesale customer's figures (D1), from the holding area — no database here, so the rules are
// tested on their own. The Order Manager's own rules (its CLAUDE.md, A8 "Sales net of refunds and
// credit notes" and A7 "store credit made by a delete"):
//
//  • An order counts while it is active and not deleted (cancelled and binned orders drop out, with
//    whatever was given back on them). History-only (catch-up) orders count: they are real sales.
//  • sales = Σ goods of the counting orders, goods = subtotal − discounts: before tax, no shipping.
//  • given back (before tax, so tax is never taken off twice): for a refund or credit note made by a
//    return that carries its own subtotal (A10's return.received has subtotal/tax/shipping since the
//    Order Manager's D1 follow-up), that subtotal — exact even when shipping went back too; else a
//    credit note's own subtotal; any other refund with an amount (money back, or store credit put on
//    the account) in its order's proportion goods / (goods + tax) (older returns without the fields). Store credit *used* later never counts (it would undo or double the
//    credit note / refund that made it).
//  • spend = sales − given back (what the plan calls "total spend").
//  • paid = live payments (removed ones don't count; a payment kept as store credit when its order was
//    deleted is removed as a payment and counted in credit instead).
//  • credit = store credit the customer holds: store-credit refunds + credit notes (with tax) +
//    payments moved to store credit by a delete (moved_to) − store credit used. A restore of the
//    order brings the payment back (live, moved_to cleared), so the credit goes away again.
//  • last order = the newest counting order's date; order count = counting orders.
import { addDays } from '@suite/shared/planner';

/**
 * @param {Array<{ uid, status, deleted, goods_cents, tax_cents, order_date, has_snapshot }>} orders
 * @param {Array<{ uid, kind, sub_kind, amount_cents, subtotal_cents, removed, moved_to, order_uid, return_uid }>} money
 */
export function customerFigures(orders, money) {
  const counting = new Map();
  for (const o of orders) {
    if (o.has_snapshot && !o.deleted && o.status === 'active') counting.set(o.uid, o);
  }
  let sales = 0;
  let first = null;
  let last = null;
  for (const o of counting.values()) {
    sales += o.goods_cents;
    if (o.order_date) {
      if (!first || o.order_date < first) first = o.order_date;
      if (!last || o.order_date > last) last = o.order_date;
    }
  }
  let givenBack = 0;
  let paid = 0;
  let credit = 0;
  // Returns that say what their goods were worth before tax (and weren't removed).
  const returnNet = new Map();
  for (const m of money) {
    if (m.kind === 'return' && !m.removed && Number.isSafeInteger(m.subtotal_cents)) returnNet.set(m.uid, m.subtotal_cents);
  }
  const fromReturn = (m) => (m.return_uid && returnNet.has(m.return_uid) ? returnNet.get(m.return_uid) : null);
  for (const m of money) {
    if (m.kind === 'payment') {
      if (!m.removed) paid += m.amount_cents;
      else if (m.moved_to === 'store_credit') credit += m.amount_cents;
      continue;
    }
    if (m.removed) continue;
    if (m.kind === 'credit_note') {
      credit += m.amount_cents;
      if (counting.has(m.order_uid)) givenBack += fromReturn(m) ?? m.subtotal_cents ?? m.amount_cents;
    } else if (m.kind === 'refund') {
      if (m.sub_kind === 'store_credit_applied') {
        credit += m.amount_cents; // negative: credit used up
        continue;
      }
      if (m.sub_kind === 'store_credit') credit += m.amount_cents;
      if (m.amount_cents > 0 && counting.has(m.order_uid)) givenBack += fromReturn(m) ?? netOfTax(m.amount_cents, counting.get(m.order_uid));
    }
  }
  return {
    order_count: counting.size,
    first_order_date: first,
    last_order_date: last,
    sales_cents: sales,
    given_back_cents: givenBack,
    spend_cents: sales - givenBack,
    paid_cents: paid,
    credit_cents: credit,
  };
}

/** A refund's amount without its share of tax: amount × goods / (goods + tax), to the cent. */
export function netOfTax(amount, order) {
  const goods = order.goods_cents;
  const withTax = goods + order.tax_cents;
  return withTax > 0 ? Math.round((amount * goods) / withTax) : amount;
}

/** What an order's own record shows: paid on it (payments + store credit used on it) and given back (with tax). */
export function orderMoney(money) {
  let paid = 0;
  let returned = 0;
  for (const m of money) {
    if (m.removed) continue;
    if (m.kind === 'payment') paid += m.amount_cents;
    else if (m.kind === 'refund' && m.sub_kind === 'store_credit_applied') paid -= m.amount_cents; // stored negative
    else if (m.kind === 'refund' && m.amount_cents > 0) returned += m.amount_cents;
    else if (m.kind === 'credit_note') returned += m.amount_cents;
  }
  return { paid_cents: paid, returned_cents: returned };
}

// ---- D3: ordering rhythm and money owing -------------------------------------------------------
// Pure rules over the holding area's rows, shared by the automations (check-ins, balance reminders)
// and the customer card (the "Quiet regular" flag), so they always agree. Dates are calendar days
// ("YYYY-MM-DD"), worked out with addDays/daysBetween (no time zones).

/** How a regular's rhythm is read. See CLAUDE.md, "Wholesale automations (D3)". */
export const RHYTHM = Object.freeze({
  /** A regular has ordered on at least this many different days (so at least 3 gaps to go by). */
  MIN_ORDER_DAYS: 4,
  /** The usual gap is the median of the most recent gaps (habits change: older ones drop out). */
  RECENT_GAPS: 8,
  /** Someone who usually goes longer than this between orders isn't a regular to chase. */
  MAX_USUAL_GAP_DAYS: 90,
  /** Quiet once the days since the last order clearly exceed the usual gap: more than … */
  FACTOR: 1.5, // … 1.5 × the usual gap (rounded up),
  MARGIN_DAYS: 7, // … and more than the usual gap + 7 days (whichever is later).
});

/** Days from `a` to `b` (both "YYYY-MM-DD"): b − a, on the calendar. */
export function daysBetween(a, b) {
  const t = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** An order that counts (as in customerFigures): active, not deleted, with a snapshot. */
export const countsAsOrder = (o) => Boolean(o.has_snapshot) && !o.deleted && o.status === 'active';

/** Newest first: order date, then when it was placed, then uid. */
const newestFirst = (a, b) => String(b.order_date ?? '').localeCompare(String(a.order_date ?? ''))
  || String(b.placed_at ?? '').localeCompare(String(a.placed_at ?? '')) || (a.uid < b.uid ? 1 : -1);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * A customer's ordering rhythm from their orders (rows with uid, status, deleted, has_snapshot,
 * order_date, placed_at). Counting orders only (active, not deleted; history-only ones count: they
 * are real past sales). Orders on the same day are one ordering day.
 *
 * → { regular, usual_gap_days, quiet_after_days, quiet_from, last_order_uid, last_order_date, order_days, gaps }
 *   regular           ≥ MIN_ORDER_DAYS ordering days and a usual gap ≤ MAX_USUAL_GAP_DAYS
 *   usual_gap_days    the median of the last RECENT_GAPS gaps between ordering days (regulars only)
 *   quiet_after_days  max(ceil(1.5 × usual), usual + 7): quiet when the days since the last order exceed it
 *   quiet_from        the first day they count as quiet: last order date + quiet_after_days + 1 (null
 *                     when not a regular). A date, so a device can tell on its own when it is reached.
 *   last_order_uid    the newest counting order (date, then placed time): the check-in's key
 */
export function orderRhythm(orders) {
  const counting = orders.filter((o) => countsAsOrder(o) && o.order_date).sort(newestFirst);
  const last = counting[0] ?? null;
  const days = [...new Set(counting.map((o) => o.order_date))].sort();
  const out = {
    regular: false, usual_gap_days: null, quiet_after_days: null, quiet_from: null,
    last_order_uid: last?.uid ?? null, last_order_date: last?.order_date ?? null, order_days: days.length, gaps: [],
  };
  if (days.length < RHYTHM.MIN_ORDER_DAYS) return out;
  const gaps = [];
  for (let i = 1; i < days.length; i += 1) gaps.push(daysBetween(days[i - 1], days[i]));
  out.gaps = gaps.slice(-RHYTHM.RECENT_GAPS);
  const usual = median(out.gaps);
  if (usual > RHYTHM.MAX_USUAL_GAP_DAYS) return out;
  const after = Math.max(Math.ceil(usual * RHYTHM.FACTOR), usual + RHYTHM.MARGIN_DAYS);
  return { ...out, regular: true, usual_gap_days: usual, quiet_after_days: after, quiet_from: addDays(last.order_date, after + 1) };
}

/** Is a rhythm (or a card with quiet_from) past its usual gap on `today`? */
export const isQuiet = (r, today) => Boolean(r?.quiet_from) && today >= r.quiet_from;

/** Money owing counts as overdue once its order is more than this many days old. */
export const OVERDUE_AFTER_DAYS = 30;

/**
 * What each order still owes, by the Order Manager's own balance rule (its A8 "Balance" and
 * utils/money.js PAID_ROWS_SQL): balance = order totals − payments − store credit applied. Refunds
 * and credit notes are NOT taken off an order's balance — a credit note is credit the customer
 * holds until it is applied (then it is "store credit applied" on an order, so taking off both would
 * count it twice), and money refunded went back to the customer. Per order:
 *
 *  • orders that count (active, not deleted; history-only ones too, as in the Order Manager):
 *    owing = total_cents − live payments on it − store credit applied on it;
 *  • money not tied to a counting order goes to the oldest owing orders first (the Order Manager's
 *    aging does the same): payments on account (no order, or an order not held here), what an
 *    overpaid order paid beyond its total, and what was paid on a cancelled or deleted order less
 *    what was given back on it (refunds + credit notes; never below 0 — PAID_ROWS_SQL's rule).
 *
 * orders: rows { uid, number, order_date, placed_at, status, deleted, has_snapshot, total_cents }
 * money:  rows { kind, sub_kind, amount_cents, removed, order_uid }
 * → { orders: [{ uid, number, order_date, total_cents, paid_cents, owing_cents }] oldest first (counting
 *     orders only), balance_cents (Σ owing), unused_cents (money left over after every order is paid) }
 */
export function owingByOrder(orders, money) {
  const counting = orders.filter(countsAsOrder);
  const isCounting = new Set(counting.map((o) => o.uid));
  const known = new Set(orders.map((o) => o.uid));
  const paidOn = new Map();
  const backOn = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  let pool = 0;
  for (const m of money) {
    if (m.removed) continue;
    let paid = 0;
    if (m.kind === 'payment') paid = m.amount_cents;
    else if (m.kind === 'refund' && m.sub_kind === 'store_credit_applied') paid = -m.amount_cents; // stored negative
    else if ((m.kind === 'refund' && m.amount_cents > 0) || m.kind === 'credit_note') {
      if (m.order_uid) add(backOn, m.order_uid, m.amount_cents);
      continue;
    } else continue;
    if (m.order_uid && known.has(m.order_uid)) add(paidOn, m.order_uid, paid);
    else pool += paid; // on account
  }
  for (const o of orders) {
    if (isCounting.has(o.uid)) continue;
    pool += Math.max(0, (paidOn.get(o.uid) ?? 0) - (backOn.get(o.uid) ?? 0));
  }
  const rows = counting.map((o) => {
    const paid = paidOn.get(o.uid) ?? 0;
    let owing = (o.total_cents ?? 0) - paid;
    if (owing < 0) {
      pool += -owing;
      owing = 0;
    }
    return { uid: o.uid, number: o.number ?? null, order_date: o.order_date ?? null, placed_at: o.placed_at ?? null, total_cents: o.total_cents ?? 0, paid_cents: paid, owing_cents: owing };
  }).sort((a, b) => -newestFirst(a, b));
  for (const r of rows) {
    if (pool <= 0) break;
    const take = Math.min(pool, r.owing_cents);
    r.owing_cents -= take;
    pool -= take;
  }
  return {
    orders: rows.map(({ placed_at: _p, ...r }) => r),
    balance_cents: rows.reduce((s, r) => s + r.owing_cents, 0),
    unused_cents: Math.max(0, pool),
  };
}

/** The orders owing money that are more than OVERDUE_AFTER_DAYS old on `today`, oldest first. */
export function overdueOrders(owing, today) {
  return owing.orders.filter((o) => o.owing_cents > 0 && o.order_date && daysBetween(o.order_date, today) > OVERDUE_AFTER_DAYS);
}
