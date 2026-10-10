// The Sales page's and the store page's words (D12), no React (client/test/sales.test.js).
import { salesMoney } from '@suite/shared/sales';

/**
 * One period's figures (a list per currency) → "$1,234.50" (each currency on its own; never added). D13: the headline
 * is **total sales** — what each store's own report calls Total sales (WooCommerce Analytics; eBay Seller Hub): items,
 * shipping and tax, after refunds — the one figure a month entered by hand also has.
 */
export function periodText(list) {
  if (!list?.length) return '$0';
  return list.map((f) => `${salesMoney(f.total, f.currency)}${f.currency === 'CAD' ? '' : ` ${f.currency}`}`).join(' + ');
}
export function ordersText(list) {
  const n = (list ?? []).reduce((a, f) => a + (f.orders || 0), 0);
  return `${n} order${n === 1 ? '' : 's'}`;
}

/** What a store's state means: null when all is well. */
export function stateText(store) {
  switch (store.state) {
    case 'paused': return { tone: 'warn', text: 'Paused on Connections' };
    case 'failing': return { tone: 'danger', text: `Can’t read it right now${store.lastError ? `: ${store.lastError}` : ''}` };
    case 'unreadable': return { tone: 'danger', text: 'Its key can’t be read on this server: replace the key on Connections' };
    case 'not_read': return { tone: 'neutral', text: 'Not read yet' };
    case 'removed': return { tone: 'neutral', text: 'Not connected (removed): totals up to when it was' };
    case 'not_set_up': return { tone: 'neutral', text: 'Not connected: set it up on System → Connections, or enter a month by hand' };
    case 'not_signed_in': return { tone: 'neutral', text: 'Not signed in to eBay yet (System → Connections)' };
    case 'signed_out': return { tone: 'danger', text: 'eBay stopped accepting the sign-in: sign in again on System → Connections' };
    default: return null;
  }
}

/** "Updated Oct 9, 2:03 p.m." / "Not read yet". */
export function updatedText(store, formatDateTime) {
  return store.lastFetchedAt ? `Updated ${formatDateTime(store.lastFetchedAt)}` : 'Not read yet';
}

/** What the order lookup box holds: an order number ("#1042", "TX-500") or an email. → { number } | { email } | { problem }. */
export function lookupQuery(text) {
  const t = String(text ?? '').trim();
  if (!t) return { problem: '' };
  if (t.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? { email: t.toLowerCase() } : { problem: 'That email isn’t complete' };
  }
  const n = t.replace(/^#/, '');
  return /^[A-Za-z0-9-]{1,30}$/.test(n) ? { number: n } : { problem: 'Type an order number (like 1042) or the customer’s email' };
}

const STATUS = {
  pending: 'Pending payment', processing: 'Processing', 'on-hold': 'On hold', completed: 'Completed', cancelled: 'Cancelled',
  refunded: 'Refunded', failed: 'Failed', 'checkout-draft': 'Draft', trash: 'In the trash',
};
const TONE = { completed: 'ok', processing: 'accent', 'on-hold': 'warn', pending: 'warn', cancelled: 'neutral', refunded: 'neutral', failed: 'danger' };
/** WooCommerce's status slug → { text, tone } (unknown slugs from plugins as written: "awaiting-shipment" → "Awaiting shipment"). */
export function orderStatus(slug) {
  const s = String(slug ?? '');
  return { text: STATUS[s] ?? (s ? s.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()) : 'Unknown'), tone: TONE[s] ?? 'neutral' };
}

/** "Canada Post 7023 4567 8901 · shipped 2026-10-12". */
export function trackingText(t) {
  return [t.provider, t.number].filter(Boolean).join(' ') + (t.shippedOn ? ` · shipped ${t.shippedOn}` : '');
}

/** The order's money lines (cents, the order's currency): only those that apply. */
export function orderMoneyLines(o) {
  const m = (c) => salesMoney(c, o.currency || 'CAD');
  return [
    o.discount ? ['Discount', `−${m(o.discount)}`] : null,
    o.shipping ? ['Shipping', m(o.shipping)] : null,
    o.tax ? ['Tax', m(o.tax)] : null,
    ['Total', m(o.total)],
    o.refunded ? ['Refunded', `−${m(o.refunded)}`] : null,
  ].filter(Boolean);
}

/** The Add a store form's own checks (the server checks again, and with the store): null or a problem. */
export function addStoreProblem({ url, key, secret, confirmed }) {
  const u = String(url ?? '').trim();
  if (!u) return 'The store’s address';
  if (/^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(u)) return 'The address must start with https://';
  if (!/^ck_[0-9a-f]{40}$/.test(String(key ?? '').trim())) return 'The consumer key starts with ck_ (copy it from WooCommerce)';
  if (!/^cs_[0-9a-f]{40}$/.test(String(secret ?? '').trim())) return 'The consumer secret starts with cs_ (copy it from WooCommerce)';
  if (!confirmed) return 'Confirm the key was made with permission “Read”';
  return null;
}

/** The store card's backfill line: "13 months read" / "Reading back to 2025-09-13 …" / "". */
export function backfillText(store) {
  if (!store?.backfill) return '';
  if (store.backfill.doneAt) return `Totals from ${store.backfill.target} on`;
  if (store.backfill.before) return `Reading older totals: back to ${store.backfill.before} so far (to ${store.backfill.target})`;
  return 'Older totals not read yet';
}

/** "October 2026" for "2026-10". */
export function monthText(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "$1,234.56" / "1234.56" / "1,234" typed → cents, or null when it isn't an amount ≥ 0. */
export function parseAmount(text) {
  const t = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** One month's line on the eBay page: what counts and where it came from. */
export function monthLine(m) {
  if (m.shown === 'real') return { figure: periodText(m.real), from: m.replaced ? 'From eBay (replaces the month entered by hand)' : 'From eBay' };
  if (m.shown === 'manual') return { figure: periodText([{ currency: m.manual.currency, total: m.manual.total }]), from: `Entered by hand${m.manual.orders !== null && m.manual.orders !== undefined ? ` · ${m.manual.orders} orders` : ''}` };
  return { figure: '—', from: 'Nothing yet' };
}
