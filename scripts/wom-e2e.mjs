#!/usr/bin/env node
// End-to-end check of D1: the real Wholesale Order Manager sending its outbox (A10) to a real suite server.
//   node scripts/wom-e2e.mjs [path to a wholesale-order-manager checkout] [--capture <file.json>]
// Needs `npm ci` in that checkout's server/ (and in this repo). Both run with throwaway databases:
// the suite in this process (createApp on a temporary database, listening on 127.0.0.1), the Order
// Manager as its own process (node src/index.js). Walks through: connect with the suite's secret,
// backfill of a customer from before the connection (waiting for a client), link it, then orders
// placed / edited / packed / shipped / cancelled / returned / deleted / restored, payments, refunds,
// store credit, a pause and catch-up, and "Forget everything" + "Send existing" (every record sent
// again with new keys) — checking the suite's timeline records and spend against the Order Manager's own, and (D3)
// the money owing (balance and over-30-days aging) against its Balances page, and (D5) its CRM notes and follow-up
// dates once "Send CRM notes to the suite" is switched on there: notes on the timeline, follow-up tasks moved and
// finished, deletes, notes waiting with an unlinked customer, and everything sent again with nothing doubled; and (D2)
// a new Order Manager customer whose email is an existing client's contact's: linked automatically, then undone.
// --capture writes every event the suite received, in order (test fixtures).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../server/src/config.js';
import { createLogger } from '../server/src/lib/log.js';
import { openDb } from '../server/src/db/open.js';
import { createApp } from '../server/src/app.js';
import { newTotpSecret } from '../server/src/modules/auth/crypto.js';

const args = process.argv.slice(2);
const captureAt = args.indexOf('--capture');
const CAPTURE = captureAt >= 0 ? path.resolve(args.splice(captureAt, 2)[1]) : null;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OM_DIR = path.resolve(args[0] || process.env.WOM_DIR || path.join(ROOT, '..', 'wholesale-order-manager'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-e2e-'));
const OM_PORT = 13190;
const OM = `http://127.0.0.1:${OM_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// ───────── the suite (in this process) ─────────
const config = loadConfig({ DATA_DIR: path.join(tmp, 'suite'), CLIENT_DIST: path.join(tmp, 'no-client'), AUTH_SCRYPT_N: '1024' });
fs.mkdirSync(config.dataDir, { recursive: true });
const sdb = openDb(config.dbPath);
const { app, ctx } = await createApp({ config, db: sdb, log: createLogger('suite', 'warn') });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const SUITE = `http://127.0.0.1:${server.address().port}`;
const { user } = await ctx.services.auth.accounts.createUserWithTwoFactor(
  { actor: 'owner', username: 'jessy', displayName: 'Jessy', password: 'correct horse battery staple' }, { secret: newTotpSecret(), step: 0 });
const session = ctx.services.auth.startSession({ user, userAgent: 'wom-e2e', secondFactor: 'totp' });
const suiteCookie = `suite_session=${session.token}`;
const captured = [];
if (CAPTURE) {
  const svc = ctx.services.wholesale;
  const receive = svc.receive;
  svc.receive = (req) => {
    const out = receive(req);
    if (out.status === 200) {
      const events = JSON.parse(req.rawBody.toString('utf8')).events;
      out.body.results.forEach((r, i) => r.status === 'applied' && captured.push(events[i]));
    }
    return out;
  };
}
async function suite(method, p, body) {
  const r = await fetch(SUITE + p, { method, headers: { cookie: suiteCookie, origin: SUITE, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const live = (table, where = '1 = 1', ...a) => sdb.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND ${where}`).all(...a);
const local = (entity, fields) => ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields }).recordId;

// ───────── the Order Manager (its own process) ─────────
let om = null;
function startOm() {
  om = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(OM_DIR, 'server'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(OM_PORT), DB_PATH: path.join(tmp, 'om', 'wom.db'), DATA_DIR: path.join(tmp, 'om'), NODE_ENV: 'development' },
  });
  om.stderr.on('data', (d) => fs.appendFileSync(path.join(tmp, 'om.err'), d));
  om.stdout.on('data', (d) => fs.appendFileSync(path.join(tmp, 'om.log'), d));
}
async function stopOm() { if (!om) return; om.kill('SIGTERM'); await new Promise((r) => om.once('exit', r)); om = null; }
async function waitUp(url) {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* starting */ } await sleep(200); }
  throw new Error(`${url} never came up — see ${tmp}/om.err`);
}
let cookie = '';
async function wom(method, p, body) {
  const r = await fetch(OM + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}
const omDb = () => new Database(path.join(tmp, 'om', 'wom.db'), { readonly: true });
const omQuery = (sql, ...a) => { const d = omDb(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const outbox = () => omQuery('SELECT status, COUNT(*) n FROM crm_outbox GROUP BY status').reduce((o, r) => ({ ...o, [r.status]: r.n }), {});
/** Until the Order Manager's outbox has nothing pending (its worker sends 300 ms after a change and every 5 s). */
async function settle(ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const box = outbox();
    if (!box.pending) return box;
    if (Date.now() > end) throw new Error(`still ${box.pending} pending: ${JSON.stringify(omQuery("SELECT name, attempts, last_error FROM crm_outbox WHERE status = 'pending' LIMIT 3"))}`);
    await sleep(150);
  }
}
const today = new Date().toISOString().slice(0, 10);
const taxed = (items) => { const sub = items.reduce((s, i) => s + i.quantity * i.unit_price, 0); return Math.round(sub * 0.13 * 100) / 100; };
async function placeOrder(customer_id, items, extra = {}) {
  const r = await wom('POST', '/api/orders', { customer_id, items, order_date: today, tax_rate: 13, tax_amount: taxed(items), tax_province: 'ON', ...extra });
  if (r.status !== 201) throw new Error(`order: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.order;
}
const orderOf = async (id) => (await wom('GET', `/api/orders/${id}`)).data;
const uidOf = (table, id) => omQuery(`SELECT uid FROM ${table} WHERE id = ?`, id)[0].uid;
const spendOf = async (customerId) => Math.round((await wom('GET', `/api/crm/customers/${customerId}/stats`)).data.total_spent * 100);

async function main() {
  console.log(`work dir ${tmp}\nOrder Manager ${OM_DIR}\nsuite ${SUITE}`);
  // ── the Order Manager with products and a customer from before the connection ──
  fs.mkdirSync(path.join(tmp, 'om'), { recursive: true });
  startOm(); await waitUp(`${OM}/api/settings/branding`); await stopOm();
  {
    const d = new Database(path.join(tmp, 'om', 'wom.db'));
    const ins = d.prepare('INSERT INTO products (id, name, sku, brand, cost, wholesale_price, stock_quantity, is_custom) VALUES (?, ?, ?, ?, 4, 10, 500, 0)');
    ins.run(1, 'Zyn Cool Mint 6mg', 'ZYN-CM6', 'Zyn'); ins.run(2, 'ALP Mango Freeze', 'ALP-MF', 'ALP'); ins.run(3, 'Velo Freeze 10mg', 'VELO-F10', 'Velo');
    // A18 (Order Manager): the default admin must change "changeme" before any other call (403 mustChangePassword).
    // Cleared here as the Order Manager's own e2e scripts do; an Order Manager without the column is left alone.
    if (d.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'must_change_password')) d.prepare('UPDATE users SET must_change_password = 0').run();
    d.close();
  }
  startOm(); await waitUp(`${OM}/api/settings/branding`);
  ok((await wom('POST', '/api/auth/login', { username: 'admin', password: 'changeme' })).status === 200, 'Order Manager: signed in');
  const lefty = (await wom('POST', '/api/customers', { business_name: 'Lefty’s Vape Shop', contact_name: 'Lefty', email: 'lefty@leftys.ca', phone: '(519) 555-0100', address_line1: '12 Main St', city: 'Simcoe', province: 'ON', postal_code: 'N3Y 4K3' })).data;
  const early = await placeOrder(lefty.id, [{ product_id: 1, quantity: 10, unit_price: 6.5 }], { payments: [{ method: 'cash', amount: 73.45 }] });

  console.log('\n1. Connect with the suite’s secret; "Send existing" brings the customer from before');
  const made = await suite('POST', '/api/wholesale/connection/secret', {});
  ok(made.status === 200 && made.data.secret.length === 43, 'the suite made a secret (shown once)');
  const bad = await wom('POST', '/api/settings/crm/connect', { url: SUITE, secret: 'not-the-right-secret-123' });
  ok(bad.status === 200, 'Order Manager connected with a wrong secret (it only finds out on sending)');
  await wom('POST', '/api/settings/crm/send-existing');
  await sleep(1500);
  const refusedStatus = (await wom('GET', '/api/settings/crm')).data;
  ok(/refused the shared secret/.test(refusedStatus.last_error ?? ''), 'a wrong secret: the Order Manager says the suite refused it', refusedStatus.last_error);
  ok(/Wrong signature/.test(ctx.services.connections.get('wom').lastError ?? ''), 'and the suite’s Connections row shows the refusal');
  ok((await wom('POST', '/api/settings/crm/connect', { url: SUITE, secret: made.data.secret })).status === 200, 'connected with the right secret');
  await wom('POST', '/api/settings/crm/send-now');
  await settle();
  const waiting = (await suite('GET', '/api/wholesale/waiting')).data;
  ok(waiting.total === 1 && waiting.customers[0].businessName === 'Lefty’s Vape Shop' && waiting.customers[0].orders === 1, 'the customer waits for a client, with its order', waiting.customers);
  ok(waiting.customers[0].phone === '5195550100' && waiting.customers[0].email === 'lefty@leftys.ca', 'clean email and phone as the Order Manager stored them');
  ok(ctx.services.connections.get('wom').queueSize === 2, 'Connections: 2 records waiting for a client (the order and its payment)', ctx.services.connections.get('wom').queueLabel);
  ok(live('wholesale_orders').length === 0, 'nothing on devices while unlinked');

  console.log('\n2. Link it to a client in the suite');
  const clientId = local('client', { name: 'Lefty’s', status: 'active' });
  const accountId = local('account', { client_id: clientId, name: 'Lefty’s Vape Shop', age_restricted: false });
  const linked = await suite('POST', `/api/wholesale/customers/${uidOf('customers', lefty.id)}/link`, { clientId, accountId });
  ok(linked.status === 200, 'linked', linked.data);
  ok(live('wholesale_orders').length === 1 && live('wholesale_entries').length === 1, 'its order and payment are on the client’s timeline');
  ok(ctx.services.crm.liveAccount(accountId).age_restricted === true, 'the account is now age-restricted');
  ok(ctx.services.crm.accountRelationships(accountId).some((r) => r.kind === 'wholesale' && r.status === 'active'), 'and has an active wholesale relationship');

  console.log('\n3. Orders, payments, packing, edits, cancel, returns, refunds, delete and restore');
  const o2 = await placeOrder(lefty.id, [{ product_id: 1, quantity: 4, unit_price: 6.5 }, { product_id: 2, quantity: 2, unit_price: 7 }]);
  ok((await wom('POST', '/api/payments', { customer_id: lefty.id, order_id: o2.id, amount: 45.2, method: 'etransfer' })).status === 201, 'payment recorded');
  {
    const { order } = await orderOf(o2.id);
    const items = [{ product_id: 1, quantity: 6, unit_price: 6.5 }, { product_id: 2, quantity: 2, unit_price: 7 }];
    const r = await wom('PUT', `/api/orders/${o2.id}`, { customer_id: lefty.id, items, order_date: order.order_date, tax_rate: 13, tax_province: 'ON', version: order.version, notes: 'Two more Zyn' });
    ok(r.status === 200, 'order edited (6 Zyn instead of 4)', r.status === 200 ? undefined : r.data);
  }
  const sig = (await wom('GET', `/api/packing/${o2.id}`)).data.packing.sig;
  ok((await wom('POST', `/api/packing/${o2.id}/packed`, { sig })).status === 200, 'packed');
  ok((await wom('POST', `/api/packing/${o2.id}/shipped`, { via: 'delivered' })).status === 200, 'gone out');
  const o3 = await placeOrder(lefty.id, [{ product_id: 3, quantity: 3, unit_price: 5 }]);
  ok((await wom('POST', `/api/orders/${o3.id}/cancel`, {})).status === 200, 'an order cancelled');
  {
    const v = (await orderOf(o2.id)).order.version;
    const r = await wom('POST', `/api/orders/${o2.id}/returns`, { version: v, reason: 'Crushed tins', outcome: 'credit_note', items: [{ product_id: 1, restock: 1, damaged: 1 }] });
    ok(r.status === 201 || r.status === 200, 'a return with a credit note', r.data);
  }
  {
    const r = await wom('POST', '/api/refunds', { order_id: early.id, amount: 7.35, reason: 'One tin short', method: 'etransfer' });
    ok(r.status === 201, 'a money refund', r.data);
  }
  const o4 = await placeOrder(lefty.id, [{ product_id: 2, quantity: 5, unit_price: 7 }], { payments: [{ method: 'cash', amount: 39.55 }] });
  {
    const { order } = await orderOf(o4.id);
    const r = await wom('POST', `/api/orders/${o4.id}/delete`, { version: order.version, payments: 'store_credit' });
    ok(r.status === 200, 'a paid order deleted, its payment kept as store credit', r.data);
  }
  await settle();
  {
    const binned = live('wholesale_orders', 'order_uid = ?', uidOf('orders', o4.id))[0];
    ok(binned?.status === 'deleted', 'the suite shows it deleted (kept on the timeline)');
    const pay = live('wholesale_entries', "kind = 'payment' AND order_uid = ?", uidOf('orders', o4.id))[0];
    ok(pay?.status === 'removed' && pay.moved_to === 'store_credit', 'its payment removed, moved to store credit');
    const card = live('wholesale_customers')[0];
    const pot = Math.round(omQuery('SELECT store_credit FROM customers WHERE id = ?', lefty.id)[0].store_credit * 100);
    ok(card.credit_cents === pot && pot > 3955, `store credit held = the Order Manager’s own (${pot / 100}: the moved payment + the credit note)`, { suite: card.credit_cents, wom: pot });
  }
  {
    const b = (await wom('GET', '/api/orders/bin')).data.orders.find((o) => o.id === o4.id);
    const r = await wom('POST', `/api/orders/${o4.id}/restore`, { version: b.version });
    ok(r.status === 200, 'restored from the bin', r.data);
  }
  ok((await wom('POST', '/api/payments', { customer_id: lefty.id, amount: 20, method: 'cash', notes: 'On account' })).status === 201, 'a payment on account');
  await settle();
  {
    const ords = live('wholesale_orders');
    ok(ords.length === 4, '4 orders on the timeline (each once)', ords.length);
    const byUid = Object.fromEntries(ords.map((o) => [o.order_uid, o]));
    const r2 = byUid[uidOf('orders', o2.id)];
    ok(r2.status === 'active' && r2.item_count === 8 && r2.packing === 'shipped', 'the edited order: 8 units, gone out', r2);
    ok(r2.returned_cents > 0, 'with its credit note counted on it', r2.returned_cents);
    ok(byUid[uidOf('orders', o3.id)].status === 'cancelled', 'the cancelled order shows cancelled');
    ok(byUid[uidOf('orders', o4.id)].status === 'active', 'the restored order is live again');
    const kinds = live('wholesale_entries').map((e) => `${e.kind}:${e.status}`).sort();
    ok(JSON.stringify(kinds) === JSON.stringify(['credit_note:live', 'payment:live', 'payment:live', 'payment:live', 'payment:live', 'refund:live', 'return:live'].sort()), 'payments, the return, its credit note and the refund', kinds);
    const card = live('wholesale_customers')[0];
    const theirs = await spendOf(lefty.id);
    ok(card.spend_cents === theirs, `spend in the suite = the Order Manager’s own (${theirs / 100})`, { suite: card.spend_cents, wom: theirs });
    ok(card.order_count === 3 && card.last_order_date === today, '3 orders count (not the cancelled one), last order today', card);
    const paidThere = omQuery('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE customer_id = ?', lefty.id)[0].s;
    ok(card.paid_cents === Math.round(paidThere * 100), 'paid = the Order Manager’s payments', { suite: card.paid_cents, wom: paidThere });
    const pot = Math.round(omQuery('SELECT store_credit FROM customers WHERE id = ?', lefty.id)[0].store_credit * 100);
    ok(card.credit_cents === pot, `store credit = the Order Manager’s after the restore (${pot / 100})`, { suite: card.credit_cents, wom: pot });
  }

  console.log('\n4. Paused in the suite: the Order Manager holds its line, then catches up');
  await suite('PUT', '/api/connections/wom', { paused: true });
  const o5 = await placeOrder(lefty.id, [{ product_id: 3, quantity: 1, unit_price: 5 }], { payments: [{ method: 'cash', amount: 5.65 }] });
  await sleep(1500);
  const box = outbox();
  const st = (await wom('GET', '/api/settings/crm')).data;
  ok(box.pending === 2, 'its two events wait in the Order Manager', box);
  ok(/503/.test(st.last_error ?? ''), 'the Order Manager says the suite answered 503', st.last_error);
  ok(!live('wholesale_orders', 'order_uid = ?', uidOf('orders', o5.id)).length, 'nothing applied while paused');
  await suite('PUT', '/api/connections/wom', { paused: false });
  await wom('POST', '/api/settings/crm/send-now');
  await settle();
  ok(live('wholesale_orders', 'order_uid = ?', uidOf('orders', o5.id))[0]?.paid_cents === 565, 'switched on: it caught up, in order');

  console.log('\n5. Everything sent again with new keys ("Forget everything" + "Send existing"): one entry each');
  const before = { orders: live('wholesale_orders').length, entries: live('wholesale_entries').length, spend: live('wholesale_customers')[0].spend_cents };
  ok((await wom('POST', '/api/settings/crm/forget', { confirm: true })).status === 200, 'forgot');
  const sent = (await wom('POST', '/api/settings/crm/send-existing')).data;
  await settle();
  ok(sent.queued >= 10, `the backfill queued ${sent.queued} events`, sent);
  const after = { orders: live('wholesale_orders').length, entries: live('wholesale_entries').length, spend: live('wholesale_customers')[0].spend_cents };
  ok(JSON.stringify(before) === JSON.stringify(after), 'same timeline, same spend', { before, after });
  ok(outbox().refused === undefined, 'nothing refused by the suite');
  const row = ctx.services.connections.get('wom');
  ok(row.lastSuccessAt && row.queueSize === 0, 'Connections row: last success, nothing waiting', row);

  console.log('\n6. Money owing (D3): the suite’s figures = the Order Manager’s balance and its Balances page aging');
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const corner = (await wom('POST', '/api/customers', { business_name: 'Northwind Corner Store', contact_name: 'Robin', email: 'robin@northwind.example' })).data;
  const old1 = await placeOrder(corner.id, [{ product_id: 1, quantity: 10, unit_price: 10 }], { order_date: daysAgo(45) });
  const old2 = await placeOrder(corner.id, [{ product_id: 2, quantity: 5, unit_price: 10 }], { order_date: daysAgo(40) });
  const fresh = await placeOrder(corner.id, [{ product_id: 3, quantity: 2, unit_price: 10 }]);
  ok((await wom('POST', '/api/payments', { customer_id: corner.id, order_id: old2.id, amount: 20, method: 'cash' })).status === 201, 'a part payment on the second order');
  ok((await wom('POST', '/api/payments', { customer_id: corner.id, order_id: fresh.id, amount: 22.6, method: 'cash' })).status === 201, 'the newest order paid on itself');
  await settle();
  const cornerUid = uidOf('customers', corner.id);
  const cc = local('client', { name: 'Northwind', status: 'active' });
  const ca = local('account', { client_id: cc, name: 'Northwind Corner Store' });
  ok((await suite('POST', `/api/wholesale/customers/${cornerUid}/link`, { clientId: cc, accountId: ca })).status === 200, 'linked in the suite');
  const { overdueOrders } = await import('../server/src/modules/wholesale/figures.js');
  const localToday = (() => { const d = new Date(); const p2 = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; })();
  for (const [label, id] of [['Lefty’s', lefty.id], ['Northwind', corner.id]]) {
    const owing = ctx.services.wholesale.owingOf(uidOf('customers', id));
    const theirs = Math.round((await wom('GET', `/api/payments/customer/${id}/balance`)).data.balance_owing * 100);
    ok(owing.balance_cents === theirs, `${label}: balance in the suite = the Order Manager’s (${theirs / 100})`, { suite: owing.balance_cents, wom: theirs });
    const row = (await wom('GET', '/api/customers/balances')).data.customers?.find((r) => r.id === id);
    const over30 = row ? Math.round(((row.aging.days_30 ?? 0) + (row.aging.days_60 ?? 0) + (row.aging.days_90 ?? 0)) * 100) : 0;
    const mine = overdueOrders(owing, localToday).reduce((sum, o) => sum + o.owing_cents, 0);
    ok(mine === over30, `${label}: owing over 30 days in the suite = the Balances page aging (${over30 / 100})`, { suite: mine, wom: over30, row });
  }
  {
    const run = ctx.services.automations.runNow('wholesale-balances');
    const task = sdb.prepare("SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND title LIKE 'Balance owing%Northwind%'").get();
    ok(run.status === 'ok' && task && /\$126\.90 \(2 orders\)$/.test(task.title), 'the balance reminder: $126.90 on the two old orders (the oldest-first rule)', { run: run.summary, title: task?.title });
    ok(/Total owing: \$126\.90/.test(task?.notes ?? '') && /To: Robin <robin@northwind\.example>/.test(task?.notes ?? ''), 'its drafted email: the total and the Order Manager’s email');
  }

  console.log('\n7. Notes and follow-ups (D5): "Send CRM notes to the suite" switched on in the Order Manager');
  const noteRows = () => live('wholesale_notes');
  const followUps = (title) => sdb.prepare("SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND title = ? ORDER BY created_at, id").all(title);
  const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  // Written before the switch is on: they go with the one-time catch-up when it is turned on.
  const early1 = (await wom('POST', `/api/crm/customers/${lefty.id}/activities`, { type: 'call', content: 'Asked about Zyn 3mg' })).data;
  ok(early1?.uid, 'a call logged in the Order Manager before the switch (nothing sent yet)', early1);
  ok((await wom('PUT', `/api/crm/customers/${corner.id}/follow-up`, { follow_up_date: inDays(5) })).status === 200, 'a follow-up date set for Northwind');
  await settle();
  ok(noteRows().length === 0 && followUps('Follow up with Northwind Corner Store').length === 0, 'nothing reached the suite while the switch was off');
  const on = await wom('POST', '/api/settings/crm/notes', { on: true });
  ok(on.status === 200 && on.data.backfill, 'switched on: the one-time catch-up queued the notes and follow-ups', on.data);
  await settle();
  ok(outbox().refused === undefined, 'nothing refused by the suite (it knows the three events)', omQuery("SELECT name, last_error FROM crm_outbox WHERE status = 'refused'"));
  {
    const [n] = noteRows();
    ok(noteRows().length === 1 && n.type === 'call' && n.body === 'Asked about Zyn 3mg' && n.written_by === 'admin' && n.client_id === clientId,
      'the call is on Lefty’s timeline (type, text, who wrote it)', noteRows());
    const [task] = followUps('Follow up with Northwind Corner Store');
    ok(task && task.due_date === inDays(5) && task.business_id === (await import('@suite/shared/crm')).BUSINESS_IDS.wholesale,
      'the backfilled follow-up is a task on the wholesale business, due that day', task);
    ok(live('wholesale_customers', 'customer_uid = ?', cornerUid)[0]?.follow_up_date === inDays(5), 'and on the customer card');
  }
  // Live: a note, a follow-up set, moved, then done (its follow-up note comes too); a note deleted.
  const live1 = (await wom('POST', `/api/crm/customers/${lefty.id}/activities`, { type: 'email', content: 'Sent the October price list' })).data;
  ok((await wom('PUT', `/api/crm/customers/${lefty.id}/follow-up`, { follow_up_date: inDays(3) })).status === 200, 'Lefty: follow-up in 3 days');
  await settle();
  let [leftyTask] = followUps('Follow up with Lefty’s Vape Shop');
  ok(leftyTask?.due_date === inDays(3) && leftyTask.done_at === null, 'Lefty’s follow-up task, due in 3 days', leftyTask);
  ok((await wom('PUT', `/api/crm/customers/${lefty.id}/follow-up`, { follow_up_date: inDays(10) })).status === 200, 'snoozed to 10 days');
  await settle();
  ok(followUps('Follow up with Lefty’s Vape Shop').length === 1 && followUps('Follow up with Lefty’s Vape Shop')[0].due_date === inDays(10), 'the same task moved');
  ok((await wom('POST', `/api/crm/customers/${lefty.id}/follow-up/done`, { note: 'Called, ordering Friday' })).status === 200, 'marked done in the Order Manager');
  ok((await wom('DELETE', `/api/crm/activities/${live1.id}`)).status === 200, 'the email note deleted there');
  await settle();
  [leftyTask] = followUps('Follow up with Lefty’s Vape Shop');
  ok(leftyTask?.done_at && /Done in the Order Manager/.test(leftyTask.notes), 'the task is finished: done in the Order Manager', leftyTask);
  ok(JSON.stringify(noteRows().map((n) => [n.type, n.body]).sort()) === JSON.stringify([['call', 'Asked about Zyn 3mg'], ['follow_up', 'Called, ordering Friday']]),
    'the timeline: the call and the follow-up note; the deleted email is gone', noteRows().map((n) => [n.type, n.body]));
  // A customer not linked yet: its note waits, counted.
  const south = (await wom('POST', '/api/customers', { business_name: 'Southside Convenience' })).data;
  await wom('POST', `/api/crm/customers/${south.id}/activities`, { type: 'meeting', content: 'Met at the trade show' });
  await settle();
  const waitingSouth = (await suite('GET', '/api/wholesale/waiting')).data.customers.find((c) => c.businessName === 'Southside Convenience');
  ok(waitingSouth?.notes === 1, 'an unlinked customer’s note waits with it (“1 note waiting”)', waitingSouth);
  ok(/1 note/.test(ctx.services.connections.get('wom').queueLabel), 'Connections: notes counted', ctx.services.connections.get('wom').queueLabel);
  // Everything sent again with new keys: nothing doubled.
  const beforeNotes = { notes: noteRows().length, tasks: sdb.prepare("SELECT count(*) AS n FROM planner_tasks WHERE deleted_at IS NULL AND title LIKE 'Follow up with%'").get().n };
  ok((await wom('POST', '/api/settings/crm/forget', { confirm: true })).status === 200, 'forgot everything again');
  await wom('POST', '/api/settings/crm/send-existing');
  await settle();
  const afterNotes = { notes: noteRows().length, tasks: sdb.prepare("SELECT count(*) AS n FROM planner_tasks WHERE deleted_at IS NULL AND title LIKE 'Follow up with%'").get().n };
  ok(JSON.stringify(beforeNotes) === JSON.stringify(afterNotes), 'sent again: each note once, no second follow-up task', { beforeNotes, afterNotes });
  ok(followUps('Follow up with Northwind Corner Store').filter((x) => !x.done_at).length === 1, 'Northwind’s follow-up: still one open task');
  ok(outbox().refused === undefined, 'nothing refused');

  console.log('\n8. Matching (D2): a new customer with an existing client’s contact email is linked automatically');
  {
    const { BUSINESS_IDS } = await import('@suite/shared/crm');
    const harbourClient = local('client', { name: 'Harbour Smoke', status: 'active' });
    const harbourAccount = local('account', { client_id: harbourClient, name: 'Harbour Smoke Shop', age_restricted: false });
    local('relationship', { account_id: harbourAccount, business_id: BUSINESS_IDS.agency, kind: 'website', status: 'active' });
    local('contact', { client_id: harbourClient, account_id: harbourAccount, name: 'Dana Reyes', email: 'dana@harbour.example' });
    // Typed with capitals and spaces in the Order Manager: it stores (and sends) the clean form.
    const harbour = (await wom('POST', '/api/customers', { business_name: 'Harbour Smoke & Vape', contact_name: 'Dana', email: ' Dana@Harbour.example ' })).data;
    await placeOrder(harbour.id, [{ product_id: 1, quantity: 6, unit_price: 6.5 }]);
    await settle();
    const uid = uidOf('customers', harbour.id);
    const [link] = ctx.services.crm.liveLinks('wom', uid);
    ok(link?.matched_by === 'auto' && link.match_reason === 'same email' && link.account_id === harbourAccount, 'linked automatically to the client’s account (same email)', link);
    ok(live('wholesale_orders', 'client_id = ?', harbourClient).length === 1, 'its order is on the client’s timeline');
    ok(ctx.services.crm.liveAccount(harbourAccount).age_restricted === true, 'the account is age-restricted');
    const alert = sdb.prepare("SELECT title FROM automations_alerts WHERE source = 'wholesale-auto-link' ORDER BY at DESC").get();
    ok(alert?.title === 'Linked 1 Order Manager customer automatically', 'one in-app alert for the pass', alert);
    const linkedRow = (await suite('GET', '/api/wholesale/linked')).data.customers.find((c) => c.uid === uid);
    ok(linkedRow?.link?.matchedBy === 'auto' && linkedRow.link.reason === 'same email', 'the Linked tab says how');
    // A similar name, no email in common: only suggested.
    const lookalike = (await wom('POST', '/api/customers', { business_name: 'Harbour Smoke Shop Ltd', contact_name: 'Kai' })).data;
    await settle();
    const lookUid = uidOf('customers', lookalike.id);
    ok(!ctx.services.crm.liveLinks('wom', lookUid).length, 'a similar name is not linked');
    const sugg = (await suite('GET', '/api/wholesale/matches/suggestions')).data.suggestions.filter((x) => x.customer.uid === lookUid);
    ok(sugg.length === 1 && sugg[0].client.id === harbourClient && sugg[0].reasons.some((r) => r.kind === 'name'), 'it is suggested for review', sugg);
    // Undo: both sides as they were.
    const undone = await suite('POST', `/api/wholesale/customers/${uid}/unlink`, {});
    ok(undone.status === 200 && undone.data.undone.restore.length === 2, 'undone: the age mark and the wholesale relationship put back', undone.data);
    ok(!ctx.services.crm.liveLinks('wom', uid).length && !live('wholesale_orders', 'client_id = ?', harbourClient).length, 'the link and the order left the client');
    ok(ctx.services.crm.liveAccount(harbourAccount).age_restricted === false, 'the age mark as before');
    ok(!ctx.services.crm.accountRelationships(harbourAccount).some((r) => r.kind === 'wholesale'), 'no wholesale relationship left');
    // A change there (sent again) doesn't link it automatically again.
    await wom('PUT', `/api/customers/${harbour.id}`, { business_name: 'Harbour Smoke & Vape', contact_name: 'Dana R.', email: 'dana@harbour.example' });
    await settle();
    ok(!ctx.services.crm.liveLinks('wom', uid).length, 'edited there: not linked again (the undo is remembered)');
  }

  if (CAPTURE) {
    fs.writeFileSync(CAPTURE, `${JSON.stringify({ capturedAt: new Date().toISOString(), from: 'scripts/wom-e2e.mjs', events: captured }, null, 1)}\n`);
    console.log(`\nwrote ${captured.length} events to ${CAPTURE}`);
  }
}

try {
  await main();
} catch (err) {
  fail++;
  console.error(err);
} finally {
  await stopOm();
  await new Promise((r) => server.close(r));
  sdb.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (!fail) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
