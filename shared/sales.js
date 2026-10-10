// Sales totals (D12; D13 eBay and D11/D15 build on them): the facts the server and devices share —
// the daily-totals row's figures, adding rows up per currency (never across currencies), a store's
// "today / this week / this month" in the store's own time zone, and money as text. Totals only:
// no customer, order or item ever reaches a sales row. See CLAUDE.md, "Sales totals (D12)".
import { addDays, weekStart, monthStart } from './planner.js';
import { BUSINESS_IDS } from './crm.js';

/**
 * Where a day's totals came from: `woo` (D12), `ebay` (D13), `wholesale` (D11: the Order Manager, worked out from the
 * suite's own holding area) and `manual` (D11: sales entered by hand — invoices, anything not connected — whose rows
 * know only total and orders: `totalOnly`). D13's months entered by hand are not rows here (sales_manual_months).
 */
export const SALES_SOURCES = Object.freeze(['woo', 'ebay', 'wholesale', 'manual']);

/** D11: kinds of a sale entered by hand. Refunds and credit notes are stored as negative amounts. */
export const ENTRY_KINDS = Object.freeze(['sale', 'refund', 'credit_note']);
/** D11: currencies offered for an entry (any three capital letters are accepted; CAD by default). */
export const ENTRY_CURRENCIES = Object.freeze(['CAD', 'USD', 'EUR', 'GBP']);
/**
 * D11 review: businesses whose sales are never entered by hand — they come from a connection (entering them too would
 * count them twice) or aren't sales at all. → business id → why (the words shown).
 */
export const NOT_BY_HAND = Object.freeze({
  [BUSINESS_IDS.wholesale]: 'Wholesale sales come from the Order Manager',
  [BUSINESS_IDS.save_point]: 'Save Point Shop’s sales come from eBay (a month can be entered by hand on its eBay page)',
  [BUSINESS_IDS.personal]: 'Personal isn’t a business that sells',
});
/**
 * D11 follow-up: businesses whose sales are entered by hand only in part — the retail stores: a store connected to
 * WooCommerce is counted from there, one that isn't (or sales outside it) can be entered. → business id → the warning.
 */
export const BY_HAND_WARNING = Object.freeze({
  [BUSINESS_IDS.retail]: 'Only for a store not connected to WooCommerce (or sales outside it): a connected store’s sales are already counted',
});
/** Can sales be entered by hand for this business? (not one of NOT_BY_HAND, not archived) */
export const byHandAllowed = (business) => Boolean(business) && !NOT_BY_HAND[business.id] && !business.archived;

/** D11: the sales module's store key for a business's hand entries in one currency ("hand:<id>", "hand:<id>:USD"). */
export const handStoreKey = (businessId, currency = 'CAD') => (currency === 'CAD' ? `hand:${businessId}` : `hand:${businessId}:${currency}`);
/** D11: an entry's signed amount: sales count up, refunds and credit notes count down. */
export const signedAmount = (kind, cents) => (kind === 'sale' ? Math.abs(cents) : -Math.abs(cents));

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

/**
 * D11: figures a source can also give unrounded (`raw`, in dollars) — the Order Manager's P&L adds unrounded amounts
 * and rounds each line once per range; a day row carries them so a sum of days can do the same.
 */
export const RAW_FIGURES = Object.freeze(['gross', 'discounts', 'refunds', 'net', 'tax']);
const rawOf = (r) => {
  const v = r?.raw;
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};
/** Dollars → whole cents, rounded once as the Order Manager does (Math.round(x × 100) / 100). */
export const roundDollars = (x) => Math.round(Number(x) * 100);

/**
 * Add rows up (their figures), per currency: Map<currency, figures + { days }>. Never across currencies. D11: rows with
 * `raw` (unrounded dollars of RAW_FIGURES, the wholesale days) are added unrounded and rounded once — their own whole-cent
 * figures are replaced by that, and `total` moves with net and tax — so a week or a month equals the Order Manager's
 * P&L for that range to the cent.
 */
export function sumByCurrency(rows) {
  const out = new Map();
  const raws = new Map();
  for (const r of rows) {
    const cur = r.currency;
    const acc = out.get(cur) ?? { ...zeroFigures(), days: 0 };
    for (const k of SALES_FIGURES) acc[k] += Number(r[k]) || 0;
    acc.days += 1;
    out.set(cur, acc);
    const raw = rawOf(r);
    if (raw && RAW_FIGURES.every((k) => Number.isFinite(raw[k]))) {
      const x = raws.get(cur) ?? { sum: Object.fromEntries(RAW_FIGURES.map((k) => [k, 0])), cents: Object.fromEntries(RAW_FIGURES.map((k) => [k, 0])) };
      for (const k of RAW_FIGURES) {
        x.sum[k] += raw[k];
        x.cents[k] += Number(r[k]) || 0;
      }
      raws.set(cur, x);
    }
  }
  for (const [cur, x] of raws) {
    const acc = out.get(cur);
    const delta = Object.fromEntries(RAW_FIGURES.map((k) => [k, roundDollars(x.sum[k]) - x.cents[k]]));
    for (const k of RAW_FIGURES) acc[k] += delta[k];
    acc.total += delta.net + delta.tax;
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
 * machine's zone. Invalid zone → this machine's zone. Invalid date → null.
 */
export function localDateIn(timeZone, date = new Date()) {
  // An invalid Date has no day (it used to recurse forever through the fallback below): null.
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const m = OFFSET_RE.exec(timeZone ?? '');
  if (m) {
    const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    return new Date(date.getTime() + minutes * 60_000).toISOString().slice(0, 10);
  }
  // D11 review (speed): one formatter per zone, and the day remembered per UTC quarter hour (every zone changes on a
  // quarter hour) — a start-up rebuild asks for tens of thousands of days; building a formatter each time was 10× slower.
  const zone = timeZone || '';
  const slot = `${zone}|${Math.floor(date.getTime() / QUARTER_HOUR_MS)}`;
  const known = DAY_CACHE.get(slot);
  if (known) return known;
  try {
    let fmt = FORMATTERS.get(zone);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' });
      FORMATTERS.set(zone, fmt);
    }
    const parts = fmt.formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const day = `${get('year')}-${get('month')}-${get('day')}`;
    if (DAY_CACHE.size >= DAY_CACHE_MAX) DAY_CACHE.clear();
    DAY_CACHE.set(slot, day);
    return day;
  } catch {
    return localDateIn(null, date);
  }
}
const QUARTER_HOUR_MS = 15 * 60_000;
const FORMATTERS = new Map();
const DAY_CACHE = new Map();
const DAY_CACHE_MAX = 50_000;

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
