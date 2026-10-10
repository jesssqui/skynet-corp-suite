// Sales totals (D12): the shared daily-totals table every source writes (D12 WooCommerce, D13 eBay) and its reads —
// upserts by source + store + day, sums per currency (never across), per store / business / overall, each store's
// today / this week / this month in its own time zone, removed stores kept with their totals, the read API.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { sumByCurrency, localDateIn, salesPeriods, lastWeek, salesMoney, toCents, SALES_FIGURES } from '@suite/shared/sales';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const RETAIL = BUSINESS_IDS.retail;
const day = (d, o = {}) => ({ day: d, orders: 1, items: 2, gross: 1000, discounts: 0, refunds: 0, net: 1000, tax: 130, shipping: 0, total: 1130, ...o });

async function setup(t, { at = '2026-10-14T05:30:00Z' } = {}) {
  const clock = testClock();
  clock.offsetMs = Date.parse(at) - Date.now();
  const env = await startApp(t, testConfig(tmpDir(t)), { now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const get = async (url, session = owner) => {
    const res = await fetch(`${env.base}${url}`, { headers: session ? { cookie: session.cookie } : {} });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { ...env, clock, sales: env.ctx.services.sales, get };
}

test('shared: sums per currency, a zone’s day, the periods, last week, money and cents', () => {
  const m = sumByCurrency([{ currency: 'CAD', net: 100, orders: 1 }, { currency: 'USD', net: 50, orders: 2 }, { currency: 'CAD', net: 5, orders: 1 }]);
  assert.equal(m.get('CAD').net, 105);
  assert.equal(m.get('CAD').days, 2);
  assert.equal(m.get('USD').orders, 2);
  for (const k of SALES_FIGURES) assert.equal(typeof m.get('USD')[k], 'number');
  const instant = new Date('2026-10-14T05:30:00Z'); // 01:30 in Toronto, 22:30 the day before in Vancouver
  assert.equal(localDateIn('America/Toronto', instant), '2026-10-14');
  assert.equal(localDateIn('America/Vancouver', instant), '2026-10-13');
  assert.equal(localDateIn('Etc/GMT-1', new Date('2026-10-13T23:30:00Z')), '2026-10-14');
  assert.equal(localDateIn('Not/AZone', instant), localDateIn(null, instant), 'an unknown zone falls back to this machine’s');
  assert.equal(localDateIn('America/Toronto', new Date('nope')), null, 'an invalid date: null, not endless recursion');
  assert.equal(localDateIn('Not/AZone', new Date(NaN)), null);
  assert.deepEqual(salesPeriods('2026-10-14'), { today: { from: '2026-10-14', to: '2026-10-14' }, week: { from: '2026-10-12', to: '2026-10-14' }, month: { from: '2026-10-01', to: '2026-10-14' } });
  assert.deepEqual(lastWeek('2026-10-14'), { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(lastWeek('2026-10-12'), { from: '2026-10-05', to: '2026-10-11' });
  assert.equal(salesMoney(123450, 'CAD'), '$1,234.50');
  assert.equal(salesMoney(500, 'CAD'), '$5');
  assert.match(salesMoney(100, 'USD'), /US\$1|\$1/);
  assert.equal(toCents('1.005'), 101);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('-3.10'), -310);
  assert.equal(toCents(null), 0);
  assert.equal(toCents('abc'), 0);
});

test('putDays upserts by source, store and day (a day read again replaces it); totals add up per currency, store and business', async (t) => {
  const s = await setup(t);
  s.sales.putDays({ source: 'woo', store: 'tinsxpress.com', name: 'TinsXpress', businessId: RETAIL, currency: 'CAD', timeZone: 'America/Vancouver', days: [day('2026-10-05'), day('2026-10-06', { net: 2000 })] });
  s.sales.putDays({ source: 'woo', store: 'tinsxpress.com', name: 'TinsXpress', businessId: RETAIL, currency: 'CAD', timeZone: 'America/Vancouver', days: [day('2026-10-06', { net: 2500, refunds: 300 })] });
  s.sales.putDays({ source: 'woo', store: 'pouches.us', name: 'Pouches US', businessId: RETAIL, currency: 'USD', timeZone: 'America/New_York', days: [day('2026-10-05', { net: 700 })] });
  s.sales.putDays({ source: 'ebay', store: 'ebay-ca', name: 'eBay', businessId: BUSINESS_IDS.wholesale, currency: 'CAD', days: [day('2026-10-07', { net: 400 })] });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sales_daily').get().n, 4, 'one row per source, store and day');
  const all = s.sales.totals({ from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(all.overall.map((o) => [o.currency, o.net, o.days]), [['CAD', 1000 + 2500 + 400, 3], ['USD', 700, 1]], 'CAD first, never added across currencies');
  assert.equal(all.stores.find((x) => x.store === 'tinsxpress.com').refunds, 300);
  assert.equal(all.stores.find((x) => x.store === 'tinsxpress.com').name, 'TinsXpress');
  assert.deepEqual(all.businesses.filter((b) => b.business_id === RETAIL).map((b) => [b.currency, b.net]), [['CAD', 3500], ['USD', 700]]);
  assert.equal(s.sales.totals({ from: '2026-10-05', to: '2026-10-11', source: 'ebay' }).overall[0].net, 400);
  assert.equal(s.sales.totals({ from: '2026-10-05', to: '2026-10-11', store: 'pouches.us' }).overall[0].currency, 'USD');
  assert.equal(s.sales.totals({ from: '2026-10-06', to: '2026-10-06', business: RETAIL }).overall[0].net, 2500);
  assert.equal(s.sales.dayCount({ source: 'woo', store: 'tinsxpress.com', from: '2026-10-01', to: '2026-10-31' }), 2);
  // A store moved to another business: its rows follow.
  s.sales.setStore({ source: 'woo', store: 'pouches.us', name: 'Pouches US', businessId: BUSINESS_IDS.agency });
  assert.equal(s.sales.totals({ from: '2026-10-05', to: '2026-10-11', business: BUSINESS_IDS.agency }).overall[0].net, 700);
  // Bad input is refused before anything is written.
  assert.throws(() => s.sales.putDays({ source: 'amazon', store: 'x', currency: 'CAD', days: [] }), /unknown source/);
  assert.throws(() => s.sales.putDays({ source: 'woo', store: 'x', currency: 'cad', days: [] }), /currency/);
  assert.throws(() => s.sales.putDays({ source: 'woo', store: 'x', currency: 'CAD', days: [day('2026-10-5')] }), /bad day/);
  assert.throws(() => s.sales.putDays({ source: 'woo', store: 'x', currency: 'CAD', days: [day('2026-10-05', { net: 10.5 })] }), /cents/);
  // Totals only: the tables have no column for a customer, an order or an item.
  const cols = (table) => s.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const c of [...cols('sales_daily'), ...cols('sales_stores')]) assert.ok(!/email|phone|customer|address|first|last_name|order_id|number|sku/.test(c), c);
});

test('the summary: each store’s today / this week / this month in its own zone, per business and overall; stores no longer connected stay with their totals', async (t) => {
  // 01:30 Wednesday Oct 14 in Toronto = 22:30 Tuesday Oct 13 in Vancouver.
  const s = await setup(t, { at: '2026-10-14T05:30:00Z' });
  s.sales.registerSource({
    source: 'ebay', label: 'eBay',
    stores: () => [{ store: 'ebay-ca', name: 'eBay Canada', businessId: RETAIL, currency: 'CAD', timeZone: 'America/Toronto', state: 'on', lastSuccessAt: null, lastError: null, link: null }],
  });
  const put = (store, tz, days, cur = 'CAD', source = 'woo') => s.sales.putDays({ source, store, name: store, businessId: RETAIL, currency: cur, timeZone: tz, days });
  put('van.example', 'America/Vancouver', [day('2026-10-13', { net: 100 }), day('2026-10-14', { net: 9999 }), day('2026-10-12', { net: 20 }), day('2026-10-01', { net: 3 }), day('2026-09-30', { net: 7777 })]);
  put('ebay-ca', 'America/Toronto', [day('2026-10-14', { net: 50 }), day('2026-10-13', { net: 5 })], 'CAD', 'ebay');
  const sum = s.sales.summary();
  const van = sum.stores.find((x) => x.store === 'van.example');
  assert.equal(van.date, '2026-10-13', 'Vancouver is still on Tuesday');
  assert.equal(sum.stores.find((x) => x.store === 'ebay-ca').date, '2026-10-14', 'Toronto is on Wednesday');
  const net = (list) => list.map((f) => `${f.currency} ${f.net}`).join(', ');
  assert.equal(net(van.week), 'CAD 120', 'Monday Oct 12 – Tuesday Oct 13 (Oct 14 is tomorrow there)');
  assert.equal(net(van.month), 'CAD 123');
  assert.equal(van.connected, false, 'no source lists it: a store removed (its totals stay)');
  assert.equal(van.state, 'removed');
  const ebay = sum.stores.find((x) => x.store === 'ebay-ca');
  assert.equal(ebay.connected, true);
  assert.equal(net(ebay.today), 'CAD 50');
  assert.equal(net(sum.overall.today), 'CAD 150', 'each store’s own today, added up');
  assert.equal(sum.businesses.find((b) => b.businessId === RETAIL).name, 'Retail stores');
  assert.ok(sum.stores.every((x) => x.lastFetchedAt));
  // The API (signed in; GET only; never cached).
  const r = await s.get('/api/sales/summary');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.stores.length, 2);
  assert.equal((await s.get('/api/sales/summary', null)).status, 401, 'signed in only');
  const tot = await s.get('/api/sales/totals?from=2026-10-12&to=2026-10-18&store=van.example');
  assert.equal(tot.body.overall[0].net, 10119);
  assert.equal((await s.get('/api/sales/totals?from=2026-10-18&to=2026-10-12')).status, 400);
  assert.equal((await s.get('/api/sales/totals?from=yesterday&to=2026-10-12')).status, 400);
});
