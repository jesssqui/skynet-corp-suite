// eBay (D13), against a fake eBay (fixtures/ebayFake.js: the token endpoint and getOrders): the keyset, the sign-in
// (state checked; the accept page or the pasted address), tokens (refresh, refused → signed out), the "done when" — a
// past month's total equals eBay's own figure worked out by hand from the fake's orders (cancellations, unpaid, refunds
// on their own day with their tax, the shop's zone at both ends of the month, another currency apart) —, paging, the
// ship tasks (no buyer details anywhere), months entered by hand (filling the card; replaced, and kept, once eBay has
// days), the sign-in reminder, pause, failures, and read-only by construction. Toronto time.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { KEPT_TABLES } from '../src/backup/restore.js';
import { createEbayClient, parseKeyset, consentUrl, codeFromUrl, EbayError, SCOPES, ORDERS_PATH, TOKEN_PATH } from '../src/modules/ebay/client.js';
import { orderFigures, refundFigures, dayRows, zoneMidnightUtc, shipView } from '../src/modules/ebay/figures.js';
import { AUTOMATION_IDS } from '../src/modules/ebay/automations.js';
import { SHIP_CAP } from '../src/modules/ebay/plans.js';
import { startFakeEbay, ebayOrder, APP_ID, CERT_ID, RU_NAME, SELLER } from './fixtures/ebayFake.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const SAVE_POINT = BUSINESS_IDS.save_point;
const START = Date.parse('2026-10-14T16:00:00Z'); // Wednesday Oct 14, noon in Toronto
const HOUR = 3_600_000;

/** September 2026 in Toronto, with orders around both ends of the month. */
function septemberOrders() {
  return [
    ebayOrder({ id: '01-A', created: '2026-09-01T03:30:00.000Z', items: [{ title: 'GoldenEye 007', sku: 'N64-GE', qty: 1, price: 100 }] }), // Aug 31, 23:30 Toronto
    ebayOrder({ id: '02-B', created: '2026-09-01T04:30:00.000Z', items: [{ title: 'Pokémon Red', sku: 'GB-RED', qty: 2, price: 20 }], shipping: 10, tax: 6.5 }),
    ebayOrder({ id: '03-C', created: '2026-09-15T18:00:00.000Z', items: [{ title: 'Zelda: Ocarina of Time', sku: 'N64-OOT', qty: 1, price: 80 }], discount: 8, shipping: 12, shipDiscount: 2, tax: 10.14 }),
    ebayOrder({ id: '04-D', created: '2026-09-10T15:00:00.000Z', cancelled: true, payment: 'FULLY_REFUNDED', items: [{ title: 'Virtual Boy', sku: 'VB', qty: 1, price: 200 }], refunds: [{ at: '2026-09-11T15:00:00.000Z', amount: 200 }] }),
    ebayOrder({ id: '05-E', created: '2026-09-20T15:00:00.000Z', payment: 'PENDING', items: [{ title: 'Tetris', sku: 'GB-TET', qty: 1, price: 30 }] }),
    ebayOrder({ id: '06-F', created: '2026-08-20T15:00:00.000Z', items: [{ title: 'Star Fox 64', sku: 'N64-SF', qty: 1, price: 60 }], tax: 7.8, refunds: [{ at: '2026-09-05T14:00:00.000Z', amount: 30 }] }),
    ebayOrder({ id: '07-G', created: '2026-09-25T15:00:00.000Z', items: [{ title: 'Kirby', sku: 'GB-KIR', qty: 1, price: 15 }], shipping: 5, tax: 2.6, refunds: [{ at: '2026-10-02T15:00:00.000Z', amount: 20 }] }),
    ebayOrder({ id: '08-H', created: '2026-10-01T03:00:00.000Z', items: [{ title: 'Mario Kart 64', sku: 'N64-MK', qty: 1, price: 25 }], tax: 3.25 }), // Sep 30, 23:00 Toronto
    ebayOrder({ id: '09-I', created: '2026-09-12T15:00:00.000Z', currency: 'USD', items: [{ title: 'Earthbound', sku: 'SNES-EB', qty: 1, price: 10 }] }),
    ebayOrder({ id: '10-J', created: '2026-09-21T15:00:00.000Z', items: [{ title: 'Donkey Kong Country', sku: 'SNES-DKC', qty: 1, price: 40 }], refunds: [{ at: '2026-09-22T15:00:00.000Z', amount: 40, status: 'PENDING' }], payment: 'PAID' }),
  ];
}

async function setup(t, { config = null, clock = testClock(), start = START, ebay = null, signIn = true, orders = [] } = {}) {
  ebay ??= await startFakeEbay(t, { now: clock.now });
  config ??= testConfig(tmpDir(t), { EBAY_API_URL: ebay.url, EBAY_AUTH_URL: ebay.url, EBAY_TIMEOUT_MS: '1000', EBAY_TIME_ZONE: 'America/Toronto' });
  if (start !== null) clock.offsetMs = start - Date.now();
  ebay.orders = orders;
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
    return { status: res.status, body: json, text };
  };
  const svc = env.ctx.services.ebay;
  const sales = env.ctx.services.sales;
  const autos = env.ctx.services.automations;
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const keyset = () => call('PUT', '/api/ebay/connection', { body: { appId: APP_ID, certId: CERT_ID, ruName: RU_NAME } });
  /** The whole sign-in, as a person would: Sign in → eBay's page → agree → the accept address back to the suite. */
  const signInNow = async ({ paste = true } = {}) => {
    const r = await call('POST', '/api/ebay/sign-in', { body: {} });
    assert.equal(r.status, 200, r.text);
    const state = new URL(r.body.url).searchParams.get('state');
    const back = ebay.authorize(state);
    const done = await call('POST', '/api/ebay/sign-in/finish', { body: paste ? { url: back.url } : { code: back.code, state } });
    assert.equal(done.status, 200, done.text);
    await svc.pull();
    return { state, back, done };
  };
  const s = { ...env, config, clock, ebay, users, owner, call, svc, sales, autos, tasks, keyset, signInNow };
  if (signIn) {
    assert.equal((await keyset()).status, 200);
    await signInNow();
  }
  return s;
}

const tasksOf = (s) => s.tasks('business_id = ? AND created_by = ?', SAVE_POINT, 'system');

// ---- pure parts --------------------------------------------------------------------------------------------
test('the client: the keyset checked, the consent address, the accepted address read back, only the two calls there are', async (t) => {
  assert.deepEqual(parseKeyset({ appId: ` ${APP_ID} `, certId: CERT_ID, ruName: RU_NAME }), { appId: APP_ID, certId: CERT_ID, ruName: RU_NAME });
  assert.throws(() => parseKeyset({ appId: 'SavePoin-suite-SBX-1a2b3c4d5-6e7f8a9b', certId: CERT_ID, ruName: RU_NAME }), (e) => e.code === 'bad_app_id' && /Sandbox/.test(e.message));
  assert.throws(() => parseKeyset({ appId: APP_ID, certId: 'x', ruName: RU_NAME }), (e) => e.code === 'bad_cert_id');
  assert.throws(() => parseKeyset({ appId: APP_ID, certId: CERT_ID, ruName: 'https://suite.example/ebay/accepted' }), (e) => e.code === 'bad_runame');
  const u = new URL(consentUrl({ authUrl: 'https://auth.ebay.com', appId: APP_ID, ruName: RU_NAME, state: 'abc' }));
  assert.equal(`${u.origin}${u.pathname}`, 'https://auth.ebay.com/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: APP_ID, redirect_uri: RU_NAME, response_type: 'code', scope: SCOPES.join(' '), state: 'abc' });
  assert.deepEqual(SCOPES, ['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'], 'one read-only scope');
  assert.throws(() => consentUrl({ authUrl: 'http://auth.ebay.com', appId: APP_ID, ruName: RU_NAME, state: 'x' }), /https/);
  // The code comes URL-encoded in the address; read back once (decoded), it goes out encoded once in the form.
  assert.deepEqual(codeFromUrl('https://x.ts.net/ebay/accepted?state=s1&code=v%5E1.1%23i%5E1&expires_in=299'), { code: 'v^1.1#i^1', state: 's1' });
  assert.deepEqual(codeFromUrl('state=s1&code=abc'), { code: 'abc', state: 's1' });
  assert.equal(codeFromUrl('https://x.ts.net/ebay/accepted?isAuthSuccessful=false'), null);
  const ebay = await startFakeEbay(t);
  const client = createEbayClient({ apiUrl: ebay.url, appId: APP_ID, certId: CERT_ID });
  assert.throws(() => client.token({ grant_type: 'client_credentials' }), (e) => e instanceof EbayError && e.code === 'bad_call');
  await assert.rejects(client.orders(null, {}), (e) => e.code === 'no_token');
  assert.equal(ebay.requests.length, 0, 'refused before any request');
});

test('figures: an order’s own figures, a refund with its tax, days in the shop’s zone, the zone’s midnight', () => {
  const c = ebayOrder({ id: 'x', created: '2026-09-15T18:00:00.000Z', items: [{ title: 'T', sku: 'S', qty: 1, price: 80 }], discount: 8, shipping: 12, shipDiscount: 2, tax: 10.14 });
  assert.deepEqual(orderFigures(c), { orders: 1, items: 1, gross: 8000, discounts: 800, refunds: 0, net: 7200, tax: 1014, shipping: 1000, total: 9214 });
  const f = ebayOrder({ id: 'f', created: '2026-08-20T15:00:00.000Z', items: [{ title: 'T', sku: 'S', qty: 1, price: 60 }], tax: 7.8 });
  assert.deepEqual(refundFigures(f, 3000), { orders: 0, items: 0, gross: 0, discounts: 0, refunds: 3000, net: -3000, tax: -390, shipping: 0, total: -3390 });
  assert.equal(zoneMidnightUtc('2026-09-01', 'America/Toronto').toISOString(), '2026-09-01T04:00:00.000Z');
  assert.equal(zoneMidnightUtc('2026-12-01', 'America/Toronto').toISOString(), '2026-12-01T05:00:00.000Z');
  const days = dayRows(septemberOrders(), { from: '2026-09-01', to: '2026-09-30', timeZone: 'America/Toronto', currencies: ['CAD'] });
  assert.equal(days.get('CAD').size, 30, 'every day of the month, zeros included');
  assert.equal(days.get('CAD').get('2026-09-30').total, 2825, 'the 23:00 order on Sep 30 in Toronto (Oct 1 in UTC)');
  assert.equal(days.get('USD').get('2026-09-12').total, 1000, 'another currency apart');
  const v = shipView(ebayOrder({ id: 'z', created: '2026-10-13T15:00:00.000Z', status: 'NOT_STARTED', shipBy: '2026-10-15T03:59:59.000Z' }));
  assert.deepEqual(Object.keys(v).sort(), ['cancelState', 'createdAt', 'currency', 'items', 'orderId', 'paymentStatus', 'shipBy', 'status', 'total']);
  assert.ok(!JSON.stringify(v).includes('buyer') && !JSON.stringify(v).includes('Secret Lane'));
});

// ---- the "done when" -----------------------------------------------------------------------------------------
test('DONE WHEN: a past month’s total equals eBay’s own figure (Seller Hub “Total sales”) worked out by hand from the orders', async (t) => {
  const s = await setup(t, { orders: septemberOrders() });
  const info = s.svc.info();
  assert.equal(info.state, 'on', JSON.stringify(info));
  assert.equal(info.account, SELLER, 'the account’s name from its orders');
  const sept = s.sales.totals({ from: '2026-09-01', to: '2026-09-30', source: 'ebay' });
  const cad = sept.overall.find((o) => o.currency === 'CAD');
  // Seller Hub's Total sales for September (Toronto), by hand:
  //   B 56.50 + C 92.14 + G 22.60 + H 28.25 (Sep 30 at 23:00 here) + J 40.00 (its refund is still pending)
  //   − F's refund on Sep 5: 30.00 + its share of tax 3.90
  //   left out: A (Aug 31 here), D (cancelled, and its refund), E (unpaid), G's refund (October), I (USD, apart)
  assert.equal(cad.total, 5650 + 9214 + 2260 + 2825 + 4000 - 3390);
  assert.equal(cad.total, 20559);
  assert.equal(cad.orders, 5);
  assert.equal(cad.refunds, 3000);
  assert.equal(cad.days, 30);
  assert.equal(cad.net, cad.total - cad.tax - cad.shipping, 'net = total − tax − shipping, as WooCommerce’s rows');
  const usd = sept.overall.find((o) => o.currency === 'USD');
  assert.equal(usd.total, 1000);
  assert.deepEqual(sept.stores.map((x) => x.store).sort(), ['ebay', 'ebay USD'], 'one constant key per connection (review fix), never the username');
  assert.ok(sept.stores.every((x) => x.business_id === SAVE_POINT));
  // August's last day has A; the backfill reached back to Sept 1 2025 (13 months, from the 1st).
  assert.equal(s.sales.totals({ from: '2026-08-31', to: '2026-08-31', source: 'ebay' }).overall[0].total, 10000);
  assert.equal(s.sales.dayCount({ source: 'ebay', store: 'ebay', from: '2025-09-01', to: '2026-10-14' }), 409);
  // The month list (the eBay card's months) shows September as eBay's own.
  const months = (await s.call('GET', '/api/sales/manual/ebay')).body;
  const m = months.months.find((x) => x.month === '2026-09');
  assert.equal(m.shown, 'real');
  assert.equal(m.real.find((f) => f.currency === 'CAD').total, 20559);
  // Every getOrders read asked for the tax breakdown and at most 200 a page.
  const reads = s.ebay.requests.filter((r) => r.path === ORDERS_PATH && r.query.filter);
  assert.ok(reads.every((r) => r.query.fieldGroups === 'TAX_BREAKDOWN' && r.query.limit === '200'));
  assert.ok(reads.some((r) => r.query.filter === 'creationdate:[2025-09-01T04:00:00.000Z..]'), reads.map((r) => r.query.filter).join(' | '));
  assert.ok(reads.some((r) => r.query.filter === 'lastmodifieddate:[2025-09-01T04:00:00.000Z..]'));
  // Read again: the same totals (upserts), and the next hourly pull reads only the last 90 days.
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  assert.equal(s.sales.totals({ from: '2026-09-01', to: '2026-09-30', source: 'ebay', store: 'ebay' }).overall[0].total, 20559);
  assert.ok(s.ebay.requests.some((r) => r.query.filter === 'creationdate:[2026-07-17T04:00:00.000Z..]'), 'the window: 90 days back to Jul 17');
});

test('paging: 450 orders in one read come in three pages of 200; offsets follow', async (t) => {
  const many = Array.from({ length: 450 }, (_, i) => ebayOrder({ id: `p-${String(i).padStart(3, '0')}`, created: `2026-06-${String(1 + (i % 28)).padStart(2, '0')}T15:00:00.000Z`, items: [{ title: 'Cart', sku: 'C', qty: 1, price: 1 }] }));
  const s = await setup(t, { orders: many });
  const created = s.ebay.requests.filter((r) => r.path === ORDERS_PATH && /^creationdate/.test(r.query.filter ?? ''));
  assert.deepEqual(created.map((r) => r.query.offset), ['0', '200', '400']);
  assert.equal(s.sales.totals({ from: '2026-06-01', to: '2026-06-30', source: 'ebay' }).overall[0].orders, 450);
});

// ---- the sign-in -------------------------------------------------------------------------------------------------
test('sign-in: the state is checked (made here, once, 30 minutes); the accept page or the pasted address; codes once; the keyset needed first', async (t) => {
  const s = await setup(t, { signIn: false });
  assert.equal((await s.call('POST', '/api/ebay/sign-in', { body: {} })).body.code, 'not_set_up');
  assert.equal((await s.call('PUT', '/api/ebay/connection', { body: { appId: 'nope', certId: CERT_ID, ruName: RU_NAME } })).body.code, 'bad_app_id');
  assert.equal((await s.keyset()).status, 200);
  assert.equal(s.svc.info().state, 'not_signed_in');
  const finish = (body) => s.call('POST', '/api/ebay/sign-in/finish', { body });
  // A state not made here.
  const stray = s.ebay.authorize('made-up-state');
  assert.equal((await finish({ url: stray.url })).body.code, 'bad_state');
  // Declined on eBay, or an address without a code.
  assert.equal((await finish({ url: 'https://suite.example.ts.net/ebay/declined?isAuthSuccessful=false' })).body.code, 'declined');
  assert.equal((await finish({ url: 'https://suite.example.ts.net/ebay/accepted' })).body.code, 'no_code');
  // Too old.
  let r = await s.call('POST', '/api/ebay/sign-in', { body: {} });
  let state = new URL(r.body.url).searchParams.get('state');
  s.clock.advance(31 * 60_000);
  assert.equal((await finish({ url: s.ebay.authorize(state).url })).body.code, 'bad_state');
  // A good one (the accept page sends code + state), then the same state again.
  r = await s.call('POST', '/api/ebay/sign-in', { body: {} });
  state = new URL(r.body.url).searchParams.get('state');
  const back = s.ebay.authorize(state);
  r = await finish({ code: back.code, state });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.state, 'not_read');
  assert.equal(r.body.refreshExpiresAt.slice(0, 10), '2028-04-14', '~18 months (47,304,000 s)');
  assert.equal((await finish({ code: back.code, state })).body.code, 'bad_state', 'a state works once');
  // A code eBay refuses (used, expired): the sign-in that went before stays.
  r = await s.call('POST', '/api/ebay/sign-in', { body: {} });
  state = new URL(r.body.url).searchParams.get('state');
  assert.equal((await finish({ code: back.code, state })).body.code, 'code_refused');
  assert.equal(s.svc.info().signedInAt !== null, true);
  // The token request: the code (decoded once), the RuName as redirect_uri, Basic App ID:Cert ID.
  const tok = s.ebay.requests.filter((x) => x.path === TOKEN_PATH);
  const form = new URLSearchParams(tok[0].body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), back.code);
  assert.equal(form.get('redirect_uri'), RU_NAME);
  assert.deepEqual(s.db.prepare('SELECT action FROM ebay_changes ORDER BY at, rowid').all().map((x) => x.action), ['keyset_set', 'signed_in']);
});

test('secrets: the Cert ID and the refresh token are stored only encrypted and never sent back; the access token lives in memory only', async (t) => {
  const s = await setup(t, { orders: septemberOrders() });
  const row = s.db.prepare('SELECT * FROM ebay_connection').get();
  assert.match(row.cert_enc, /^v1:/);
  assert.match(row.refresh_enc, /^v1:/);
  assert.equal(fs.statSync(s.config.ebay.keyFile).mode & 0o777, 0o600);
  const refresh = s.ebay.refresh;
  const access = [...s.ebay.access.keys()];
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  const file = fs.readFileSync(s.config.dbPath);
  for (const secret of [CERT_ID, refresh, ...access]) assert.ok(!file.includes(Buffer.from(secret)), 'not in the database file');
  for (const url of ['/api/ebay/connection', '/api/connections', '/api/sales/summary', '/api/sales/manual/ebay']) {
    const r = await s.call('GET', url);
    for (const secret of [CERT_ID, refresh, ...access]) assert.ok(!r.text.includes(secret), url);
  }
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM ebay_changes').all()).includes(CERT_ID));
});

test('tokens: a new access token every 2 hours from the refresh token; eBay refusing it signs out (no more calls) and the reminder task comes', async (t) => {
  const s = await setup(t, { orders: septemberOrders() });
  const refreshes = () => s.ebay.requests.filter((r) => r.path === TOKEN_PATH && /grant_type=refresh_token/.test(r.body));
  assert.equal(refreshes().length, 0, 'the first access token came with the sign-in');
  s.clock.advance(2 * HOUR + 1000);
  await s.svc.pull();
  assert.equal(refreshes().length, 1);
  assert.match(decodeURIComponent(refreshes()[0].body), /scope=https:\/\/api\.ebay\.com\/oauth\/api_scope\/sell\.fulfillment\.readonly/);
  // eBay takes the sign-in back.
  s.ebay.revoked = true;
  s.clock.advance(2 * HOUR + 1000);
  await s.svc.pull();
  const info = s.svc.info();
  assert.equal(info.state, 'signed_out');
  assert.ok(info.signedOutAt);
  const n = s.ebay.requests.length;
  s.clock.advance(2 * HOUR);
  await s.svc.pull({ force: true });
  assert.equal(s.ebay.requests.length, n, 'signed out: no calls');
  assert.equal((await s.call('POST', '/api/ebay/pull', { body: {} })).body.code, 'not_signed_in');
  const row = (await s.call('GET', '/api/connections')).body.connections.find((c) => c.id === 'ebay');
  assert.match(row.lastError, /stopped accepting/);
  s.autos.runNow(AUTOMATION_IDS.signIn);
  const remind = tasksOf(s).filter((x) => /^Sign in to eBay again/.test(x.title));
  assert.equal(remind.length, 1);
  assert.equal(remind[0].owner, 'partner', 'Save Point Shop’s default owner');
  // Signing in again finishes it.
  await s.signInNow();
  s.autos.runNow(AUTOMATION_IDS.signIn);
  assert.ok(s.db.prepare('SELECT done_at FROM planner_tasks WHERE id = ?').get(remind[0].id).done_at);
});

test('the sign-in reminder: once, 30 days before the refresh token lapses; a new sign-in finishes it', async (t) => {
  const s = await setup(t, { orders: [] });
  s.autos.runNow(AUTOMATION_IDS.signIn);
  assert.equal(tasksOf(s).length, 0, 'good for ~18 months');
  s.db.prepare("UPDATE ebay_connection SET refresh_expires_at = '2026-11-05T16:00:00.000Z'").run();
  s.autos.runNow(AUTOMATION_IDS.signIn);
  s.autos.runNow(AUTOMATION_IDS.signIn);
  const list = tasksOf(s);
  assert.equal(list.length, 1, 'once');
  assert.equal(list[0].title, 'Sign in to eBay again before Nov 5, 2026');
  assert.equal(list[0].due_date, '2026-10-29', 'a week before');
  await s.signInNow();
  s.autos.runNow(AUTOMATION_IDS.signIn);
  assert.match(s.db.prepare('SELECT notes FROM planner_tasks WHERE id = ?').get(list[0].id).notes, /Signed in to eBay again on Oct 14, 2026/);
});

// ---- orders to ship ------------------------------------------------------------------------------------------------
test('orders to ship: a task per waiting order, due its ship-by day, for Save Point Shop’s default owner — no buyer details anywhere; finished when shipped or cancelled', async (t) => {
  const waiting = [
    ebayOrder({ id: '20-W1', created: '2026-10-13T15:00:00.000Z', status: 'NOT_STARTED', shipBy: '2026-10-16T03:59:59.000Z', items: [{ title: 'Chrono Trigger', sku: 'SNES-CT', qty: 1, price: 150 }, { title: 'Manual', sku: null, qty: 2, price: 5 }] }),
    ebayOrder({ id: '21-W2', created: '2026-10-14T12:00:00.000Z', status: 'IN_PROGRESS', shipBy: '2026-10-17T03:59:59.000Z' }),
    ebayOrder({ id: '22-X', created: '2026-10-12T15:00:00.000Z', status: 'NOT_STARTED', cancelled: true }),
    ebayOrder({ id: '23-Y', created: '2026-10-12T15:00:00.000Z', status: 'NOT_STARTED', payment: 'PENDING' }),
    ebayOrder({ id: '24-Z', created: '2026-10-10T15:00:00.000Z', status: 'FULFILLED' }),
  ];
  const s = await setup(t, { orders: waiting });
  let list = tasksOf(s).filter((x) => /^Ship eBay order/.test(x.title));
  assert.deepEqual(list.map((x) => [x.title, x.due_date, x.owner]), [
    ['Ship eBay order 20-W1: 3 items', '2026-10-15', 'partner'],
    ['Ship eBay order 21-W2: 1 item', '2026-10-16', 'partner'],
  ]);
  assert.match(list[0].notes, /1 × Chrono Trigger \(SNES-CT\)\n• 2 × Manual/);
  assert.match(list[0].notes, /https:\/\/www\.ebay\.ca\/sh\/ord\/details\?orderid=20-W1/);
  assert.match(list[1].notes, /\(part shipped\)/);
  // Nothing about a buyer anywhere in the database (tasks, the ship table, the logs of the sync).
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name);
  const everything = tables.map((tb) => JSON.stringify(s.db.prepare(`SELECT * FROM "${tb}"`).all())).join('\n');
  for (const str of ['buyer_20-W1', 'Buyer Fullname', 'Secret Lane', 'buyer20-W1@example.com', '5195550100', 'side door', 'N3T 1A1']) assert.ok(!everything.includes(str), str);
  // A re-read changes nothing; then W1 ships, W2 is cancelled.
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  assert.equal(tasksOf(s).filter((x) => /^Ship eBay order/.test(x.title)).length, 2);
  s.ebay.orders = s.ebay.orders.map((o) => (o.orderId === '20-W1' ? { ...o, orderFulfillmentStatus: 'FULFILLED', lastModifiedDate: '2026-10-14T18:00:00.000Z' }
    : o.orderId === '21-W2' ? { ...o, cancelStatus: { cancelState: 'CANCELED', cancelRequests: [] }, lastModifiedDate: '2026-10-14T18:00:00.000Z' } : o));
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  list = s.db.prepare("SELECT * FROM planner_tasks WHERE title LIKE 'Ship eBay order%' ORDER BY title").all();
  assert.ok(list.every((x) => x.done_at));
  assert.match(list[0].notes, /Shipped on eBay — finished by the suite/);
  assert.match(list[1].notes, /Cancelled on eBay — finished by the suite/);
  // A person finishing one is final; another order makes its own.
  s.ebay.orders.push(ebayOrder({ id: '25-V', created: '2026-10-14T15:00:00.000Z', status: 'NOT_STARTED', shipBy: '2026-10-18T03:59:59.000Z' }));
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  const v = tasksOf(s).find((x) => x.title.startsWith('Ship eBay order 25-V'));
  s.ctx.services.sync.applyLocal({ actor: 'partner', entity: 'task', op: 'update', recordId: v.id, fields: { done_at: new Date(s.clock.now()).toISOString() } });
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  assert.equal(tasksOf(s).filter((x) => x.title.startsWith('Ship eBay order 25-V')).length, 1, 'not made again');
  assert.ok(s.db.prepare('SELECT done_at FROM planner_tasks WHERE id = ?').get(v.id).done_at);
});

test(`orders to ship: at most ${SHIP_CAP} new a read, earliest ship-by first; the rest with the next reads`, async (t) => {
  const orders = Array.from({ length: SHIP_CAP + 5 }, (_, i) => ebayOrder({
    id: `30-${String(i).padStart(2, '0')}`, created: '2026-10-13T15:00:00.000Z', status: 'NOT_STARTED', shipBy: `2026-10-${String(15 + (i % 10)).padStart(2, '0')}T20:00:00.000Z`,
  }));
  const s = await setup(t, { orders });
  assert.equal(tasksOf(s).length, SHIP_CAP);
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  assert.equal(tasksOf(s).length, SHIP_CAP + 5);
});

// ---- months entered by hand ------------------------------------------------------------------------------------------
test('DONE WHEN: a month entered by hand fills the same card while eBay is off; once eBay has days for it, those win and the entry is kept as replaced', async (t) => {
  const s = await setup(t, { signIn: false, orders: [
    ebayOrder({ id: '40-A', created: '2026-10-05T15:00:00.000Z', items: [{ title: 'Metroid', sku: 'NES-MET', qty: 1, price: 70 }] }),
  ] });
  const card = async () => (await s.call('GET', '/api/sales/summary')).body.stores.find((x) => x.source === 'ebay');
  let c = await card();
  assert.equal(c.state, 'not_set_up');
  assert.equal(c.manualStore, 'ebay');
  assert.equal(c.name, 'Save Point Shop (eBay)');
  // Entered by hand for this month (October) and September.
  let r = await s.call('PUT', '/api/sales/manual/ebay/2026-10', { body: { total: 123456, currency: 'CAD', orders: 31, note: 'From Seller Hub' } });
  assert.equal(r.status, 200, r.text);
  await s.call('PUT', '/api/sales/manual/ebay/2026-09', { body: { total: 99900 } });
  c = await card();
  assert.equal(c.monthFromManual, true);
  assert.deepEqual(c.month.map((f) => [f.currency, f.total, f.orders]), [['CAD', 123456, 31]]);
  assert.deepEqual(c.today, [], 'no days by hand: today and this week stay empty');
  const sum = (await s.call('GET', '/api/sales/summary')).body;
  assert.equal(sum.overall.month.find((f) => f.currency === 'CAD').total, 123456, 'in the totals of all stores together too');
  assert.equal(sum.businesses.find((b) => b.businessId === SAVE_POINT).month[0].total, 123456);
  // Refused: a future month, a bad total, a store that takes no hand entries.
  assert.equal((await s.call('PUT', '/api/sales/manual/ebay/2026-11', { body: { total: 1 } })).body.code, 'bad_month');
  assert.equal((await s.call('PUT', '/api/sales/manual/ebay/2026-08', { body: { total: -1 } })).body.code, 'bad_total');
  assert.equal((await s.call('PUT', '/api/sales/manual/ebay/2026-08', { body: { total: 1.5 } })).body.code, 'bad_total');
  assert.equal((await s.call('PUT', '/api/sales/manual/tinsxpress.com/2026-08', { body: { total: 1 } })).status, 404);
  // D15's monthly read has them.
  let monthly = (await s.call('GET', '/api/sales/monthly?from=2026-09&to=2026-10')).body.months;
  assert.deepEqual(monthly.map((x) => [x.month, x.source, x.from, x.total]), [['2026-09', 'manual', 'manual', 99900], ['2026-10', 'manual', 'manual', 123456]]);
  // eBay connected: its days for October (and September, empty days) win; the entries stay, shown as replaced.
  await s.keyset();
  await s.signInNow();
  c = await card();
  assert.ok(!c.monthFromManual);
  assert.equal(c.month[0].total, 7000);
  const months = (await s.call('GET', '/api/sales/manual/ebay')).body;
  const oct = months.months.find((x) => x.month === '2026-10');
  assert.deepEqual([oct.shown, oct.replaced, oct.manual.total, oct.manual.note, oct.manual.enteredBy], ['real', true, 123456, 'From Seller Hub', 'owner']);
  assert.equal(months.months.find((x) => x.month === '2026-09').replaced, true, 'eBay has (empty) days for September too: its own figure wins');
  assert.equal((await s.call('PUT', '/api/sales/manual/ebay/2026-10', { body: { total: 5 } })).body.code, 'has_data');
  monthly = (await s.call('GET', '/api/sales/monthly?from=2026-10&to=2026-10')).body.months;
  assert.deepEqual(monthly.map((x) => [x.source, x.total]), [['ebay', 7000]]);
  // Entries stay deletable.
  assert.equal((await s.call('DELETE', '/api/sales/manual/ebay/2026-10')).status, 200);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sales_manual_months').get().n, 1);
});

// ---- connections, pause, failures ---------------------------------------------------------------------------------
test('Connections: the eBay row; paused = no calls at all (pulls, Pull now, sign-in); switched on = read at once; failures back off', async (t) => {
  const s = await setup(t, { orders: septemberOrders() });
  let row = (await s.call('GET', '/api/connections')).body.connections.find((c) => c.id === 'ebay');
  assert.equal(row.state, 'on');
  assert.match(row.queueLabel, /0 orders to ship · totals to 2026-10-14/);
  assert.match(row.detail, /Sign-in good until 2028-04-14/);
  await s.call('PUT', '/api/connections/ebay', { body: { paused: true } });
  const n = s.ebay.requests.length;
  await s.svc.pull({ force: true });
  assert.equal((await s.call('POST', '/api/ebay/pull', { body: {} })).body.code, 'paused');
  assert.equal((await s.call('POST', '/api/ebay/sign-in', { body: {} })).body.code, 'paused');
  assert.equal(s.ebay.requests.length, n);
  s.clock.advance(5 * 60_000);
  await s.call('PUT', '/api/connections/ebay', { body: { paused: false } });
  await s.svc.pull();
  assert.ok(s.ebay.requests.length > n);
  // eBay failing: backoff 2 then 4 minutes; the row shows it.
  s.ebay.fail[ORDERS_PATH] = { status: 503, times: 2 };
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  row = (await s.call('GET', '/api/connections')).body.connections.find((c) => c.id === 'ebay');
  assert.match(row.lastError, /eBay answered 503/);
  const m = s.ebay.requests.length;
  await s.svc.pull();
  assert.equal(s.ebay.requests.length, m, 'waits 2 minutes');
  s.clock.advance(2 * 60_000 + 1000);
  await s.svc.pull();
  assert.equal(s.db.prepare('SELECT failures FROM ebay_pulls').get().failures, 2);
  s.clock.advance(4 * 60_000 + 1000);
  await s.svc.pull();
  assert.equal(s.db.prepare('SELECT failures FROM ebay_pulls').get().failures, 0);
  assert.equal(s.svc.info().state, 'on');
});

test('settings and forgetting: a new zone reads the days again in it; Forget keeps totals and tasks; kept across restores', async (t) => {
  assert.ok(KEPT_TABLES.includes('ebay_connection') && KEPT_TABLES.includes('ebay_changes'));
  assert.ok(!KEPT_TABLES.includes('ebay_pulls') && !KEPT_TABLES.includes('sales_manual_months'));
  const s = await setup(t, { orders: septemberOrders() });
  assert.equal((await s.call('PUT', '/api/ebay/settings', { body: { timeZone: 'Mars/Base' } })).body.code, 'bad_zone');
  const r = await s.call('PUT', '/api/ebay/settings', { body: { timeZone: 'UTC' } });
  assert.equal(r.body.timeZone, 'UTC');
  await s.svc.pull();
  // In UTC, A (Sep 1 03:30 UTC) is September and H (Oct 1 03:00 UTC) is October.
  assert.equal(s.sales.totals({ from: '2026-09-01', to: '2026-09-01', source: 'ebay', store: 'ebay' }).overall[0].total, 10000 + 5650);
  assert.equal(s.sales.totals({ from: '2026-10-01', to: '2026-10-01', source: 'ebay', store: 'ebay' }).overall[0].total, 2825);
  await s.call('DELETE', '/api/ebay/connection');
  assert.equal(s.svc.info().state, 'not_set_up');
  assert.ok(s.sales.dayCount({ source: 'ebay', store: 'ebay', from: '2025-01-01', to: '2026-12-31' }) > 0, 'totals stay');
  assert.deepEqual(s.db.prepare('SELECT action FROM ebay_changes ORDER BY at, rowid').all().map((x) => x.action), ['keyset_set', 'signed_in', 'settings', 'forgotten']);
});

// ---- read-only proof -----------------------------------------------------------------------------------------------
test('the suite only reads: every call it made in a full run was a GET of getOrders or the POST to the token endpoint; one fetch in the module', async (t) => {
  const s = await setup(t, { orders: [...septemberOrders(), ebayOrder({ id: '50-W', created: '2026-10-13T15:00:00.000Z', status: 'NOT_STARTED' })] });
  s.clock.advance(3 * HOUR);
  await s.svc.pull();
  await s.call('POST', '/api/ebay/pull', { body: {} });
  await s.call('PUT', '/api/connections/ebay', { body: { paused: true } });
  await s.call('PUT', '/api/connections/ebay', { body: { paused: false } });
  await s.svc.pull();
  assert.ok(s.ebay.requests.length >= 6);
  for (const r of s.ebay.requests) {
    if (r.method === 'GET') {
      assert.equal(r.path, ORDERS_PATH);
      assert.equal(r.body, '');
      assert.match(r.headers.authorization, /^Bearer /);
    } else {
      assert.deepEqual([r.method, r.path], ['POST', TOKEN_PATH]);
      assert.match(new URLSearchParams(r.body).get('grant_type'), /^(authorization_code|refresh_token)$/);
    }
  }
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/modules/ebay');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, src] of sources) {
    const fetches = src.match(/\bfetch(Impl)?\s*\(/g) ?? [];
    assert.equal(fetches.length, f === 'client.js' ? 1 : 0, `${f}: network calls`);
    assert.ok(!/\b(http|https)\.request\b|node:http|undici|XMLHttpRequest/.test(src), `${f}: no other HTTP client`);
  }
  const client = sources.find(([f]) => f === 'client.js')[1];
  assert.match(client, /const allowed = \(method === 'GET' && path === ORDERS_PATH\) \|\| \(method === 'POST' && path === TOKEN_PATH\);/);
});

// ---- D13 review fixes -------------------------------------------------------------------------------------------------
test('review fix: the store key is constant — a seller who changes their eBay username keeps the same totals (nothing doubles)', async (t) => {
  const s = await setup(t, { orders: septemberOrders() });
  const rows = () => s.db.prepare("SELECT store, COUNT(*) AS n FROM sales_daily WHERE source = 'ebay' GROUP BY store ORDER BY store").all();
  const before = rows();
  assert.deepEqual(before.map((r) => r.store), ['ebay', 'ebay USD']);
  s.ebay.orders = s.ebay.orders.map((o) => ({ ...o, sellerId: 'savepoint_retro' }));
  s.clock.advance(HOUR + 1000);
  await s.svc.pull();
  assert.equal(s.svc.info().account, 'savepoint_retro', 'the new name, as a label');
  assert.deepEqual(rows(), before, 'the same rows: no second set under the new name');
  assert.equal(s.sales.totals({ from: '2026-09-01', to: '2026-09-30', source: 'ebay' }).overall.find((o) => o.currency === 'CAD').total, 20559);
  const card = (await s.call('GET', '/api/sales/summary')).body.stores.find((x) => x.source === 'ebay' && x.currency === 'CAD');
  assert.equal(card.store, 'ebay');
  assert.equal(card.account, 'savepoint_retro');
});

test('review fix: after Forget, a month eBay read completely can’t be entered by hand again (no double count); its own figure stays', async (t) => {
  const s = await setup(t, { orders: septemberOrders() });
  await s.call('DELETE', '/api/ebay/connection');
  const r = await s.call('PUT', '/api/sales/manual/ebay/2026-09', { body: { total: 50000 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'has_data');
  const monthly = (await s.call('GET', '/api/sales/monthly?from=2026-09&to=2026-09')).body.months;
  assert.deepEqual(monthly.map((x) => [x.source, x.store, x.currency, x.total]), [['ebay', 'ebay', 'CAD', 20559], ['ebay', 'ebay USD', 'USD', 1000]]);
  const sept = (await s.call('GET', '/api/sales/manual/ebay')).body.months.find((m) => m.month === '2026-09');
  assert.deepEqual([sept.shown, sept.canEnter, sept.partial], ['real', false, false]);
});

test('review fix: a month eBay stopped reading part way (signed out) may be entered by hand and counts — until eBay is back and has read it all', async (t) => {
  const s = await setup(t, { orders: [
    ebayOrder({ id: '60-A', created: '2026-10-05T15:00:00.000Z', items: [{ title: 'Metroid', sku: 'NES-MET', qty: 1, price: 70 }] }),
  ] });
  // Signed out on Oct 14; ten days later October has days only to the 14th.
  s.ebay.revoked = true;
  s.clock.advance(2 * HOUR + 1000);
  await s.svc.pull();
  assert.equal(s.svc.info().state, 'signed_out');
  s.clock.advance(10 * 24 * HOUR);
  let oct = (await s.call('GET', '/api/sales/manual/ebay')).body.months.find((m) => m.month === '2026-10');
  assert.deepEqual([oct.shown, oct.partial, oct.canEnter], ['real', true, true]);
  let r = await s.call('PUT', '/api/sales/manual/ebay/2026-10', { body: { total: 25000, orders: 6 } });
  assert.equal(r.status, 200, r.text);
  oct = r.body.months.find((m) => m.month === '2026-10');
  assert.deepEqual([oct.shown, oct.replaced], ['manual', false]);
  const card = async () => (await s.call('GET', '/api/sales/summary')).body.stores.find((x) => x.source === 'ebay' && x.currency === 'CAD');
  let c = await card();
  assert.equal(c.monthFromManual, true);
  assert.equal(c.month[0].total, 25000);
  let monthly = (await s.call('GET', '/api/sales/monthly?from=2026-10&to=2026-10')).body.months;
  assert.deepEqual(monthly.map((x) => [x.source, x.total]), [['manual', 25000]], 'never both');
  // Signed in again: eBay reads the whole month, its figure wins, the entry is kept as replaced.
  await s.signInNow();
  c = await card();
  assert.ok(!c.monthFromManual);
  assert.equal(c.month[0].total, 7000);
  oct = (await s.call('GET', '/api/sales/manual/ebay')).body.months.find((m) => m.month === '2026-10');
  assert.deepEqual([oct.shown, oct.replaced, oct.partial], ['real', true, false]);
  monthly = (await s.call('GET', '/api/sales/monthly?from=2026-10&to=2026-10')).body.months;
  assert.deepEqual(monthly.map((x) => [x.source, x.total]), [['ebay', 7000]]);
  assert.ok(s.db.prepare("SELECT replaced_at FROM sales_manual_months WHERE month = '2026-10'").get().replaced_at, 'marked replaced for good');
  // Re-check fix: paused for 3 days (October no longer complete, eBay not reading) — the replaced entry never comes back.
  await s.call('PUT', '/api/connections/ebay', { body: { paused: true } });
  s.clock.advance(3 * 24 * HOUR);
  c = await card();
  assert.ok(!c.monthFromManual, 'still eBay’s figure on the card');
  assert.equal(c.month[0].total, 7000);
  oct = (await s.call('GET', '/api/sales/manual/ebay')).body.months.find((m) => m.month === '2026-10');
  assert.deepEqual([oct.shown, oct.replaced, oct.partial, oct.canEnter], ['real', true, true, true], 'shown as eBay’s days, read in part; open to a new entry');
  monthly = (await s.call('GET', '/api/sales/monthly?from=2026-10&to=2026-10')).body.months;
  assert.deepEqual(monthly.map((x) => [x.source, x.total]), [['ebay', 7000]]);
  // Saving the month again by hand (a person's newer figure) counts again.
  const again = await s.call('PUT', '/api/sales/manual/ebay/2026-10', { body: { total: 30000 } });
  assert.equal(again.status, 200, again.text);
  assert.equal((await card()).month[0].total, 30000);
  assert.deepEqual((await s.call('GET', '/api/sales/monthly?from=2026-10&to=2026-10')).body.months.map((x) => [x.source, x.total]), [['manual', 30000]]);
});
