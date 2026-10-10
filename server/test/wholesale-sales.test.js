// Wholesale as a sales source (D11): the Order Manager's sales per day, worked out from the holding area with its own
// P&L rules (Reports → P&L: active orders on the UTC day of their created_at; refunds and credit notes before tax on
// their own day, while their order counts), written into the shared daily sales totals — compared with a real Order
// Manager's P&L answers captured by scripts/wom-e2e.mjs; every change re-writes its days (no double counts); a start
// and a restore write every day again from the holding area.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { salesDays, givenBack, utcDayOf, orderSaleFigures } from '../src/modules/wholesale/salesDays.js';
import { tmpDir, testConfig, ensureTestUsers, sessionFor, quietLog } from './helpers.js';
import { womKit, postEvents } from './fixtures/wom.js';

async function setup(t, { config = testConfig(tmpDir(t)), secret = true } = {}) {
  const db = openDb(config.dbPath);
  const { app, ctx } = await createApp({ config, db, log: quietLog });
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
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { cookie: owner.cookie, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let shared = null;
  if (secret) shared = (await call('POST', '/api/wholesale/connection/secret', {})).body.secret;
  const post = async (events) => {
    for (let i = 0; i < events.length; i += 50) {
      const r = await postEvents(base, shared, events.slice(i, i + 50));
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
  };
  const sales = ctx.services.sales;
  const dayRow = (d) => sales.totals({ from: d, to: d, source: 'wholesale' }).overall[0] ?? null;
  const rows = () => db.prepare("SELECT * FROM sales_daily WHERE source = 'wholesale' ORDER BY day").all();
  return { config, db, ctx, base, call, post, sales, dayRow, rows, close, secret: shared };
}

/** The P&L's summary (dollars) → the sales row's figures it is compared with (cents). */
const c = (n) => Math.round((Number(n) || 0) * 100);
const fromPnl = (s) => ({
  orders: s.total_orders, gross: c(s.revenue), discounts: c(s.discounts_given), refunds: c(s.refunds_issued) + c(s.credit_notes_issued),
  net: c(s.net_revenue), tax: c(s.tax_collected), shipping: c(s.shipping_collected),
});
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? 0]));
const MATCHED = ['orders', 'gross', 'discounts', 'refunds', 'net'];

// An order as the Order Manager makes it, placed at a given UTC time (created_at), and its held-row shape.
const at = (iso) => ({ created_at: iso });
const held = (o, extra = {}) => ({ uid: o.order_uid, status: o.status, deleted: 0, snapshot: o, placed_at: o.created_at, goods_cents: o.totals.subtotal_cents - o.totals.discount_cents, tax_cents: o.totals.tax_cents, ...extra });
const heldMoney = (kind, m, extra = {}) => ({
  uid: m.refund_uid ?? m.credit_note_uid ?? m.return_uid, kind, sub_kind: kind === 'refund' ? m.kind : null, order_uid: m.order_uid,
  amount_cents: m.amount_cents, subtotal_cents: m.subtotal_cents ?? null, removed: 0, return_uid: m.return_uid ?? null,
  at: m.created_at ?? m.issued_at ?? m.received_at, snapshot: m, ...extra,
});

test('the rules: UTC day of created_at, active orders only, lines-less orders, given back before tax on its own day', () => {
  const om = womKit();
  const cu = om.customer();
  // 23:30 in UTC on Oct 9 = 7:30 p.m. in Toronto: the P&L counts it on Oct 9; 01:00 UTC on Oct 10 = 9 p.m. on Oct 9 in Toronto: Oct 10 there.
  const a = om.order(cu, [{ name: 'Zyn', quantity: 10, unit_price_cents: 650 }], at('2026-10-09T23:30:00.000Z')); // 6500 + 845
  const b = om.order(cu, [{ name: 'ALP', quantity: 2, unit_price_cents: 700, discount_cents: 100 }], { ...at('2026-10-10T01:00:00.000Z'), shipping_cents: 1500, order_discount_cents: 300 });
  const cancelled = om.order(cu, [{ name: 'Velo', quantity: 3, unit_price_cents: 500 }], { ...at('2026-10-09T12:00:00.000Z'), status: 'cancelled' });
  const noLines = { ...om.order(cu, [], at('2026-10-09T13:00:00.000Z')), totals: { subtotal_cents: 0, discount_cents: 0, shipping_cents: 1000, tax_cents: 0, total_cents: 1000 } };
  assert.deepEqual(orderSaleFigures(held(noLines)), { orders: 0, items: 0, gross: 0, discounts: 0, tax: 0, shipping: 1000 }, 'no lines: not an order, its shipping still counts');
  const deleted = held(om.order(cu, [{ name: 'Velo', quantity: 1, unit_price_cents: 500 }], at('2026-10-09T14:00:00.000Z')), { deleted: 1 });
  // Given back on Oct 11: money back on `a` (in its proportion goods / (goods + tax)), a credit note on `b` with shipping,
  // store credit used up (never counted), a removed refund, and a refund on the cancelled order (drops out with it).
  const r1 = om.refund(a, 1000, { created_at: '2026-10-11T15:00:00.000Z' });
  const cn = { ...om.creditNote(b, { subtotal_cents: 500, tax_cents: 65, shipping_cents: 1500 }), issued_at: '2026-10-11T16:00:00.000Z' };
  const used = om.refund(a, -400, { kind: 'store_credit_applied', created_at: '2026-10-11T16:30:00.000Z' });
  const removed = om.refund(a, 300, { created_at: '2026-10-11T17:00:00.000Z' });
  const onCancelled = om.refund(cancelled, 500, { created_at: '2026-10-11T17:30:00.000Z' });
  const orders = [held(a), held(b), held(cancelled), held(noLines), deleted];
  const money = [heldMoney('refund', r1), heldMoney('credit_note', cn), heldMoney('refund', used), heldMoney('refund', removed, { removed: 1 }), heldMoney('refund', onCancelled)];
  const days = salesDays({ orders, money });
  assert.deepEqual([...days.keys()].sort(), ['2026-10-09', '2026-10-10', '2026-10-11']);
  assert.deepEqual(days.get('2026-10-09'), { orders: 1, items: 10, gross: 6500, discounts: 0, refunds: 0, net: 6500, tax: 845, shipping: 1000, total: 8345 });
  // b: 1400 − 100 line − 300 order = 1000 goods, tax 130, shipping 1500.
  assert.deepEqual(days.get('2026-10-10'), { orders: 1, items: 2, gross: 1400, discounts: 400, refunds: 0, net: 1000, tax: 130, shipping: 1500, total: 2630 });
  // 1000 × 6500 / 7345 = 884.96 → 885 before tax (115 tax); the credit note: 500 net + 65 tax + 1500 shipping.
  assert.deepEqual(days.get('2026-10-11'), { orders: 0, items: 0, gross: 0, discounts: 0, refunds: 1385, net: -1385, tax: -180, shipping: -1500, total: -3065 });
  assert.equal(givenBack(heldMoney('refund', used), () => held(a), () => null), null, 'store credit used up never counts');
  assert.equal(utcDayOf('2026-10-10T01:00:00.000Z'), '2026-10-10');
  // A day asked for with nothing on it comes back as zeros (a cancelled order's day written again).
  assert.deepEqual(salesDays({ orders, money, days: ['2026-10-12'] }).get('2026-10-12').total, 0);
});

test('a day’s proportional refunds are added unrounded and rounded once (as the P&L rounds its sum)', () => {
  const om = womKit();
  const cu = om.customer();
  const o = om.order(cu, [{ name: 'Zyn', quantity: 3, unit_price_cents: 333 }], at('2026-10-01T12:00:00.000Z')); // 999 + 130
  const refunds = [1, 2, 3].map((i) => heldMoney('refund', om.refund(o, 101, { created_at: `2026-10-02T1${i}:00:00.000Z` })));
  // 101 × 999 / 1129 = 89.37… each: three rounded one by one = 267, the sum rounded once = 268.
  const d = salesDays({ orders: [held(o)], money: refunds }).get('2026-10-02');
  assert.equal(d.refunds, 268);
  assert.equal(d.total, -303, 'the whole of what went back comes off the total');
  assert.equal(d.tax, -35);
});

test('a refund made by a return takes the return’s own subtotal; older returns without it: the proportion', () => {
  const om = womKit();
  const cu = om.customer();
  const o = om.order(cu, [{ name: 'Zyn', quantity: 10, unit_price_cents: 650 }], { ...at('2026-10-01T12:00:00.000Z'), shipping_cents: 1200 });
  const ret = { ...om.return(o, [], { amount_cents: 2100 }), subtotal_cents: 1000, tax_cents: 130, shipping_cents: 970, received_at: '2026-10-03T12:00:00.000Z' };
  const r = om.refund(o, 2100, { return_uid: ret.return_uid, created_at: '2026-10-03T12:01:00.000Z' });
  const withSub = salesDays({ orders: [held(o)], money: [heldMoney('return', ret), heldMoney('refund', r)] }).get('2026-10-03');
  assert.deepEqual(pick(withSub, ['refunds', 'tax', 'shipping', 'total']), { refunds: 1000, tax: -130, shipping: -970, total: -2100 });
  const older = { ...ret, subtotal_cents: undefined, tax_cents: undefined, shipping_cents: undefined };
  const without = salesDays({ orders: [held(o)], money: [heldMoney('return', older, { subtotal_cents: null }), heldMoney('refund', r)] }).get('2026-10-03');
  assert.equal(without.refunds, Math.round((2100 * 6500) / 7345));
});

test('the "done when": a real Order Manager’s events give its own P&L for every day, net of refunds (captured by wom-e2e)', async (t) => {
  const { events, pnl } = JSON.parse(fs.readFileSync(new URL('./fixtures/wom-captured-sales.json', import.meta.url), 'utf8'));
  const { post, dayRow, sales, rows } = await setup(t);
  await post(events);
  let compared = 0;
  for (const [d, summary] of Object.entries(pnl.days)) {
    const theirs = fromPnl(summary);
    const keys = theirs.refunds ? MATCHED : [...MATCHED, 'tax', 'shipping'];
    assert.deepEqual(pick(dayRow(d), keys), pick(theirs, keys), `day ${d}`);
    if (theirs.orders || theirs.refunds) compared += 1;
  }
  assert.ok(compared >= 3, 'days with sales and with refunds were compared');
  const range = sales.totals({ from: pnl.range.from, to: pnl.range.to, source: 'wholesale' }).overall[0];
  assert.deepEqual(pick(range, MATCHED), pick(fromPnl(pnl.range.summary), MATCHED), 'and the whole range');
  for (const r of rows()) {
    assert.equal(r.business_id, BUSINESS_IDS.wholesale);
    assert.equal(r.currency, 'CAD');
    assert.equal(r.total, r.net + r.tax + r.shipping);
  }
  // Everything sent again (the Order Manager's "Forget everything" + "Send existing" re-sends with new keys): upserts.
  const before = JSON.stringify(rows().map(({ fetched_at: _f, ...r }) => r));
  const again = events.map((e) => ({ ...e, key: e.key.slice(0, -4) + 'ffff' })); // new keys, same content
  await post(again);
  assert.equal(JSON.stringify(rows().map(({ fetched_at: _f, ...r }) => r)), before, 'nothing counted twice');
});

test('every held change re-writes its days: placed, edited, cancelled, deleted, restored, refunded later', async (t) => {
  const { post, dayRow, sales } = await setup(t);
  const om = womKit();
  const cu = om.customer(); // never linked: its sales count all the same
  const o = om.order(cu, [{ name: 'Zyn', quantity: 10, unit_price_cents: 650 }], at('2026-10-05T15:00:00.000Z')); // 6500 + 845
  await post([om.customerCreated(cu), om.orderPlaced(o)]);
  assert.deepEqual(pick(dayRow('2026-10-05'), ['orders', 'gross', 'net', 'total']), { orders: 1, gross: 6500, net: 6500, total: 7345 });
  const edited = { ...o, lines: [{ ...o.lines[0], quantity: 12, subtotal_cents: 7800, total_cents: 7800 }], totals: { ...o.totals, subtotal_cents: 7800, tax_cents: 1014, total_cents: 8814 } };
  await post([om.orderChanged(edited)]);
  assert.deepEqual(pick(dayRow('2026-10-05'), ['orders', 'items', 'gross', 'total']), { orders: 1, items: 12, gross: 7800, total: 8814 }, 'edited: replaced, not added');
  const r = om.refund(edited, 1000, { created_at: '2026-10-07T12:00:00.000Z' });
  await post([om.refundIssued(r)]);
  assert.equal(dayRow('2026-10-07').refunds, Math.round((1000 * 7800) / 8814), 'a refund on its own day');
  await post([om.orderCancelled({ ...edited, status: 'cancelled' })]);
  assert.equal(dayRow('2026-10-05').total, 0, 'cancelled: its day is zero');
  assert.equal(dayRow('2026-10-07').total, 0, 'and its refund drops out with it');
  await post([om.orderRestored(edited)]);
  assert.equal(dayRow('2026-10-05').total, 8814, 'restored (reopened): back');
  assert.ok(dayRow('2026-10-07').refunds > 0);
  await post([om.orderDeleted(edited)]);
  assert.equal(dayRow('2026-10-05').total, 0, 'deleted (in the bin there): out');
  await post([om.orderRestored(edited), om.refundGone(r)]);
  assert.equal(dayRow('2026-10-05').total, 8814);
  assert.equal(dayRow('2026-10-07').total, 0, 'a refund that is gone there comes off again');
  // A guest sale (no customer) counts too.
  const guest = om.order(null, [{ name: 'Velo', quantity: 1, unit_price_cents: 500 }], at('2026-10-05T16:00:00.000Z'));
  await post([om.orderPlaced(guest)]);
  assert.deepEqual(pick(dayRow('2026-10-05'), ['orders', 'total']), { orders: 2, total: 8814 + 565 });
  // Money → Sales: the Order Manager's card, UTC days, the wholesale business.
  const card = sales.summary().stores.find((s) => s.source === 'wholesale');
  assert.deepEqual([card.store, card.businessId, card.timeZone, card.currency, card.state], ['wholesale', BUSINESS_IDS.wholesale, 'UTC', 'CAD', null]);
});

test('listed once set up: "nothing yet" before any event, not listed with no secret and nothing received', async (t) => {
  const none = await setup(t, { secret: false });
  assert.equal(none.sales.summary().stores.some((s) => s.source === 'wholesale'), false);
  const set = await setup(t);
  assert.equal(set.sales.summary().stores.find((s) => s.source === 'wholesale')?.state, 'nothing_yet');
  await set.call('PUT', '/api/connections/wom', { paused: true });
  assert.equal(set.sales.summary().stores.find((s) => s.source === 'wholesale')?.state, 'paused');
});

test('a start writes every day again from the holding area; a restore (totals rolled back, holding area kept) too', async (t) => {
  const config = testConfig(tmpDir(t));
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(`${config.backup.offsiteDir}/.suite-backup-target`, '');
  const first = await setup(t, { config });
  const om = womKit();
  const cu = om.customer();
  const o1 = om.order(cu, [{ name: 'Zyn', quantity: 2, unit_price_cents: 650 }], at('2026-10-01T12:00:00.000Z'));
  await first.post([om.customerCreated(cu), om.orderPlaced(o1)]);
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  // After the backup: another order and o1 cancelled.
  const o2 = om.order(cu, [{ name: 'ALP', quantity: 3, unit_price_cents: 700 }], at('2026-10-02T12:00:00.000Z'));
  await first.post([om.orderPlaced(o2), om.orderCancelled({ ...o1, status: 'cancelled' })]);
  const want = first.rows().map(({ fetched_at: _f, ...r }) => r);
  assert.deepEqual(want.map((r) => [r.day, r.total]), [['2026-10-01', 0], ['2026-10-02', 2373]]);
  await first.close();
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  // The restored copy's totals say o1 counts and o2 doesn't exist; the holding area (kept) says otherwise.
  const again = await setup(t, { config, secret: false });
  assert.deepEqual(again.rows().map(({ fetched_at: _f, ...r }) => r), want, 'written again at start: as the Order Manager last said');
  // A plain restart changes nothing.
  await again.close();
  const third = await setup(t, { config, secret: false });
  assert.deepEqual(third.rows().map(({ fetched_at: _f, ...r }) => r), want);
});
