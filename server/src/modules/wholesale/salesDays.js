// Wholesale sales per day (D11), from the holding area — pure, no database (tested on its own). The rows go into the
// shared daily sales totals (the sales module, source `wholesale`), so the Sales page and the overview show wholesale
// beside the stores. See CLAUDE.md, "Wholesale sales (D11)".
//
// Which report is matched (decision): the Order Manager's **Reports → P&L** (`GET /api/reports/profit-loss?from&to`),
// the one report there that is "net of refunds and credit notes" for any range of days. Its rules, copied exactly:
//
//  • An order counts while it is **active** (cancelled orders, and deleted ones — binned orders are cancelled there —
//    don't). History-only (catch-up) orders count: they are active.
//  • It counts on the **UTC day of its created_at** (SQLite's date(created_at): the Order Manager stores created_at in
//    UTC and its P&L filters with date(), so an order entered after 8 p.m. in Toronto (7 p.m. in winter) is on the next
//    day there). A history-only order's created_at is its order date at 12:00, so it counts on its order date. Not
//    order_date: the P&L never reads it.
//  • Revenue = Σ quantity × price of its lines (an order with no lines adds nothing to revenue or the order count, but
//    its discount, tax and shipping still count — the P&L reads those from the orders table without the lines).
//    Discounts = its discount_amount. Tax collected and shipping collected = its tax and shipping.
//  • Given back (the P&L's "Refunds" and "Credit notes"), **before tax**, on the day it was given (the refund's
//    created_at / the credit note's issued_at, UTC), only while its order still counts (a cancelled order's refunds
//    drop out with it): a refund made by a return takes the return's own subtotal; any other refund with an amount
//    (money back or store credit put on the account) is taken in its order's proportion goods / (goods + tax); a credit
//    note takes its own subtotal. Store credit used up later is never counted (it would undo the credit).
//  • Net revenue = revenue − discounts − refunds − credit notes.
//
// The row (SALES_FIGURES): orders, items (units on the counting orders' lines), gross = revenue, discounts, refunds =
// refunds + credit notes before tax (so `net` = the P&L's Net Revenue, to the cent), and — so that `total` is "total
// sales" like every other store's (items, shipping and tax after discounts and refunds) — tax and shipping **less what
// went back**: each refund or credit note takes its whole amount off the total, split into its net (above), its
// shipping (the return's or credit note's own shipping, else none) and the rest as tax. So `tax` and `shipping` equal
// the P&L's "Tax Collected" and "Shipping Collected" on days with nothing given back, and are lower on the others (the
// P&L doesn't take refunded tax or shipping off). total = net + tax + shipping = Σ order totals − Σ given back with tax.
// Rounding: like the P&L, a day's proportional refunds are added unrounded and the day's sum rounded once (orders,
// returns and credit notes are whole cents already), so each day equals the P&L for that day to the cent. A range is
// the sum of its days, while the P&L rounds the whole range once: a range with proportional refunds on several days
// can differ from the P&L's range by a cent.
import { addDays } from '@suite/shared/planner';
import { zeroFigures } from '@suite/shared/sales';

/** The store key of the Order Manager in the daily sales totals (one Order Manager; CAD). */
export const WHOLESALE_STORE = 'wholesale';
/** Its days are UTC days: the Order Manager's P&L counts by date(created_at) on UTC times (see above). */
export const WHOLESALE_SALES_ZONE = 'UTC';
export const WHOLESALE_CURRENCY = 'CAD';

const isInt = (v) => Number.isSafeInteger(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
/** "2026-10-09T23:30:00.000Z" → "2026-10-09" (the stored times are UTC ISO), else null. */
export const utcDayOf = (iso) => (typeof iso === 'string' && DAY_RE.test(iso) ? iso.slice(0, 10) : null);
const parse = (s) => {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
};

/** An order that counts in the P&L: seen in full, active, not deleted. */
export const countsAsSale = (o) => Boolean(o?.snapshot) && !o.deleted && o.status === 'active';

/** An order's own figures for its day (from its snapshot): { orders, items, gross, discounts, tax, shipping, total }. */
export function orderSaleFigures(o) {
  const s = parse(o.snapshot) ?? {};
  const t = s.totals ?? {};
  const lines = Array.isArray(s.lines) ? s.lines : [];
  const items = lines.reduce((a, l) => a + (isInt(l?.quantity) ? l.quantity : 0), 0);
  const gross = isInt(t.subtotal_cents) ? t.subtotal_cents : lines.reduce((a, l) => a + (isInt(l?.subtotal_cents) ? l.subtotal_cents : 0), 0);
  const discounts = isInt(t.discount_cents) ? t.discount_cents : 0;
  const tax = isInt(t.tax_cents) ? t.tax_cents : 0;
  const shipping = isInt(t.shipping_cents) ? t.shipping_cents : 0;
  return {
    // The P&L counts orders (and revenue) through their lines: an order with none isn't an order there.
    orders: lines.length ? 1 : 0,
    items,
    gross: lines.length ? gross : 0,
    discounts,
    tax,
    shipping,
  };
}

/**
 * A refund or credit note as the P&L takes it off: null when it doesn't count (removed, store credit used up, no
 * amount, its order doesn't count now), else { day, net, raw, shipping, tax, amount } in cents — net before tax (the
 * P&L's figure, rounded; `raw` = unrounded, for a refund taken in its order's proportion — a day adds those up first),
 * amount = all of it (with tax), shipping/tax = what of the rest was shipping and tax.
 *   m        a held money row { kind, sub_kind, amount_cents, subtotal_cents, removed, order_uid, return_uid, at, snapshot }
 *   orderOf  uid → held order (or null)
 *   returnOf uid → held return row (or null)
 */
export function givenBack(m, orderOf, returnOf) {
  if (!m || m.removed) return null;
  if (m.kind !== 'refund' && m.kind !== 'credit_note') return null;
  if (m.kind === 'refund' && m.sub_kind === 'store_credit_applied') return null;
  const amount = Number(m.amount_cents) || 0;
  if (m.kind === 'refund' && amount <= 0) return null;
  const order = m.order_uid ? orderOf(m.order_uid) : null;
  if (!countsAsSale(order)) return null;
  const day = utcDayOf(m.at);
  if (!day) return null;
  const snap = parse(m.snapshot) ?? {};
  let net;
  let raw = null;
  let shipping = 0;
  if (m.kind === 'credit_note') {
    net = isInt(m.subtotal_cents) ? m.subtotal_cents : (isInt(snap.subtotal_cents) ? snap.subtotal_cents : amount);
    shipping = isInt(snap.shipping_cents) ? snap.shipping_cents : 0;
  } else {
    const ret = m.return_uid ? returnOf(m.return_uid) : null;
    const retSnap = ret && !ret.removed ? (parse(ret.snapshot) ?? {}) : null;
    const retSub = ret && !ret.removed ? (isInt(ret.subtotal_cents) ? ret.subtotal_cents : (isInt(retSnap?.subtotal_cents) ? retSnap.subtotal_cents : null)) : null;
    if (retSub !== null) {
      net = retSub;
      shipping = isInt(retSnap?.shipping_cents) ? retSnap.shipping_cents : 0;
    } else {
      // In its order's proportion goods / (goods + tax), as the P&L does (goods = items − discounts).
      const goods = Number(order.goods_cents) || 0;
      const withTax = goods + (Number(order.tax_cents) || 0);
      raw = withTax > 0 ? (amount * goods) / withTax : amount;
      net = Math.round(raw);
    }
  }
  return { day, net, raw, shipping, tax: amount - net - shipping, amount };
}

/**
 * Days → figures (SALES_FIGURES, cents) for the days asked (`days`: a Set or array; null = every day anything happened),
 * from held orders and money rows. A day asked with nothing on it comes back as zeros (a cancelled order's day is
 * written again as zeros). → Map day → figures
 *   orders  held order rows { uid, status, deleted, snapshot, placed_at, goods_cents, tax_cents }
 *   money   held money rows (refunds and credit notes; others are ignored)
 *   orderOf / returnOf  lookups for the money rows' orders and returns (default: from `orders` / `money`)
 */
export function salesDays({ orders, money, days = null, orderOf = null, returnOf = null }) {
  const want = days ? new Set(days) : null;
  const out = new Map();
  const row = (day) => {
    if (!out.has(day)) out.set(day, zeroFigures());
    return out.get(day);
  };
  if (want) for (const d of want) row(d);
  const byUid = orderOf ? null : new Map(orders.map((o) => [o.uid, o]));
  const moneyByUid = returnOf ? null : new Map(money.map((m) => [m.uid, m]));
  const findOrder = orderOf ?? ((uid) => byUid.get(uid) ?? null);
  const findReturn = returnOf ?? ((uid) => moneyByUid.get(uid) ?? null);
  for (const o of orders) {
    if (!countsAsSale(o)) continue;
    const day = utcDayOf(o.placed_at);
    if (!day || (want && !want.has(day))) continue;
    const f = orderSaleFigures(o);
    const r = row(day);
    for (const k of ['orders', 'items', 'gross', 'discounts', 'tax', 'shipping']) r[k] += f[k];
  }
  // What went back per day: whole-cent nets, the proportional ones unrounded (rounded once per day, as the P&L does),
  // all of it with tax, and its shipping.
  const back = new Map();
  for (const m of money) {
    const b = givenBack(m, findOrder, findReturn);
    if (!b || (want && !want.has(b.day))) continue;
    row(b.day);
    const acc = back.get(b.day) ?? { exact: 0, raw: 0, amount: 0, shipping: 0 };
    if (b.raw === null) acc.exact += b.net;
    else acc.raw += b.raw;
    acc.amount += b.amount;
    acc.shipping += b.shipping;
    back.set(b.day, acc);
  }
  for (const [day, r] of out) {
    const b = back.get(day);
    if (b) {
      r.refunds = b.exact + Math.round(b.raw);
      r.shipping -= b.shipping;
      r.tax -= b.amount - r.refunds - b.shipping; // the rest of what went back was tax
    }
    r.net = r.gross - r.discounts - r.refunds;
    r.total = r.net + r.tax + r.shipping;
  }
  return out;
}

/** The days an order and its money rows count on (its own day and each refund's / credit note's), for re-writing. */
export function daysTouched(order, money) {
  const days = new Set();
  const d = utcDayOf(order?.placed_at);
  if (d) days.add(d);
  for (const m of money ?? []) {
    const md = utcDayOf(m?.at);
    if (md) days.add(md);
  }
  return days;
}

/** Every day from `from` to `to` ("YYYY-MM-DD", both included). */
export function dayRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
