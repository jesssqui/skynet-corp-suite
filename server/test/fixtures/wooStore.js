// A fake WooCommerce store for D12's tests: the parts of WordPress / WooCommerce's REST API the suite reads, on a
// local port, computed from a list of orders the test controls —
//   GET /wp-json/                                    the site index: name, namespaces, timezone_string, gmt_offset (public)
//   GET /wp-json/wc/v3/data/currencies/current       { code, name, symbol }
//   GET /wp-json/wc-analytics/reports/revenue/stats  Analytics → Revenue, worked out like WooCommerce's wc_order_stats:
//        every order whose status isn't excluded is a row on its day (by the store's date type, in the store's zone):
//          total = goods − coupon + tax + shipping, net = total − tax − shipping, items = quantities, orders = 1;
//        every refund of such an order is a row on the refund's own day, negative (orders 0);
//        gross_sales = Σtotal + coupons − taxes − shipping + refunds; refunds = |Σ negative net|; net_revenue = Σnet.
//        `after` / `before` are store-local times; interval=day|week (weeks start Monday, WordPress's default);
//        every interval in the range is listed (empty ones with zeros), `order` asc|desc (default desc), per_page
//        (≤ maxPerPage) and page, X-WP-Total / X-WP-TotalPages; `totals` = the whole range.
//   GET /wp-json/wc/v3/orders(?search=&per_page=&page=)  and  /wp-json/wc/v3/orders/<id>
//   GET /wp-json/wc-shipment-tracking/v3/orders/<id>/shipments   (when `tracking` is on)
// Every other method → 405 (a real store answers a read key's writes with 401; the suite never sends one). Basic auth
// with the key and secret on everything but the index. It records every request (method, path, query, headers, body
// length) so tests can prove the suite only reads.
import http from 'node:http';

export const STORE_KEY = `ck_${'0123456789'.repeat(4)}`;
export const STORE_SECRET = `cs_${'abcdef0123'.repeat(4)}`;
export const OTHER_KEY = `ck_${'9876543210'.repeat(4)}`;
export const OTHER_SECRET = `cs_${'fedcba9876'.repeat(4)}`;
export const DEFAULT_EXCLUDED = Object.freeze(['pending', 'failed', 'cancelled']);

const cents = (n) => Math.round(Number(n) * 100);
const money = (c) => (c / 100).toFixed(2);
const num = (c) => Number((c / 100).toFixed(2));

/** "YYYY-MM-DDTHH:MM:SS" local in `timeZone` → a Date (UTC instant). */
export function localToUtc(local, timeZone) {
  const [d, t = '00:00:00'] = local.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm, ss = 0] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm, ss);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = (k) => Number(parts.find((p) => p.type === k).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return new Date(ms);
}
/** A Date → "YYYY-MM-DDTHH:MM:SS" in `timeZone`. */
export function utcToLocal(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
  const g = (k) => parts.find((p) => p.type === k).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}`;
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monday = (d) => {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return addDays(d, -((wd + 6) % 7));
};

/**
 * An order (amounts in dollars, times store-local): { id, number?, status, created, paid?, completed?, items: [{ name,
 * sku, qty, price }], coupon, tax, shipping, method, refunds: [{ id, at, amount, tax, shipping, qty }], first, last,
 * email, phone, address, meta }.
 */
export function order(o) {
  return {
    id: o.id, number: String(o.number ?? o.id), status: o.status ?? 'completed', created: o.created, paid: o.paid ?? (['pending', 'failed', 'cancelled'].includes(o.status) ? null : o.created),
    completed: o.completed ?? null, items: o.items ?? [{ name: 'Zyn Cool Mint 6mg', sku: 'ZYN-CM6', qty: 1, price: 10 }],
    coupon: o.coupon ?? 0, tax: o.tax ?? 0, shipping: o.shipping ?? 0, method: o.method ?? 'Canada Post Expedited',
    refunds: o.refunds ?? [], first: o.first ?? 'Pat', last: o.last ?? 'Lefty', email: o.email ?? `buyer${o.id}@example.com`,
    phone: o.phone ?? '5195550100', address: o.address ?? '12 Main St', meta: o.meta ?? [],
  };
}

/** The wc_order_stats-like rows of the orders that count, with their store-local day. */
export function statsRows(orders, { excluded = DEFAULT_EXCLUDED, dateType = 'date_created' } = {}) {
  const rows = [];
  for (const o of orders) {
    if (excluded.includes(o.status)) continue;
    const when = dateType === 'date_paid' ? (o.paid ?? o.created) : dateType === 'date_completed' ? (o.completed ?? o.created) : o.created;
    const goods = o.items.reduce((a, i) => a + cents(i.price) * i.qty, 0);
    const coupon = cents(o.coupon);
    const tax = cents(o.tax);
    const ship = cents(o.shipping);
    const total = goods - coupon + tax + ship;
    rows.push({ day: when.slice(0, 10), at: when, orders: 1, items: o.items.reduce((a, i) => a + i.qty, 0), total, tax, shipping: ship, net: total - tax - ship, coupon });
    for (const r of o.refunds) {
      const rt = cents(r.tax ?? 0);
      const rs = cents(r.shipping ?? 0);
      const amount = cents(r.amount);
      rows.push({ day: r.at.slice(0, 10), at: r.at, orders: 0, items: -(r.qty ?? 0), total: -(amount + rt + rs), tax: -rt, shipping: -rs, net: -amount, coupon: 0 });
    }
  }
  return rows;
}

/** Analytics → Revenue subtotals of some rows (as the store answers them: dollars as numbers). */
export function subtotals(rows) {
  const s = (k) => rows.reduce((a, r) => a + r[k], 0);
  const refunds = Math.abs(rows.reduce((a, r) => a + (r.net < 0 ? r.net : 0), 0));
  const gross = s('total') + s('coupon') - s('tax') - s('shipping') + refunds;
  return {
    orders_count: s('orders'), num_items_sold: s('items'), gross_sales: num(gross), total_sales: num(s('total')), coupons: num(s('coupon')),
    coupons_count: rows.filter((r) => r.coupon > 0).length, refunds: num(refunds), taxes: num(s('tax')), shipping: num(s('shipping')),
    net_revenue: num(s('net')), avg_items_per_order: 0, avg_order_value: 0, total_customers: 0, products: 0, segments: [],
  };
}

/**
 * Start it. Options: name, timezone ('America/Vancouver'; '' with gmtOffset for an offset-only site), currency,
 * excluded statuses, dateType, analytics (false: no wc-analytics namespace / route), tracking (the shipment tracking
 * plugin's route), maxPerPage (Analytics' 100; more is a 400), capPerPage (answer pages this small, whatever was asked), key/secret, now (clock for "today").
 * → { url, state, requests, fail, delayMs, redirectTo, close() }
 */
export async function startFakeWoo(t, {
  name = 'TinsXpress', timezone = 'America/Vancouver', gmtOffset = null, currency = 'CAD', excluded = [...DEFAULT_EXCLUDED], dateType = 'date_created',
  analytics = true, tracking = true, maxPerPage = 100, capPerPage = null, key = STORE_KEY, secret = STORE_SECRET,
} = {}) {
  const store = {
    state: { name, timezone, gmtOffset, currency, excluded, dateType, analytics, tracking, maxPerPage, capPerPage, key, secret, orders: [], shipments: {} },
    requests: [],
    /** path prefix → { status, times, code, skip } : answer that instead (skip: let that many through first; times: how many calls; Infinity = until cleared). */
    fail: {},
    /** path prefix → ms to wait before answering. */
    delayMs: {},
    /** when set, every request is answered 301 to this address. */
    redirectTo: null,
  };
  const st = store.state;
  const tz = () => st.timezone || (st.gmtOffset !== null ? `Etc/GMT${st.gmtOffset > 0 ? '-' : '+'}${Math.abs(st.gmtOffset)}` : 'UTC');
  const gmt = (local) => (local ? localToUtc(local, tz()).toISOString().slice(0, 19) : null);

  const orderJson = (o) => ({
    id: o.id, parent_id: 0, number: o.number, status: o.status, currency: st.currency,
    date_created: o.created, date_created_gmt: gmt(o.created), date_paid: o.paid, date_paid_gmt: gmt(o.paid), date_completed: o.completed, date_completed_gmt: gmt(o.completed),
    discount_total: money(cents(o.coupon)), shipping_total: money(cents(o.shipping)), total_tax: money(cents(o.tax)),
    total: money(o.items.reduce((a, i) => a + cents(i.price) * i.qty, 0) - cents(o.coupon) + cents(o.tax) + cents(o.shipping)),
    customer_id: 0, customer_note: 'leave at the back door',
    billing: { first_name: o.first, last_name: o.last, company: '', address_1: o.address, city: 'Brantford', state: 'ON', postcode: 'N3T 1A1', country: 'CA', email: o.email, phone: o.phone },
    shipping: { first_name: o.first, last_name: o.last, address_1: o.address, city: 'Brantford', state: 'ON', postcode: 'N3T 1A1', country: 'CA' },
    payment_method_title: 'Interac e-Transfer', customer_ip_address: '203.0.113.9',
    line_items: o.items.map((i, n) => ({ id: n + 1, name: i.name, sku: i.sku, quantity: i.qty, subtotal: money(cents(i.price) * i.qty), total: money(cents(i.price) * i.qty) })),
    shipping_lines: [{ id: 1, method_title: o.method, total: money(cents(o.shipping)) }],
    refunds: o.refunds.map((r) => ({ id: r.id, reason: '', total: money(-(cents(r.amount) + cents(r.tax ?? 0) + cents(r.shipping ?? 0))) })),
    meta_data: o.meta,
  });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8', ...headers });
    res.end(body === null ? undefined : JSON.stringify(body));
  };

  function revenue(q, res) {
    const after = String(q.get('after') ?? '');
    const before = String(q.get('before') ?? '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(after) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(before)) {
      return send(res, 400, { code: 'rest_invalid_param', message: 'Invalid parameter(s): after, before' });
    }
    const interval = q.get('interval') ?? 'week';
    if (!['day', 'week'].includes(interval)) return send(res, 400, { code: 'rest_invalid_param', message: 'interval' });
    const perPage = Number(q.get('per_page') ?? 10);
    if (!(perPage >= 1 && perPage <= st.maxPerPage)) return send(res, 400, { code: 'rest_invalid_param', message: `per_page must be between 1 (inclusive) and ${st.maxPerPage} (inclusive)` });
    const page = Number(q.get('page') ?? 1);
    const size = Math.min(perPage, st.capPerPage ?? perPage); // a host that pages smaller than asked
    const rows = statsRows(st.orders, st).filter((r) => r.at >= after && r.at <= before);
    const fromDay = after.slice(0, 10);
    const toDay = before.slice(0, 10);
    const keys = [];
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
      const k = interval === 'day' ? d : monday(d);
      if (keys.at(-1) !== k) keys.push(k);
    }
    let intervals = keys.map((k) => {
      const start = interval === 'day' ? k : (k < fromDay ? fromDay : k);
      const endDay = interval === 'day' ? k : [addDays(k, 6), toDay].sort()[0];
      const own = rows.filter((r) => r.day >= start && r.day <= endDay);
      return {
        interval: k,
        date_start: `${start} 00:00:00`, date_start_gmt: gmt(`${start}T00:00:00`).replace('T', ' '),
        date_end: `${endDay} 23:59:59`, date_end_gmt: gmt(`${endDay}T23:59:59`).replace('T', ' '),
        subtotals: subtotals(own),
      };
    });
    if ((q.get('order') ?? 'desc') === 'desc') intervals = intervals.reverse();
    const total = intervals.length;
    const pages = Math.max(1, Math.ceil(total / size));
    return send(res, 200, { totals: subtotals(rows), intervals: intervals.slice((page - 1) * size, page * size) }, { 'x-wp-total': String(total), 'x-wp-totalpages': String(pages) });
  }

  function orders(q, res) {
    const search = String(q.get('search') ?? '').toLowerCase();
    const perPage = Math.min(Number(q.get('per_page') ?? 10), 100);
    const page = Number(q.get('page') ?? 1);
    let list = [...st.orders].sort((a, b) => (a.created < b.created ? 1 : -1));
    if (search) list = list.filter((o) => [o.number, o.email, o.first, o.last, o.address].some((v) => String(v).toLowerCase().includes(search)));
    const fields = q.get('_fields');
    let body = list.slice((page - 1) * perPage, page * perPage).map(orderJson);
    if (fields) body = body.map((o) => Object.fromEntries(fields.split(',').map((f) => [f, o[f]])));
    return send(res, 200, body, { 'x-wp-total': String(list.length), 'x-wp-totalpages': String(Math.max(1, Math.ceil(list.length / perPage))) });
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      store.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, bodyLength: Buffer.byteLength(raw) });
      const delay = Object.entries(store.delayMs).find(([p]) => path.startsWith(p))?.[1];
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (store.redirectTo) return send(res, 301, null, { location: `${store.redirectTo}${path}` });
      if (req.method !== 'GET') return send(res, 405, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' }, { allow: 'GET' });
      const failing = Object.entries(store.fail).find(([p, f]) => path.startsWith(p) && f.times > 0 && !(f.skip > 0 && f.skip-- > 0));
      if (failing) {
        failing[1].times -= 1;
        return send(res, failing[1].status, { code: failing[1].code ?? 'internal_server_error', message: 'Failing on purpose' });
      }
      if (path === '/wp-json/' || path === '/wp-json') {
        const namespaces = ['oembed/1.0', 'wp/v2', 'wc/v3', 'wc/store/v1', ...(st.analytics ? ['wc-analytics', 'wc-admin'] : []), ...(st.tracking ? ['wc-shipment-tracking/v3'] : [])];
        return send(res, 200, { name: st.name, description: '', url: 'https://example.test', home: 'https://example.test', gmt_offset: st.gmtOffset ?? 0, timezone_string: st.timezone, namespaces, routes: {} });
      }
      const auth = req.headers.authorization ?? '';
      const expected = `Basic ${Buffer.from(`${st.key}:${st.secret}`).toString('base64')}`;
      if (auth !== expected) return send(res, 401, { code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.', data: { status: 401 } });
      if (path === '/wp-json/wc/v3/data/currencies/current') return send(res, 200, { code: st.currency, name: 'Canadian dollar', symbol: '&#36;' });
      if (path === '/wp-json/wc-analytics/reports/revenue/stats') {
        if (!st.analytics) return send(res, 404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
        return revenue(url.searchParams, res);
      }
      if (path === '/wp-json/wc/v3/orders') return orders(url.searchParams, res);
      let m = path.match(/^\/wp-json\/wc\/v3\/orders\/(\d+)$/);
      if (m) {
        const o = st.orders.find((x) => x.id === Number(m[1]));
        return o ? send(res, 200, orderJson(o)) : send(res, 404, { code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' });
      }
      m = path.match(/^\/wp-json\/wc-shipment-tracking\/v3\/orders\/(\d+)\/shipments$/);
      if (m && st.tracking) return send(res, 200, st.shipments[m[1]] ?? []);
      return send(res, 404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  store.url = `http://127.0.0.1:${server.address().port}`;
  store.close = () => new Promise((resolve) => server.close(resolve));
  t.after(() => store.close());
  /** The store's own Analytics answer for a range of store-local days (what the owner sees in WooCommerce). */
  store.analytics = (from, to, interval = 'week') => {
    const rows = statsRows(st.orders, st).filter((r) => r.at >= `${from}T00:00:00` && r.at <= `${to}T23:59:59`);
    void interval;
    return subtotals(rows);
  };
  store.localNow = (ms) => utcToLocal(new Date(ms), tz());
  return store;
}
