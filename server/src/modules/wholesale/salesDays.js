// Wholesale sales per day (D11), from the holding area — pure, no database (tested on its own). The rows go into the
// shared daily sales totals (the sales module, source `wholesale`), so the Sales page and the overview show wholesale
// beside the stores. See CLAUDE.md, "Wholesale sales (D11)".
//
// Which report is matched (decision): the Order Manager's **Reports → P&L** (`GET /api/reports/profit-loss?from&to`),
// the one report there that is "net of refunds and credit notes" for any range of days. Its rules (since its A19),
// copied exactly:
//
//  • An order counts while it is **active** (cancelled orders, and deleted ones — binned orders are cancelled there —
//    don't). History-only (catch-up) orders count: they are active.
//  • It counts on the business's **local day** (America/Toronto) of its created_at; a history-only order on its
//    order_date (it is stamped at noon UTC — the same day in Toronto). Days are calendar days in that zone, DST and all.
//  • Revenue = Σ quantity × price of its lines (an order with no lines adds nothing to revenue or the order count, but
//    its discount, tax and shipping still count). Discounts = its discount_amount. Tax / shipping collected = its own.
//  • Given back (the P&L's "Refunds" and "Credit notes"), **before tax**, on the local day it was given (the refund's
//    created_at / the credit note's issued_at), only while its order still counts: a refund made by a return takes the
//    return's own subtotal; any other refund with an amount (money back or store credit put on the account) is taken in
//    its order's proportion goods / (goods + tax) (1 when that is ≤ 0); a credit note takes its own subtotal. Store
//    credit used up later is never counted.
//  • Net revenue = revenue − discounts − refunds − credit notes.
//  • **Exact cents** (its A19): the P&L adds the stored, unrounded amounts and rounds each line once per range. The
//    order snapshots carry them (`totals.items_raw`, `discount_raw`, `tax_raw`, dollars) and refunds `amount_raw`; when
//    present they are added up unrounded here too — per day, and each day row keeps them (`raw`), so a week or month is
//    rounded once as well (sumByCurrency in shared/sales.js). Older events without them fall back to whole cents.
//
// The row (SALES_FIGURES): orders, items (units on the counting orders' lines), gross = revenue, discounts, refunds =
// refunds + credit notes before tax (so `net` = the P&L's Net Revenue, to the cent), and — so that `total` is "total
// sales" like every other store's (items, shipping and tax after discounts and refunds) — tax and shipping **less what
// went back**: each refund or credit note takes its whole amount off the total, split into its net (above), its
// shipping (the return's or credit note's own shipping, else none) and the rest as tax. So `tax` and `shipping` equal
// the P&L's "Tax Collected" and "Shipping Collected" on days with nothing given back, and are lower on the others (the
// P&L doesn't take refunded tax or shipping off). total = net + tax + shipping.
import { zeroFigures, localDateIn, roundDollars } from '@suite/shared/sales';

/** The store key of the Order Manager in the daily sales totals (one Order Manager; CAD). */
export const WHOLESALE_STORE = 'wholesale';
/** Its days are the business's local days, as the Order Manager's P&L counts them since its A19 (REPORT_TIME_ZONE there). */
export const WHOLESALE_SALES_ZONE = 'America/Toronto';
export const WHOLESALE_CURRENCY = 'CAD';

const isInt = (v) => Number.isSafeInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const parse = (s) => {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A stored time (UTC ISO) → its calendar day in the business's zone, else null. */
export function localDayOf(iso, zone = WHOLESALE_SALES_ZONE) {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localDateIn(zone, d);
}

/** The day an order counts on: a history-only order its order_date, any other the local day it was entered. */
export function orderDayOf(o, zone = WHOLESALE_SALES_ZONE) {
  const s = parse(o?.snapshot) ?? {};
  if (s.history_only && DATE_RE.test(s.order_date ?? '')) return s.order_date;
  return localDayOf(o?.placed_at, zone);
}

/** An order that counts in the P&L: seen in full, active, not deleted. */
export const countsAsSale = (o) => Boolean(o?.snapshot) && !o.deleted && o.status === 'active';

/**
 * An order's own figures for its day (from its snapshot): whole cents { orders, items, gross, discounts, tax, shipping }
 * and unrounded dollars { itemsRaw, discountRaw, taxRaw } (A19's raw totals, else the cents / 100).
 */
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
    itemsRaw: lines.length ? (isNum(t.items_raw) ? t.items_raw : gross / 100) : 0,
    discountRaw: isNum(t.discount_raw) ? t.discount_raw : discounts / 100,
    taxRaw: isNum(t.tax_raw) ? t.tax_raw : tax / 100,
  };
}

/**
 * A refund or credit note as the P&L takes it off: null when it doesn't count (removed, store credit used up, no
 * amount, its order doesn't count now), else { day, netRaw (dollars, before tax: the P&L's figure, unrounded),
 * net (cents, rounded), shippingCents, amountCents (all of it, with tax), amountRaw (dollars) }.
 *   m        a held money row { kind, sub_kind, amount_cents, subtotal_cents, removed, order_uid, return_uid, at, snapshot }
 *   orderOf  uid → held order (or null)
 *   returnOf uid → held return row (or null)
 */
export function givenBack(m, orderOf, returnOf, zone = WHOLESALE_SALES_ZONE) {
  if (!m || m.removed) return null;
  if (m.kind !== 'refund' && m.kind !== 'credit_note') return null;
  if (m.kind === 'refund' && m.sub_kind === 'store_credit_applied') return null;
  const amount = Number(m.amount_cents) || 0;
  if (m.kind === 'refund' && amount <= 0) return null;
  const order = m.order_uid ? orderOf(m.order_uid) : null;
  if (!countsAsSale(order)) return null;
  const day = localDayOf(m.at, zone);
  if (!day) return null;
  const snap = parse(m.snapshot) ?? {};
  const amountRaw = isNum(snap.amount_raw) ? snap.amount_raw : amount / 100;
  let netRaw;
  let shipping = 0;
  if (m.kind === 'credit_note') {
    const sub = isInt(m.subtotal_cents) ? m.subtotal_cents : (isInt(snap.subtotal_cents) ? snap.subtotal_cents : amount);
    netRaw = sub / 100;
    shipping = isInt(snap.shipping_cents) ? snap.shipping_cents : 0;
  } else {
    const ret = m.return_uid ? returnOf(m.return_uid) : null;
    const retSnap = ret && !ret.removed ? (parse(ret.snapshot) ?? {}) : null;
    const retSub = ret && !ret.removed ? (isInt(ret.subtotal_cents) ? ret.subtotal_cents : (isInt(retSnap?.subtotal_cents) ? retSnap.subtotal_cents : null)) : null;
    if (retSub !== null) {
      netRaw = retSub / 100;
      shipping = isInt(retSnap?.shipping_cents) ? retSnap.shipping_cents : 0;
    } else {
      // In its order's proportion goods / (goods + tax) as the order is now (goods = items − discounts), as the P&L does.
      const f = orderSaleFigures(order);
      const goods = f.itemsRaw - f.discountRaw;
      const withTax = goods + f.taxRaw;
      netRaw = amountRaw * (withTax > 0 ? goods / withTax : 1);
    }
  }
  return { day, netRaw, net: roundDollars(netRaw), shippingCents: shipping, amountCents: amount, amountRaw };
}

/**
 * Days → figures (SALES_FIGURES, cents, plus `raw`: { gross, discounts, refunds, net, tax } unrounded in dollars) for
 * the days asked (`days`: a Set or array; null = every day anything happened), from held orders and money rows. A day
 * asked with nothing on it comes back as zeros (a cancelled order's day is written again as zeros). → Map day → figures
 *   orders  held order rows { uid, status, deleted, snapshot, placed_at, goods_cents, tax_cents }
 *   money   held money rows (refunds and credit notes; others are ignored)
 *   orderOf / returnOf  lookups for the money rows' orders and returns (default: from `orders` / `money`)
 */
export function salesDays({ orders, money, days = null, orderOf = null, returnOf = null, zone = WHOLESALE_SALES_ZONE }) {
  const want = days ? new Set(days) : null;
  const acc = new Map();
  const at = (day) => {
    if (!acc.has(day)) {
      acc.set(day, {
        orders: 0, items: 0, shippingCents: 0, grossRaw: 0, discountRaw: 0, taxRaw: 0,
        backNetRaw: 0, backAmountRaw: 0, backAmountCents: 0, backShipCents: 0,
      });
    }
    return acc.get(day);
  };
  if (want) for (const d of want) at(d);
  const byUid = orderOf ? null : new Map(orders.map((o) => [o.uid, o]));
  const moneyByUid = returnOf ? null : new Map(money.map((m) => [m.uid, m]));
  const findOrder = orderOf ?? ((uid) => byUid.get(uid) ?? null);
  const findReturn = returnOf ?? ((uid) => moneyByUid.get(uid) ?? null);
  const seen = new Set();
  for (const o of orders) {
    if (!countsAsSale(o) || seen.has(o.uid)) continue;
    seen.add(o.uid);
    const day = orderDayOf(o, zone);
    if (!day || (want && !want.has(day))) continue;
    const f = orderSaleFigures(o);
    const a = at(day);
    a.orders += f.orders;
    a.items += f.items;
    a.shippingCents += f.shipping;
    a.grossRaw += f.itemsRaw;
    a.discountRaw += f.discountRaw;
    a.taxRaw += f.taxRaw;
  }
  const seenMoney = new Set();
  for (const m of money) {
    if (seenMoney.has(m.uid)) continue;
    seenMoney.add(m.uid);
    const b = givenBack(m, findOrder, findReturn, zone);
    if (!b || (want && !want.has(b.day))) continue;
    const a = at(b.day);
    a.backNetRaw += b.netRaw;
    a.backAmountRaw += b.amountRaw;
    a.backAmountCents += b.amountCents;
    a.backShipCents += b.shippingCents;
  }
  const out = new Map();
  for (const [day, a] of acc) {
    const refunds = roundDollars(a.backNetRaw);
    const netRaw = a.grossRaw - a.discountRaw - a.backNetRaw;
    // What went back that wasn't its net or shipping was tax.
    const tax = roundDollars(a.taxRaw) - (a.backAmountCents - refunds - a.backShipCents);
    const shipping = a.shippingCents - a.backShipCents;
    const net = roundDollars(netRaw);
    out.set(day, {
      ...zeroFigures(),
      orders: a.orders,
      items: a.items,
      gross: roundDollars(a.grossRaw),
      discounts: roundDollars(a.discountRaw),
      refunds,
      net,
      tax,
      shipping,
      total: net + tax + shipping,
      raw: {
        gross: a.grossRaw, discounts: a.discountRaw, refunds: a.backNetRaw, net: netRaw,
        tax: a.taxRaw - (a.backAmountRaw - a.backNetRaw - a.backShipCents / 100),
      },
    });
  }
  return out;
}

/** The days an order and its money rows count on (its own day and each refund's / credit note's), for re-writing. */
export function daysTouched(order, money, zone = WHOLESALE_SALES_ZONE) {
  const days = new Set();
  const d = order ? orderDayOf(order, zone) : null;
  if (d) days.add(d);
  for (const m of money ?? []) {
    const md = localDayOf(m?.at, zone);
    if (md) days.add(md);
  }
  return days;
}
