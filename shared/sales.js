// Sales totals (D12; D13 eBay and D11/D15 build on them): the facts the server and devices share —
// the daily-totals row's figures, adding rows up per currency (never across currencies), a store's
// "today / this week / this month" in the store's own time zone, and money as text. Totals only:
// no customer, order or item ever reaches a sales row. See CLAUDE.md, "Sales totals (D12)".
import { addDays, weekStart, monthStart } from './planner.js';

/** Where a day's totals came from. `manual` is for a later package (totals typed by hand). */
export const SALES_SOURCES = Object.freeze(['woo', 'ebay', 'manual']);

/**
 * A daily row's figures, all integer cents except `orders` and `items` — WooCommerce Analytics → Revenue's own
 * columns (D12 decision: the suite reads that report, it doesn't recompute it):
 *   orders     orders placed that day (Analytics "Orders")
 *   items      items sold
 *   gross      gross sales: product sales before coupons and returns
 *   discounts  coupons
 *   refunds    returns (refunds, without their tax and shipping), counted on the day they were made
 *   net        net sales = gross − discounts − refunds
 *   tax        taxes (refunded tax already taken off)
 *   shipping   shipping (refunded shipping already taken off)
 *   total      total sales = net + tax + shipping
 */
export const SALES_FIGURES = Object.freeze(['orders', 'items', 'gross', 'discounts', 'refunds', 'net', 'tax', 'shipping', 'total']);

/** Zero of every figure. */
export const zeroFigures = () => Object.fromEntries(SALES_FIGURES.map((k) => [k, 0]));

/** Add rows up (their figures), per currency: Map<currency, figures + { days }>. Never across currencies. */
export function sumByCurrency(rows) {
  const out = new Map();
  for (const r of rows) {
    const cur = r.currency;
    const acc = out.get(cur) ?? { ...zeroFigures(), days: 0 };
    for (const k of SALES_FIGURES) acc[k] += Number(r[k]) || 0;
    acc.days += 1;
    out.set(cur, acc);
  }
  return out;
}

/** A fixed UTC offset written "+05:30" / "-03:30" (a WordPress site with only a gmt_offset, D12 review fix). */
export const OFFSET_RE = /^([+-])(\d{2}):(\d{2})$/;
/** gmt_offset hours (5.5, -3.5, 1) → "+05:30" / "-03:30" / "+01:00". */
export function offsetZone(hours) {
  const minutes = Math.round(Number(hours) * 60);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * "YYYY-MM-DD" in a time zone: an IANA name, or a fixed offset "+05:30" (counted from its minutes, no DST); null = this
 * machine's zone. Invalid zone → this machine's zone.
 */
export function localDateIn(timeZone, date = new Date()) {
  const m = OFFSET_RE.exec(timeZone ?? '');
  if (m) {
    const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    return new Date(date.getTime() + minutes * 60_000).toISOString().slice(0, 10);
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return localDateIn(null, date);
  }
}

/**
 * The periods the Sales page shows for a store whose "today" is `today` (its own calendar): today, this
 * week (Monday–Sunday) and this month — each { from, to } as "YYYY-MM-DD", to = today.
 */
export function salesPeriods(today) {
  return {
    today: { from: today, to: today },
    week: { from: weekStart(today), to: today },
    month: { from: monthStart(today), to: today },
  };
}

/** The Monday–Sunday week before the one `today` is in: { from, to }. */
export function lastWeek(today) {
  const from = addDays(weekStart(today), -7);
  return { from, to: addDays(from, 6) };
}

/** Cents → "$1,234.50" in its currency (whole dollars without cents). Unknown codes fall back to "123.45 XYZ". */
export function salesMoney(cents, currency = 'CAD') {
  const n = Number(cents) || 0;
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency', currency, currencyDisplay: currency === 'CAD' ? 'narrowSymbol' : 'symbol',
      minimumFractionDigits: n % 100 ? 2 : 0, maximumFractionDigits: 2,
    }).format(n / 100);
  } catch {
    return `${(n / 100).toFixed(2)} ${currency}`;
  }
}

/** A money amount from a store's API ("123.45", 123.45) → integer cents (rounded); anything else → 0. */
export function toCents(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  // toFixed first: 1.005 * 100 is 100.49999…, and a store's 1.005 means 1.01.
  return Number.isFinite(n) ? Math.round(Number((n * 100).toFixed(6))) : 0;
}
