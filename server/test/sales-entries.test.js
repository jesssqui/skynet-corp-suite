// Sales entered by hand (D11): invoices and anything not connected — a business, a day, an amount (refunds and credit
// notes count down), a currency (CAD by default), orders and a note — added up per day into the shared sales totals
// (source 'manual'), where they count like any store's days but only their total and orders are known (totalOnly);
// the id made on the device makes a save sent twice one entry; D13's months entered by hand are untouched.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { handStoreKey, signedAmount } from '@suite/shared/sales';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const CONSULTING = BUSINESS_IDS.consulting;
const AGENCY = BUSINESS_IDS.agency;

async function setup(t, { at = '2026-10-14T15:30:00Z' } = {}) {
  const clock = testClock();
  clock.offsetMs = Date.parse(at) - Date.now();
  const env = await startApp(t, testConfig(tmpDir(t)), { now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const partner = sessionFor(env.ctx, users.partner);
  const call = async (method, url, body, session = owner) => {
    const res = await fetch(`${env.base}${url}`, {
      method, headers: { cookie: session.cookie, origin: env.base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const add = (fields, session) => call('POST', '/api/sales/entries', { id: newId(), ...fields }, session);
  return { ...env, clock, sales: env.ctx.services.sales, call, add, partner };
}

test('shared: a hand store’s key and an entry’s sign', () => {
  assert.equal(handStoreKey(CONSULTING), `hand:${CONSULTING}`);
  assert.equal(handStoreKey(CONSULTING, 'USD'), `hand:${CONSULTING}:USD`);
  assert.deepEqual([signedAmount('sale', 500), signedAmount('refund', 500), signedAmount('credit_note', -500)], [500, -500, -500]);
});

test('entries add up per day into the totals: sales up, refunds and credit notes down, per currency, total only', async (t) => {
  const { add, call, sales } = await setup(t);
  const a = await add({ businessId: CONSULTING, day: '2026-10-14', kind: 'sale', amount: 150000, orders: 1, note: 'Invoice 2026-031' });
  assert.equal(a.status, 201);
  assert.deepEqual([a.body.entry.amount, a.body.entry.currency, a.body.entry.enteredBy], [150000, 'CAD', 'owner']);
  assert.equal((await add({ businessId: CONSULTING, day: '2026-10-14', kind: 'credit_note', amount: 20000, note: 'CN for invoice 031' })).status, 201);
  assert.equal((await add({ businessId: CONSULTING, day: '2026-10-13', kind: 'sale', amount: 50000, orders: 2 })).status, 201);
  assert.equal((await add({ businessId: CONSULTING, day: '2026-10-12', kind: 'refund', amount: 5000 })).status, 201);
  assert.equal((await add({ businessId: CONSULTING, day: '2026-10-14', kind: 'sale', amount: 10000, currency: 'usd' })).status, 201);
  const day = sales.totals({ from: '2026-10-14', to: '2026-10-14', business: CONSULTING });
  assert.deepEqual(day.overall.map((f) => [f.currency, f.total, f.orders, f.totalOnly]), [['CAD', 130000, 1, true], ['USD', 10000, 0, true]]);
  const week = sales.totals({ from: '2026-10-12', to: '2026-10-18', business: CONSULTING }).overall.find((f) => f.currency === 'CAD');
  assert.deepEqual([week.total, week.orders, week.net, week.tax], [175000, 3, 0, 0], 'only total and orders are known');
  // Money → Sales: one card per currency for the business, "entered by hand", in the business and overall sums.
  const sum = sales.summary();
  const cards = sum.stores.filter((s) => s.source === 'manual');
  assert.deepEqual(cards.map((s) => [s.name, s.state, s.connected, s.businessId]).sort(), [
    ['Business consulting (USD)', 'by_hand', true, CONSULTING], ['Business consulting', 'by_hand', true, CONSULTING],
  ]);
  const cad = cards.find((s) => s.currency === 'CAD');
  assert.equal(cad.link, `/costs/sales/entries?business=${CONSULTING}`);
  assert.deepEqual(cad.today.map((f) => [f.total, f.totalOnly]), [[130000, true]]);
  assert.deepEqual(cad.week.map((f) => f.total), [175000]);
  const biz = sum.businesses.find((b) => b.businessId === CONSULTING);
  assert.deepEqual(biz.week.map((f) => [f.currency, f.total, f.totalOnly]), [['CAD', 175000, true], ['USD', 10000, true]]);
  assert.ok(sum.overall.month.every((f) => f.totalOnly));
  // The list: newest day first, sums per currency.
  const list = (await call('GET', `/api/sales/entries?business=${CONSULTING}`)).body;
  assert.equal(list.total, 5);
  assert.deepEqual(list.entries.map((e) => e.day), ['2026-10-14', '2026-10-14', '2026-10-14', '2026-10-13', '2026-10-12']);
  assert.deepEqual(list.sums, [{ currency: 'CAD', total: 175000 }, { currency: 'USD', total: 10000 }]);
  // D15's monthly read marks them total only too.
  const m = sales.monthly({ fromMonth: '2026-10', toMonth: '2026-10' }).months.filter((r) => r.source === 'manual');
  assert.ok(m.length === 2 && m.every((r) => r.totalOnly));
});

test('an edit moves the entry’s day, business or currency; a delete takes it off; the card goes with the last one', async (t) => {
  const { add, call, sales, db } = await setup(t);
  const id = newId();
  assert.equal((await call('POST', '/api/sales/entries', { id, businessId: CONSULTING, day: '2026-10-10', kind: 'sale', amount: 40000 })).status, 201);
  const moved = await call('PUT', `/api/sales/entries/${id}`, { businessId: AGENCY, day: '2026-10-11', kind: 'sale', amount: 45000, note: 'Website deposit' }, undefined);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.entry.businessId, AGENCY);
  const rows = () => db.prepare("SELECT store, day, total FROM sales_daily WHERE source = 'manual' ORDER BY store, day").all();
  assert.deepEqual(rows(), [{ store: handStoreKey(AGENCY), day: '2026-10-11', total: 45000 }], 'the old day is gone, not left at zero');
  assert.deepEqual(sales.summary().stores.filter((s) => s.source === 'manual').map((s) => s.businessId), [AGENCY]);
  assert.equal((await call('DELETE', `/api/sales/entries/${id}`)).body.deleted, true);
  assert.equal((await call('DELETE', `/api/sales/entries/${id}`)).body.deleted, false, 'deleting again is fine (a retry)');
  assert.deepEqual(rows(), []);
  assert.equal(sales.summary().stores.some((s) => s.source === 'manual'), false, 'no entries left: no card');
  assert.equal((await call('PUT', `/api/sales/entries/${id}`, { businessId: AGENCY, day: '2026-10-11', kind: 'sale', amount: 1 })).status, 404);
  assert.ok(await add({ businessId: AGENCY, day: '2026-10-11', kind: 'sale', amount: 1 }));
});

test('a save sent twice is one entry; another entry under the same id is refused', async (t) => {
  const { call, db } = await setup(t);
  const id = newId();
  const body = { id, businessId: CONSULTING, day: '2026-10-14', kind: 'sale', amount: 1000 };
  assert.equal((await call('POST', '/api/sales/entries', body)).status, 201);
  const again = await call('POST', '/api/sales/entries', body);
  assert.equal(again.status, 200);
  assert.equal(again.body.entry.id, id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sales_entries').get().n, 1);
  const other = await call('POST', '/api/sales/entries', { ...body, amount: 2000 });
  assert.deepEqual([other.status, other.body.code], [409, 'exists']);
});

test('checked: our business, a real day not in the future, a kind, an amount above 0, a currency, orders on sales only', async (t) => {
  const { add, call } = await setup(t);
  const ok = { businessId: CONSULTING, day: '2026-10-14', kind: 'sale', amount: 1000 };
  const bad = async (over, code) => {
    const r = await add({ ...ok, ...over });
    assert.deepEqual([r.status, r.body?.code], [400, code], JSON.stringify(over));
  };
  await bad({ businessId: newId() }, 'bad_business');
  await bad({ day: '2026-02-30' }, 'bad_day');
  await bad({ day: '2026-10-20' }, 'bad_day');
  await bad({ kind: 'invoice' }, 'bad_kind');
  await bad({ amount: 0 }, 'bad_amount');
  await bad({ amount: -500 }, 'bad_amount');
  await bad({ amount: 10.5 }, 'bad_amount');
  await bad({ currency: 'dollars' }, 'bad_currency');
  await bad({ kind: 'refund', orders: 1 }, 'bad_orders');
  await bad({ orders: -1 }, 'bad_orders');
  assert.equal((await add({ ...ok, day: '2026-10-15' })).status, 201, 'tomorrow is let through (a device in another zone)');
  const noId = await call('POST', '/api/sales/entries', ok);
  assert.deepEqual([noId.status, noId.body.code], [400, 'bad_id']);
  assert.equal((await call('GET', '/api/sales/entries?from=nope')).status, 400);
});

test('D13’s eBay months entered by hand still work beside the entries', async (t) => {
  const { call, add, sales } = await setup(t);
  assert.equal((await add({ businessId: CONSULTING, day: '2026-10-14', kind: 'sale', amount: 2500 })).status, 201);
  const put = await call('PUT', '/api/sales/manual/ebay/2026-10', { total: 123456, orders: 7 });
  assert.equal(put.status, 200);
  const ebay = sales.summary().stores.find((s) => s.source === 'ebay');
  assert.deepEqual(ebay.month.map((f) => [f.total, f.totalOnly]), [[123456, true]]);
  const sp = sales.summary().businesses.find((b) => b.businessId === BUSINESS_IDS.save_point);
  assert.deepEqual(sp.month.map((f) => f.total), [123456], 'Save Point Shop: the eBay month');
  assert.deepEqual(sales.summary().overall.month.map((f) => f.total), [123456 + 2500], 'all together: the eBay month and the entry');
});

test('never for a business whose sales come from a connection (counted twice), Personal, or an archived business', async (t) => {
  const { add, call, ctx } = await setup(t);
  // The retail stores: allowed (a store not connected to WooCommerce, sales outside it) — the sheet warns.
  assert.equal((await add({ businessId: BUSINESS_IDS.retail, day: '2026-10-14', kind: 'sale', amount: 1000 })).status, 201);
  for (const [id, words] of [
    [BUSINESS_IDS.wholesale, /Order Manager/], [BUSINESS_IDS.save_point, /eBay/], [BUSINESS_IDS.personal, /Personal/],
  ]) {
    const r = await add({ businessId: id, day: '2026-10-14', kind: 'sale', amount: 1000 });
    assert.deepEqual([r.status, r.body.code], [400, 'not_by_hand']);
    assert.match(r.body.error, words);
  }
  // An entry made before its business was archived can still be changed (and stays on it); a new one can't be made.
  const id = newId();
  assert.equal((await call('POST', '/api/sales/entries', { id, businessId: AGENCY, day: '2026-10-14', kind: 'sale', amount: 1000 })).status, 201);
  ctx.services.sync.applyLocal({ actor: 'owner', entity: 'business', op: 'update', recordId: AGENCY, fields: { archived: true } });
  assert.equal((await call('PUT', `/api/sales/entries/${id}`, { businessId: AGENCY, day: '2026-10-14', kind: 'sale', amount: 1200 })).status, 200);
  const r = await add({ businessId: AGENCY, day: '2026-10-14', kind: 'sale', amount: 1000 });
  assert.deepEqual([r.status, r.body.code], [400, 'not_by_hand']);
  assert.match(r.body.error, /archived/);
});
