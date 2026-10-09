// Stock tasks from Stockroom (D16), against a fake Stockroom that implements its read-only suite API
// (B5: signed GETs with a nonce, each signature once, 405 for anything else, ETags): the connection
// (code checked before it is saved, the secret only encrypted), the pull schedule and its backoff,
// time-outs, a revoked key, the pause switch, every call a GET with no body, and the four automations —
// reorders by supplier (episodes), the weekly spot check on the shared list, deliveries to receive,
// differences to investigate — each made once (replays, Run now, restarts, restores), kept up to date
// only while still the suite's, and finished when Stockroom says so. Toronto time.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { atLocal } from '../src/modules/automations/schedule.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup, KEPT_TABLES } from '../src/backup/restore.js';
import {
  parseConnection, cleanHubUrl, signGet, createStockroomClient, StockroomError,
} from '../src/modules/stockroom/client.js';
import { backoffMs } from '../src/modules/stockroom/service.js';
import { AUTOMATION_IDS, PULLED_EVENT } from '../src/modules/stockroom/automations.js';
import { DAILY_CAPS, DELIVERY_GONE, DIFFERENCE_GONE } from '../src/modules/stockroom/plans.js';
import { startFakeHub, connectionCode, READER_KEY, READER_SECRET } from './fixtures/stockroomHub.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const WHOLESALE = BUSINESS_IDS.wholesale;
const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};
const MONDAY = '2026-10-12';

// ---- builders --------------------------------------------------------------------------------------
const item = (o) => ({
  sku: o.sku, sku_id: o.sku_id ?? Number(o.sku.replace(/\D/g, '')) ?? 1, name: o.name ?? `Product ${o.sku}`, brand: o.brand ?? 'Zyn', status: o.status ?? 'order_soon',
  on_hand: 10, available: o.available ?? 8, daily_rate: 2, days_left: o.days_left ?? 4, runs_out_on: o.runs_out_on ?? '2026-10-16',
  suggested_qty: 'suggested_qty' in o ? o.suggested_qty : 50, suggested_why: null, on_order: o.on_order ?? 0, on_order_orders: [], case_size: o.case_size ?? 10, min_order: null,
  supplier: o.supplier === undefined ? 'Swedish Match' : o.supplier, supplier_id: o.supplier_id === undefined ? 7 : o.supplier_id,
  last_supplier: o.last_supplier ?? null,
});
const po = (o) => ({
  po_id: o.po_id, number: o.number ?? `PO-${String(o.po_id).padStart(4, '0')}`, supplier: o.supplier ?? 'Swedish Match', supplier_id: o.supplier_id ?? 7,
  status: o.status ?? 'confirmed', expected_on: o.expected_on === undefined ? '2026-10-20' : o.expected_on, overdue: false,
  confirmed_at: o.confirmed_at ?? '2026-10-12T14:00:00.000Z', confirmed_by: 'jessy', remaining_tins: o.remaining_tins ?? 100,
  lines: o.lines ?? [{ sku: 'ZYN-1', sku_id: 1, name: 'Zyn Cool Mint', brand: 'Zyn', supplier_code: 'SM-1', ordered: 100, received: 0, remaining: o.remaining_tins ?? 100 }],
});
const diff = (o) => ({
  id: o.id, sku: o.sku ?? `ZYN-${o.id}`, sku_id: o.id, name: o.name ?? `Product ${o.id}`, brand: 'Zyn', count_id: 'c1', count_type: 'weekly',
  counted_at: '2026-10-11T20:00:00.000Z', expected: 20, counted: 20 + (o.variance ?? -5), variance: o.variance ?? -5, reason: null,
  value_cents: o.value_cents ?? -2500, opened_at: '2026-10-11T20:00:00.000Z', opened_by: 'sam',
});

// ---- setup -----------------------------------------------------------------------------------------
async function setup(t, { config = testConfig(tmpDir(t), { STOCKROOM_TIMEOUT_MS: '300' }), clock = testClock(), start = at(`${MONDAY} 08:00`), hub = null, connect = true } = {}) {
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  if (start !== null) setNow(start);
  const env = await startApp(t, config, { modules, now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const { automations: autos, stockroom: svc } = env.ctx.services;
  hub ??= await startFakeHub(t, { now: clock.now });
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
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const task = (id) => env.db.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id);
  const open = (where = '1', ...args) => tasks(`done_at IS NULL AND ${where}`, ...args);
  const runs = (id) => env.db.prepare('SELECT * FROM automations_runs WHERE automation_id = ? ORDER BY started_at, id').all(id);
  const edit = (id, fields, actor = 'owner') => {
    const r = env.ctx.services.sync.applyLocal({ actor, entity: 'task', op: 'update', recordId: id, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
  };
  const pull = () => svc.pullRound({ force: true });
  const s = { ...env, config, clock, setNow, users, owner, autos, svc, hub, call, tasks, task, open, runs, edit, pull };
  if (connect) {
    const r = await call('PUT', '/api/stockroom/connection', { body: { code: hub.code } });
    assert.equal(r.status, 200, r.text);
    await svc.pullRound(); // the first pull (also started in the background by connect: the same round)
  }
  return s;
}

// ---- the client ------------------------------------------------------------------------------------
test('connection codes: SLR1 codes and the three parts are read and checked; store codes and plain http are refused', () => {
  const code = connectionCode({ url: 'https://stockroom-hub.fly.dev/' });
  assert.deepEqual(parseConnection({ code }), { url: 'https://stockroom-hub.fly.dev', key: READER_KEY, secret: READER_SECRET });
  assert.deepEqual(parseConnection({ url: 'https://stockroom-hub.fly.dev', key: READER_KEY, secret: READER_SECRET.toUpperCase() }).secret, READER_SECRET);
  const refuses = (input, code) => assert.throws(() => parseConnection(input), (e) => e instanceof StockroomError && e.code === code);
  refuses({ code: 'SL1.abc' }, 'bad_code');
  refuses({ code: 'SLR1.###' }, 'bad_code');
  refuses({ url: 'https://h.fly.dev', key: 'store.0123456789ab', secret: READER_SECRET }, 'bad_key');
  refuses({ url: 'https://h.fly.dev', key: READER_KEY, secret: 'short' }, 'bad_secret');
  refuses({ url: 'http://stockroom-hub.fly.dev', key: READER_KEY, secret: READER_SECRET }, 'bad_url');
  refuses({ url: 'https://h.fly.dev/?x=1', key: READER_KEY, secret: READER_SECRET }, 'bad_url');
  assert.equal(cleanHubUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080', 'plain http only for this machine (tests, a local hub)');
  // Stockroom's own formula (src/lib/hmac.ts): ts \n METHOD \n path-with-query \n sha256hex(body)
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(signGet('k', 1, '/v1/suite?nonce=abc'), crypto.createHmac('sha256', 'k').update(`1\nGET\n/v1/suite?nonce=abc\n${empty}`).digest('hex'));
});

test('the client can only make signed GETs of /v1/suite reads — no other path, no other method, no body', async (t) => {
  const hub = await startFakeHub(t);
  const client = createStockroomClient({ url: hub.url, key: READER_KEY, secret: READER_SECRET });
  for (const p of ['/v1/stock', '/v1/suite/../admin', '/api/admin/readers', '/v1/suite/deliveries?x=1']) {
    await assert.rejects(client.get(p), (e) => e.code === 'bad_path', p);
  }
  const r = await client.get('/v1/suite/deliveries');
  assert.equal(r.status, 200);
  const again = await client.get('/v1/suite/deliveries', { etag: r.etag });
  assert.equal(again.status, 304, 'If-None-Match');
  const req = hub.requests.at(-1);
  assert.equal(req.method, 'GET');
  assert.equal(req.bodyLength, 0);
  assert.match(req.query.nonce, /^[A-Za-z0-9_-]{16,64}$/);
  assert.notEqual(hub.requests[0].query.nonce, req.query.nonce, 'a fresh nonce every call');
  // Signed just before a Stockroom restart: re-signed once.
  hub.staleOnce = true;
  assert.equal((await client.get('/v1/suite/counts')).status, 200);
  // The wrong secret: refused with a plain-English reason, never the secret.
  const wrong = createStockroomClient({ url: hub.url, key: READER_KEY, secret: 'cd'.repeat(32) });
  await assert.rejects(wrong.get('/v1/suite'), (e) => e.code === 'unauthorized' && e.reason === 'bad_signature' && !e.message.includes('cd'.repeat(32)));
  // Stockroom itself answers anything but GET with 405 (the suite never sends one: proved below).
  const post = await fetch(`${hub.url}/v1/suite/deliveries`, { method: 'POST', body: '{}' });
  assert.deepEqual([post.status, post.headers.get('allow')], [405, 'GET']);
});

// ---- the connection --------------------------------------------------------------------------------
test('the connection: the code is checked with Stockroom before it is saved; the secret is stored only encrypted; the card never shows it', async (t) => {
  const s = await setup(t, { connect: false });
  assert.equal(s.ctx.services.connections.get('stockroom').state, 'on', 'a real connection in the placeholder’s place');
  assert.equal(s.ctx.services.connections.get('stockroom').queueLabel, 'Not set up');

  assert.equal((await s.call('PUT', '/api/stockroom/connection', { body: { code: 'SL1.xyz' } })).body.code, 'bad_code');
  const wrong = await s.call('PUT', '/api/stockroom/connection', { body: { code: connectionCode({ url: s.hub.url, secret: 'cd'.repeat(32) }) } });
  assert.deepEqual([wrong.status, wrong.body.code], [400, 'refused']);
  const away = await s.call('PUT', '/api/stockroom/connection', { body: { code: connectionCode({ url: 'http://127.0.0.1:9' }) } });
  assert.deepEqual([away.status, away.body.code], [502, 'unreachable']);
  assert.equal((await s.call('GET', '/api/stockroom/connection')).body.connected, false, 'nothing saved');

  const ok = await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.hubUrl, s.hub.url);
  assert.equal(ok.body.readerKey, READER_KEY);
  assert.ok(!ok.text.includes(READER_SECRET), 'never the secret');
  assert.ok(s.hub.requests.some((r) => r.path === '/v1/suite'), 'checked first');
  const row = s.db.prepare('SELECT * FROM stockroom_connection').get();
  assert.match(row.secret_enc, /^v1:/);
  assert.ok(!JSON.stringify(row).includes(READER_SECRET));
  assert.ok(fs.existsSync(s.config.stockroom.keyFile), 'the key file is made in the data folder');
  s.db.pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(!fs.readFileSync(s.config.dbPath).includes(Buffer.from(READER_SECRET)), 'not in the database file in usable form');
  await s.svc.pullRound();
  const info = (await s.call('GET', '/api/stockroom/connection')).body;
  assert.ok(info.reads.every((r) => r.fetchedAt), 'the first pull read everything');
  assert.deepEqual(info.changes.map((c) => c.action), ['connected']);

  // Forget: the connection and the answers go; nothing more is called.
  const before = s.hub.requests.length;
  const gone = await s.call('DELETE', '/api/stockroom/connection');
  assert.equal(gone.body.connected, false);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM stockroom_pulls').get().n, 0);
  assert.equal((await s.svc.pullRound()).skipped, 'not_set_up');
  assert.equal((await s.call('POST', '/api/stockroom/pull', { body: {} })).body.code, 'not_set_up');
  assert.equal(s.hub.requests.length, before);
});

test('a key file that is gone: the secret can’t be read, nothing is called, the card says to paste the code again', async (t) => {
  const s = await setup(t);
  fs.rmSync(s.config.stockroom.keyFile);
  // A fresh service (a restart) has no cached secret.
  const s2 = await setup(t, { config: s.config, clock: s.clock, start: null, hub: s.hub, connect: false });
  const before = s.hub.requests.length;
  assert.equal((await s2.svc.pullRound({ force: true })).skipped, 'unreadable');
  assert.equal(s.hub.requests.length, before);
  assert.match(s2.ctx.services.connections.get('stockroom').lastError, /key file is missing/);
});

// ---- the schedule ----------------------------------------------------------------------------------
test('the schedule: deliveries, differences and counts hourly (304 when unchanged); order-soon daily after 6:30 and when deliveries change', async (t) => {
  const s = await setup(t);
  const calls = () => Object.fromEntries(['deliveries', 'differences', 'counts', 'order-soon'].map((e) => [e, s.hub.calls(e)]));
  assert.deepEqual(calls(), { deliveries: 1, differences: 1, counts: 1, 'order-soon': 1 });
  assert.deepEqual((await s.svc.pullRound()).got, [], 'nothing due a minute later');
  s.clock.advance(61 * 60_000);
  const r = await s.svc.pullRound();
  assert.deepEqual(r.got, ['deliveries', 'differences', 'counts']);
  assert.deepEqual(r.changed, [], 'unchanged → 304');
  assert.ok(s.hub.requests.filter((q) => q.path === '/v1/suite/counts').at(-1).headers['if-none-match']);
  // A purchase order confirmed: deliveries change → order-soon is read again in the same round.
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 1 })] };
  s.clock.advance(61 * 60_000);
  assert.deepEqual((await s.svc.pullRound()).got, ['deliveries', 'differences', 'counts', 'order-soon']);
  // Next morning: order-soon again after 6:30, not before.
  s.setNow(at('2026-10-13 06:00'));
  assert.ok(!(await s.svc.pullRound()).got.includes('order-soon'));
  s.setNow(at('2026-10-13 06:31'));
  assert.deepEqual((await s.svc.pullRound()).got, ['order-soon']);
});

test('failures back off (2, 4, 8 … 60 minutes); a server error stops the round; a 404 on one read doesn’t stop the others; time-outs; nothing else breaks', async (t) => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMs(n) / 60_000), [2, 4, 8, 16, 32, 60, 60]);
  const s = await setup(t);
  s.hub.fail.deliveries = { status: 503, times: 2 };
  s.clock.advance(61 * 60_000);
  const r = await s.svc.pullRound();
  assert.deepEqual([r.got, r.failed], [[], ['deliveries', 'differences', 'counts']], 'the round stops; the others wait with it');
  const row = (e) => s.db.prepare('SELECT * FROM stockroom_pulls WHERE endpoint = ?').get(e);
  assert.equal(row('deliveries').failures, 1);
  assert.equal(Date.parse(row('deliveries').next_try_at) - s.clock.now() <= 2 * 60_000, true);
  assert.match(row('counts').last_error, /^Not tried: Stockroom answered 503/);
  assert.deepEqual((await s.svc.pullRound()).got, [], 'not before the backoff');
  s.clock.advance(2 * 60_000 + 1000);
  await s.svc.pullRound();
  assert.equal(row('deliveries').failures, 2);
  assert.ok(Date.parse(row('deliveries').next_try_at) - s.clock.now() > 3 * 60_000, 'longer each time');
  const card = s.ctx.services.connections.get('stockroom');
  assert.match(card.lastError, /Stockroom answered 503/);
  s.clock.advance(4 * 60_000 + 1000);
  assert.deepEqual((await s.svc.pullRound()).got, ['deliveries', 'differences', 'counts'], 'recovered');
  assert.equal(row('deliveries').failures, 0);

  // A read Stockroom doesn't know (404): the others still come.
  s.hub.fail.counts = { status: 404, times: 1 };
  s.clock.advance(61 * 60_000);
  const r2 = await s.svc.pullRound();
  assert.deepEqual([r2.got, r2.failed], [['deliveries', 'differences'], ['counts']]);

  // A time-out (STOCKROOM_TIMEOUT_MS = 300 here).
  s.hub.delayMs.deliveries = 1000;
  s.clock.advance(61 * 60_000);
  const r3 = await s.svc.pullRound();
  assert.deepEqual(r3.failed, ['deliveries', 'differences', 'counts']);
  assert.match(row('deliveries').last_error, /didn’t answer within/);
  s.hub.delayMs.deliveries = 0;

  // Stockroom unreachable: recorded, nothing thrown, the suite answers as usual.
  await s.hub.close();
  s.clock.advance(2 * 60 * 60_000);
  const r4 = await s.svc.pullRound();
  assert.ok(r4.failed.length && !r4.got.length);
  assert.match(row('deliveries').last_error, /Can’t reach Stockroom/);
  assert.equal((await s.call('GET', '/api/health')).status, 200);
});

test('401 revoked (disconnected in Stockroom): no more calls; the card says so; pasting a new code starts again', async (t) => {
  const s = await setup(t);
  s.hub.revoked = true;
  s.clock.advance(61 * 60_000);
  const r = await s.svc.pullRound();
  assert.deepEqual(r.failed, ['deliveries']);
  const card = s.ctx.services.connections.get('stockroom');
  assert.equal(card.queueLabel, 'Disconnected');
  assert.match(card.lastError, /Disconnected in Stockroom/);
  const before = s.hub.requests.length;
  s.clock.advance(3 * 60 * 60_000);
  assert.equal((await s.svc.pullRound()).skipped, 'revoked');
  assert.equal((await s.call('POST', '/api/stockroom/pull', { body: {} })).body.code, 'revoked');
  assert.equal(s.hub.requests.length, before, 'not one more call');
  s.hub.revoked = false; // a new reader in Stockroom (the fake keeps the same key)
  assert.equal((await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } })).status, 200);
  await s.svc.pullRound();
  assert.equal(s.db.prepare('SELECT revoked_at FROM stockroom_connection').get().revoked_at, null);
  assert.deepEqual(s.db.prepare('SELECT action FROM stockroom_connection_changes ORDER BY at, id').all().map((c) => c.action), ['connected', 'revoked', 'replaced']);
});

test('paused on Connections: no calls at all (loop, Pull now, connecting); on again: it catches up', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('PUT', '/api/connections/stockroom', { body: { paused: true } })).body.connection.state, 'paused');
  const before = s.hub.requests.length;
  s.clock.advance(2 * 24 * 60 * 60_000);
  assert.equal((await s.svc.pullRound()).skipped, 'paused');
  assert.equal((await s.call('POST', '/api/stockroom/pull', { body: {} })).body.code, 'paused');
  assert.equal((await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } })).body.code, 'paused');
  assert.equal(s.hub.requests.length, before, 'nothing called while paused');
  assert.equal(s.ctx.services.connections.get('stockroom').lastError, null, 'nothing logged as a failure');
  await s.call('PUT', '/api/connections/stockroom', { body: { paused: false } });
  await s.svc.pullRound(); // resume() started one; this waits for it
  assert.ok(s.hub.requests.length > before);
});

// ---- the automations -------------------------------------------------------------------------------
test('reorders: one task per supplier (products with no supplier share one), kept up to date while still the suite’s, finished when ordered or nothing is left', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state['order-soon'] = {
    today: MONDAY,
    items: [
      item({ sku: 'ZYN-1', name: 'Zyn Cool Mint', days_left: 3 }),
      item({ sku: 'ZYN-2', name: 'Zyn Citrus', suggested_qty: 30, days_left: 6 }),
      item({ sku: 'VEL-3', name: 'Velo Ice', supplier: 'BAT', supplier_id: 9, suggested_qty: 20 }),
      item({ sku: 'ODD-4', name: 'Odd Pouch', supplier: null, supplier_id: null, last_supplier: 'A friend' }),
      item({ sku: 'OK-5', name: 'Enough', suggested_qty: 0 }),
      item({ sku: 'NEW-6', name: 'No speed', suggested_qty: null }),
    ],
  };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const made = s.open("title LIKE 'Reorder%'");
  assert.deepEqual(made.map((x) => x.title).sort(), [
    'Reorder from BAT: 1 product', 'Reorder from Swedish Match: 2 products', 'Reorder: 1 product with no supplier in Stockroom',
  ]);
  const sm = made.find((x) => x.title.includes('Swedish Match'));
  assert.deepEqual([sm.business_id, sm.owner, sm.due_date, sm.created_by], [WHOLESALE, s.ctx.services.planner.automatedOwnerFor(WHOLESALE), MONDAY, 'system']);
  assert.match(sm.notes, /Zyn Cool Mint \(ZYN-1\) — order 50 tins \(cases of 10\) · 3 days left \(runs out Oct 16, 2026\)/);
  assert.ok(sm.notes.indexOf('ZYN-1') < sm.notes.indexOf('ZYN-2'), 'most urgent first');
  assert.match(s.open("title LIKE 'Reorder: %'")[0].notes, /last bought from A friend/);

  // Pulled again, nothing new: nothing made, no run row.
  const runsBefore = s.runs(AUTOMATION_IDS.reorders).length;
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Reorder%'").length, 3);
  assert.equal(s.runs(AUTOMATION_IDS.reorders).length, runsBefore, 'no run row for a no-op');

  // The list changes: the open task follows (title and notes are still the suite's).
  s.hub.state['order-soon'].items.push(item({ sku: 'ZYN-7', name: 'Zyn Spearmint', days_left: 8 }));
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.task(sm.id).title, 'Reorder from Swedish Match: 3 products');
  assert.match(s.task(sm.id).notes, /Zyn Spearmint/);
  // A person renames BAT's: never put back.
  const bat = made.find((x) => x.title.includes('BAT'));
  s.edit(bat.id, { title: 'Call BAT about Velo' });
  s.hub.state['order-soon'].items.find((i) => i.sku === 'VEL-3').suggested_qty = 40;
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.task(bat.id).title, 'Call BAT about Velo');

  // A purchase order to Swedish Match confirmed in Stockroom: its task is finished at the next pull.
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 31, confirmed_at: new Date(s.clock.now() + 60_000).toISOString() })] };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.ok(s.task(sm.id).done_at);
  assert.match(s.task(sm.id).notes, /Ordered: purchase order PO-0031 confirmed in Stockroom on .* — finished by the suite/);
  // Still short the same day: no new task until the next day's list.
  assert.equal(s.open("title LIKE 'Reorder from Swedish%'").length, 0);
  s.setNow(at('2026-10-16 07:00'));
  await s.svc.pullRound();
  const again = s.open("title LIKE 'Reorder from Swedish%'");
  assert.equal(again.length, 1, 'a new episode, a new task');
  assert.notEqual(again[0].id, sm.id);

  // BAT's: nothing from it needs ordering any more → finished.
  s.hub.state['order-soon'].items = s.hub.state['order-soon'].items.filter((i) => i.supplier_id !== 9);
  s.setNow(at('2026-10-17 07:00'));
  await s.svc.pullRound();
  assert.ok(s.task(bat.id).done_at);
  assert.match(s.task(bat.id).notes, /Nothing from this supplier needs ordering in Stockroom any more/);
  const eps = s.db.prepare('SELECT * FROM stockroom_reorder_episodes ORDER BY supplier_key, episode').all();
  assert.deepEqual(eps.map((e) => [e.supplier_key, e.episode, e.closed_why]), [['sup:7', 1, 'ordered'], ['sup:7', 2, null], ['sup:9', 1, 'empty'], ['sup:none', 1, null]]);
});

test('reorders: a person finishing the task is final for that episode; the next need after it ends is a new task; at most 10 new a day', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state['order-soon'] = { today: MONDAY, items: [item({ sku: 'ZYN-1' })] };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const [first] = s.open("title LIKE 'Reorder%'");
  s.edit(first.id, { done_at: new Date(s.clock.now()).toISOString() });
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Reorder%'").length, 0, 'not made again while the need goes on');
  assert.equal(s.ctx.services.automations.runNow(AUTOMATION_IDS.reorders).summary, '1 reorder task already handled by a person');
  // Nothing to order for a day, then again: a new episode.
  s.hub.state['order-soon'].items = [];
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  s.hub.state['order-soon'].items = [item({ sku: 'ZYN-1' })];
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Reorder%'").length, 1);

  // The cap: 12 suppliers at once → 10 today, 2 tomorrow (most urgent first).
  s.hub.state['order-soon'].items = Array.from({ length: 12 }, (_, i) => item({ sku: `S-${i + 10}`, supplier: `Supplier ${i + 10}`, supplier_id: 100 + i, days_left: i }));
  s.clock.advance(25 * 60 * 60_000);
  await s.svc.pullRound();
  const today = s.open("title LIKE 'Reorder from Supplier%'");
  assert.equal(today.length, DAILY_CAPS.reorders);
  assert.ok(!today.some((x) => /Supplier (20|21)/.test(x.title)), 'the least urgent wait');
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Reorder from Supplier%'").length, 10, 'still 10 the same day');
  s.clock.advance(24 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Reorder from Supplier%'").length, 12);
});

test('the weekly spot check: on the shared list once a week; none when one was already applied that week; finished when Stockroom shows one; replaced the next week', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state.counts = {
    last_spot_check: { id: 'c0', type: 'spot', applied_at: '2026-10-08T15:00:00.000Z' },
    spot_check_suggestions: [{ sku: 'ZYN-1', sku_id: 1, name: 'Zyn Cool Mint', brand: 'Zyn', on_hand: 12, score: 9, reasons: ['sells fast', 'not counted in 3 weeks'] }],
  };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const [w1] = s.open("title LIKE 'Weekly spot check%'");
  assert.deepEqual([w1.owner, w1.business_id, w1.due_date, w1.title], ['shared', WHOLESALE, MONDAY, 'Weekly spot check in Stockroom: 1 product to count']);
  assert.match(w1.notes, /2026-W42.*\n.*\n• Zyn Cool Mint \(ZYN-1\), Zyn · 12 on hand · sells fast; not counted in 3 weeks/);
  // Pulled again, Run now, the same event again: still one.
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  s.ctx.services.automations.runNow(AUTOMATION_IDS.spotCheck);
  s.ctx.services.automations.emit(PULLED_EVENT, { key: 'same-round' });
  s.ctx.services.automations.emit(PULLED_EVENT, { key: 'same-round' });
  assert.equal(s.tasks("title LIKE 'Weekly spot check%'").length, 1);
  // Applied in Stockroom on Wednesday: finished.
  s.hub.state.counts = { ...s.hub.state.counts, last_spot_check: { id: 'c1', type: 'spot', applied_at: '2026-10-14T18:00:00.000Z' } };
  s.setNow(at('2026-10-14 15:00'));
  await s.svc.pullRound();
  assert.ok(s.task(w1.id).done_at);
  assert.match(s.task(w1.id).notes, /Spot check applied in Stockroom on Oct 14, 2026/);
  // Next week, not done: made Monday; Tuesday a person finishes it; the week after, a new one replaces nothing open.
  s.setNow(at('2026-10-19 00:30'));
  await s.svc.pullRound();
  const [w2] = s.open("title LIKE 'Weekly spot check%'");
  assert.equal(w2.due_date, '2026-10-19');
  s.setNow(at('2026-10-26 01:00'));
  await s.svc.pullRound();
  assert.ok(s.task(w2.id).done_at, 'last week’s left open is replaced');
  assert.match(s.task(w2.id).notes, /Replaced by this week’s spot check/);
  assert.equal(s.open("title LIKE 'Weekly spot check%'").length, 1);
  // A week where the spot check was applied before the first pull: none made.
  s.hub.state.counts = { ...s.hub.state.counts, last_spot_check: { id: 'c2', type: 'spot', applied_at: '2026-11-02T13:00:00.000Z' } };
  s.setNow(at('2026-11-02 10:00'));
  await s.svc.pullRound();
  assert.equal(s.tasks("due_date = '2026-11-02' AND title LIKE 'Weekly spot check%'").length, 0);
});

test('deliveries: one task per confirmed purchase order, due on its expected day (moved while still the suite’s); finished when Stockroom no longer expects it; back → reopened', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 1, expected_on: '2026-10-20' }), po({ po_id: 2, number: 'PO-0002', supplier: 'BAT', supplier_id: 9, expected_on: null, remaining_tins: 40 })] };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const one = s.open("title LIKE 'Receive delivery PO-0001%'")[0];
  const two = s.open("title LIKE 'Receive delivery PO-0002%'")[0];
  assert.deepEqual([one.title, one.due_date, one.business_id], ['Receive delivery PO-0001 from Swedish Match: 100 tins', '2026-10-20', WHOLESALE]);
  assert.equal(two.due_date, MONDAY, 'no expected day: today');
  assert.match(one.notes, /Zyn Cool Mint \(ZYN-1\) \(their code SM-1\): 100 tins/);
  // The expected day moves: the task follows. Partly received: title and notes follow.
  s.hub.state.deliveries.items[0] = po({ po_id: 1, expected_on: '2026-10-22', status: 'partly_received', remaining_tins: 60,
    lines: [{ sku: 'ZYN-1', sku_id: 1, name: 'Zyn Cool Mint', brand: 'Zyn', supplier_code: 'SM-1', ordered: 100, received: 40, remaining: 60 }] });
  // A person gives PO-0002 a day of their own.
  s.edit(two.id, { due_date: '2026-10-15' });
  s.hub.state.deliveries.items[1] = po({ po_id: 2, number: 'PO-0002', supplier: 'BAT', supplier_id: 9, expected_on: '2026-10-25', remaining_tins: 40 });
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.deepEqual([s.task(one.id).due_date, s.task(one.id).title], ['2026-10-22', 'Receive delivery PO-0001 from Swedish Match: 60 tins']);
  assert.match(s.task(one.id).notes, /Partly received already[\s\S]*60 of 100 tins/);
  assert.equal(s.task(two.id).due_date, '2026-10-15', 'a person’s own day is kept');
  // PO-0001 received in full (gone from the list): finished. PO-0002 finished by a person: final.
  s.edit(two.id, { done_at: new Date(s.clock.now()).toISOString() });
  s.hub.state.deliveries.items = [s.hub.state.deliveries.items[1]];
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.ok(s.task(one.id).done_at);
  assert.ok(s.task(one.id).notes.includes(DELIVERY_GONE));
  assert.equal(s.open("title LIKE 'Receive delivery%'").length, 0, 'PO-0002 isn’t made again');
  // PO-0001 listed again (say a receipt was deleted in Stockroom): the suite reopens the one it finished.
  s.hub.state.deliveries.items.push(po({ po_id: 1, expected_on: '2026-10-22', remaining_tins: 10 }));
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.task(one.id).done_at, null);
  assert.match(s.task(one.id).notes, /reopened by the suite/);
  assert.equal(s.tasks("title LIKE 'Receive delivery%'").length, 2, 'never a second task for one order');
  assert.match(s.task(one.id).notes, /10 of 100 tins/, 'reopened with the order as it is now');
  // …and it keeps following the order (review fix: the notes froze after a reopen).
  s.hub.state.deliveries.items[1] = po({ po_id: 1, expected_on: '2026-10-22', remaining_tins: 4 });
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.match(s.task(one.id).notes, /4 of 100 tins/);
  assert.equal(s.task(one.id).title, 'Receive delivery PO-0001 from Swedish Match: 4 tins');
  // A person's own notes are never replaced.
  s.edit(one.id, { notes: 'Call them first' });
  s.hub.state.deliveries.items[1] = po({ po_id: 1, expected_on: '2026-10-22', remaining_tins: 3 });
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.task(one.id).notes, 'Call them first');
});

test('deliveries with Stockroom’s B10 fields: finished with how the order ended; a truncated open list finishes nothing', async (t) => {
  const s = await setup(t, { connect: false });
  const ended = (o) => ({ po_id: o.po_id, number: `PO-000${o.po_id}`, supplier: 'Swedish Match', supplier_id: 7, status: o.status, ended_at: '2026-10-12T15:00:00.000Z', reason: o.reason ?? null });
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [1, 2, 3, 4].map((id) => po({ po_id: id })), ended: [], purchase_orders_truncated: false };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const byPo = (n) => s.tasks(`title LIKE 'Receive delivery PO-000${n} %'`)[0];
  assert.equal(s.open("title LIKE 'Receive delivery%'").length, 4);
  // Over 500 open (cut): orders missing from the list may still be open — nothing is finished.
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 4 })], purchase_orders_truncated: true };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Receive delivery%'").length, 4);
  // Whole again: each finished with how it ended.
  s.hub.state.deliveries = {
    ...s.hub.state.deliveries, purchase_orders_truncated: false,
    ended: [ended({ po_id: 1, status: 'received' }), ended({ po_id: 2, status: 'cancelled', reason: 'Supplier out of stock' }), ended({ po_id: 3, status: 'closed_short', reason: '' })],
  };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.match(byPo(1).notes, /Received in full in Stockroom — finished by the suite/);
  assert.match(byPo(2).notes, /Cancelled in Stockroom: Supplier out of stock — finished by the suite/);
  assert.match(byPo(3).notes, /Closed short in Stockroom — finished by the suite/);
  assert.equal(byPo(4).done_at, null);
  // Gone and not in `ended` (ended over 30 days ago, say): the general reason.
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [] };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.ok(byPo(4).notes.includes(DELIVERY_GONE));
});

test('differences: one task per open difference at or over Stockroom’s limit; finished when marked investigated; a truncated list finishes nothing; at most 10 new a day', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state.differences = { threshold_tins: 3, open: 3, truncated: false, items: [diff({ id: 1, variance: -5 }), diff({ id: 2, variance: 4, value_cents: 1800 }), diff({ id: 3, variance: 2 })] };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const made = s.open("title LIKE 'Investigate%'");
  assert.deepEqual(made.map((x) => x.title).sort(), ['Investigate count difference: Product 1 (ZYN-1), -5 tins', 'Investigate count difference: Product 2 (ZYN-2), +4 tins']);
  assert.match(made.find((x) => x.title.includes('Product 1')).notes, /expected 20, the weekly count on Oct 11, 2026 found 15 — -5 tins \(−\$25\.00\)/);
  // Truncated (over 500 open): one missing from the page isn't taken as investigated.
  s.hub.state.differences = { ...s.hub.state.differences, truncated: true, items: [diff({ id: 2, variance: 4 })] };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Investigate%'").length, 2);
  s.hub.state.differences = { ...s.hub.state.differences, truncated: false };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  const p1 = made.find((x) => x.title.includes('Product 1'));
  assert.ok(s.task(p1.id).done_at);
  assert.ok(s.task(p1.id).notes.includes(DIFFERENCE_GONE));
  // 15 new the next day (two were made today: the cap is per day).
  s.hub.state.differences.items = Array.from({ length: 15 }, (_, i) => diff({ id: 100 + i, variance: -(3 + i) }));
  s.setNow(at('2026-10-13 09:00'));
  await s.svc.pullRound();
  const today = s.open("title LIKE 'Investigate%Product 1__%'");
  assert.equal(today.length, DAILY_CAPS.differences);
  assert.ok(today.every((x) => !/Product 10[0-4]\b/.test(x.title)), 'the smallest wait');
  s.clock.advance(24 * 60 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.open("title LIKE 'Investigate%Product 1__%'").length, 15);
});

test('differences: a limit raised in Stockroom doesn’t close what is still open — the task stays until it is investigated; no new tasks under the limit', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state.differences = { threshold_tins: 3, open: 1, truncated: false, items: [diff({ id: 1, variance: -5 })] };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const [task] = s.open("title LIKE 'Investigate%'");
  s.hub.state.differences = { threshold_tins: 10, open: 2, truncated: false, items: [diff({ id: 1, variance: -5 }), diff({ id: 2, variance: -6 })] };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.equal(s.task(task.id).done_at, null, 'still open in Stockroom: not “investigated”');
  assert.equal(s.tasks("title LIKE 'Investigate%'").length, 1, 'none made for a difference under the new limit');
  s.hub.state.differences = { threshold_tins: 10, open: 1, truncated: false, items: [diff({ id: 2, variance: -6 })] };
  s.clock.advance(61 * 60_000);
  await s.svc.pullRound();
  assert.ok(s.task(task.id).done_at);
  assert.ok(s.task(task.id).notes.includes(DIFFERENCE_GONE));
});

test('a forced round asked for while one runs is run after it — once, however many ask (Pull now, a new code)', async (t) => {
  const s = await setup(t);
  s.hub.delayMs.deliveries = 150;
  s.clock.advance(61 * 60_000);
  const before = s.hub.calls('order-soon');
  const first = s.svc.pullRound();
  const a = s.svc.pullRound({ force: true });
  const b = s.svc.pullRound({ force: true });
  assert.equal(a, b, 'coalesced');
  assert.notEqual(a, first);
  assert.equal(s.svc.pullRound(), first, 'a plain request shares the running round');
  assert.deepEqual((await first).got, ['deliveries', 'differences', 'counts']);
  assert.deepEqual((await a).got, ['deliveries', 'differences', 'counts', 'order-soon'], 'the forced round read everything');
  assert.equal(s.hub.calls('deliveries'), 3, 'connect + the first round + one forced round');
  assert.equal(s.hub.calls('order-soon'), before + 1);
});

test('the order-soon re-read after deliveries change survives a failure and its backoff; a new day alone isn’t a change', async (t) => {
  const s = await setup(t);
  const want = () => s.db.prepare("SELECT wanted FROM stockroom_pulls WHERE endpoint = 'order-soon'").get().wanted;
  // Only the calendar moved (today, overdue, counts): no re-read.
  s.hub.state.deliveries = { ...s.hub.state.deliveries, today: '2026-10-13', counts: { orders: 0, tins: 0, overdue: 1 } };
  s.clock.advance(61 * 60_000);
  const r0 = await s.svc.pullRound();
  assert.deepEqual([r0.got, r0.changed], [['deliveries', 'differences', 'counts'], []]);
  // An order confirmed while order-soon fails: kept wanted through the backoff.
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 1 })] };
  s.hub.fail['order-soon'] = { status: 503, times: 1 };
  s.clock.advance(61 * 60_000);
  const r1 = await s.svc.pullRound();
  assert.deepEqual([r1.changed, r1.failed], [['deliveries'], ['order-soon']]);
  assert.equal(want(), 1);
  assert.deepEqual((await s.svc.pullRound()).got, [], 'not before the backoff');
  s.clock.advance(2 * 60_000 + 1000);
  assert.deepEqual((await s.svc.pullRound()).got, ['order-soon'], 'read once the backoff is over');
  assert.equal(want(), 0);
  s.clock.advance(5 * 60_000);
  assert.deepEqual((await s.svc.pullRound()).got, []);
});

test('each task once: replays of an event, Run now, a restart and another pull make nothing twice', async (t) => {
  const config = testConfig(tmpDir(t), { STOCKROOM_TIMEOUT_MS: '300' });
  const clock = testClock();
  const s = await setup(t, { config, clock, connect: false });
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 5 })] };
  s.hub.state.differences = { threshold_tins: 3, open: 1, truncated: false, items: [diff({ id: 9 })] };
  s.hub.state['order-soon'] = { today: MONDAY, items: [item({ sku: 'ZYN-1' })] };
  s.hub.state.counts = { last_spot_check: null, spot_check_suggestions: [] };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  const count = () => s.tasks().filter((x) => x.created_by === 'system' && /^(Reorder|Weekly|Receive|Investigate)/.test(x.title)).length;
  assert.equal(count(), 4);
  for (const id of Object.values(AUTOMATION_IDS)) s.ctx.services.automations.runNow(id);
  s.ctx.services.automations.emit(PULLED_EVENT, { key: 'k1' });
  s.ctx.services.automations.emit(PULLED_EVENT, { key: 'k1' });
  await s.pull();
  assert.equal(count(), 4);
  await s.close();
  // A restart on the same database (and the same Stockroom).
  const s2 = await setup(t, { config, clock, start: null, hub: s.hub, connect: false });
  await s2.pull();
  for (const id of Object.values(AUTOMATION_IDS)) s2.ctx.services.automations.runNow(id);
  assert.equal(s2.tasks().filter((x) => x.created_by === 'system' && /^(Reorder|Weekly|Receive|Investigate)/.test(x.title)).length, 4);
});

test('restores: the connection is the current one (a key replaced after the backup doesn’t come back); tasks made after the backup are made again once', async (t) => {
  assert.ok(KEPT_TABLES.includes('stockroom_connection') && KEPT_TABLES.includes('stockroom_connection_changes'));
  assert.deepEqual(modules.find((m) => m.name === 'stockroom').keepOnRestore, ['stockroom_connection', 'stockroom_connection_changes']);
  const dir = tmpDir(t);
  const config = testConfig(dir, { STOCKROOM_TIMEOUT_MS: '300' });
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const clock = testClock();
  const first = await setup(t, { config, clock, connect: false });
  const hub = first.hub;
  // Another reader of the same fake Stockroom (a new secret made in Stockroom after the backup).
  const hub2 = await startFakeHub(t, { now: clock.now, secret: 'ef'.repeat(32) });
  hub.state.deliveries = { ...hub.state.deliveries, items: [po({ po_id: 1 })] };
  await first.call('PUT', '/api/stockroom/connection', { body: { code: hub.code } });
  await first.svc.pullRound();
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  hub2.state.deliveries = { ...hub.state.deliveries, items: [po({ po_id: 1 }), po({ po_id: 2, number: 'PO-0002' })] };
  await first.call('PUT', '/api/stockroom/connection', { body: { code: hub2.code } });
  await first.svc.pullRound();
  assert.equal(first.open("title LIKE 'Receive delivery%'").length, 2);
  await first.close();

  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const second = await setup(t, { config, clock, start: null, hub: hub2, connect: false });
  const conn = (await second.call('GET', '/api/stockroom/connection')).body;
  assert.equal(conn.hubUrl, hub2.url, 'the current connection, not the one at backup time');
  assert.equal(conn.readable, true);
  assert.equal(second.open("title LIKE 'Receive delivery%'").length, 1, 'rolled back with the database');
  await second.pull();
  assert.deepEqual(second.open("title LIKE 'Receive delivery%'").map((x) => x.title).sort(), [
    'Receive delivery PO-0001 from Swedish Match: 100 tins', 'Receive delivery PO-0002 from Swedish Match: 100 tins',
  ]);
  await second.pull();
  assert.equal(second.tasks("title LIKE 'Receive delivery%'").length, 2, 'once');
});

test('the suite only reads: every call it made to Stockroom in a full run was a GET with no body; no code path can send anything else', async (t) => {
  const s = await setup(t, { connect: false });
  s.hub.state.deliveries = { ...s.hub.state.deliveries, items: [po({ po_id: 1 })] };
  s.hub.state.differences = { threshold_tins: 3, open: 1, truncated: false, items: [diff({ id: 9 })] };
  s.hub.state['order-soon'] = { today: MONDAY, items: [item({ sku: 'ZYN-1' })] };
  await s.call('PUT', '/api/stockroom/connection', { body: { code: s.hub.code } });
  await s.svc.pullRound();
  // Finish things, change things, pull again for a few days, pause, resume, forget.
  const [d] = s.open("title LIKE 'Receive%'");
  s.edit(d.id, { done_at: new Date(s.clock.now()).toISOString() });
  s.hub.state.deliveries.items = [];
  s.hub.state.differences.items = [];
  for (let i = 0; i < 3; i += 1) {
    s.clock.advance(25 * 60 * 60_000);
    await s.svc.pullRound();
  }
  await s.call('POST', '/api/stockroom/pull', { body: {} });
  await s.call('PUT', '/api/connections/stockroom', { body: { paused: true } });
  await s.call('PUT', '/api/connections/stockroom', { body: { paused: false } });
  await s.svc.pullRound();
  await s.call('DELETE', '/api/stockroom/connection');
  assert.ok(s.hub.requests.length >= 15);
  for (const r of s.hub.requests) {
    assert.equal(r.method, 'GET', `${r.method} ${r.path}`);
    assert.equal(r.bodyLength, 0);
    assert.ok(r.path.startsWith('/v1/suite'), r.path);
    assert.ok(r.headers['x-sl-signature'] && r.headers['x-sl-reader'] === READER_KEY);
  }
  // In the code: the module's one network call is client.js's fetch, its method fixed to GET.
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/modules/stockroom');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  for (const [f, src] of sources) {
    const fetches = src.match(/\bfetch(Impl)?\s*\(/g) ?? [];
    assert.equal(fetches.length, f === 'client.js' ? 1 : 0, `${f}: network calls`);
    assert.ok(!/\b(http|https)\.request\b|node:http|undici/.test(src), `${f}: no other HTTP client`);
  }
  const client = sources.find(([f]) => f === 'client.js')[1];
  assert.match(client, /fetchImpl\(u\.toString\(\), \{ method: 'GET', headers, redirect: 'manual', signal: AbortSignal\.timeout\(timeoutMs\) \}\)/);
  assert.ok(!/body\s*:/.test(client.split('fetchImpl(u.toString()')[1].split('\n')[0]), 'no body');
});
