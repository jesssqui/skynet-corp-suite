// WooCommerce stores (D12), against a fake WooCommerce (fixtures/wooStore.js) that works out Analytics → Revenue from
// its orders the way WooCommerce does (statuses, refunds on their own day, the store's zone, pages): the "done when" —
// a past week's total for each store equals the store's own Analytics answer —, the key checked before anything is
// saved, the secret only encrypted, read-only by construction (every call a GET with no body; one fetch in the module),
// the rolling window and the backfill (chunked, resumable, idempotent, refilled after a restore), each store its own
// Connections row (pause, failures and backoff, one store never holding up another), live order lookups that keep
// nothing (first name only), removing a store. Toronto time; the stores are in other zones.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS_IDS, addMonths } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { toCents, SALES_FIGURES } from '@suite/shared/sales';
import { modules } from '../src/modules/index.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup, KEPT_TABLES } from '../src/backup/restore.js';
import { createWooClient, cleanStoreUrl, storeKey, parseKeys, PATHS, WooError } from '../src/modules/woocommerce/client.js';
import { siteTimeZone, figuresFrom, orderView, backoffMs, connectionId, WINDOW_DAYS, BACKFILL_MONTHS } from '../src/modules/woocommerce/service.js';
import { startFakeWoo, order, STORE_KEY, STORE_SECRET, OTHER_KEY, OTHER_SECRET, DEFAULT_EXCLUDED } from './fixtures/wooStore.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const RETAIL = BUSINESS_IDS.retail;
// 01:30 on Wednesday Oct 14 in Toronto = 22:30 on Tuesday Oct 13 in Vancouver: the stores' "today" isn't the Mac's.
const START = Date.parse('2026-10-14T05:30:00Z');
const VAN_TODAY = '2026-10-13';
const LAST_WEEK = { from: '2026-10-05', to: '2026-10-11' };
const MINUTE = 60_000;

// ---- the orders --------------------------------------------------------------------------------------
/** TinsXpress (Vancouver): last week's orders around both ends of the week, excluded statuses, refunds, coupons. */
function vancouverOrders() {
  const list = [
    order({ id: 101, created: '2026-10-05T00:15:00', items: [{ name: 'Zyn Cool Mint 6mg', sku: 'ZYN-CM6', qty: 2, price: 12.5 }], coupon: 2, tax: 3.25, shipping: 8 }),
    order({ id: 102, created: '2026-10-04T23:50:00', items: [{ name: 'Velo Ice', sku: 'VELO-I', qty: 4, price: 10 }] }), // the week before (but Monday in Toronto)
    order({ id: 103, status: 'processing', created: '2026-10-11T23:30:00', paid: '2026-10-12T08:00:00', items: [{ name: 'Alp Spearmint', sku: 'ALP-S', qty: 3, price: 25 }], tax: 9.75 }), // Monday in Toronto
    order({ id: 104, status: 'cancelled', created: '2026-10-08T10:00:00', items: [{ name: 'Zyn', sku: 'Z', qty: 10, price: 10 }] }),
    order({ id: 105, status: 'pending', created: '2026-10-09T12:00:00', items: [{ name: 'Zyn', sku: 'Z', qty: 5, price: 11 }] }),
    order({ id: 106, status: 'failed', created: '2026-10-09T13:00:00' }),
    order({ id: 107, created: '2026-09-28T09:00:00', items: [{ name: 'Zyn', sku: 'Z', qty: 6, price: 10 }], refunds: [{ id: 9107, at: '2026-10-07T15:00:00', amount: 20, tax: 2.6, qty: 2 }] }),
    order({ id: 108, status: 'refunded', created: '2026-10-09T16:00:00', items: [{ name: 'Zyn', sku: 'Z', qty: 1, price: 30 }], refunds: [{ id: 9108, at: '2026-10-12T10:00:00', amount: 30, qty: 1 }] }),
    order({ id: 109, status: 'on-hold', created: '2026-10-10T11:00:00', items: [{ name: 'Zyn', sku: 'Z', qty: 1, price: 15 }] }),
    order({ id: 110, created: '2026-10-12T00:05:00' }),
  ];
  // A year and more of older orders for the backfill: one every 3 days.
  for (let i = 0; i < 140; i += 1) list.push(order({ id: 1000 + i, created: `${addDays('2026-09-23', -3 * i)}T12:00:00`, items: [{ name: 'Zyn', sku: 'Z', qty: 1, price: 10 + (i % 7) }], tax: 1.3 }));
  return list;
}
/** Pouches (an offset-only site, GMT+1, USD). */
function offsetOrders() {
  return [
    order({ id: 201, status: 'processing', created: '2026-10-11T23:59:00', items: [{ name: 'On! Citrus', sku: 'ON-C', qty: 5, price: 10 }], shipping: 6.5 }),
    order({ id: 202, created: '2026-10-05T00:00:30', items: [{ name: 'On! Mint', sku: 'ON-M', qty: 2, price: 10 }], coupon: 5 }),
    order({ id: 203, created: '2026-10-04T23:59:59', items: [{ name: 'On! Mint', sku: 'ON-M', qty: 9, price: 11 }] }),
    order({ id: 204, created: '2026-09-30T08:00:00', items: [{ name: 'On! Mint', sku: 'ON-M', qty: 3, price: 10 }], refunds: [{ id: 9204, at: '2026-10-06T09:00:00', amount: 10, qty: 1 }] }),
  ];
}

// ---- setup ---------------------------------------------------------------------------------------------
async function setup(t, { config = testConfig(tmpDir(t), { WOO_TIMEOUT_MS: '1000' }), clock = testClock(), start = START } = {}) {
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  if (start !== null) setNow(start);
  const env = await startApp(t, config, { modules, now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const call = async (method, url, { body, session = owner } = {}) => {
    const res = await fetch(`${env.base}${url}`, {
      method,
      headers: {
        ...(session ? { cookie: session.cookie } : {}),
        ...(method !== 'GET' ? { origin: env.base } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const svc = env.ctx.services.woocommerce;
  const sales = env.ctx.services.sales;
  /** Add a store through the API and wait for its first pull (window + backfill). */
  const add = async (store, extra = {}) => {
    const r = await call('POST', '/api/woocommerce/stores', { body: { url: store.url, key: STORE_KEY, secret: STORE_SECRET, readOnlyConfirmed: true, ...extra } });
    assert.equal(r.status, 201, r.text);
    await svc.pullStore(r.body.store.id);
    return r.body.store;
  };
  const pulls = (id) => env.db.prepare('SELECT * FROM woocommerce_pulls WHERE store_id = ?').get(id);
  return { ...env, config, clock, setNow, users, owner, call, svc, sales, add, pulls };
}

/** The store's own Analytics → Revenue answer for a range (what the owner sees in WooCommerce). */
async function analytics(store, { from, to }, { key = STORE_KEY, secret = STORE_SECRET } = {}) {
  const u = new URL(`${store.url}/wp-json/wc-analytics/reports/revenue/stats`);
  u.searchParams.set('interval', 'week');
  u.searchParams.set('after', `${from}T00:00:00`);
  u.searchParams.set('before', `${to}T23:59:59`);
  u.searchParams.set('per_page', '100');
  const res = await fetch(u, { headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } });
  assert.equal(res.status, 200);
  return (await res.json()).totals;
}
const asFigures = (wc) => ({
  orders: wc.orders_count, items: wc.num_items_sold, gross: toCents(wc.gross_sales), discounts: toCents(wc.coupons), refunds: toCents(wc.refunds),
  net: toCents(wc.net_revenue), tax: toCents(wc.taxes), shipping: toCents(wc.shipping), total: toCents(wc.total_sales),
});
const pick = (f) => Object.fromEntries(SALES_FIGURES.map((k) => [k, f[k]]));
const analyticsCalls = (store) => store.requests.filter((r) => r.path === '/wp-json/wc-analytics/reports/revenue/stats');

// ---- pure parts ------------------------------------------------------------------------------------------
test('the client: addresses, keys, the allowlist — anything but a GET of an allowed path is refused before a request', async (t) => {
  assert.equal(cleanStoreUrl('tinsxpress.com'), 'https://tinsxpress.com');
  assert.equal(cleanStoreUrl('https://TinsXpress.com/wp-json/wc/v3/'), 'https://tinsxpress.com');
  assert.equal(cleanStoreUrl('https://example.com/shop/'), 'https://example.com/shop');
  assert.equal(storeKey('https://Example.com/shop'), 'example.com/shop');
  assert.equal(cleanStoreUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080', 'plain http only for this machine');
  for (const bad of ['http://tinsxpress.com', 'ftp://x.com', 'https://x.com/?a=1', 'https://u:p@x.com', 'not a url at all']) {
    assert.throws(() => cleanStoreUrl(bad), (e) => e instanceof WooError && e.code === 'bad_url', bad);
  }
  assert.deepEqual(parseKeys({ key: ` ${STORE_KEY} `, secret: STORE_SECRET }), { key: STORE_KEY, secret: STORE_SECRET });
  assert.throws(() => parseKeys({ key: 'ck_123', secret: STORE_SECRET }), (e) => e.code === 'bad_key');
  assert.throws(() => parseKeys({ key: STORE_KEY, secret: STORE_KEY }), (e) => e.code === 'bad_secret');

  const store = await startFakeWoo(t);
  const client = createWooClient({ url: store.url, key: STORE_KEY, secret: STORE_SECRET });
  for (const p of ['/wp-json/wc/v3/products', '/wp-json/wc/v3/orders/1/notes', '/wp-json/wc/v3/orders/1/refunds', '/wp-json/wc/v3/customers',
    '/wp-json/wc/v3/orders/batch', '/wp-json/wc/v3/orders/../products', '/wp-json/wc/v3/system_status', '/wp-json/wp/v2/users', '/wp-admin/']) {
    await assert.rejects(client.get(p), (e) => e instanceof WooError && e.code === 'bad_path', p);
  }
  assert.equal(store.requests.length, 0, 'refused before any request');
  assert.equal(PATHS.length, 6);
  // The index is public (no key sent there); everything else carries the key.
  await client.get('/wp-json/');
  await client.get('/wp-json/wc/v3/data/currencies/current');
  assert.equal(store.requests[0].headers.authorization, undefined);
  assert.match(store.requests[1].headers.authorization, /^Basic /);
  assert.ok(store.requests.every((r) => !('consumer_key' in r.query) && !('consumer_secret' in r.query)), 'the key never goes in the address');
  // No key: nothing is sent.
  await assert.rejects(createWooClient({ url: store.url }).get('/wp-json/wc/v3/orders'), (e) => e.code === 'no_key');
  // A redirect is never followed.
  store.redirectTo = 'https://elsewhere.example';
  await assert.rejects(client.get('/wp-json/'), (e) => e.code === 'redirect');
  assert.equal(store.requests.filter((r) => r.path === '/wp-json/').length, 2);
});

test('the site’s zone, Analytics figures in cents, an order shown with the first name only', () => {
  assert.equal(siteTimeZone({ timezone_string: 'America/Vancouver', gmt_offset: -7 }), 'America/Vancouver');
  assert.equal(siteTimeZone({ timezone_string: '', gmt_offset: 1 }), 'Etc/GMT-1');
  assert.equal(siteTimeZone({ timezone_string: '', gmt_offset: -5 }), 'Etc/GMT+5');
  assert.equal(siteTimeZone({ timezone_string: '', gmt_offset: 0 }), 'UTC');
  assert.equal(siteTimeZone({ timezone_string: '', gmt_offset: 5.5 }), null, 'a half-hour offset has no Etc zone: the last known one is kept');
  assert.equal(siteTimeZone({ timezone_string: 'Mars/Olympus' }), null);
  assert.deepEqual(figuresFrom({ orders_count: 3, num_items_sold: 5, gross_sales: 145, coupons: 2, refunds: 20, net_revenue: 123, taxes: 10.4, shipping: 8, total_sales: 141.4 }),
    { orders: 3, items: 5, gross: 14500, discounts: 200, refunds: 2000, net: 12300, tax: 1040, shipping: 800, total: 14140 });
  const v = orderView({
    id: 5, number: '5', status: 'completed', total: '10.00', billing: { first_name: 'Mary Ann', last_name: 'Smith', email: 'm@x.ca', phone: '1', address_1: '1 St' },
    shipping: { address_1: '1 St' }, customer_note: 'gate code 1234', customer_ip_address: '1.2.3.4',
    meta_data: [{ key: '_tracking_number', value: 'hidden' }, { key: 'tracking_number', value: 'CP123' }, { key: 'gift_message', value: 'secret' }],
  });
  assert.equal(v.customerFirstName, 'Mary');
  assert.deepEqual(v.tracking, [{ provider: null, number: 'CP123', url: null, shippedOn: null }]);
  const text = JSON.stringify(v);
  for (const s of ['Smith', 'm@x.ca', '1 St', 'gate code', '1.2.3.4', 'secret', 'hidden']) assert.ok(!text.includes(s), s);
  assert.equal(backoffMs(1), 2 * MINUTE);
  assert.equal(backoffMs(3), 8 * MINUTE);
  assert.equal(backoffMs(20), 60 * MINUTE);
  assert.equal(connectionId('01a1163c-1a04-7005-9cd7-b9f83f986c43'), 'woo-01a1163c1a0470059cd7b9f83f986c43');
});

// ---- the "done when" ----------------------------------------------------------------------------------------
test('DONE WHEN: a past week’s total for each store equals WooCommerce’s own Analytics answer (statuses, refunds, the store’s zone)', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t, { name: 'TinsXpress', timezone: 'America/Vancouver' });
  van.state.orders = vancouverOrders();
  const off = await startFakeWoo(t, { name: 'Pouches', timezone: '', gmtOffset: 1, currency: 'USD' });
  off.state.orders = offsetOrders();
  const a = await s.add(van);
  const b = await s.add(off, { businessId: BUSINESS_IDS.agency });
  assert.equal(a.timeZone, 'America/Vancouver');
  assert.equal(a.currency, 'CAD');
  assert.equal(b.timeZone, 'Etc/GMT-1');
  assert.equal(b.currency, 'USD');
  assert.equal(a.businessId, RETAIL, 'retail by default');
  assert.equal(s.svc.store(a.id).today, VAN_TODAY);

  for (const [store, row] of [[van, a], [off, b]]) {
    const suite = s.sales.totals({ ...LAST_WEEK, store: row.storeKey }).overall;
    assert.equal(suite.length, 1, 'one currency');
    assert.equal(suite[0].days, 7, 'every day of the week has its row');
    assert.deepEqual(pick(suite[0]), asFigures(await analytics(store, LAST_WEEK)), `${row.name}: the week equals Analytics`);
  }
  // By hand, so the fake isn't just agreeing with itself: TinsXpress Oct 5–11 in Vancouver.
  const week = s.sales.totals({ ...LAST_WEEK, store: a.storeKey }).overall[0];
  assert.deepEqual(pick(week), { orders: 4, items: 5, gross: 14500, discounts: 200, refunds: 2000, net: 12300, tax: 1040, shipping: 800, total: 14140 });
  // Its days are the store's days: the 23:30 Sunday order is on Sunday (it was Monday in Toronto), the 23:50
  // Sunday-before order on Oct 4 (Monday Oct 5 in Toronto).
  const days = Object.fromEntries(s.db.prepare('SELECT day, net FROM sales_daily WHERE store = ?').all(a.storeKey).map((r) => [r.day, r.net]));
  assert.equal(days['2026-10-11'], 7500);
  assert.equal(days['2026-10-04'], 4000);
  assert.equal(days['2026-10-12'], 1000 - 3000, 'Monday: order 110 and the refund of 108');
  const usd = s.sales.totals({ ...LAST_WEEK, store: b.storeKey }).overall[0];
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.net, 5000 + 1500 - 1000);

  // The store's own settings decide: more excluded statuses and "date paid" in WooCommerce → the next pull follows.
  van.state.excluded = [...DEFAULT_EXCLUDED, 'on-hold'];
  van.state.dateType = 'date_paid';
  await s.svc.pullStore(a.id, { force: true });
  const after = s.sales.totals({ ...LAST_WEEK, store: a.storeKey }).overall[0];
  assert.deepEqual(pick(after), asFigures(await analytics(van, LAST_WEEK)));
  assert.equal(after.orders, 2, 'on-hold left out; order 103 paid on Monday moved to this week');
  // The combined total is per currency, never added across.
  const both = s.sales.totals(LAST_WEEK).overall;
  assert.deepEqual(both.map((o) => o.currency), ['CAD', 'USD']);
});

test('pages: Analytics answered in small pages is read page by page and still matches', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t, { capPerPage: 7 });
  van.state.orders = vancouverOrders();
  const a = await s.add(van);
  const window = analyticsCalls(van).filter((r) => r.query.after === `${addDays(VAN_TODAY, -(WINDOW_DAYS - 1))}T00:00:00`);
  assert.deepEqual(window.map((r) => r.query.page), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], '60 days in pages of 7');
  assert.ok(window.every((r) => r.query.interval === 'day' && r.query.per_page === '100' && r.query.force_cache_refresh === 'true'));
  assert.deepEqual(pick(s.sales.totals({ ...LAST_WEEK, store: a.storeKey }).overall[0]), asFigures(await analytics(van, LAST_WEEK)));
  const year = { from: addMonths(VAN_TODAY, -BACKFILL_MONTHS), to: VAN_TODAY };
  assert.deepEqual(pick(s.sales.totals({ ...year, store: a.storeKey }).overall[0]), asFigures(await analytics(van, year)));
});

// ---- the window and the backfill -------------------------------------------------------------------------
test('backfill: 13 months in 90-day reads, newest first, once; later pulls re-read only the 60-day window; a late refund lands', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  van.state.orders = vancouverOrders();
  const a = await s.add(van);
  const target = addMonths(VAN_TODAY, -BACKFILL_MONTHS);
  const windowFrom = addDays(VAN_TODAY, -(WINDOW_DAYS - 1));
  const reads = analyticsCalls(van).map((r) => [r.query.after.slice(0, 10), r.query.before.slice(0, 10)]);
  assert.deepEqual(reads, [
    ['2026-10-12', '2026-10-12'], // the key check: one day (yesterday in the store)
    [windowFrom, VAN_TODAY],
    [addDays(windowFrom, -90), addDays(windowFrom, -1)],
    [addDays(windowFrom, -180), addDays(windowFrom, -91)],
    [addDays(windowFrom, -270), addDays(windowFrom, -181)],
    [target, addDays(windowFrom, -271)],
  ]);
  const allDays = s.sales.dayCount({ source: 'woo', store: a.storeKey, from: target, to: VAN_TODAY });
  assert.equal(allDays, 396, 'every day from the target to today');
  assert.ok(s.pulls(a.id).backfill_done_at);
  const year = { from: target, to: VAN_TODAY };
  const before = s.sales.totals({ ...year, store: a.storeKey }).overall[0];
  assert.deepEqual(pick(before), asFigures(await analytics(van, year)));

  // An hour later: only the window again.
  const n = analyticsCalls(van).length;
  await s.svc.pullRound();
  assert.equal(analyticsCalls(van).length, n, 'not due yet');
  s.clock.advance(61 * MINUTE);
  await s.svc.pullRound();
  assert.equal(analyticsCalls(van).length, n + 1);
  assert.deepEqual(pick(s.sales.totals({ ...year, store: a.storeKey }).overall[0]), pick(before), 'nothing counted twice');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sales_daily WHERE store = ?').get(a.storeKey).n, 396);

  // A refund made today on an order from three weeks ago lands on today.
  van.state.orders.find((o) => o.id === 1000).refunds.push({ id: 9999, at: `${VAN_TODAY}T21:00:00`, amount: 5, qty: 0 });
  await s.svc.pullStore(a.id, { force: true });
  assert.equal(s.db.prepare('SELECT refunds FROM sales_daily WHERE store = ? AND day = ?').get(a.storeKey, VAN_TODAY).refunds, 500);
});

test('backfill: a failure part way is remembered; the next pull (after its backoff) carries on from there, and the result is the same', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  van.state.orders = vancouverOrders();
  // Let the key check, the window and the first backfill chunk through, then fail once.
  van.fail['/wp-json/wc-analytics'] = { status: 500, times: 1, skip: 3 };
  const a = await s.add(van);
  const p = s.pulls(a.id);
  assert.equal(p.failures, 1);
  assert.equal(p.backfill_done_at, null);
  const windowFrom = addDays(VAN_TODAY, -(WINDOW_DAYS - 1));
  assert.equal(p.backfill_before, addDays(windowFrom, -90), 'the first chunk is saved');
  assert.ok(p.last_success_at, 'the window itself was read');
  assert.match(p.last_error, /500/);
  const n = analyticsCalls(van).length;
  await s.svc.pullRound();
  assert.equal(analyticsCalls(van).length, n, 'waits for its backoff (2 minutes)');
  s.clock.advance(2 * MINUTE + 1000);
  await s.svc.pullRound();
  const p2 = s.pulls(a.id);
  assert.equal(p2.failures, 0);
  assert.ok(p2.backfill_done_at);
  const later = analyticsCalls(van).slice(n).map((r) => r.query.after.slice(0, 10));
  assert.deepEqual(later, [windowFrom, addDays(windowFrom, -180), addDays(windowFrom, -270), addMonths(VAN_TODAY, -BACKFILL_MONTHS)], 'the window, then on from where it stopped');
  const year = { from: addMonths(VAN_TODAY, -BACKFILL_MONTHS), to: VAN_TODAY };
  assert.deepEqual(pick(s.sales.totals({ ...year, store: a.storeKey }).overall[0]), asFigures(await analytics(van, year)));
});

// ---- adding a store ------------------------------------------------------------------------------------------
test('adding a store: the key is checked with real reads before anything is saved; read-only must be confirmed; bad keys, sites and redirects are refused', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  const post = (body) => s.call('POST', '/api/woocommerce/stores', { body: { url: van.url, key: STORE_KEY, secret: STORE_SECRET, readOnlyConfirmed: true, ...body } });
  const count = () => s.db.prepare('SELECT COUNT(*) AS n FROM woocommerce_stores').get().n;
  let r = await post({ readOnlyConfirmed: false });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'confirm_read');
  assert.equal(van.requests.length, 0, 'not even a read before the confirmation');
  r = await post({ secret: OTHER_SECRET });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'refused');
  assert.match(r.body.error, /refused the key.*nothing was saved/);
  r = await post({ key: 'ck_nope' });
  assert.equal(r.body.code, 'bad_key');
  r = await post({ url: 'http://tinsxpress.com' });
  assert.equal(r.body.code, 'bad_url');
  r = await post({ businessId: 'not-a-business' });
  assert.equal(r.body.code, 'bad_business');
  van.state.analytics = false;
  r = await post({});
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'no_analytics');
  assert.match(r.body.error, /Analytics is off/);
  van.state.analytics = true;
  van.redirectTo = 'https://www.example.com';
  r = await post({});
  assert.equal(r.body.code, 'redirect');
  van.redirectTo = null;
  van.fail['/wp-json/wc/v3/orders'] = { status: 403, code: 'woocommerce_rest_cannot_view', times: 1 };
  r = await post({});
  assert.equal(r.body.code, 'refused', 'a key that can’t read orders (lookups) is refused too');
  assert.equal(count(), 0, 'nothing saved by any of these');
  const dead = await startFakeWoo(t);
  await dead.close();
  r = await s.call('POST', '/api/woocommerce/stores', { body: { url: dead.url, key: STORE_KEY, secret: STORE_SECRET, readOnlyConfirmed: true } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'unreachable');

  r = await post({ name: '  TX  ' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.store.name, 'TX');
  assert.equal(r.body.store.readOnlyConfirmed, true);
  assert.equal(count(), 1);
  r = await post({});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'exists');
  const ch = s.db.prepare('SELECT * FROM woocommerce_changes').all();
  assert.deepEqual(ch.map((c) => [c.action, c.actor]), [['added', 'owner']]);
  // Signed in only.
  assert.equal((await s.call('GET', '/api/woocommerce/stores', { session: null })).status, 401);
});

test('secrets: the consumer secret is stored only encrypted (key file 0600, outside the database) and never sent back; a lost key file means “replace the key”', async (t) => {
  const config = testConfig(tmpDir(t), { WOO_TIMEOUT_MS: '1000' });
  const clock = testClock();
  const s = await setup(t, { config, clock });
  const van = await startFakeWoo(t);
  const a = await s.add(van);
  const row = s.db.prepare('SELECT * FROM woocommerce_stores').get();
  assert.ok(!row.secret_enc.includes(STORE_SECRET) && !row.secret_enc.includes(STORE_SECRET.slice(3)));
  assert.match(row.secret_enc, /^v1:/);
  assert.equal(fs.statSync(config.woocommerce.keyFile).mode & 0o777, 0o600);
  for (const url of ['/api/woocommerce/stores', `/api/woocommerce/stores/${a.id}`, '/api/connections', '/api/sales/summary']) {
    const r = await s.call('GET', url);
    assert.equal(r.status, 200, url);
    assert.ok(!r.text.includes(STORE_SECRET) && !r.text.includes(STORE_SECRET.slice(3)), url);
  }
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(!fs.readFileSync(config.dbPath).includes(Buffer.from(STORE_SECRET.slice(3))), 'not in the database file');
  // Replacing the key: checked first, logged without the secret.
  let r = await s.call('PUT', `/api/woocommerce/stores/${a.id}/key`, { body: { key: OTHER_KEY, secret: OTHER_SECRET, readOnlyConfirmed: true } });
  assert.equal(r.status, 400, 'the store doesn’t know that key yet');
  van.state.key = OTHER_KEY;
  van.state.secret = OTHER_SECRET;
  r = await s.call('PUT', `/api/woocommerce/stores/${a.id}/key`, { body: { key: OTHER_KEY, secret: OTHER_SECRET, readOnlyConfirmed: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.store.keyEnd, OTHER_KEY.slice(-7));
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM woocommerce_changes').all()).includes(OTHER_SECRET.slice(3)));
  await s.close();
  // The key file is gone (a new Mac without the volume): the store stays, its secret can't be read.
  fs.rmSync(config.woocommerce.keyFile);
  const s2 = await setup(t, { config, clock, start: null });
  const info = s2.svc.store(a.id);
  assert.equal(info.readable, false);
  const n = van.requests.length;
  await s2.svc.pullStore(a.id, { force: true });
  assert.equal(van.requests.length, n, 'no calls without the secret');
  assert.match(s2.svc.store(a.id).lastError, /can’t be read/);
  assert.equal((await s2.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=101`)).body.code, 'unreadable');
});

// ---- Connections: rows, pause, failures ------------------------------------------------------------------
test('Connections: a “WooCommerce stores” row and one row per store under it; pausing a store stops every call to it; switching it on catches up', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  van.state.orders = vancouverOrders();
  const off = await startFakeWoo(t, { timezone: '', gmtOffset: 1 });
  const a = await s.add(van);
  const b = await s.add(off);
  let list = (await s.call('GET', '/api/connections')).body.connections;
  const ids = list.map((c) => c.id);
  assert.deepEqual(ids.slice(ids.indexOf('woocommerce'), ids.indexOf('woocommerce') + 3), ['woocommerce', a.connectionId, b.connectionId], 'the stores right under their row');
  const hub = list.find((c) => c.id === 'woocommerce');
  assert.equal(hub.state, 'always_on');
  assert.equal(hub.queueLabel, '2 stores');
  assert.equal((await s.call('PUT', '/api/connections/woocommerce', { body: { paused: true } })).body.code, 'not_pausable');
  const rowA = list.find((c) => c.id === a.connectionId);
  assert.equal(rowA.state, 'on');
  assert.ok(rowA.lastSuccessAt);
  assert.match(rowA.queueLabel, /Totals to 2026-10-13 · 13 months read/);
  assert.match(rowA.name, /TinsXpress/);

  assert.equal((await s.call('PUT', `/api/connections/${a.connectionId}`, { body: { paused: true } })).status, 200);
  const n = van.requests.length;
  await s.svc.pullRound({ force: true });
  assert.equal(van.requests.length, n, 'paused: no calls at all');
  assert.equal((await s.call('POST', `/api/woocommerce/stores/${a.id}/pull`)).body.code, 'paused');
  assert.equal((await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=101`)).body.code, 'paused');
  assert.equal(van.requests.length, n);
  list = (await s.call('GET', '/api/connections')).body.connections;
  assert.equal(list.find((c) => c.id === a.connectionId).state, 'paused');
  assert.equal(list.find((c) => c.id === a.connectionId).lastError, null, 'a pause is not a failure');
  assert.equal((await s.svc.pullStore(b.id, { force: true })).ok, true, 'the other store is unaffected');
  s.clock.advance(5 * MINUTE);
  await s.call('PUT', `/api/connections/${a.connectionId}`, { body: { paused: false } });
  await s.svc.pullStore(a.id);
  assert.ok(van.requests.length > n, 'switched on: read at once');
  assert.ok(Date.parse(s.pulls(a.id).last_success_at) >= s.clock.now() - 2000, 'a fresh read');
});

test('failures: one store failing (or slow) never holds up another; its own backoff 2, 4 … 60 minutes; its row shows the error', async (t) => {
  const s = await setup(t);
  const bad = await startFakeWoo(t, { name: 'Broken' });
  const slow = await startFakeWoo(t, { name: 'Slow' });
  const good = await startFakeWoo(t, { name: 'Good' });
  good.state.orders = vancouverOrders();
  const A = await s.add(bad);
  const B = await s.add(slow);
  const C = await s.add(good);
  bad.fail['/wp-json'] = { status: 500, times: Infinity };
  slow.delayMs['/wp-json'] = 1500; // over the 1 s time-out
  s.clock.advance(61 * MINUTE);
  const t0 = Date.now();
  const res = await s.svc.pullRound();
  assert.ok(Date.now() - t0 < 2500, 'the round waits for the slowest (time-out), not their sum');
  assert.equal(res[A.id].failed, true);
  assert.equal(res[B.id].failed, true);
  assert.equal(res[C.id].ok, true);
  assert.match(s.pulls(A.id).last_error, /answered 500/);
  assert.match(s.pulls(B.id).last_error, /didn’t answer within 1 s/);
  const list = (await s.call('GET', '/api/connections')).body.connections;
  assert.match(list.find((c) => c.id === A.connectionId).lastError, /500/);
  assert.equal(list.find((c) => c.id === C.connectionId).lastError, null);
  // Backoff: 2 minutes, then 4.
  const calls = () => bad.requests.length;
  let n = calls();
  await s.svc.pullRound();
  assert.equal(calls(), n);
  s.clock.advance(2 * MINUTE + 1000);
  await s.svc.pullRound();
  assert.equal(calls(), n + 1, 'one try (the index failed)');
  assert.equal(s.pulls(A.id).failures, 2);
  n = calls();
  s.clock.advance(3 * MINUTE);
  await s.svc.pullRound();
  assert.equal(calls(), n, 'four minutes this time');
  s.clock.advance(MINUTE + 1000);
  await s.svc.pullRound();
  assert.equal(calls(), n + 1);
  // Fixed there: the next try works and clears the error.
  delete bad.fail['/wp-json'];
  s.clock.advance(9 * MINUTE);
  await s.svc.pullRound();
  assert.equal(s.pulls(A.id).failures, 0);
  assert.equal((await s.call('GET', '/api/connections')).body.connections.find((c) => c.id === A.connectionId).lastError, null);
});

// ---- order lookups -----------------------------------------------------------------------------------------
test('order lookups: by number or email, live; first name only; tracking when there is some; nothing is stored anywhere', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  van.state.orders = [
    ...vancouverOrders(),
    order({ id: 120, created: '2026-10-12T09:00:00', email: 'kim@example.com', first: 'Kim', last: 'Nakamura', phone: '6045550199', address: '77 Secret Lane' }),
    order({ id: 121, created: '2026-10-13T09:00:00', email: 'Kim@Example.com', first: 'Kim', last: 'Nakamura' }),
    order({ id: 122, created: '2026-10-13T10:00:00', email: 'xkim@example.com', first: 'Xavier', last: 'Kimball' }),
    order({ id: 500, number: 'TX-500', created: '2026-10-13T11:00:00', first: 'Jo' }),
  ];
  van.state.shipments['120'] = [{ tracking_provider: 'Canada Post', tracking_number: '7023 4567 8901', tracking_link: 'https://www.canadapost-postescanada.ca/track?x=1', date_shipped: '2026-10-12' }];
  const a = await s.add(van);
  const before = van.requests.length;
  let r = await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=%23120`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.orders.length, 1);
  const o = r.body.orders[0];
  assert.equal(o.number, '120');
  assert.equal(o.customerFirstName, 'Kim');
  assert.equal(o.status, 'completed');
  assert.equal(o.total, 1000);
  assert.deepEqual(o.shippingMethods, ['Canada Post Expedited']);
  assert.deepEqual(o.tracking, [{ provider: 'Canada Post', number: '7023 4567 8901', url: 'https://www.canadapost-postescanada.ca/track?x=1', shippedOn: '2026-10-12' }]);
  assert.equal(o.createdAt, '2026-10-12T16:00:00Z', 'times in UTC (Vancouver 09:00)');
  for (const s2 of ['Nakamura', 'kim@example.com', '6045550199', '77 Secret Lane', 'back door', '203.0.113.9', 'Brantford', 'N3T']) assert.ok(!r.text.includes(s2), s2);
  r = await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?email=${encodeURIComponent(' KIM@example.com ')}`);
  assert.deepEqual(r.body.orders.map((x) => x.number).sort(), ['120', '121'], 'exact email only (not xkim@)');
  assert.ok(!r.text.includes('Xavier') && !r.text.includes('kim@'));
  r = await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=TX-500`);
  assert.deepEqual(r.body.orders.map((x) => x.number), ['TX-500'], 'a custom order number, through the search');
  r = await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=99999`);
  assert.deepEqual(r.body.orders, []);
  assert.equal((await s.call('GET', `/api/woocommerce/stores/${a.id}/orders`)).status, 400);
  assert.equal((await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?email=not-an-email`)).status, 400);
  assert.equal((await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=1;DROP`)).status, 400);
  // No tracking plugin: the order still shows.
  van.state.tracking = false;
  r = await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=121`);
  assert.deepEqual(r.body.orders[0].tracking, []);
  assert.ok(van.requests.slice(before).every((q) => q.method === 'GET'));
  // Nothing from the lookups is anywhere in the database.
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name);
  const everything = tables.map((tb) => JSON.stringify(s.db.prepare(`SELECT * FROM "${tb}"`).all())).join('\n');
  for (const s2 of ['kim@example.com', 'Kim@Example.com', 'Nakamura', 'Kim', '7023 4567', '6045550199', 'Secret Lane', 'Pat', 'Lefty']) assert.ok(!everything.includes(s2), s2);
});

// ---- read-only proof ---------------------------------------------------------------------------------------
test('the suite only reads: every call it made to a store in a full run was a GET with no body, of an allowed path; one fetch in the module', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  van.state.orders = vancouverOrders();
  const a = await s.add(van);
  await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?number=101`);
  await s.call('GET', `/api/woocommerce/stores/${a.id}/orders?email=buyer101@example.com`);
  await s.call('POST', `/api/woocommerce/stores/${a.id}/pull`);
  await s.call('PUT', `/api/woocommerce/stores/${a.id}`, { body: { name: 'TX', businessId: BUSINESS_IDS.agency } });
  await s.call('PUT', `/api/connections/${a.connectionId}`, { body: { paused: true } });
  await s.call('PUT', `/api/connections/${a.connectionId}`, { body: { paused: false } });
  await s.svc.pullStore(a.id);
  await s.call('DELETE', `/api/woocommerce/stores/${a.id}`);
  assert.ok(van.requests.length > 10);
  for (const r of van.requests) {
    assert.equal(r.method, 'GET', r.path);
    assert.equal(r.bodyLength, 0, r.path);
    assert.ok(PATHS.some((re) => re.test(r.path)), r.path);
    assert.ok(!('consumer_secret' in r.query), r.path);
  }
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/modules/woocommerce');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, src] of sources) {
    const fetches = src.match(/\bfetch(Impl)?\s*\(/g) ?? [];
    assert.equal(fetches.length, f === 'client.js' ? 1 : 0, `${f}: network calls`);
    assert.ok(!/\b(http|https)\.request\b|node:http|undici|XMLHttpRequest/.test(src), `${f}: no other HTTP client`);
  }
  const client = sources.find(([f]) => f === 'client.js')[1];
  assert.match(client, /fetchImpl\(u\.toString\(\), \{ method: 'GET', headers, redirect: 'manual', signal: AbortSignal\.timeout\(timeoutMs\) \}\)/);
  const salesDir = path.join(dir, '../sales');
  for (const f of fs.readdirSync(salesDir).filter((x) => x.endsWith('.js'))) assert.ok(!/\bfetch\s*\(/.test(fs.readFileSync(path.join(salesDir, f), 'utf8')), `sales/${f} calls nothing`);
});

// ---- changing and removing a store ---------------------------------------------------------------------------
test('rename / move to another business (its totals follow); remove (its row goes, its totals stay); added again it carries on', async (t) => {
  const s = await setup(t);
  const van = await startFakeWoo(t);
  van.state.orders = vancouverOrders();
  const a = await s.add(van);
  let r = await s.call('PUT', `/api/woocommerce/stores/${a.id}`, { body: { name: 'TinsXpress.com', businessId: BUSINESS_IDS.agency } });
  assert.equal(r.body.store.name, 'TinsXpress.com');
  assert.equal(s.sales.totals({ ...LAST_WEEK, business: BUSINESS_IDS.agency }).overall[0].net, 12300);
  assert.equal(s.sales.totals({ ...LAST_WEEK, business: RETAIL }).overall.length, 0);
  assert.equal((await s.call('PUT', `/api/woocommerce/stores/${a.id}`, { body: { name: '  ' } })).body.code, 'bad_name');
  r = await s.call('DELETE', `/api/woocommerce/stores/${a.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.stores, []);
  const ids = (await s.call('GET', '/api/connections')).body.connections.map((c) => c.id);
  assert.ok(!ids.includes(a.connectionId) && ids.includes('woocommerce'));
  const sum = (await s.call('GET', '/api/sales/summary')).body;
  const gone = sum.stores.find((x) => x.store === a.storeKey);
  assert.equal(gone.connected, false);
  assert.equal(gone.name, 'TinsXpress.com');
  assert.equal(s.sales.totals({ ...LAST_WEEK, store: a.storeKey }).overall[0].net, 12300, 'its totals stay');
  assert.equal((await s.call('GET', `/api/woocommerce/stores/${a.id}`)).status, 404);
  const again = await s.add(van);
  assert.notEqual(again.id, a.id);
  assert.equal(again.storeKey, a.storeKey, 'the same store in the totals');
  assert.equal(s.sales.totals({ ...LAST_WEEK, store: a.storeKey }).overall[0].net, 12300);
  assert.deepEqual(s.db.prepare('SELECT action FROM woocommerce_changes ORDER BY at, rowid').all().map((x) => x.action), ['added', 'renamed', 'business_changed', 'removed', 'added']);
});

// ---- restores ------------------------------------------------------------------------------------------------
test('restores: the stores are the current ones (one added after the backup stays); totals missing from the restored copy are read again', async (t) => {
  assert.ok(KEPT_TABLES.includes('woocommerce_stores') && KEPT_TABLES.includes('woocommerce_changes'));
  assert.ok(!KEPT_TABLES.includes('woocommerce_pulls') && !KEPT_TABLES.includes('sales_daily'));
  const dir = tmpDir(t);
  const config = testConfig(dir, { WOO_TIMEOUT_MS: '1000' });
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const clock = testClock();
  const first = await setup(t, { config, clock });
  const van = await startFakeWoo(t);
  van.state.orders = vancouverOrders();
  const off = await startFakeWoo(t, { timezone: '', gmtOffset: 1, currency: 'USD' });
  off.state.orders = offsetOrders();
  const a = await first.add(van);
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  const b = await first.add(off);
  await first.close();

  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const second = await setup(t, { config, clock, start: null });
  assert.deepEqual(second.svc.listStores().map((x) => x.id), [a.id, b.id], 'the store added after the backup is still there');
  assert.equal(second.sales.dayCount({ source: 'woo', store: b.storeKey, from: '2025-01-01', to: '2026-12-31' }), 0, 'its totals rolled back');
  const ids = (await second.call('GET', '/api/connections')).body.connections.map((c) => c.id);
  assert.ok(ids.includes(b.connectionId));
  await second.svc.pullRound();
  for (const [store, row] of [[van, a], [off, b]]) {
    assert.deepEqual(pick(second.sales.totals({ ...LAST_WEEK, store: row.storeKey }).overall[0]), asFigures(await analytics(store, LAST_WEEK)));
  }
  // Days lost from a finished backfill (a restore of an older backup) are read again.
  second.db.prepare("DELETE FROM sales_daily WHERE store = ? AND day BETWEEN '2026-01-01' AND '2026-01-31'").run(a.storeKey);
  second.clock.advance(61 * MINUTE);
  await second.svc.pullRound();
  const target = addMonths(VAN_TODAY, -BACKFILL_MONTHS);
  assert.equal(second.sales.dayCount({ source: 'woo', store: a.storeKey, from: target, to: VAN_TODAY }), 396);
});
