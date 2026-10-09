// The wholesale connection (D1): the signed receiver for the Order Manager's outbox (A10), the guard
// exemption limited to that one path, every event kind with the Order Manager's exact shapes,
// ordering, duplicates, refusals, backfill, held deletes, order.restored, spend, linking (held →
// linked → attached; unlink → detached; links made elsewhere), pause → 503 → catch-up, and the
// Done when: the same sample events replayed twice give one timeline entry each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { customerFigures, netOfTax } from '../src/modules/wholesale/figures.js';
import { eventProblem } from '../src/modules/wholesale/events.js';
import { decryptSecret, encryptSecret, loadKey } from '../src/modules/wholesale/secret.js';
import { tmpDir, testConfig, ensureTestUsers, sessionFor } from './helpers.js';
import { relationshipsToChase, reviewNumbers } from '../src/modules/planner/automations.js';
import { addDays } from '@suite/shared/planner';
import { localDate } from '@suite/shared/time';
import { womKit, postEvents, sampleStream, sign, EVENTS_PATH } from './fixtures/wom.js';

function capturingLog(lines = []) {
  const make = (tag) => {
    const out = (level) => (...args) => lines.push({ level, tag, text: args.map(String).join(' ') });
    return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error'), child: (sub) => make(`${tag}:${sub}`) };
  };
  return Object.assign(make('test'), { lines });
}

/** A suite with every module, both accounts, an owner session, and (unless secret: false) a shared secret made. */
async function setup(t, { config = testConfig(tmpDir(t)), secret = true } = {}) {
  const lines = [];
  const db = openDb(config.dbPath);
  const { app, ctx } = await createApp({ config, db, log: capturingLog(lines) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    server.close(() => { db.close(); resolve(); });
  });
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = await ensureTestUsers(ctx);
  const owner = sessionFor(ctx, users.owner);
  const call = async (method, url, body, { session = owner, headers = {}, origin = base } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(session ? { cookie: session.cookie } : {}),
        ...(origin ? { origin } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let shared = null;
  if (secret) shared = (await call('POST', '/api/wholesale/connection/secret', {})).body.secret;
  const post = (events, opts) => postEvents(base, shared, events, opts);
  const svc = ctx.services.wholesale;
  const local = (actor, entity, fields, op = 'create', recordId) => {
    const r = ctx.services.sync.applyLocal({ actor, entity, op, recordId, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
    return r.recordId;
  };
  /** A client with one account (the way people make them), → { clientId, accountId }. */
  const client = (name = 'Lefty’s', { age = false } = {}) => {
    const clientId = local('owner', 'client', { name, status: 'active' });
    const accountId = local('owner', 'account', { client_id: clientId, name, age_restricted: age });
    return { clientId, accountId };
  };
  const live = (table, where = '1 = 1', ...args) => db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND ${where}`).all(...args);
  return { config, db, ctx, base, users, owner, call, secret: shared, post, svc, local, client, live, lines, close };
}

const statuses = (res) => res.body.results.map((r) => r.status);
const errors = (lines) => lines.filter((l) => l.level === 'error');

// ---- signature --------------------------------------------------------------------------------

test('a signed request is applied; a wrong secret, an old or future timestamp, a missing header are refused (401)', async (t) => {
  const { post, secret, ctx, lines, base } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const good = await post([om.customerCreated(c)]);
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.results.map((r) => [r.key.length, r.status]), [[36, 'applied']]);

  const wrong = await post([om.customerCreated(om.customer())], { sigSecret: 'not-the-shared-secret-at-all' });
  assert.deepEqual([wrong.status, wrong.body.code], [401, 'bad_signature']);
  const now = Math.floor(Date.now() / 1000);
  const stale = await post([om.customerCreated(om.customer())], { ts: now - 301 });
  assert.deepEqual([stale.status, stale.body.code], [401, 'stale']);
  const future = await post([om.customerCreated(om.customer())], { ts: now + 301 });
  assert.deepEqual([future.status, future.body.code], [401, 'stale']);
  assert.equal((await post([om.customerCreated(om.customer())], { ts: now - 250 })).status, 200, 'inside the 5-minute window');
  const noSig = await post([], { signature: '' });
  assert.deepEqual([noSig.status, noSig.body.code], [401, 'no_signature']);
  const noTs = await post([], { ts: '' });
  assert.equal(noTs.status, 401);
  // The body is what is signed: one changed byte after signing is refused.
  const raw = JSON.stringify({ source: 'wom', events: [om.customerCreated(om.customer())] });
  const ts = Math.floor(Date.now() / 1000);
  const tampered = await postEvents(base, secret, [], { body: raw.replace('Corner', 'Korner'), signature: sign(secret, ts, 'POST', EVENTS_PATH, raw), ts });
  assert.equal(tampered.status, 401);
  // So is a signature made for another path (the path is part of what is signed).
  assert.equal((await post([om.customerCreated(om.customer())], { signPath: '/api/wom/other' })).status, 401);

  // The Connections row: last success, the last refusal with a count — never the secret.
  const row = ctx.services.connections.get('wom');
  assert.ok(row.lastSuccessAt);
  assert.match(row.lastError, /^Wrong signature: the shared secret doesn’t match/);
  assert.match(row.lastError, /\(4 refused since the last good request\)/, 'counted since the last good one (no signature, no timestamp, tampered, other path)');
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.ok(!lines.some((l) => l.text.includes(secret)), 'the secret is never logged');
});

test('replaying a captured request: its events answer duplicate (each key applies once)', async (t) => {
  const { secret, base, live, client, local } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]);
  const raw = JSON.stringify({ source: 'wom', events: [om.customerCreated(c), om.orderPlaced(o)] });
  const ts = Math.floor(Date.now() / 1000);
  const signature = sign(secret, ts, 'POST', EVENTS_PATH, raw);
  const first = await postEvents(base, secret, [], { body: raw, signature, ts });
  const again = await postEvents(base, secret, [], { body: raw, signature, ts });
  assert.deepEqual(statuses(first), ['applied', 'applied']);
  assert.deepEqual(statuses(again), ['duplicate', 'duplicate']);
  assert.equal(live('wholesale_orders').length, 1);
});

test('no secret yet → 401 not_set_up; the secret is shown once, stored encrypted, a new one replaces it', async (t) => {
  const { call, base, db, config, ctx } = await setup(t, { secret: false });
  const om = womKit();
  const none = await postEvents(base, 'whatever-secret-1234567', [om.customerCreated(om.customer())]);
  assert.deepEqual([none.status, none.body.code], [401, 'not_set_up']);
  assert.equal((await call('GET', '/api/wholesale/connection')).body.secret.set, false);

  const made = await call('POST', '/api/wholesale/connection/secret', {});
  assert.equal(made.status, 200);
  assert.match(made.body.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(made.body.connection.url, 'http://host.docker.internal:3100');
  assert.equal(made.body.connection.path, '/api/wom/events');
  // Never again over the API; in the database only encrypted, with the key outside it.
  const info = await call('GET', '/api/wholesale/connection');
  assert.ok(!JSON.stringify(info.body).includes(made.body.secret));
  assert.deepEqual([info.body.secret.set, info.body.secret.readable, info.body.secret.setBy], [true, true, 'owner']);
  const stored = db.prepare('SELECT secret_enc FROM wholesale_connection').get().secret_enc;
  assert.ok(!stored.includes(made.body.secret));
  assert.match(stored, /^v1:/);
  assert.ok(fs.existsSync(config.wholesale.keyFile));
  assert.equal(decryptSecret(loadKey(config.wholesale.keyFile, { create: false }), stored), made.body.secret);
  assert.equal(decryptSecret(Buffer.alloc(32, 7), stored), null, 'another machine’s key can’t read it');
  assert.equal((await postEvents(base, made.body.secret, [om.customerCreated(om.customer())])).status, 200);

  // Either person makes a new one: the old one stops working at once.
  const partner = sessionFor(ctx, (await ensureTestUsers(ctx)).partner);
  const second = await call('POST', '/api/wholesale/connection/secret', {}, { session: partner });
  assert.notEqual(second.body.secret, made.body.secret);
  assert.equal(second.body.secret.length, 43);
  assert.equal(second.body.connection.changes[0].actor, 'partner');
  assert.equal((await postEvents(base, made.body.secret, [om.customerCreated(om.customer())])).status, 401);
  assert.equal((await postEvents(base, second.body.secret, [om.customerCreated(om.customer())])).status, 200);
  assert.equal((await call('POST', '/api/wholesale/connection/secret', {}, { session: null })).status, 401, 'signed in only');
});

test('encryption round trip; a damaged value reads as no secret', () => {
  const key = Buffer.alloc(32, 1);
  const enc = encryptSecret(key, 'a-secret-value-123456');
  assert.equal(decryptSecret(key, enc), 'a-secret-value-123456');
  assert.equal(decryptSecret(key, `${enc.slice(0, -2)}xx`), null);
  assert.equal(decryptSecret(key, 'nonsense'), null);
});

// ---- the guard exemption ----------------------------------------------------------------------

test('only POST /api/wom/events skips the Origin/JSON guard; everything else is still guarded', async (t) => {
  const { post, call, base } = await setup(t);
  const om = womKit();
  // The receiver: no Origin, no session — and even a browser's cross-site headers don't matter (signed).
  const ok = await post([om.customerCreated(om.customer())], { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(ok.status, 200);
  // Unsigned there: refused by the signature check, not let through.
  const unsigned = await fetch(`${base}/api/wom/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"events":[]}' });
  assert.equal(unsigned.status, 401);

  const raw = (method, path, { body, headers = {} } = {}) => fetch(`${base}${path}`, { method, headers, body }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  // Another path or method under /api/wom: the guard as usual.
  for (const path of ['/api/wom/events/x', '/api/wom/other', '/api/wom']) {
    const r = await raw('POST', path, { body: '{}', headers: { 'content-type': 'application/json' } });
    assert.deepEqual([r.status, r.body?.code], [403, 'bad_origin'], path);
  }
  assert.equal((await raw('GET', '/api/wom/events')).status, 401, 'GET is not the receiver: unknown route, signed-out');
  assert.equal((await raw('PUT', '/api/wom/events', { body: '{}', headers: { 'content-type': 'application/json' } })).status, 403);
  // The suite's own writes keep every rule: Origin (with a valid session too), JSON only.
  const noOrigin = await call('POST', '/api/wholesale/connection/secret', {}, { origin: null });
  assert.deepEqual([noOrigin.status, noOrigin.body.code], [403, 'bad_origin']);
  const otherOrigin = await call('POST', '/api/wholesale/connection/secret', {}, { origin: 'http://evil.example' });
  assert.equal(otherOrigin.status, 403);
  const form = await call('POST', '/api/wholesale/connection/secret', 'a=b', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.deepEqual([form.status, form.body.code], [415, 'json_only']);
  for (const path of ['/api/auth/logout', '/api/crm/import/commit', '/api/sync/push', '/api/connections/wom']) {
    const r = await raw('POST', path, { body: '{}', headers: { 'content-type': 'application/json' } });
    assert.deepEqual([r.status, r.body?.code], [403, 'bad_origin'], path);
  }
});

test('a signed route must be an exact POST/PUT /api path', async (t) => {
  const config = testConfig(tmpDir(t));
  const db = openDb(config.dbPath);
  t.after(() => db.close());
  const bad = { name: 'badmod', signedRoutes: [{ method: 'GET', path: '/api/x', handlers: () => [] }] };
  await assert.rejects(createApp({ config, db, log: capturingLog(), modules: [...modules, bad] }), /signed route/);
});

// ---- events ----------------------------------------------------------------------------------

test('every event kind, in the Order Manager’s shapes: held, and shown for a linked customer', async (t) => {
  const { post, live, client, local, ctx } = await setup(t);
  const { events, customer, orders, money } = sampleStream();
  const { clientId, accountId } = client('Lefty’s');
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: customer.customer_uid, matched_by: 'approved' });
  const res = await post(events);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.key), events.map((e) => e.key), 'one answer per event, in the order sent');
  assert.ok(statuses(res).every((s) => s === 'applied'), JSON.stringify(res.body.results.filter((r) => r.status !== 'applied')));

  const os = live('wholesale_orders');
  assert.equal(os.length, 5);
  assert.ok(os.every((o) => o.account_id === accountId && o.client_id === clientId));
  const byUid = Object.fromEntries(os.map((o) => [o.order_uid, o]));
  const o1 = byUid[orders.o1.order_uid];
  assert.deepEqual(
    [o1.number, o1.order_date, o1.status, o1.goods_cents, o1.tax_cents, o1.total_cents, o1.paid_cents, o1.returned_cents, o1.item_count, o1.packing],
    [orders.o1.number, '2026-09-28', 'active', 10000, 1300, 11300, 11300, 791, 15, 'shipped'],
  );
  assert.equal(o1.items, '10 × Zyn Cool Mint 6mg, 5 × ALP Mango');
  assert.equal(byUid[orders.o2.order_uid].returned_cents, 1130, 'credit note with tax');
  assert.equal(byUid[orders.o3.order_uid].status, 'cancelled');
  assert.equal(byUid[orders.o4.order_uid].status, 'active', 'deleted then restored: live again');
  assert.equal(byUid[orders.o4.order_uid].paid_cents, 2373);
  assert.equal(byUid[orders.o5.order_uid].paid_cents, 500, 'store credit used on it counts as paid');

  const es = live('wholesale_entries');
  const kinds = Object.fromEntries(es.map((e) => [e.uid, e]));
  assert.equal(es.length, 8);
  assert.deepEqual([kinds[money.p1.payment_uid].kind, kinds[money.p1.payment_uid].amount_cents, kinds[money.p1.payment_uid].method], ['payment', 11300, 'etransfer']);
  assert.deepEqual([kinds[money.p4.payment_uid].status, kinds[money.p4.payment_uid].moved_to], ['live', null], 'restored with its order');
  assert.equal(kinds[money.r1.refund_uid].kind, 'refund');
  assert.equal(kinds[money.ret.return_uid].kind, 'return');
  assert.match(kinds[money.ret.return_uid].detail, /1 × ALP Mango \(damaged\) · Refunded · Damaged in transit/);
  assert.deepEqual([kinds[money.cn.credit_note_uid].kind, kinds[money.cn.credit_note_uid].number, kinds[money.cn.credit_note_uid].amount_cents], ['credit_note', 'CN-0001', 1130]);
  assert.equal(kinds[money.sc.refund_uid].kind, 'store_credit');
  assert.deepEqual([kinds[money.used.refund_uid].kind, kinds[money.used.refund_uid].amount_cents], ['credit_applied', -500]);

  const [card] = live('wholesale_customers');
  assert.deepEqual(
    [card.name, card.order_count, card.first_order_date, card.last_order_date, card.sales_cents, card.given_back_cents, card.spend_cents, card.paid_cents, card.credit_cents, card.gone],
    ['Lefty’s Vape Shop', 4, '2026-09-28', '2026-10-05', 14600, 2142, 12458, 13673, 1130, 0],
  );
  // The account is age-restricted and has an active wholesale relationship now.
  assert.equal(ctx.services.crm.liveAccount(accountId).age_restricted, true);
  const rels = ctx.services.crm.accountRelationships(accountId);
  assert.deepEqual(rels.map((r) => [r.business_id, r.kind, r.status, r.start_date]), [[BUSINESS_IDS.wholesale, 'wholesale', 'active', '2026-09-28']]);
  assert.equal(ctx.services.crm.getClient(clientId).client.name, 'Lefty’s', 'nothing else about the client changed');
});

test('the Done when: the same sample events replayed twice give one timeline entry each', async (t) => {
  const { post, live, client, local, db } = await setup(t);
  const { events, customer } = sampleStream();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: customer.customer_uid, matched_by: 'approved' });
  const first = await post(events);
  const steps = db.prepare('SELECT count(*) AS n FROM sync_steps').get().n;
  const second = await post(events);
  assert.ok(statuses(first).every((s) => s === 'applied'));
  assert.ok(statuses(second).every((s) => s === 'duplicate'), 'the replay is answered duplicate, event by event');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sync_steps').get().n, steps, 'and changes nothing');
  assert.equal(live('wholesale_orders').length, 5);
  assert.equal(live('wholesale_entries').length, 8);
  assert.equal(live('wholesale_customers').length, 1);
  // The Order Manager may also send creation events again with new keys (after a reconnect, a
  // restore, "Send existing…"): every event is an upsert by uid, so still one entry each.
  const resent = events.map((e) => ({ ...e, key: newId(), data: { ...e.data, backfill: true } }));
  assert.ok(statuses(await post(resent)).every((s) => s === 'applied'));
  assert.equal(live('wholesale_orders').length, 5);
  assert.equal(live('wholesale_entries').length, 8);
  assert.equal(live('wholesale_customers').length, 1);
  assert.equal(live('wholesale_customers')[0].spend_cents, 12458);
});

test('the Order Manager’s real events (captured from it by scripts/wom-e2e.mjs) replayed twice: one entry each', async (t) => {
  const { post, live, client, local } = await setup(t);
  const { events } = JSON.parse(fs.readFileSync(new URL('./fixtures/wom-captured-events.json', import.meta.url), 'utf8'));
  const customerUid = events.find((e) => e.name === 'customer.created').data.customer.customer_uid;
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: customerUid, matched_by: 'approved' });
  const orders = new Set(events.filter((e) => e.data.order?.order_uid).map((e) => e.data.order.order_uid));
  const money = new Set(events.flatMap((e) => [e.data.payment?.payment_uid, e.data.refund?.refund_uid, e.data.return?.return_uid, e.data.credit_note?.credit_note_uid]).filter(Boolean));
  assert.ok(statuses(await post(events)).every((x) => x === 'applied'));
  assert.ok(statuses(await post(events)).every((x) => x === 'duplicate'));
  assert.equal(live('wholesale_orders').length, orders.size);
  assert.equal(live('wholesale_entries').length, money.size);
  assert.deepEqual(live('wholesale_orders').map((o) => o.status).sort(), ['active', 'active', 'active', 'active', 'cancelled']);
  const [card] = live('wholesale_customers');
  assert.equal(card.name, 'Lefty’s Vape Shop');
  // The figures the cross-app run checked against the Order Manager's own: spend 133.50 then +5.00, 4 counting orders.
  assert.deepEqual([card.spend_cents, card.order_count], [13850, 4]);
});

test('events apply in the order received (not by time); a refused one doesn’t stop the rest', async (t) => {
  const { post, live, client, local } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 2, unit_price_cents: 500 }]);
  const changed = om.orderChanged({ ...o, lines: [{ ...o.lines[0], quantity: 3, subtotal_cents: 1500, total_cents: 1500 }], totals: { ...o.totals, subtotal_cents: 1500, tax_cents: 195, total_cents: 1695 } });
  changed.time = '2020-01-01T00:00:00.000Z'; // an old time: order of arrival still wins
  const broken = { ...om.orderPacked(o), version: 2 };
  const res = await post([om.customerCreated(c), om.orderPlaced(o), changed, broken, om.orderCancelled({ ...o, status: 'cancelled' })]);
  assert.deepEqual(statuses(res), ['applied', 'applied', 'applied', 'refused', 'applied']);
  assert.match(res.body.results[3].reason, /Version 2 of order.packed isn’t understood/);
  const [row] = live('wholesale_orders');
  assert.equal(row.status, 'cancelled', 'the last one applied wins');
  assert.equal(row.goods_cents, 1000, 'the cancel’s snapshot (latest arrival) wins over the earlier edit');
  // In one batch, a key twice: the second is a duplicate.
  const p = om.paymentRecorded(om.payment(o, 100));
  assert.deepEqual(statuses(await post([p, p])), ['applied', 'duplicate']);
});

test('malformed events are refused with a reason (never a 500); a bad body is 400', async (t) => {
  const { post, svc } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 100 }]);
  const cases = [
    [{ ...om.customerCreated(c), name: 'customer.merged' }, /Unknown event "customer.merged"/],
    [{ ...om.customerCreated(c), key: 'abc' }, /key must be a UUIDv7/],
    [{ ...om.customerCreated(c), source: 'pos' }, /source must be "wom"/],
    [{ ...om.customerCreated(c), time: 'yesterday' }, /time must be/],
    [{ ...om.customerCreated(c), data: null }, /data is missing/],
    [om.customerCreated({ ...c, customer_uid: 42 }), /customer_uid is not a permanent id/],
    [om.orderPlaced({ ...o, status: 'open' }), /status must be active or cancelled/],
    [om.orderPlaced({ ...o, totals: { ...o.totals, total_cents: 12.5 } }), /total_cents must be whole cents/],
    [om.orderPlaced({ ...o, order_date: '01/10/2026' }), /order_date must be YYYY-MM-DD/],
    [om.paymentRecorded({ ...om.payment(o, 5), amount_cents: '5.00' }), /amount_cents must be whole cents/],
    [om.refundIssued({ ...om.refund(o, 5), kind: 'cash' }), /kind must be refund, store_credit/],
    [om.creditNoteIssued({ ...om.creditNote(o, { subtotal_cents: 100, tax_cents: 13 }), credit_note_uid: 'CN-1' }), /credit_note_uid is not a permanent id/],
    [{ ...om.orderDeleted(o), data: { order_uid: o.order_uid, order: { ...o, order_uid: newId() } } }, /another order/],
    ['not an object', /Not an event object/],
  ];
  const res = await post(cases.map(([e]) => e));
  assert.equal(res.status, 200);
  res.body.results.forEach((r, i) => {
    assert.equal(r.status, 'refused', `case ${i}`);
    assert.match(r.reason, cases[i][1], `case ${i}`);
  });
  assert.equal(res.body.results[13].key, null);
  assert.equal(svc.status().refused_events, String(cases.length));
  // Refused keys aren't kept: the same event, fixed, applies.
  assert.deepEqual(statuses(await post([om.customerCreated(c)])), ['applied']);

  for (const body of ['not json', JSON.stringify({ events: [] }), JSON.stringify({ events: 'x' }), JSON.stringify([1]),
    JSON.stringify({ source: 'wom', events: Array.from({ length: 51 }, () => om.customerCreated(om.customer())) })]) {
    const r = await post([], { body });
    assert.equal(r.status, 400, body.slice(0, 40));
  }
  assert.equal(eventProblem({ ...om.customerCreated(c), version: '1' }) !== null, true);
});

test('backfill events (old times, backfill: true) apply in the order received', async (t) => {
  const { post, live, client, local, svc, db } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const old = om.order(c, [{ name: 'Old order', quantity: 1, unit_price_cents: 1000 }], { order_date: '2025-03-01', history_only: true, created_at: '2025-03-01T12:00:00.000Z' });
  // A change to an order the suite never heard of: its creation goes first, marked backfill, timed when made.
  const ahead = [
    { ...om.customerCreated(c, { backfill: true }), time: '2025-01-01T10:00:00.000Z' },
    { ...om.orderPlaced(old, { source: 'backfill', backfill: true }), time: old.created_at },
    om.orderPacked(old, { change: 'packed' }),
  ];
  assert.deepEqual(statuses(await post(ahead)), ['applied', 'applied', 'applied']);
  const [row] = live('wholesale_orders');
  assert.deepEqual([row.order_date, row.at, row.history_only], ['2025-03-01', '2025-03-01T12:00:00.000Z', 1]);
  assert.ok(svc.status().last_backfill_at);
  assert.equal(db.prepare('SELECT backfill FROM wholesale_events ORDER BY received_at, key').all().filter((e) => e.backfill).length, 2);

  assert.doesNotMatch(svc.describe().detail, /restored|Forget everything/, 'no resend is ever asked for (the holding area survives restores)');
});

test('held deletes arriving later: gone marks the order deleted (kept on the timeline); a creation brings it back', async (t) => {
  const { post, live, client, local } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 4, unit_price_cents: 500 }]); // 2000 + 260
  const p = om.payment(o, 2260);
  const r = om.refund(o, 1130);
  await post([om.customerCreated(c), om.orderPlaced(o), om.paymentRecorded(p), om.refundIssued(r)]);
  assert.equal(live('wholesale_customers')[0].spend_cents, 1000);

  // Days later (the Order Manager's admin pressed "Send deletes" after an import): cut-down snapshots.
  const gone = [
    om.paymentRemoved({ payment_uid: p.payment_uid, number: p.number, customer_uid: c.customer_uid, order_uid: o.order_uid }, { reason: 'gone_after_restore' }),
    om.refundGone(r),
    om.orderGone(o, 'gone_after_restore'),
    { ...om.customerDeleted({ customer_uid: c.customer_uid, number: c.number }), data: { by: null, change: 'deleted', deleted: true, reason: 'gone_after_restore', customer: { customer_uid: c.customer_uid, number: c.number } } },
  ];
  assert.deepEqual(statuses(await post(gone)), ['applied', 'applied', 'applied', 'applied']);
  const [order] = live('wholesale_orders');
  assert.equal(order.status, 'deleted', 'the timeline keeps it, marked deleted');
  assert.equal(order.total_cents, 2260, 'with what it was');
  const entries = live('wholesale_entries');
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.status === 'removed'));
  assert.equal(entries.find((e) => e.kind === 'payment').amount_cents, 2260, 'the full snapshot kept');
  const [card] = live('wholesale_customers');
  assert.deepEqual([card.gone, card.name, card.spend_cents, card.order_count, card.paid_cents], [1, 'Corner Store', 0, 0, 0]);

  // The right backup imported there: the records come back as creations.
  assert.deepEqual(statuses(await post([om.customerCreated(c, { backfill: true }), om.orderPlaced(o, { backfill: true }), om.paymentRecorded(p, { backfill: true })])), ['applied', 'applied', 'applied']);
  assert.equal(live('wholesale_orders')[0].status, 'active');
  assert.equal(live('wholesale_entries').find((e) => e.kind === 'payment').status, 'live');
  assert.deepEqual([live('wholesale_customers')[0].gone, live('wholesale_orders').length], [0, 1]);
});

test('order.restored is a creation event: no order.placed needed ahead of it', async (t) => {
  const { post, live, client, local } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 800 }]);
  // Deleted while the suite was told nothing about it, then restored: the restore is the first event.
  assert.deepEqual(statuses(await post([om.customerCreated(c), om.orderRestored(o)])), ['applied', 'applied']);
  assert.deepEqual(live('wholesale_orders').map((r) => [r.order_uid, r.status]), [[o.order_uid, 'active']]);
  // A deleted one comes back live with order.restored.
  await post([om.orderDeleted(o)]);
  assert.equal(live('wholesale_orders')[0].status, 'deleted');
  await post([om.orderRestored(o)]);
  assert.equal(live('wholesale_orders')[0].status, 'active');
  assert.equal(live('wholesale_customers')[0].order_count, 1);
});

// ---- spend ----------------------------------------------------------------------------------

test('spend: net of refunds and credit notes before tax; returns, credit notes and moved_to store credit', async (t) => {
  const { post, live, client, local } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const card = () => live('wholesale_customers')[0];
  const a = om.order(c, [{ name: 'A', quantity: 10, unit_price_cents: 1000 }], { order_date: '2026-10-01' }); // 10000 + 1300
  const pa = om.payment(a, 11300);
  await post([om.customerCreated(c), om.orderPlaced(a), om.paymentRecorded(pa)]);
  assert.deepEqual([card().sales_cents, card().spend_cents, card().paid_cents, card().credit_cents], [10000, 10000, 11300, 0]);

  // A full return refunded with tax nets to 0, not −13 % (no tax double counting).
  const ret = om.return(a, [{ name: 'A', quantity: 10, restocked: true }], { outcome: 'refund', amount_cents: 11300 });
  await post([om.returnReceived(ret), om.refundIssued(om.refund(a, 11300, { return_uid: ret.return_uid }))]);
  assert.deepEqual([card().given_back_cents, card().spend_cents], [10000, 0]);
  assert.equal(netOfTax(1130, { goods_cents: 10000, tax_cents: 1300 }), 1000);

  // A credit note counts its own subtotal (before tax and shipping), and is credit held with tax.
  const b = om.order(c, [{ name: 'B', quantity: 5, unit_price_cents: 1000 }], { order_date: '2026-10-02', shipping_cents: 1500 }); // 5000 goods
  const cn = om.creditNote(b, { subtotal_cents: 2000, tax_cents: 260, shipping_cents: 500 });
  await post([om.orderPlaced(b), om.returnReceived(om.return(b, [{ name: 'B', quantity: 2, restocked: true }], { outcome: 'credit_note', amount_cents: 2760, credit_note_uid: cn.credit_note_uid })), om.creditNoteIssued(cn)]);
  assert.deepEqual([card().sales_cents, card().given_back_cents, card().spend_cents, card().credit_cents], [15000, 12000, 3000, 2760]);

  // A7: a paid order deleted with its payment kept as store credit: its sale drops out, the money is credit.
  const d = om.order(c, [{ name: 'D', quantity: 1, unit_price_cents: 4000 }], { order_date: '2026-10-03' }); // 4000 + 520
  const pd = om.payment(d, 4520);
  await post([om.orderPlaced(d), om.paymentRecorded(pd)]);
  assert.deepEqual([card().spend_cents, card().paid_cents], [7000, 15820]);
  await post([om.paymentRemoved(pd, { reason: 'order_deleted', moved_to: 'store_credit' }), om.orderDeleted(d)]);
  assert.deepEqual([card().spend_cents, card().paid_cents, card().credit_cents, card().order_count], [3000, 11300, 2760 + 4520, 2]);
  const moved = live('wholesale_entries').find((e) => e.uid === pd.payment_uid);
  assert.deepEqual([moved.status, moved.moved_to, moved.removed_reason], ['removed', 'store_credit', 'order_deleted']);
  // Credit used on a new order: it counts as paid on that order and comes off the credit; spend counts the new sale once.
  const e = om.order(c, [{ name: 'E', quantity: 1, unit_price_cents: 4000 }], { order_date: '2026-10-04' });
  await post([om.orderPlaced(e), om.refundIssued(om.refund(e, -4520, { kind: 'store_credit_applied' }))]);
  assert.deepEqual([card().spend_cents, card().credit_cents, card().last_order_date], [7000, 2760, '2026-10-04']);
  assert.equal(live('wholesale_orders').find((o) => o.order_uid === e.order_uid).paid_cents, 4520);
  // Refunds on a cancelled order drop out with its sale.
  const f = om.order(c, [{ name: 'F', quantity: 1, unit_price_cents: 1000 }], { order_date: '2026-10-05' });
  await post([om.orderPlaced(f), om.refundIssued(om.refund(f, 565)), om.orderCancelled({ ...f, status: 'cancelled' })]);
  assert.deepEqual([card().spend_cents, card().order_count, card().last_order_date], [7000, 3, '2026-10-04']);
});

test('customerFigures on its own: what counts', () => {
  const f = customerFigures(
    [
      { uid: 'a', status: 'active', deleted: 0, goods_cents: 1000, tax_cents: 130, order_date: '2026-01-02', has_snapshot: 1 },
      { uid: 'b', status: 'cancelled', deleted: 0, goods_cents: 500, tax_cents: 65, order_date: '2026-03-01', has_snapshot: 1 },
      { uid: 'c', status: 'active', deleted: 1, goods_cents: 700, tax_cents: 91, order_date: '2026-04-01', has_snapshot: 1 },
      { uid: 'd', status: 'active', deleted: 0, goods_cents: 0, tax_cents: 0, order_date: null, has_snapshot: 0 },
    ],
    [
      { kind: 'refund', sub_kind: 'refund', amount_cents: 565, removed: 0, order_uid: 'a' },
      { kind: 'refund', sub_kind: 'refund', amount_cents: 565, removed: 0, order_uid: 'b' },
      { kind: 'refund', sub_kind: 'refund', amount_cents: 100, removed: 1, order_uid: 'a' },
      { kind: 'payment', amount_cents: 1130, removed: 0 },
      { kind: 'return', amount_cents: 565, removed: 0, order_uid: 'a' },
    ],
  );
  assert.deepEqual(f, {
    order_count: 1, first_order_date: '2026-01-02', last_order_date: '2026-01-02', sales_cents: 1000, given_back_cents: 500,
    spend_cents: 500, paid_cents: 1130, credit_cents: 0,
  });
});

// ---- linking ---------------------------------------------------------------------------------

test('unlinked → held and listed as waiting → linked → everything attached; unlink → detached; link again → back', async (t) => {
  const { post, call, live, client, ctx, db } = await setup(t);
  const { events, customer } = sampleStream();
  await post(events);
  assert.equal(live('wholesale_orders').length, 0, 'nothing on devices while unlinked');
  const waiting = await call('GET', '/api/wholesale/waiting');
  assert.equal(waiting.status, 200);
  assert.deepEqual(waiting.body.customers.map((c) => [c.uid, c.businessName, c.orders, c.lastOrderDate, c.spendCents, c.email]),
    [[customer.customer_uid, 'Lefty’s Vape Shop', 4, '2026-10-05', 12458, 'lefty@leftys.ca']]);
  assert.deepEqual(waiting.body.counts, { customers: 1, orders: 5, money: 8, notes: 0, linked: 0, problems: 0 });
  const row = ctx.services.connections.get('wom');
  assert.deepEqual([row.queueSize, row.queueLabel], [13, '13 records from 1 customer waiting for a client']);
  assert.equal((await call('GET', '/api/wholesale/waiting?q=lefty')).body.total, 1);
  assert.equal((await call('GET', '/api/wholesale/waiting?q=555-0199')).body.total, 1, 'a phone typed another way');
  assert.equal((await call('GET', '/api/wholesale/waiting?q=nobody')).body.total, 0);

  // Link it to an existing client's account that is already age-restricted with a wholesale relationship.
  const { clientId, accountId } = client('Lefty’s Group', { age: true });
  ctx.services.sync.applyLocal({ actor: 'partner', entity: 'relationship', op: 'create', fields: { account_id: accountId, business_id: BUSINESS_IDS.wholesale, kind: 'wholesale', status: 'paused' } });
  const steps = db.prepare("SELECT count(*) AS n FROM sync_steps WHERE entity IN ('account', 'relationship')").get().n;
  const linked = await call('POST', `/api/wholesale/customers/${customer.customer_uid}/link`, { clientId, accountId });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.deepEqual([linked.body.customer.accountId, linked.body.customer.clientName], [accountId, 'Lefty’s Group']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sync_steps WHERE entity IN ('account', 'relationship')").get().n, steps, 'nothing set that was set already (a paused relationship stays paused)');
  const link = ctx.services.crm.liveLinks('wom', customer.customer_uid);
  assert.deepEqual(link.map((l) => [l.account_id, l.matched_by, l.created_by]), [[accountId, 'approved', 'owner']]);
  assert.equal(live('wholesale_orders').length, 5);
  assert.equal(live('wholesale_entries').length, 8);
  assert.equal(live('wholesale_customers')[0].spend_cents, 12458);
  assert.equal((await call('GET', '/api/wholesale/waiting')).body.total, 0);
  assert.equal((await call('GET', '/api/wholesale/linked')).body.customers[0].accountName, 'Lefty’s Group');
  assert.equal(ctx.services.connections.get('wom').queueSize, 0);
  assert.equal((await call('POST', `/api/wholesale/customers/${customer.customer_uid}/link`, { clientId, accountId })).status, 409, 'already linked');

  // Unlink: its records leave the devices; nothing held is lost.
  const ids = live('wholesale_orders').map((o) => o.id);
  const un = await call('POST', `/api/wholesale/customers/${customer.customer_uid}/unlink`, {});
  assert.equal(un.status, 200);
  assert.equal(live('wholesale_orders').length + live('wholesale_entries').length + live('wholesale_customers').length, 0);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM wholesale_orders WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NOT NULL`).get(JSON.stringify(ids)).n, 5, 'detached = soft-deleted');
  assert.equal((await call('GET', '/api/wholesale/waiting')).body.total, 1);
  assert.equal(ctx.services.crm.liveAccount(accountId).age_restricted, true, 'the account keeps its mark');

  // Link again (here to a new account under another client): everything comes back.
  const other = client('Someone else').clientId;
  const again = await call('POST', `/api/wholesale/customers/${customer.customer_uid}/link`, { clientId: other });
  assert.equal(again.status, 200);
  assert.equal(again.body.customer.accountName, 'Lefty’s Vape Shop', 'a new account named after the customer');
  assert.equal(live('wholesale_orders').length, 5);
  assert.ok(live('wholesale_orders').every((o) => o.client_id === other));
  const acct = ctx.services.crm.liveAccount(again.body.customer.accountId);
  assert.deepEqual([acct.age_restricted, acct.city, acct.postal_code], [true, 'Simcoe', 'N3Y 4K3']);
  assert.equal(ctx.services.crm.accountRelationships(acct.id)[0].status, 'active');

  // Bad requests.
  assert.equal((await call('POST', `/api/wholesale/customers/${newId()}/link`, { clientId })).status, 404);
  assert.equal((await call('POST', '/api/wholesale/customers/nope/unlink', {})).status, 404);
  const third = client('Third');
  const un2 = await call('POST', `/api/wholesale/customers/${customer.customer_uid}/unlink`, {});
  assert.equal(un2.status, 200);
  assert.equal((await call('POST', `/api/wholesale/customers/${customer.customer_uid}/link`, { clientId: third.clientId, accountId })).body.code, 'no_account', 'an account of another client');
  assert.equal((await call('POST', `/api/wholesale/customers/${customer.customer_uid}/link`, { clientId: newId() })).body.code, 'no_client');
});

test('create a client from a waiting customer: client, account, contact, relationship, link — then attached', async (t) => {
  const { post, call, live, ctx } = await setup(t);
  const om = womKit();
  const c = om.customer({ business_name: 'Brantford Vape', contact_name: 'Amy Baker', email: 'amy@bvape.ca', phone: '5195551234', contact_problems: [], address: { line1: '1 King St', line2: 'Unit 4', city: 'Brantford', province: 'ON', postal_code: 'n3t1a1', country: 'Canada' } });
  const bad = om.customer({ business_name: 'No Clean Phone', email: null, phone: null, contact_problems: [{ field: 'phone', as_typed: '555-0100' }] });
  await post([om.customerCreated(c), om.orderPlaced(om.order(c, [{ name: 'Zyn', quantity: 2, unit_price_cents: 650 }])), om.customerCreated(bad)]);
  const made = await call('POST', `/api/wholesale/customers/${c.customer_uid}/create-client`, {});
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const page = ctx.services.crm.getClient(made.body.customer.clientId);
  assert.equal(page.client.name, 'Brantford Vape');
  assert.deepEqual([page.accounts[0].street, page.accounts[0].postal_code, page.accounts[0].age_restricted], ['1 King St, Unit 4', 'N3T 1A1', true]);
  assert.deepEqual(page.accounts[0].relationships.map((r) => [r.kind, r.status]), [['wholesale', 'active']]);
  assert.deepEqual(page.contacts.map((p) => [p.name, p.email, p.phone, p.account_id]), [['Amy Baker', 'amy@bvape.ca', '5195551234', page.accounts[0].id]]);
  assert.deepEqual(page.accounts[0].links.map((l) => [l.app, l.external_id, l.matched_by]), [['wom', c.customer_uid, 'approved']]);
  assert.equal(live('wholesale_orders').length, 1);
  assert.equal((await call('POST', `/api/wholesale/customers/${c.customer_uid}/create-client`, {})).status, 409);
  // A phone the Order Manager couldn't clean goes into the account's notes, never matched on.
  const second = await call('POST', `/api/wholesale/customers/${bad.customer_uid}/create-client`, {});
  const p2 = ctx.services.crm.getClient(second.body.customer.clientId);
  assert.match(p2.accounts[0].notes, /Phone as typed in the Order Manager: 555-0100/);
  assert.deepEqual(p2.contacts.map((p) => p.phone), ['No Clean Phone'].map(() => null));
});

test('a link made elsewhere (D2, a device) is picked up by reconcile; undoing it detaches; two links are never picked silently', async (t) => {
  const { post, svc, live, client, local, ctx, call } = await setup(t);
  const om = womKit();
  const c = om.customer();
  await post([om.customerCreated(c), om.orderPlaced(om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]))]);
  const a = client('A');
  const linkId = local('partner', 'link', { account_id: a.accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'auto' });
  assert.equal(live('wholesale_orders').length, 0, 'not until reconcile looks');
  assert.deepEqual(svc.reconcile(), { changed: 1 });
  assert.equal(live('wholesale_orders').length, 1);
  assert.deepEqual(svc.reconcile(), { changed: 0 }, 'nothing to do the second time');
  assert.equal(ctx.services.crm.liveAccount(a.accountId).age_restricted, true);
  assert.equal(ctx.services.crm.accountRelationships(a.accountId).length, 1, 'made by the system');

  // The account moves to another client (D2 merge): its records follow.
  const b = client('B');
  local('owner', 'account', { client_id: b.clientId }, 'update', a.accountId);
  svc.reconcile();
  assert.deepEqual(live('wholesale_orders').map((o) => o.client_id), [b.clientId]);

  // A second live account link for the same customer (the CRM refuses one; a deleted link can come back
  // through a clash): detached and flagged, never one picked.
  const other = client('Other');
  const crmSvc = ctx.services.crm;
  const realLinks = crmSvc.liveAccountLinks;
  crmSvc.liveAccountLinks = (app) => [...realLinks(app), { id: newId(), external_id: c.customer_uid, account_id: other.accountId, client_id: other.clientId }];
  svc.reconcile();
  assert.equal(live('wholesale_orders').length, 0);
  const w = (await call('GET', '/api/wholesale/waiting')).body;
  assert.deepEqual([w.customers[0].linkProblem, w.counts.problems], ['several_links', 1]);
  assert.match(ctx.services.connections.get('wom').detail, /linked to more than one account/);

  // Undo the first (as D2's undo would): attached to the one left.
  crmSvc.liveAccountLinks = realLinks;
  local('owner', 'link', undefined, 'delete', linkId);
  local('owner', 'link', { account_id: other.accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'auto' });
  svc.reconcile();
  assert.deepEqual(live('wholesale_orders').map((o) => [o.account_id, o.client_id]), [[other.accountId, other.clientId]]);

  // The account deleted: the link isn't live, so the records are detached (and hidden with it anyway).
  local('owner', 'account', undefined, 'delete', other.accountId);
  svc.reconcile();
  assert.equal(live('wholesale_orders').length, 0);
  assert.equal(errors([]).length, 0);
});

test('devices can’t create, change or delete Order Manager records', async (t) => {
  const { post, client, local, ctx, base, live } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId, clientId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  await post([om.customerCreated(c), om.orderPlaced(om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]))]);
  const order = live('wholesale_orders')[0];
  const dev = sessionFor(ctx, (await ensureTestUsers(ctx)).owner);
  const { createHlc } = await import('@suite/shared/hlc');
  const clock = createHlc(dev.deviceId);
  const step = (op, entity, recordId, fields) => ({ key: newId(), entity, recordId, op, hlc: clock.now(), ...(fields ? { fields } : {}) });
  const res = await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: { cookie: dev.cookie, origin: base, 'content-type': 'application/json', 'x-suite-device': dev.deviceId },
    body: JSON.stringify({ steps: [
      step('create', 'wholesale_order', newId(), { account_id: accountId, client_id: clientId, customer_uid: c.customer_uid, order_uid: newId(), at: new Date().toISOString(), status: 'active' }),
      step('update', 'wholesale_order', order.id, { total_cents: 1 }),
      step('delete', 'wholesale_order', order.id),
      step('create', 'wholesale_entry', newId(), { account_id: accountId, client_id: clientId, customer_uid: c.customer_uid, uid: newId(), kind: 'payment', at: new Date().toISOString(), status: 'live' }),
    ] }),
  }).then((r) => r.json());
  assert.deepEqual(res.results.map((r) => [r.status, r.code]), Array(4).fill(['rejected', 'op_not_allowed']), JSON.stringify(res));
  assert.equal(live('wholesale_orders')[0].total_cents, order.total_cents);
});

// ---- pause and restore ------------------------------------------------------------------------

test('paused → 503 with nothing applied or logged as a failure; on again → the Order Manager catches up in order', async (t) => {
  const { post, call, svc, live, client, local, lines } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  await post([om.customerCreated(c)]);
  const before = svc.describe();
  assert.equal((await call('PUT', '/api/connections/wom', { paused: true })).body.connection.state, 'paused');
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]);
  const queued = [om.orderPlaced(o), om.paymentRecorded(om.payment(o, 565))];
  const r = await post(queued);
  assert.deepEqual([r.status, r.body.code], [503, 'paused']);
  // Even a request with a wrong signature isn't looked at (or counted) while paused.
  assert.equal((await post(queued, { sigSecret: 'wrong-wrong-wrong-wrong' })).status, 503);
  assert.equal(live('wholesale_orders').length, 0);
  const during = svc.describe();
  assert.deepEqual([during.lastError, during.lastErrorAt, during.lastSuccessAt], [before.lastError, before.lastErrorAt, before.lastSuccessAt]);
  assert.equal(errors(lines).length, 0);
  assert.equal(lines.filter((l) => l.level === 'warn' && l.tag.includes('wholesale')).length, 0);

  assert.equal((await call('PUT', '/api/connections/wom', { paused: false })).body.connection.state, 'on');
  // The Order Manager's next try sends the same events (same keys), in order.
  assert.deepEqual(statuses(await post(queued)), ['applied', 'applied']);
  assert.equal(live('wholesale_orders')[0].paid_cents, 565);
});

test('a restore keeps the current shared secret (and drops nothing it shouldn’t)', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(`${config.backup.offsiteDir}/.suite-backup-target`, '');
  const first = await setup(t, { config });
  const om = womKit();
  await first.post([om.customerCreated(om.customer())]);
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  const newer = (await first.call('POST', '/api/wholesale/connection/secret', {})).body.secret;
  await first.close();
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const again = await setup(t, { config, secret: false });
  assert.equal((await postEvents(again.base, newer, [om.customerCreated(om.customer())])).status, 200, 'the newer secret still works');
  assert.equal((await postEvents(again.base, first.secret, [om.customerCreated(om.customer())])).status, 401, 'the replaced one stays replaced');
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM wholesale_connection_changes').get().n, 2);
});

test('emits each applied event for automations (D3), with the customer’s account when linked', async (t) => {
  const { post, client, local, ctx } = await setup(t);
  const seen = [];
  ctx.services.automations.register({
    id: 'test-order-placed', name: 'Test', description: 'test', module: 'wholesale',
    trigger: { type: 'event', event: 'order.placed', key: (d) => d.orderUid },
    defaults: { enabled: true, alert: false },
    run(_c, { data }) { seen.push(data); return { summary: 'ok' }; },
  });
  const om = womKit();
  const c = om.customer();
  const { accountId, clientId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]);
  const placed = om.orderPlaced(o);
  await post([om.customerCreated(c), placed]);
  await post([placed]); // a duplicate emits nothing
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].key, seen[0].orderUid, seen[0].customerUid, seen[0].accountId, seen[0].clientId, seen[0].linked, seen[0].backfill],
    [placed.key, o.order_uid, c.customer_uid, accountId, clientId, true, false]);
});

// ---- review fixes ------------------------------------------------------------------------------

test('restore: orders and payments deleted after the backup stay deleted; records re-adopted by uid, nothing doubled or resent', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(`${config.backup.offsiteDir}/.suite-backup-target`, '');
  const first = await setup(t, { config });
  const om = womKit();
  const c = om.customer();
  const { accountId } = first.client();
  first.local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 2, unit_price_cents: 1000 }]);
  const p = om.payment(o, 2260);
  const o2 = om.order(c, [{ name: 'Alp', quantity: 1, unit_price_cents: 1000 }]);
  const p2 = om.payment(o2, 1130);
  assert.ok(statuses(await first.post([om.customerCreated(c), om.orderPlaced(o), om.paymentRecorded(p), om.orderPlaced(o2), om.paymentRecorded(p2)])).every((x) => x === 'applied'));
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });

  // After the backup: the paid order deleted (its payment kept as store credit), a payment deleted by
  // hand, a new order — and the customer unlinked and linked again (new record ids).
  const o3 = om.order(c, [{ name: 'Velo', quantity: 1, unit_price_cents: 500 }]);
  const after = [om.paymentRemoved(p, { reason: 'order_deleted', moved_to: 'store_credit' }), om.orderDeleted(o), om.paymentRemoved(p2), om.orderPlaced(o3)];
  assert.ok(statuses(await first.post(after)).every((x) => x === 'applied'));
  assert.equal((await first.call('POST', `/api/wholesale/customers/${c.customer_uid}/unlink`, {})).status, 200);
  assert.equal((await first.call('POST', `/api/wholesale/customers/${c.customer_uid}/link`, { clientId: first.ctx.services.crm.liveAccount(accountId).client_id, accountId })).status, 200);
  const view = (env) => ({
    orders: env.live('wholesale_orders').map((r) => [r.order_uid, r.status]).sort(),
    entries: env.live('wholesale_entries').map((r) => [r.uid, r.status, r.moved_to]).sort(),
    card: env.live('wholesale_customers').map((r) => [r.spend_cents, r.paid_cents, r.credit_cents, r.order_count]),
  });
  const want = view(first);
  assert.deepEqual(want.orders.map((x) => x[1]).sort(), ['active', 'active', 'deleted']);
  await first.close();

  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const again = await setup(t, { config, secret: false });
  await again.svc.reconcileAll();
  assert.deepEqual(view(again), want, 'as the Order Manager last said — the deleted order and payments stay deleted');
  for (const table of ['wholesale_orders', 'wholesale_entries', 'wholesale_customers']) {
    const field = { wholesale_orders: 'order_uid', wholesale_entries: 'uid', wholesale_customers: 'customer_uid' }[table];
    assert.equal(again.db.prepare(`SELECT count(*) AS n FROM (SELECT ${field} FROM ${table} WHERE deleted_at IS NULL GROUP BY ${field} HAVING count(*) > 1)`).get().n, 0, `no doubles in ${table}`);
  }
  // The Order Manager resending what it already delivered changes nothing; the secret still works.
  assert.ok(statuses(await postEvents(again.base, first.secret, after)).every((x) => x === 'duplicate'));
  assert.doesNotMatch(again.svc.describe().detail, /restored|Forget everything/);
});

test('extras naming the same uid are removed, and a lost record id is found again by uid', async (t) => {
  const { post, live, client, local, svc, db, ctx } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId, clientId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]);
  await post([om.customerCreated(c), om.orderPlaced(o)]);
  const [kept] = live('wholesale_orders');
  ctx.services.sync.applyLocal({ entity: 'wholesale_order', op: 'create', fields: { account_id: accountId, client_id: clientId, customer_uid: c.customer_uid, order_uid: o.order_uid, at: kept.at, status: 'active' } });
  db.prepare('UPDATE wholesale_held_orders SET dirty = 1, record_id = NULL').run();
  svc.project();
  assert.deepEqual(live('wholesale_orders').map((r) => r.id), [kept.id], 'the oldest kept, the extra deleted');
  assert.equal(db.prepare('SELECT record_id FROM wholesale_held_orders').get().record_id, kept.id);
});

test('spend: a return refunded with shipping uses the return’s own subtotal; older returns fall back to the proportion', async (t) => {
  const { post, live, client, local } = await setup(t);
  const om = womKit();
  const spendOf = (uid) => live('wholesale_customers').find((x) => x.customer_uid === uid).spend_cents;
  const run = async (withFields, outcome) => {
    const c = om.customer();
    const { accountId } = client(`C ${withFields} ${outcome}`);
    local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
    // 2 × $25 + 13 % + $15 shipping = $71.50; one returned, shipping refunded too: $25 + $3.25 + $15 = $43.25.
    const o = om.order(c, [{ name: 'Kit', quantity: 2, unit_price_cents: 2500 }], { shipping_cents: 1500 });
    const ret = om.return(o, [{ name: 'Kit', quantity: 1, restocked: true }], { outcome, amount_cents: 4325 });
    if (withFields) Object.assign(ret, { subtotal_cents: 2500, tax_cents: 325, shipping_cents: 1500 });
    const money = outcome === 'refund'
      ? om.refundIssued(om.refund(o, 4325, { return_uid: ret.return_uid }))
      : om.creditNoteIssued(om.creditNote(o, { subtotal_cents: 2500, tax_cents: 325, shipping_cents: 1500, return_uid: ret.return_uid }));
    assert.ok(statuses(await post([om.customerCreated(c), om.orderPlaced(o), om.returnReceived(ret), money])).every((x) => x === 'applied'));
    return spendOf(c.customer_uid);
  };
  assert.equal(await run(true, 'refund'), 2500, 'the Order Manager’s own figure: $50 − $25');
  assert.equal(await run(false, 'refund'), 5000 - Math.round((4325 * 5000) / 5650), 'an older return: the proportion');
  assert.equal(await run(true, 'credit_note'), 2500);
  assert.equal(await run(false, 'credit_note'), 2500, 'a credit note always had its own subtotal');
});

test('an unexpected error while applying answers only the events before it (they are sent again), never refused', async (t) => {
  const { post, live, client, local, db, svc } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = client();
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  await post([om.customerCreated(om.customer())]);
  const okAt = svc.describe().lastSuccessAt;
  await new Promise((r) => setTimeout(r, 5));
  const o = om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }]);
  const events = [om.customerCreated(c), om.orderPlaced(o), om.paymentRecorded(om.payment(o, 565))];
  db.exec(`CREATE TEMP TRIGGER wholesale_test_busy BEFORE INSERT ON main.wholesale_held_orders WHEN NEW.uid = '${o.order_uid}'
    BEGIN SELECT RAISE(ABORT, 'database is locked (simulated)'); END`);
  const res = await post(events);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => [r.key, r.status]), [[events[0].key, 'applied']], 'a prefix: the rest come again');
  // Not a success: the row shows the error; tried again and failing again on the same event → "stuck since".
  const first = svc.describe();
  assert.equal(first.lastSuccessAt, okAt, 'last success is the earlier good request, not this one');
  assert.ok(first.lastError.startsWith(`Couldn’t apply event order.placed (${events[1].key})`), first.lastError);
  assert.match(first.lastError, /database is locked \(simulated\)/);
  assert.doesNotMatch(first.detail, /Stuck since/);
  const again = await post(events);
  assert.deepEqual(again.body.results.map((r) => r.status), ['duplicate'], 'an empty-handed answer for the stuck event');
  const second = svc.describe();
  assert.equal(second.lastSuccessAt, okAt);
  assert.match(second.detail, /Stuck since .*failed 2 times/);
  db.exec('DROP TRIGGER wholesale_test_busy');
  assert.deepEqual(statuses(await post(events)), ['duplicate', 'applied', 'applied']);
  const healed = svc.describe();
  assert.notEqual(healed.lastSuccessAt, okAt);
  assert.equal(healed.lastError, null);
  assert.doesNotMatch(healed.detail, /Stuck since/);
  assert.equal(live('wholesale_orders')[0].paid_cents, 565);
});

test('the receiver answers from the headers before reading a body; bodies over 2 MB are 413; refusals are written and logged at most once a minute', async (t) => {
  const { base, secret, svc, db, lines, call } = await setup(t);
  const big = 'x'.repeat(3 * 1024 * 1024);
  const raw = (headers) => fetch(`${base}/api/wom/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: big })
    .then((r) => r.status).catch((e) => `error ${e.cause?.code ?? e.message}`);
  // Unsigned: 401 at once (whether the client sees it before it has sent all 3 MB or not, nothing was read).
  const unsigned = await raw({});
  assert.ok(unsigned === 401 || /^error/.test(unsigned), String(unsigned));
  // Well-formed headers: the body is read — up to 2 MB.
  const ts = Math.floor(Date.now() / 1000);
  assert.equal(await raw({ 'x-wom-timestamp': String(ts), 'x-wom-signature': sign(secret, ts, 'POST', EVENTS_PATH, big) }), 413);
  // Paused: 503 before anything.
  await call('PUT', '/api/connections/wom', { paused: true });
  const paused = await raw({ 'x-wom-timestamp': String(ts), 'x-wom-signature': 'a'.repeat(64) });
  assert.ok(paused === 503 || /^error/.test(paused), String(paused));
  await call('PUT', '/api/connections/wom', { paused: false });

  // Ten bad signatures in a row: one status write, one warning; the row still counts them all.
  const writes = () => db.prepare("SELECT value FROM wholesale_status WHERE key = 'refused_requests'").get()?.value;
  const before = lines.filter((l) => l.level === 'warn' && l.tag.includes('wholesale')).length;
  for (let i = 0; i < 10; i += 1) assert.equal((await postEvents(base, 'wrong-secret-wrong-secret', [])).status, 401);
  assert.ok(Number(writes()) <= 2, `written at most once a minute (${writes()})`);
  assert.ok(lines.filter((l) => l.level === 'warn' && l.tag.includes('wholesale')).length - before <= 1);
  assert.match(svc.describe().lastError, /refused since the last good request/);
  assert.match(svc.describe().lastError, /\((1[0-3]) refused/);
});

test('through Tailscale Serve (HTTPS, forwarded Host and address): the signature still checks out', async (t) => {
  const { post } = await setup(t);
  const om = womKit();
  const res = await post([om.customerCreated(om.customer())], {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mac-mini.tail1234.ts.net', 'x-forwarded-for': '100.101.102.103' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(statuses(res), ['applied']);
});

test('reconcileAll links many customers in small transactions, giving the event loop turns', async (t) => {
  const { post, live, client, local, svc } = await setup(t);
  const om = womKit();
  const { accountId } = client('Big group');
  const events = [];
  const customers = [];
  for (let i = 0; i < 120; i += 1) {
    const c = om.customer({ business_name: `Store ${i}` });
    customers.push(c);
    events.push(om.customerCreated(c), om.orderPlaced(om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }])));
  }
  for (let i = 0; i < events.length; i += 50) await post(events.slice(i, i + 50));
  // Linked elsewhere (as D2's auto-links would), all at once: one account each.
  for (const c of customers) {
    const a = local('owner', 'account', { client_id: client(`Client ${c.number}`).clientId, name: c.business_name });
    local('owner', 'link', { account_id: a, app: 'wom', external_id: c.customer_uid, matched_by: 'auto' });
  }
  assert.ok(accountId);
  let turns = 0;
  const timer = setInterval(() => { turns += 1; }, 0);
  const done = await svc.reconcileAll();
  clearInterval(timer);
  assert.equal(done.changed, 120);
  assert.equal(live('wholesale_orders').length, 120);
  assert.ok(turns >= 2, `the event loop ran in between (${turns} turns)`);
});

test('wholesale relationships never count as "no next step"; an order counts as activity for quiet clients', async (t) => {
  const { post, client, local, ctx } = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId, clientId } = client('Ordering often');
  local('owner', 'link', { account_id: accountId, app: 'wom', external_id: c.customer_uid, matched_by: 'approved' });
  const inFuture = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
  await post([om.customerCreated(c), om.orderPlaced(om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }], { created_at: inFuture(85) }))]);
  const { crm, planner } = ctx.services;
  assert.equal(crm.accountRelationships(accountId)[0].kind, 'wholesale');
  assert.equal(relationshipsToChase({ crm, planner }).length, 0, 'the linked account’s new wholesale relationship isn’t flagged');
  const quiet = local('owner', 'client', { name: 'Quiet one', status: 'active' });
  const today = addDays(localDate(), 90);
  const n = reviewNumbers({ crm, planner, services: ctx.services }, today);
  assert.equal(n.quiet, 1, `only the client with no order is quiet (${quiet}, not ${clientId})`);
  assert.equal(reviewNumbers({ crm, planner }, today).quiet, 2, 'without the wholesale read both would be');
});
