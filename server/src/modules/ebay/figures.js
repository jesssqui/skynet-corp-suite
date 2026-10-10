// eBay orders → the suite's figures (D13), pure: the daily sales rows, the orders waiting to ship. No buyer
// detail is ever read into anything here (no username, name, address, email or phone: only order ids, amounts,
// dates, items and their quantities).
//
// The figure matched (decision; see CLAUDE.md "eBay (D13)"): Seller Hub → Performance → Sales, **Total sales** for a
// month — eBay's own definition: "Includes item price, shipping and handling paid by buyers to you, taxes and
// government fees such as recycling fees. Returns and canceled transactions are reflected." From getOrders (with
// fieldGroups=TAX_BREAKDOWN, so eBay-collected tax is in `total` and `tax`):
//   an order counts on the day it was created (the shop's zone), unless it is cancelled (cancelState CANCELED —
//   the order and its refunds are left out entirely) or unpaid (orderPaymentStatus PENDING / FAILED);
//   its figures: gross = priceSubtotal, discounts = priceSubtotal − (priceSubtotal + priceDiscount + adjustment),
//   shipping = deliveryCost + deliveryDiscount, tax = tax, total = pricingSummary.total, items = Σ quantity;
//   each refund (paymentSummary.refunds with refundStatus REFUNDED; line-item refunds when the order has none) counts
//   on the day it was issued, negative: refunds = its amount (eBay: the seller's net, without eBay-collected tax), the
//   tax refunded with it estimated in proportion (order tax × refund ÷ (order total − order tax), at most the order's
//   tax), total −= refund + that tax;
//   net = total − tax − shipping on every row (as WooCommerce's rows: total = net + tax + shipping).
import { toCents, zeroFigures, localDateIn } from '@suite/shared/sales';

const UNPAID = new Set(['PENDING', 'FAILED']);
const UNSHIPPED = new Set(['NOT_STARTED', 'IN_PROGRESS']);

const cents = (amount) => (amount && amount.value !== undefined ? toCents(amount.value) : 0);
const currencyOf = (o) => o?.pricingSummary?.total?.currency ?? o?.pricingSummary?.priceSubtotal?.currency ?? null;

/** Does the order count at all? (Not cancelled, paid or refunded.) */
export function orderCounts(o) {
  if (o?.cancelStatus?.cancelState === 'CANCELED') return false;
  if (UNPAID.has(o?.orderPaymentStatus)) return false;
  return Boolean(o?.creationDate && currencyOf(o));
}

/** One order's own figures (the day it was created). */
export function orderFigures(o) {
  const p = o.pricingSummary ?? {};
  const gross = cents(p.priceSubtotal);
  const goods = gross + cents(p.priceDiscount) + cents(p.adjustment);
  const shipping = cents(p.deliveryCost) + cents(p.deliveryDiscount);
  const tax = cents(p.tax);
  const total = p.total ? cents(p.total) : goods + shipping + tax;
  const items = (o.lineItems ?? []).reduce((a, li) => a + (Number(li.quantity) || 0), 0);
  return { ...zeroFigures(), orders: 1, items, gross, discounts: gross - goods, shipping, tax, total, net: total - tax - shipping };
}

/** The refunds that count: { at, amount (cents), currency }. */
export function refundsOf(o) {
  const own = (o.paymentSummary?.refunds ?? []).filter((r) => r.refundStatus === 'REFUNDED' && r.refundDate);
  const list = own.length ? own : (o.lineItems ?? []).flatMap((li) => (li.refunds ?? []).filter((r) => r.refundDate && r.amount));
  return list.map((r) => ({ at: r.refundDate, amount: cents(r.amount), currency: r.amount?.currency ?? currencyOf(o) })).filter((r) => r.amount > 0);
}

/** A refund's row (negative), with the tax refunded with it estimated in proportion. */
export function refundFigures(o, amount) {
  const f = orderFigures(o);
  const base = f.total - f.tax;
  const tax = base > 0 ? Math.min(f.tax, Math.round((f.tax * amount) / base)) : 0;
  return { ...zeroFigures(), refunds: amount, tax: -tax, total: -(amount + tax), net: -amount };
}

function add(a, b) {
  for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k];
  return a;
}

/**
 * The days from…to (the shop's calendar in `timeZone`) of a set of orders: Map currency → Map day → figures. Every day
 * from…to is there (zeros) for `currencies` (the shop's main one and any seen before); days outside from…to are left
 * out (their orders may be partial in this set).
 */
export function dayRows(orders, { from, to, timeZone, currencies = ['CAD'] }) {
  const out = new Map();
  const ensure = (cur) => {
    if (!out.has(cur)) {
      const m = new Map();
      for (let d = from; d <= to; d = nextDay(d)) m.set(d, zeroFigures());
      out.set(cur, m);
    }
    return out.get(cur);
  };
  for (const c of currencies) ensure(c);
  const inRange = (day) => day >= from && day <= to;
  for (const o of orders) {
    if (!orderCounts(o)) continue;
    const cur = currencyOf(o);
    const day = localDateIn(timeZone, new Date(o.creationDate));
    if (inRange(day)) add(ensure(cur).get(day), orderFigures(o));
    for (const r of refundsOf(o)) {
      const rd = localDateIn(timeZone, new Date(r.at));
      if (inRange(rd)) add(ensure(r.currency ?? cur).get(rd), refundFigures(o, r.amount));
    }
  }
  return out;
}

function nextDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The UTC instant of midnight starting `day` in `timeZone` (for getOrders' creationdate filter). */
export function zoneMidnightUtc(day, timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = (k) => Number(parts.find((p) => p.type === k).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return new Date(ms);
}

/** The order's ship-by date (the earliest of its line items'), or null. */
export const shipByOf = (o) => (o.lineItems ?? []).map((li) => li.lineItemFulfillmentInstructions?.shipByDate).filter(Boolean).sort()[0] ?? null;

/** Is the order waiting to be shipped (not started or part shipped, not cancelled, paid and not fully refunded)? */
export const waitingToShip = (o) => UNSHIPPED.has(o?.orderFulfillmentStatus) && orderCounts(o) && o.orderPaymentStatus !== 'FULLY_REFUNDED';

/**
 * What the suite keeps of an order for its shipping task — and nothing else: no buyer (username, name, address,
 * email, phone), no notes from the buyer, no fulfilment instructions' address.
 */
export function shipView(o) {
  return {
    orderId: String(o.orderId),
    createdAt: o.creationDate ?? null,
    status: o.orderFulfillmentStatus ?? null,
    cancelState: o.cancelStatus?.cancelState ?? null,
    paymentStatus: o.orderPaymentStatus ?? null,
    shipBy: shipByOf(o),
    total: cents(o.pricingSummary?.total),
    currency: currencyOf(o),
    items: (o.lineItems ?? []).map((li) => ({ title: String(li.title ?? '').slice(0, 200), sku: li.sku ? String(li.sku).slice(0, 80) : null, quantity: Number(li.quantity) || 0 })),
  };
}

/** How an order that is no longer waiting ended, in plain English (for its finished task). */
export function shipEndedWhy(view) {
  if (!view) return 'No longer waiting to ship on eBay';
  if (view.cancelState === 'CANCELED') return 'Cancelled on eBay';
  if (view.status === 'FULFILLED') return 'Shipped on eBay';
  if (view.paymentStatus === 'FULLY_REFUNDED') return 'Refunded on eBay';
  return 'No longer waiting to ship on eBay';
}
