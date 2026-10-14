// Sales by channel: the sale_day record type registered with sync (fields, columns), the module's
// amount rule, past dates, the totals the overview will use, and the shared helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { createHlc } from '@suite/shared/hlc';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { SALES_CHANNEL_IDS, totalsByChannel, isSaleAmount, roundCents } from '@suite/shared/sales';
import { modules } from '../src/modules/index.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, quietLog } from './helpers.js';

const SPS = BUSINESS_IDS.save_point;

async function setup(t) {
  const env = await startApp(t, testConfig(tmpDir(t)), { modules });
  const users = await ensureTestUsers(env.ctx);
  return { ...env, users };
}

/** A device signed in as `actor`, pushing one step at a time. */
function makeDevice(env, actor) {
  const { cookie, deviceId: id } = sessionFor(env.ctx, env.users[actor]);
  const clock = createHlc(id);
  const headers = { 'content-type': 'application/json', cookie, origin: env.base };
  const d = {
    async push(op, entity, recordId, fields) {
      const step = { key: newId(), entity, recordId, op, ...(fields ? { fields } : {}), hlc: clock.now() };
      const res = await fetch(`${env.base}/api/sync/push`, { method: 'POST', headers, body: JSON.stringify({ steps: [step] }) });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      clock.receive(body.hlc);
      return body.results[0];
    },
    async create(fields, recordId = newId()) {
      const r = await d.push('create', 'sale_day', recordId, fields);
      assert.equal(r.status, 'applied', JSON.stringify(r));
      return recordId;
    },
  };
  return d;
}

const sale = (channel, sale_date, amount, extra = {}) => ({ business_id: SPS, channel, sale_date, amount, ...extra });

test('sales registers sale_day with sync: fields, ops, enum of hand-entered channels (no eBay), columns match', async (t) => {
  const { ctx, db } = await setup(t);
  const mine = ctx.services.sync.info().entities.filter((e) => e.module === 'sales');
  assert.deepEqual(mine.map((e) => e.entity), ['sale_day']);
  const e = mine[0];
  assert.deepEqual(e.ops, ['create', 'update', 'delete']);
  assert.deepEqual(e.fields.channel.values, ['whatnot', 'poshmark', 'facebook_marketplace']);
  assert.ok(!SALES_CHANNEL_IDS.includes('ebay'), 'eBay is automatic, never typed by hand');
  assert.deepEqual(
    [e.fields.business_id.ref, e.fields.business_id.parent, e.fields.amount.type, e.fields.sale_date.type],
    ['business', true, 'number', 'date'],
  );
  const cols = Object.fromEntries(db.prepare('PRAGMA table_info(sales_days)').all().map((c) => [c.name, c.type]));
  assert.deepEqual([cols.amount, cols.sale_date, cols.channel, cols.business_id], ['REAL', 'TEXT', 'TEXT', 'TEXT']);
});

test('a day’s sales are added on any device, for today or a past day, and edited or deleted later', async (t) => {
  const env = await setup(t);
  const phone = makeDevice(env, 'partner');
  const id = await phone.create(sale('whatnot', '2026-10-13', 182.5, { notes: 'Tuesday show' }));
  const past = await phone.create(sale('poshmark', '2025-01-02', 40)); // a missed day, added much later
  const row = (rid) => env.db.prepare('SELECT * FROM sales_days WHERE id = ?').get(rid);
  assert.deepEqual([row(id).amount, row(id).sale_date, row(id).notes, row(id).business_id], [182.5, '2026-10-13', 'Tuesday show', SPS]);
  assert.equal(row(past).sale_date, '2025-01-02');
  const up = await phone.push('update', 'sale_day', id, { amount: 190.25 });
  assert.equal(up.status, 'applied');
  assert.equal(row(id).amount, 190.25);
  const del = await phone.push('delete', 'sale_day', past);
  assert.equal(del.status, 'applied');
  assert.notEqual(row(past).deleted_at, null);
});

test('the amount is 0 or more with at most two decimals; an unknown channel and a missing business are refused', async (t) => {
  const env = await setup(t);
  const phone = makeDevice(env, 'owner');
  for (const amount of [-1, 10.005, 1_000_001]) {
    const r = await phone.push('create', 'sale_day', newId(), sale('whatnot', '2026-10-13', amount));
    assert.deepEqual([r.status, r.code], ['rejected', 'invalid_value'], `${amount}: ${JSON.stringify(r)}`);
  }
  const ok = await phone.push('create', 'sale_day', newId(), sale('whatnot', '2026-10-13', 0));
  assert.equal(ok.status, 'applied', 'a day with no sales can be recorded as 0');
  const id = await phone.create(sale('whatnot', '2026-10-13', 5));
  const bad = await phone.push('update', 'sale_day', id, { amount: 1.234 });
  assert.deepEqual([bad.status, bad.code], ['rejected', 'invalid_value']);
  const ebay = await phone.push('create', 'sale_day', newId(), sale('ebay', '2026-10-13', 5));
  assert.equal(ebay.status, 'rejected', 'eBay totals are never typed in');
  const nobiz = await phone.push('create', 'sale_day', newId(), { ...sale('whatnot', '2026-10-13', 5), business_id: newId() });
  assert.deepEqual([nobiz.status, nobiz.code], ['rejected', 'not_found']);
});

test('direct writes to the table are refused: only sync steps change it', async (t) => {
  const { db } = await setup(t);
  assert.throws(() => db.prepare(`INSERT INTO sales_days (id, business_id, channel, sale_date, amount) VALUES (?, ?, 'whatnot', '2026-10-13', 1)`).run(newId(), SPS));
});

test('totals add a channel’s entries for a range, skip deleted ones, and keep cents exact', async (t) => {
  const env = await setup(t);
  const phone = makeDevice(env, 'partner');
  const svc = env.ctx.services.sales;
  await phone.create(sale('whatnot', '2026-10-12', 0.1));
  await phone.create(sale('whatnot', '2026-10-12', 0.2)); // same day twice: both count
  await phone.create(sale('whatnot', '2026-10-13', 100));
  await phone.create(sale('poshmark', '2026-10-13', 25.5));
  await phone.create(sale('facebook_marketplace', '2026-09-30', 60)); // outside the range
  const gone = await phone.create(sale('poshmark', '2026-10-14', 999));
  await phone.push('delete', 'sale_day', gone);
  const t1 = svc.totals(SPS, '2026-10-01', '2026-10-31');
  assert.deepEqual(t1, { byChannel: { whatnot: { total: 100.3, days: 2 }, poshmark: { total: 25.5, days: 1 } }, total: 125.8 });
  assert.deepEqual(svc.totals(SPS, '2026-09-01', '2026-09-30').byChannel, { facebook_marketplace: { total: 60, days: 1 } });
  assert.deepEqual(svc.totals(BUSINESS_IDS.wholesale, '2026-01-01', '2026-12-31'), { byChannel: {}, total: 0 }, 'another business has none');
});

test('shared helpers: totalsByChannel (every channel present, open ranges), isSaleAmount, roundCents', () => {
  const rows = [
    { channel: 'whatnot', sale_date: '2026-10-01', amount: 10 },
    { channel: 'whatnot', sale_date: '2026-10-01', amount: 5.25 },
    { channel: 'poshmark', sale_date: '2026-10-09', amount: 7 },
    { channel: 'ebay', sale_date: '2026-10-09', amount: 500 }, // not a hand-entered channel: ignored
  ];
  const all = totalsByChannel(rows);
  assert.deepEqual(all.byChannel, {
    whatnot: { total: 15.25, days: 1 }, poshmark: { total: 7, days: 1 }, facebook_marketplace: { total: 0, days: 0 },
  });
  assert.equal(all.total, 22.25);
  assert.equal(totalsByChannel(rows, { from: '2026-10-05' }).total, 7);
  assert.equal(totalsByChannel(rows, { to: '2026-10-05' }).total, 15.25);
  assert.deepEqual([isSaleAmount(0), isSaleAmount(19.99), isSaleAmount(-0.01), isSaleAmount(1.005), isSaleAmount('5')], [true, true, false, false, false]);
  assert.equal(roundCents(0.1 + 0.2), 0.3);
});

test('sales needs the CRM: registered without it, the server refuses to start', async (t) => {
  const config = testConfig(tmpDir(t));
  const db = openDb(config.dbPath);
  t.after(() => db.close());
  const noCrm = modules.filter((m) => !['crm', 'planner'].includes(m.name));
  await assert.rejects(createApp({ config, db, log: quietLog, modules: noCrm }), /sales needs the crm module/);
});
