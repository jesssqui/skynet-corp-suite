// Wholesale automations (D3): check-ins for quiet regulars, balance reminders with a drafted email,
// ready-to-ship tasks on packed orders, and the "Quiet regular" rhythm on the customer card. Each
// fires once (scheduler again, Run now, a re-delivered event, a restart), goes to the wholesale
// business's default owner, makes only tasks (and in-app alerts), and ignores backfill events.
// The server's local time zone is Toronto's.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { modules } from '../src/modules/index.js';
import { atLocal } from '../src/modules/automations/schedule.js';
import {
  orderRhythm, isQuiet, owingByOrder, overdueOrders, daysBetween, RHYTHM,
} from '../src/modules/wholesale/figures.js';
import {
  CHECK_IN_ID, BALANCES_ID, SHIP_ID, NOTES_MARK, NEW_TASKS_CAP, mergeNotes, balanceDraft, readyToShip, whyNotWaiting, money, dayText,
} from '../src/modules/wholesale/automations.js';
import { CARD_VERSION } from '../src/modules/wholesale/service.js';
import { openDb } from '../src/db/open.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock } from './helpers.js';
import { womKit } from './fixtures/wom.js';

const W = BUSINESS_IDS.wholesale;
/** Local time in Toronto as ms ("2026-10-14 08:00"). */
const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};

async function setup(t, { config = testConfig(tmpDir(t)), clock = testClock() } = {}) {
  const env = await startApp(t, config, { modules, now: clock.now });
  await ensureTestUsers(env.ctx);
  const { sync, automations: autos, wholesale: svc } = env.ctx.services;
  const local = (entity, fields, op = 'create', recordId) => {
    const r = sync.applyLocal({ actor: 'owner', entity, op, recordId, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
    return r.recordId;
  };
  /** A client with an account linked to an Order Manager customer (the way D2 / a person links them). */
  const linked = (customer, name = 'Lefty’s', { contactEmail = 'pat@leftys.ca' } = {}) => {
    const clientId = local('client', { name, status: 'active' });
    const accountId = local('account', { client_id: clientId, name });
    if (contactEmail !== null) local('contact', { client_id: clientId, account_id: accountId, name: 'Pat Lee', email: contactEmail });
    local('link', { account_id: accountId, app: 'wom', external_id: customer.customer_uid, matched_by: 'approved' });
    svc.reconcile({ only: [customer.customer_uid] });
    return { clientId, accountId };
  };
  const apply = (events) => svc.applyEvents(events);
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const runs = (id) => env.db.prepare('SELECT * FROM automations_runs WHERE automation_id = ? ORDER BY started_at, id').all(id);
  const card = (uid) => env.db.prepare('SELECT * FROM wholesale_customers WHERE customer_uid = ? AND deleted_at IS NULL').get(uid);
  const relOf = (accountId) => env.db.prepare('SELECT id FROM crm_relationships WHERE account_id = ? AND business_id = ? AND deleted_at IS NULL').get(accountId, W)?.id;
  /** Only the automations under test run in tick() (switch the others off). */
  const only = (...ids) => {
    for (const a of autos.list()) if (a.trigger.type === 'schedule') autos.setSettings(a.id, { enabled: ids.includes(a.id) }, { actor: 'owner' });
  };
  return { ...env, config, clock, sync, autos, svc, local, linked, apply, setNow, tasks, runs, card, relOf, only };
}

/** An order the kit makes, with a given date and total goods (one line, 13 % tax). */
const orderOn = (om, c, date, cents = 10000, over = {}) => om.order(c, [{ name: 'Zyn Cool Mint', quantity: 1, unit_price_cents: cents }], { order_date: date, ...over });

// ---- the rules (pure) ---------------------------------------------------------------------------

const row = (uid, order_date, over = {}) => ({ uid, order_date, status: 'active', deleted: 0, has_snapshot: 1, placed_at: `${order_date}T15:00:00.000Z`, ...over });

test('orderRhythm: a regular’s usual gap is the median of their recent gaps; quiet from last + max(1.5 × gap, gap + 7) + 1', () => {
  const weekly = orderRhythm([row('a', '2026-09-01'), row('b', '2026-09-08'), row('c', '2026-09-15'), row('d', '2026-09-22')]);
  assert.deepEqual([weekly.regular, weekly.usual_gap_days, weekly.quiet_after_days, weekly.quiet_from, weekly.last_order_uid], [true, 7, 14, '2026-10-07', 'd']);
  assert.equal(isQuiet(weekly, '2026-10-06'), false, '14 days after the last order is not "clearly longer"');
  assert.equal(isQuiet(weekly, '2026-10-07'), true);
  const monthly = orderRhythm([row('a', '2026-06-01'), row('b', '2026-07-01'), row('c', '2026-07-31'), row('d', '2026-08-30')]);
  assert.deepEqual([monthly.usual_gap_days, monthly.quiet_after_days, monthly.quiet_from], [30, 45, '2026-10-15'], '1.5 × 30 beats 30 + 7');
  // Three ordering days are not enough; two orders on one day are one ordering day.
  assert.equal(orderRhythm([row('a', '2026-09-01'), row('b', '2026-09-08'), row('c', '2026-09-15'), row('x', '2026-09-15')]).regular, false);
  // Cancelled, deleted and snapshot-less orders don't count; history-only ones do (they are rows like any other).
  const mixed = orderRhythm([row('a', '2026-09-01'), row('b', '2026-09-08'), row('c', '2026-09-15'), row('d', '2026-09-22', { status: 'cancelled' }),
    row('e', '2026-09-29', { deleted: 1 }), row('f', '2026-10-01', { has_snapshot: 0 })]);
  assert.deepEqual([mixed.regular, mixed.last_order_uid], [false, 'c']);
  // Someone ordering every four months isn't a regular to chase.
  assert.equal(orderRhythm([row('a', '2025-06-01'), row('b', '2025-10-01'), row('c', '2026-02-01'), row('d', '2026-06-01')]).regular, false);
  // An odd gap doesn't move the median; only the last RECENT_GAPS gaps count.
  const steady = orderRhythm(['2026-01-05', '2026-03-30', '2026-04-06', '2026-04-13', '2026-04-20', '2026-04-27'].map((d, i) => row(`o${i}`, d)));
  assert.equal(steady.usual_gap_days, 7);
  const many = Array.from({ length: 12 }, (_, i) => row(`m${i}`, `2026-0${i < 6 ? 1 : 2}-${String(i < 6 ? 1 + i * 5 : (i - 6) * 3 + 1).padStart(2, '0')}`));
  assert.equal(orderRhythm(many).gaps.length, RHYTHM.RECENT_GAPS);
  assert.equal(daysBetween('2026-02-27', '2026-03-02'), 3);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1, 'across the DST change: whole days');
});

test('owingByOrder: the Order Manager’s balance — total less payments and credit used; money on account goes to the oldest first', () => {
  const orders = [
    { uid: 'o1', number: 1, order_date: '2026-08-01', status: 'active', deleted: 0, has_snapshot: 1, total_cents: 11300 },
    { uid: 'o2', number: 2, order_date: '2026-08-20', status: 'active', deleted: 0, has_snapshot: 1, total_cents: 5000 },
    { uid: 'o3', number: 3, order_date: '2026-09-30', status: 'active', deleted: 0, has_snapshot: 1, total_cents: 2000 },
    { uid: 'oc', number: 4, order_date: '2026-08-05', status: 'cancelled', deleted: 0, has_snapshot: 1, total_cents: 3000 },
    { uid: 'od', number: 5, order_date: '2026-08-06', status: 'active', deleted: 1, has_snapshot: 1, total_cents: 9999 },
  ];
  const m = (kind, amount_cents, order_uid, over = {}) => ({ kind, sub_kind: null, amount_cents, order_uid, removed: 0, ...over });
  const money1 = [
    m('payment', 5000, 'o1'),
    m('payment', 1000, null), // on account → the oldest owing order
    m('refund', -800, 'o2', { sub_kind: 'store_credit_applied' }), // credit used counts as paid
    m('credit_note', 1130, 'o3'), // credit held: NOT taken off the balance
    m('refund', 500, 'o1', { sub_kind: 'refund' }), // money back: not a payment either
    m('payment', 3000, 'oc'), m('refund', 1000, 'oc', { sub_kind: 'refund' }), // cancelled: 3000 − 1000 back = 2000 to the pool
    m('payment', 999, 'o2', { removed: 1 }), // removed: nothing
  ];
  const r = owingByOrder(orders, money1);
  assert.deepEqual(r.orders.map((o) => [o.uid, o.owing_cents]), [['o1', 3300], ['o2', 4200], ['o3', 2000]], 'o1: 11300 − 5000 − 1000 − 2000');
  assert.equal(r.balance_cents, 9500);
  // The Order Manager's customer balance: Σ active totals − Σ paid rows (payments + credit used − given back on cancelled).
  assert.equal(r.balance_cents, (11300 + 5000 + 2000) - (5000 + 1000 + 800 + 3000 - 1000));
  assert.deepEqual(overdueOrders(r, '2026-10-14').map((o) => o.uid), ['o1', 'o2'], 'o3 is 14 days old');
  assert.deepEqual(overdueOrders(r, '2026-08-31').map((o) => o.uid), [], 'o1 is exactly 30 days old: not yet');
  // An overpaid order's extra goes to the next oldest; more than everything → unused.
  const over = owingByOrder(orders.slice(0, 2), [m('payment', 12300, 'o1')]);
  assert.deepEqual([over.orders.map((o) => o.owing_cents), over.unused_cents], [[0, 4000], 0]);
  assert.deepEqual(owingByOrder(orders.slice(0, 1), [m('payment', 20000, null)]).unused_cents, 8700);
});

test('the drafted email: amounts, total, store credit, recipient; the person’s notes below the line are kept', () => {
  const d = balanceDraft({
    name: 'Lefty’s', to: { name: 'Pat Lee', email: 'pat@leftys.ca' }, creditCents: 1130, businessName: 'Wholesale',
    overdue: [{ uid: 'a', number: 12, order_date: '2026-08-01', total_cents: 65000, owing_cents: 50000 }, { uid: 'b', number: 15, order_date: '2026-08-20', total_cents: 20000, owing_cents: 20000 }],
  });
  assert.equal(d.title, 'Balance owing over 30 days: Lefty’s, $700.00 (2 orders)');
  assert.equal(d.totalCents, 70000);
  assert.match(d.draft, /^Drafted by the suite — nothing has been sent\./);
  assert.match(d.draft, /\nTo: Pat Lee <pat@leftys\.ca>\nSubject: Balance owing: \$700\.00 on orders #12, #15\n\nHi Pat,/);
  assert.match(d.draft, /• Order #12 from Aug 1, 2026: \$500\.00 owing \(order total \$650\.00\)\n• Order #15 from Aug 20, 2026: \$200\.00 owing\n\nTotal owing: \$700\.00/);
  assert.match(d.draft, /You also have \$11\.30 in store credit with us/);
  assert.match(d.draft, /Thanks,\nWholesale$/);
  const none = balanceDraft({ name: 'Corner', to: { name: null, email: null }, overdue: [{ number: 1, order_date: '2026-08-01', total_cents: 100, owing_cents: 100 }], businessName: 'W' });
  assert.match(none.draft, /To: \(no email on file for Corner: add one to a contact\)/);
  assert.match(none.draft, /Hi Corner,/);
  assert.ok(!none.draft.includes('store credit'));

  const first = mergeNotes(null, 'DRAFT 1');
  assert.equal(first, `DRAFT 1\n\n${NOTES_MARK}\n`);
  const mine = `${first}Called Pat: paying Friday.`;
  assert.equal(mergeNotes(mine, 'DRAFT 2'), `DRAFT 2\n\n${NOTES_MARK}\nCalled Pat: paying Friday.`);
  assert.equal(mergeNotes(mine, 'DRAFT 1'), null, 'nothing changed: no update');
  assert.equal(mergeNotes('My own notes only', 'DRAFT 2'), null, 'the line removed: the notes are the person’s');
  assert.equal(money(123456), '$1,234.56');
  assert.equal(dayText('2026-08-01'), 'Aug 1, 2026');
});

test('ready to ship: packed and active is waiting; why a task is finished, in plain English', () => {
  const om = womKit();
  const c = om.customer();
  const o = orderOn(om, c, '2026-10-10');
  const packed = { ...o, packing: { ...o.packing, state: 'packed' } };
  const ev = (e) => ({ ...e, data: e.data });
  assert.equal(readyToShip(ev(om.orderPacked(packed))), true);
  assert.equal(readyToShip(ev(om.orderPacked({ ...o, packing: { ...o.packing, state: 'to_pack' } }, { change: 'unpacked' }))), false);
  assert.equal(readyToShip(ev(om.orderShipped({ ...o, packing: { ...o.packing, state: 'shipped', shipped_via: 'eshipper' } }, { via: 'eshipper' }))), false);
  assert.equal(readyToShip(ev(om.orderDeleted(packed))), false);
  assert.equal(readyToShip(ev(om.orderCancelled({ ...packed, status: 'cancelled' }))), false);
  assert.equal(whyNotWaiting(om.orderShipped({ ...o, packing: { ...o.packing, state: 'shipped' } }, { via: 'eshipper' })), 'Shipped in the Order Manager (eShipper)');
  assert.equal(whyNotWaiting(om.orderCancelled({ ...packed, status: 'cancelled' })), 'Cancelled in the Order Manager');
  assert.equal(whyNotWaiting(om.orderDeleted(packed)), 'Deleted in the Order Manager');
  assert.equal(whyNotWaiting(om.orderPacked({ ...o, packing: { ...o.packing, state: 'to_pack' } }, { change: 'unpacked' })), 'Unpacked in the Order Manager (no longer ready to ship)');
});

// ---- 1. check-ins and 4. the quiet-regular flag ------------------------------------------------

test('check-in: a quiet regular gets one task (scheduler again, Run now, next day, restart: still one); a new order finishes it and moves the flag', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const env = await setup(t, { config, clock });
  env.only(CHECK_IN_ID);
  env.setNow(at('2026-10-14 07:00'));
  const om = womKit();
  const c = om.customer({ business_name: 'Lefty’s Vape Shop', email: 'lefty@leftys.ca' });
  const dates = ['2026-08-01', '2026-08-15', '2026-08-29', '2026-09-12'];
  const orders = dates.map((d) => orderOn(om, c, d));
  // The history arrives as the Order Manager's catch-up (backfill): nothing is triggered by it.
  env.apply([om.customerCreated(c, { backfill: true }), ...orders.map((o) => om.orderPlaced(o, { backfill: true, source: 'backfill' }))]);
  // An unlinked quiet regular, and a linked customer with only three ordering days: no tasks.
  const stranger = om.customer({ business_name: 'Stranger' });
  env.apply([om.customerCreated(stranger), ...dates.map((d) => om.orderPlaced(orderOn(om, stranger, d)))]);
  const few = om.customer({ business_name: 'Few Orders' });
  env.apply([om.customerCreated(few), ...dates.slice(1).map((d) => om.orderPlaced(orderOn(om, few, d)))]);
  env.linked(few, 'Few Orders');
  const { clientId, accountId } = env.linked(c);

  // The card: usual gap 14 days, quiet from Oct 4 (Sep 12 + 21 + 1).
  assert.deepEqual([env.card(c.customer_uid).usual_gap_days, env.card(c.customer_uid).quiet_from], [14, '2026-10-04']);
  assert.deepEqual([env.card(few.customer_uid).usual_gap_days, env.card(few.customer_uid).quiet_from], [null, null], 'not a regular');

  assert.deepEqual(env.autos.tick(), [], 'not before 7:40');
  env.setNow(at('2026-10-14 07:41'));
  const [run] = env.autos.tick();
  assert.deepEqual([run.automation, run.status, run.createdCount], [CHECK_IN_ID, 'ok', 1]);
  const [task] = env.tasks();
  assert.equal(task.title, 'Check in with Lefty’s: no order in 32 days (usually every 14)');
  assert.deepEqual(
    [task.owner, task.business_id, task.client_id, task.account_id, task.relationship_id, task.due_date, task.created_by],
    ['owner', W, clientId, accountId, env.relOf(accountId), '2026-10-14', 'system'],
  );
  assert.match(task.notes, /usually orders every 14 days \(the middle of their last 3 gaps between orders\)\. Their last order was #4 on Sep 12, 2026 \(\$113\.00\): 32 days ago\./);
  assert.match(task.notes, /the suite never contacts anyone/);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM automations_alerts').get().n, 0, 'silent by default');

  // Once: the scheduler again, Run now, the next day, a restart.
  assert.deepEqual(env.autos.tick(), []);
  assert.equal(env.autos.runNow(CHECK_IN_ID).createdCount, 0);
  env.setNow(at('2026-10-15 08:00'));
  assert.equal(env.autos.tick()[0].createdCount, 0);
  await env.close();
  const again = await setup(t, { config, clock });
  again.setNow(at('2026-10-16 08:00'));
  assert.equal(again.autos.tick().find((r) => r.automation === CHECK_IN_ID).createdCount, 0);
  assert.equal(again.tasks().length, 1, 'one check-in, ever, for this quiet spell');

  // A new order: the open check-in is finished (never deleted), the flag moves on, no new task.
  const o5 = orderOn(om, c, '2026-10-16');
  again.apply([om.orderPlaced(o5)]);
  assert.deepEqual([again.card(c.customer_uid).usual_gap_days, again.card(c.customer_uid).quiet_from], [14, '2026-11-07']);
  again.setNow(at('2026-10-17 08:00'));
  const [r2] = again.autos.tick().filter((r) => r.automation === CHECK_IN_ID);
  assert.match(r2.summary, /finished 1 earlier check-in/);
  const [done] = again.tasks();
  assert.ok(done.done_at, 'finished by the suite');
  assert.match(done.notes, /Ordered again \(order #\d+ on Oct 16, 2026\) — finished by the suite on Oct 17, 2026\.$/);
  assert.equal(again.tasks('done_at IS NULL').length, 0);

  // Quiet again later: a new spell, a new task.
  again.setNow(at('2026-11-08 08:00'));
  again.autos.tick();
  const open = again.tasks('done_at IS NULL');
  assert.deepEqual(open.map((x) => x.title), ['Check in with Lefty’s: no order in 23 days (usually every 14)']);
});

test('check-in: the business’s default owner, closed clients skipped, gone customers skipped, at most 10 a run', async (t) => {
  const env = await setup(t);
  env.only(CHECK_IN_ID);
  env.setNow(at('2026-10-14 07:00'));
  env.local('business', { default_owner: 'partner' }, 'update', W);
  const om = womKit();
  const dates = ['2026-08-01', '2026-08-15', '2026-08-29', '2026-09-12'];
  const customers = Array.from({ length: NEW_TASKS_CAP + 3 }, (_, i) => om.customer({ business_name: `Shop ${i}` }));
  for (const [i, c] of customers.entries()) {
    // Shop 0 has the longest silence; the others are later by one day each.
    env.apply([om.customerCreated(c), ...dates.map((d) => om.orderPlaced(orderOn(om, c, addDays(d, Math.min(i, 9)))))]);
  }
  const ids = customers.map((c, i) => env.linked(c, `Shop ${i}`));
  env.local('client', { status: 'closed' }, 'update', ids[1].clientId);
  env.apply([om.customerDeleted(customers[2])]);
  env.setNow(at('2026-10-14 07:41'));
  const [run] = env.autos.tick();
  assert.equal(run.createdCount, NEW_TASKS_CAP);
  assert.match(run.summary, /^Made 10 check-ins; 1 more waiting/);
  const made = env.tasks();
  assert.ok(made.every((x) => x.owner === 'partner'), 'the wholesale business’s default owner');
  assert.ok(!made.some((x) => /Shop [12]\b/.test(x.title)), 'closed client and deleted customer: none');
  assert.match(made[0].title, /^Check in with Shop 0:/, 'most overdue first');
  env.setNow(at('2026-10-15 07:41'));
  assert.equal(env.autos.tick()[0].createdCount, 1, 'the one left over comes the next day');
});

test('the quiet flag reaches cards made before D3: the card fields are filled once, through sync', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  env.apply([om.customerCreated(c), ...['2026-08-01', '2026-08-15', '2026-08-29', '2026-09-12'].map((d) => om.orderPlaced(orderOn(om, c, d)))]);
  env.linked(c);
  assert.equal(env.svc.status().card_version, String(CARD_VERSION));
  assert.equal(env.svc.checkCardVersion(), false, 'already at this version');
  // An older database: its cards have no rhythm yet (as right after the migration added the columns).
  // Written on another connection: the sync guard (TEMP triggers) is only on the app's own.
  const other = openDb(env.config.dbPath);
  other.prepare('UPDATE wholesale_customers SET usual_gap_days = NULL, quiet_from = NULL').run();
  other.close();
  env.db.prepare("UPDATE wholesale_status SET value = '1' WHERE key = 'card_version'").run();
  const seqBefore = env.sync.info().cursor;
  assert.equal(env.svc.checkCardVersion(), true);
  assert.equal(env.svc.checkCardVersion(), false, 'once');
  env.svc.project();
  const after = env.card(c.customer_uid);
  assert.deepEqual([after.usual_gap_days, after.quiet_from], [14, '2026-10-04']);
  assert.notEqual(env.sync.info().cursor, seqBefore, 'written through sync: devices pull the change');
});

// ---- 2. balances -----------------------------------------------------------------------------

test('balance reminder: one task with a drafted email whose amounts match the holding area; kept up to date; paid off → finished', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const env = await setup(t, { config, clock });
  env.only(BALANCES_ID);
  env.setNow(at('2026-10-14 07:00'));
  const om = womKit();
  const c = om.customer({ business_name: 'Corner Store', contact_name: 'Pat Lee' });
  const o1 = orderOn(om, c, '2026-08-20'); // 10000 + 1300 tax = 11300
  const o2 = orderOn(om, c, '2026-09-01', 2000); // 2260
  const o3 = orderOn(om, c, '2026-10-01', 4000); // 4520: not 30 days old yet
  const oc = orderOn(om, c, '2026-08-25', 5000); // cancelled: nothing owing
  const oh = orderOn(om, c, '2026-07-01', 1000, { history_only: true }); // a past (catch-up) sale, unpaid: 1130 owing
  const p1 = om.payment(o1, 5000);
  const onAccount = om.payment(o1, 1000, { order_uid: null, order_number: null });
  const cn = om.creditNote(o3, { subtotal_cents: 1000, tax_cents: 130 });
  env.apply([
    om.customerCreated(c), om.orderPlaced(oh, { source: 'history_only' }), om.orderPlaced(o1), om.orderPlaced(oc), om.orderCancelled({ ...oc, status: 'cancelled' }),
    om.orderPlaced(o2), om.orderPlaced(o3), om.paymentRecorded(p1), om.paymentRecorded(onAccount), om.creditNoteIssued(cn),
  ]);
  const { accountId, clientId } = env.linked(c, 'Corner Store');
  env.setNow(at('2026-10-14 07:46'));
  const [run] = env.autos.tick();
  assert.deepEqual([run.automation, run.createdCount], [BALANCES_ID, 1]);
  assert.ok(run.alertId, 'alert by default');
  const [task] = env.tasks();
  // On account (1000) goes to the oldest: the history-only order (1130 → 130). o1: 11300 − 5000 = 6300. o2: 2260.
  const held = owingByOrder(
    env.db.prepare(`SELECT uid, number, status, deleted, order_date, placed_at, total_cents, snapshot IS NOT NULL AS has_snapshot
      FROM wholesale_held_orders WHERE customer_uid = ?`).all(c.customer_uid),
    env.db.prepare('SELECT kind, sub_kind, amount_cents, removed, order_uid FROM wholesale_held_money WHERE customer_uid = ?').all(c.customer_uid),
  );
  const overdue = overdueOrders(held, '2026-10-14');
  assert.deepEqual(overdue.map((o) => [o.number, o.owing_cents]), [[oh.number, 130], [o1.number, 6300], [o2.number, 2260]]);
  assert.equal(task.title, 'Balance owing over 30 days: Corner Store, $86.90 (3 orders)');
  assert.deepEqual([task.owner, task.business_id, task.client_id, task.account_id, task.relationship_id, task.due_date],
    ['owner', W, clientId, accountId, env.relOf(accountId), '2026-10-14']);
  assert.match(task.notes, /To: Pat Lee <pat@leftys\.ca>/);
  assert.match(task.notes, new RegExp(`• Order #${oh.number} from Jul 1, 2026: \\$1\\.30 owing \\(order total \\$11\\.30\\)`));
  assert.match(task.notes, new RegExp(`• Order #${o1.number} from Aug 20, 2026: \\$63\\.00 owing \\(order total \\$113\\.00\\)`));
  assert.match(task.notes, new RegExp(`• Order #${o2.number} from Sep 1, 2026: \\$22\\.60 owing\\n`));
  assert.match(task.notes, /Total owing: \$86\.90/);
  assert.match(task.notes, /You also have \$11\.30 in store credit with us/, 'the credit note is credit held, not taken off');
  assert.ok(!task.notes.includes(`#${o3.number} `) && !task.notes.includes(`#${oc.number} `), 'not 30 days old / cancelled');
  assert.ok(task.notes.endsWith(`${NOTES_MARK}\n`));

  // Once: again, Run now, the next day (nothing changed: no update, no alert), a restart.
  assert.deepEqual(env.autos.tick(), []);
  const now1 = env.autos.runNow(BALANCES_ID);
  assert.deepEqual([now1.createdCount, now1.alertId, now1.summary], [0, null, '1 reminder open, nothing changed']);
  await env.close();
  const env2 = await setup(t, { config, clock });
  env2.setNow(at('2026-10-15 07:46'));
  const r15 = env2.autos.tick().find((r) => r.automation === BALANCES_ID);
  assert.deepEqual([r15.createdCount, r15.alertId], [0, null]);
  assert.equal(env2.tasks().length, 1);

  // The person writes below the line; a payment comes in: the draft and title follow, their notes stay.
  const t1 = env2.tasks()[0];
  env2.local('task', { notes: `${t1.notes}Called Pat — paying Friday.` }, 'update', t1.id);
  env2.apply([om.paymentRecorded(om.payment(o1, 6300))]);
  env2.setNow(at('2026-10-16 07:46'));
  const r16 = env2.autos.tick().find((r) => r.automation === BALANCES_ID);
  assert.match(r16.summary, /^Brought 1 reminder up to date/);
  assert.ok(r16.alertId, 'a change in the money is worth an alert');
  const t2 = env2.tasks()[0];
  assert.equal(t2.title, 'Balance owing over 30 days: Corner Store, $23.90 (2 orders)');
  assert.match(t2.notes, /Total owing: \$23\.90/);
  assert.ok(t2.notes.endsWith(`${NOTES_MARK}\nCalled Pat — paying Friday.`));
  assert.equal(env2.tasks().length, 1, 'still one task');

  // Paid off (o3, from Oct 1, isn't 30 days old yet): nothing owing over 30 days → finished.
  env2.apply([om.paymentRecorded(om.payment(oh, 130)), om.paymentRecorded(om.payment(o2, 2260))]);
  env2.setNow(at('2026-10-17 07:46'));
  const r17 = env2.autos.tick().find((r) => r.automation === BALANCES_ID);
  assert.match(r17.summary, /^Finished 1 reminder \(paid\)/);
  const t3 = env2.tasks()[0];
  assert.ok(t3.done_at);
  assert.match(t3.notes, /Nothing owing over 30 days any more — finished by the suite on Oct 17, 2026\.$/);
  assert.equal(env2.tasks().length, 1, 'finished, never deleted, and nothing new');
});

test('balance reminder: finished by hand while still owed → not made again for that oldest order; a newer one comes due → a new one', async (t) => {
  const env = await setup(t);
  env.only(BALANCES_ID);
  env.setNow(at('2026-10-14 07:46'));
  const om = womKit();
  const c = om.customer({ business_name: 'Corner' });
  const o1 = orderOn(om, c, '2026-09-01');
  const o2 = orderOn(om, c, '2026-09-30');
  env.apply([om.customerCreated(c), om.orderPlaced(o1), om.orderPlaced(o2)]);
  env.linked(c, 'Corner', { contactEmail: null });
  env.autos.tick();
  const [first] = env.tasks();
  assert.match(first.notes, /To: \(no email on file for Corner: add one to a contact\)/);
  env.local('task', { done_at: new Date(at('2026-10-14 09:00')).toISOString() }, 'update', first.id);
  env.setNow(at('2026-10-20 07:46'));
  env.autos.tick();
  assert.equal(env.tasks('done_at IS NULL').length, 0, 'the person finished it: not again while order #1 is the oldest unpaid');
  // Order #1 paid; order #2 is now over 30 days and the oldest unpaid: a new reminder.
  env.apply([om.paymentRecorded(om.payment(o1, 11300))]);
  env.setNow(at('2026-11-01 07:46'));
  env.autos.tick();
  assert.deepEqual(env.tasks('done_at IS NULL').map((x) => x.title), ['Balance owing over 30 days: Corner, $113.00 (1 order)']);
});

// ---- 3. ready to ship --------------------------------------------------------------------------

test('ready to ship: packed → a task; shipped / cancelled / deleted / unpacked → finished; re-delivered events, backfill and unlinked customers do nothing', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const env = await setup(t, { config, clock });
  env.setNow(at('2026-10-14 10:00'));
  const om = womKit();
  const c = om.customer({ business_name: 'Lefty’s Vape Shop' });
  env.apply([om.customerCreated(c)]);
  const { clientId, accountId } = env.linked(c);
  const pack = (o, extra) => om.orderPacked({ ...o, packing: { ...o.packing, state: 'packed', packed_at: new Date(at('2026-10-14 09:30')).toISOString(), packed_by: 'sam' } }, extra);
  const ship = (o, via = 'delivered') => om.orderShipped({ ...o, packing: { ...o.packing, state: 'shipped', shipped_via: via } }, { via });

  const o1 = orderOn(om, c, '2026-10-13', 10000, { reference_number: 'PO-77' });
  env.apply([om.orderPlaced(o1)]);
  const packed = pack(o1);
  const res = env.apply([packed]);
  assert.deepEqual(res.map((r) => r.status), ['applied']);
  const [task] = env.tasks();
  assert.equal(task.title, `Ship order #${o1.number} for Lefty’s`);
  assert.deepEqual([task.owner, task.business_id, task.client_id, task.account_id, task.relationship_id, task.due_date, task.done_at],
    ['owner', W, clientId, accountId, env.relOf(accountId), '2026-10-14', null]);
  assert.match(task.notes, /^Packed in the Order Manager by sam \(Oct 14, 2026\)\.\nOrder #\d+ · PO-77 from Oct 13, 2026: \$113\.00\.\n1 × Zyn Cool Mint/);
  // Re-delivered (same key): duplicate, nothing emitted. The same event emitted twice: its run key holds.
  assert.deepEqual(env.apply([packed]).map((r) => r.status), ['duplicate']);
  const again = env.autos.emit('order.packed', { key: packed.key, name: 'order.packed', backfill: false, customerUid: c.customer_uid, orderUid: o1.order_uid, accountId, clientId, linked: true, data: packed.data });
  assert.deepEqual(again, [], 'the run key for that event is taken');
  // Packed again after a check-again: still one task.
  env.apply([pack(o1, { change: 'packed_again' })]);
  assert.equal(env.tasks().length, 1);
  // A restart, then the Order Manager re-sends (lost reply): nothing new.
  await env.close();
  const env2 = await setup(t, { config, clock });
  assert.deepEqual(env2.apply([packed]).map((r) => r.status), ['duplicate']);
  assert.equal(env2.tasks().length, 1);
  // Shipped → finished (never deleted).
  env2.apply([ship(o1, 'eshipper')]);
  const [shipped] = env2.tasks();
  assert.ok(shipped.done_at);
  assert.match(shipped.notes, /Shipped in the Order Manager \(eShipper\) — finished by the suite on Oct 14, 2026\.$/);

  // Cancelled, deleted, unpacked: each finishes its own task. Re-packed after an unpack: a new one.
  const [o2, o3, o4] = ['2026-10-13', '2026-10-13', '2026-10-13'].map((d) => orderOn(om, c, d));
  env2.apply([om.orderPlaced(o2), om.orderPlaced(o3), om.orderPlaced(o4), pack(o2), pack(o3), pack(o4)]);
  assert.equal(env2.tasks('done_at IS NULL').length, 3);
  env2.apply([om.orderCancelled({ ...o2, status: 'cancelled', packing: { ...o2.packing, state: 'cancelled_packed' } })]);
  env2.apply([om.orderDeleted({ ...o3, packing: { ...o3.packing, state: 'packed' } })]);
  env2.apply([om.orderPacked({ ...o4, packing: { ...o4.packing, state: 'to_pack' } }, { change: 'unpacked' })]);
  const byTitle = (n) => env2.tasks('title = ?', `Ship order #${n} for Lefty’s`);
  assert.match(byTitle(o2.number)[0].notes, /Cancelled in the Order Manager — finished/);
  assert.match(byTitle(o3.number)[0].notes, /Deleted in the Order Manager — finished/);
  assert.match(byTitle(o4.number)[0].notes, /Unpacked in the Order Manager \(no longer ready to ship\) — finished/);
  assert.equal(env2.tasks('done_at IS NULL').length, 0);
  env2.apply([pack(o4)]);
  assert.deepEqual(byTitle(o4.number).map((x) => Boolean(x.done_at)), [true, false], 'packed again: a new task, the old one stays finished');

  // Backfill events never trigger anything (no task, no run).
  const runsBefore = env2.runs(SHIP_ID).length;
  const o5 = orderOn(om, c, '2026-10-12');
  env2.apply([om.orderPlaced(o5, { backfill: true, source: 'backfill' }), { ...pack(o5), data: { ...pack(o5).data, backfill: true } }]);
  assert.equal(byTitle(o5.number).length, 0);
  assert.equal(env2.runs(SHIP_ID).length, runsBefore, 'no run at all');

  // An unlinked customer's packed order: nothing; linking later replays nothing.
  const stranger = om.customer({ business_name: 'Stranger' });
  const os = orderOn(om, stranger, '2026-10-13');
  env2.apply([om.customerCreated(stranger), om.orderPlaced(os), pack(os)]);
  assert.equal(env2.runs(SHIP_ID).length, runsBefore);
  env2.linked(stranger, 'Stranger');
  assert.equal(env2.tasks('title LIKE ?', '%Stranger%').length, 0);
  // Only tasks (and no alert while silent) were ever made: nothing sent anywhere.
  assert.equal(env2.db.prepare('SELECT count(*) AS n FROM automations_alerts').get().n, 0);
});

test('switched off, the ready-to-ship automation makes nothing; Run now explains it runs on events', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  env.apply([om.customerCreated(c)]);
  env.linked(c);
  env.autos.setSettings(SHIP_ID, { enabled: false }, { actor: 'owner' });
  const o = orderOn(om, c, '2026-10-01');
  env.apply([om.orderPlaced(o), om.orderPacked({ ...o, packing: { ...o.packing, state: 'packed' } })]);
  assert.equal(env.tasks().length, 0);
  const r = env.autos.runNow(SHIP_ID);
  assert.deepEqual([r.status, r.createdCount], ['ok', 0]);
  assert.match(r.summary, /Runs when the Order Manager packs an order/);
  const view = env.autos.get(SHIP_ID);
  assert.equal(view.when, 'When the Order Manager packs an order (finished when it ships, is cancelled or deleted)');
  assert.deepEqual(view.trigger.events, ['order.packed', 'order.shipped', 'order.cancelled', 'order.deleted', 'order.restored']);
});
