// The overview (D11): GET /api/overview — sales per business (only those with sales, in our order) for today, this
// week and this month with the combined total per currency, and the list of what needs dealing with, in the plan's
// order: overdue tasks (both people and the shared list), wholesale balances over 30 days, renewals and retainers in
// 30 days (client services and our costs), low stock (Stockroom), support emails (not connected yet), payments with no
// order to go against, relationships and leads with no next step, quiet clients.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, testClock } from './helpers.js';
import { womKit, postEvents } from './fixtures/wom.js';
import { ATTENTION_SECTIONS, MAX_ITEMS } from '../src/modules/overview/service.js';

const TODAY = '2026-10-14';
const NOW = '2026-10-14T15:00:00Z';

async function setup(t) {
  const clock = testClock();
  clock.offsetMs = Date.parse(NOW) - Date.now();
  const env = await startApp(t, testConfig(tmpDir(t)), { now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const partner = sessionFor(env.ctx, users.partner);
  const call = async (method, url, body, session = owner) => {
    const res = await fetch(`${env.base}${url}`, {
      method, headers: { cookie: session.cookie, origin: env.base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const local = (entity, fields, { actor = 'owner', stampMs } = {}) => {
    const r = env.ctx.services.sync.applyLocal({ actor, entity, op: 'create', fields, ...(stampMs ? { stampMs } : {}) });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const overview = async (session = owner, today = TODAY) => call('GET', `/api/overview?today=${today}`, undefined, session);
  const section = (body, id) => body.attention.find((s) => s.id === id);
  return { ...env, clock, call, local, overview, section, partner };
}

test('an empty suite: every section in the plan’s order, counts of 0, the outside ones not connected', async (t) => {
  const { overview, section } = await setup(t);
  const r = await overview();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.today, TODAY);
  assert.deepEqual(r.body.attention.map((s) => s.id), [...ATTENTION_SECTIONS]);
  assert.deepEqual(['overdue', 'renewals', 'noNextStep', 'quiet'].map((id) => section(r.body, id).count), [0, 0, 0, 0]);
  assert.deepEqual(['balances', 'payments', 'lowStock', 'support'].map((id) => section(r.body, id).state), ['not_connected', 'not_connected', 'not_connected', 'not_connected']);
  assert.equal(section(r.body, 'support').comesWith, 'the helpdesk (D14)');
  assert.deepEqual(r.body.sales.businesses, [], 'no business has sales yet (eBay’s card, not set up, doesn’t count)');
});

test('overdue tasks: both people’s and the shared list’s, oldest first, "mine" from who is asking', async (t) => {
  const { local, overview, section, partner } = await setup(t);
  const task = (title, owner, due_date, extra = {}) => local('task', { title, owner, business_id: BUSINESS_IDS.personal, due_date, ...extra });
  task('Call the accountant', 'owner', '2026-10-10');
  task('Order labels', 'partner', '2026-10-01');
  task('Renew the domain', 'shared', '2026-10-13');
  task('Due today', 'owner', TODAY);
  task('Done already', 'owner', '2026-10-02', { done_at: '2026-10-03T12:00:00.000Z' });
  task('No date', 'owner', null);
  const mine = section((await overview()).body, 'overdue');
  assert.equal(mine.count, 3);
  assert.deepEqual(mine.items.map((i) => [i.title, i.whose, i.dueDate]), [
    ['Order labels', 'partner', '2026-10-01'], ['Call the accountant', 'mine', '2026-10-10'], ['Renew the domain', 'shared', '2026-10-13'],
  ]);
  assert.equal(mine.items[0].business, 'Personal');
  const theirs = section((await overview(partner)).body, 'overdue');
  assert.deepEqual(theirs.items.map((i) => i.whose), ['mine', 'partner', 'shared']);
});

test('wholesale: balances over 30 days (the Balances page’s aging), payments with no order to go against', async (t) => {
  const { call, overview, section, base, clock } = await setup(t);
  const secret = (await call('POST', '/api/wholesale/connection/secret', {})).body.secret;
  const om = womKit();
  const late = om.customer({ business_name: 'Northwind Corner Store' });
  const old1 = om.order(late, [{ name: 'Zyn', quantity: 10, unit_price_cents: 1000 }], { order_date: addDays(TODAY, -45) }); // 11300
  const old2 = om.order(late, [{ name: 'ALP', quantity: 5, unit_price_cents: 1000 }], { order_date: addDays(TODAY, -40) }); // 5650
  const fresh = om.order(late, [{ name: 'Velo', quantity: 2, unit_price_cents: 1000 }], { order_date: addDays(TODAY, -3) }); // 2260
  // Paid on account 20 days ago, no order since: listed. A regular depositor (paid ahead last week, ordering every week)
  // and a payment made two days ago: not (review decision: credit an ordering customer uses up isn't a problem).
  const ahead = om.customer({ business_name: 'Bayview Variety' });
  const onAccount = om.payment({ order_uid: null, customer_uid: ahead.customer_uid, number: null, order_date: addDays(TODAY, -20) }, 5000, { created_at: `${addDays(TODAY, -20)}T15:00:00.000Z` });
  const regular = om.customer({ business_name: 'Weekly Smoke Shop' });
  const weekly = om.order(regular, [{ name: 'Zyn', quantity: 1, unit_price_cents: 1000 }], { order_date: addDays(TODAY, -5) }); // 1130
  const deposit = om.payment({ order_uid: null, customer_uid: regular.customer_uid, number: null, order_date: addDays(TODAY, -40) }, 50000, { created_at: `${addDays(TODAY, -40)}T15:00:00.000Z` });
  const fresh2 = om.customer({ business_name: 'Fresh Start Variety' });
  const justPaid = om.payment({ order_uid: null, customer_uid: fresh2.customer_uid, number: null, order_date: addDays(TODAY, -2) }, 3000, { created_at: `${addDays(TODAY, -2)}T15:00:00.000Z` });
  const paidUp = om.customer({ business_name: 'Harbour Smoke' });
  const hp = om.order(paidUp, [{ name: 'Zyn', quantity: 1, unit_price_cents: 1000 }], { order_date: addDays(TODAY, -50) });
  const r = await postEvents(base, secret, [
    om.customerCreated(late), om.orderPlaced(old1), om.orderPlaced(old2), om.orderPlaced(fresh),
    om.paymentRecorded(om.payment(old2, 2000)),
    om.customerCreated(ahead), om.paymentRecorded(onAccount),
    om.customerCreated(paidUp), om.orderPlaced(hp), om.paymentRecorded(om.payment(hp, 1130)),
    om.customerCreated(regular), om.orderPlaced(weekly), om.paymentRecorded(deposit),
    om.customerCreated(fresh2), om.paymentRecorded(justPaid),
  ], { ts: Math.floor(clock.now() / 1000) });
  assert.equal(r.status, 200);
  const body = (await overview()).body;
  const balances = section(body, 'balances');
  // 11300 + 5650 − 2000 paid (oldest first) = 14950 owing on the two old orders; the fresh one isn't 30 days old.
  assert.deepEqual([balances.state, balances.count, balances.totalCents], ['ok', 1, 14950]);
  assert.deepEqual(balances.items.map((i) => [i.name, i.overdueCents, i.orders, i.oldestDate]), [['Northwind Corner Store', 14950, 2, addDays(TODAY, -45)]]);
  const payments = section(body, 'payments');
  assert.deepEqual(payments.items.map((i) => [i.name, i.unusedCents]), [['Bayview Variety', 5000]]);
  assert.deepEqual([payments.count, payments.customers, payments.unmatched], [1, 1, null], 'the Order Manager hasn’t sent its e-Transfer count');
  // Its A19 count of unmatched e-Transfers: counted in the section, shown as its own line.
  const um = { name: 'payments.unmatched', version: 1, key: newId(), source: 'wom', time: new Date(clock.now()).toISOString(), data: { by: null, count: 3, total_cents: 45000, oldest_at: '2026-10-02T13:00:00.000Z', page: '/customers/etransfers' } };
  assert.equal((await postEvents(base, secret, [um], { ts: Math.floor(clock.now() / 1000) })).body.results[0].status, 'applied');
  const again = section((await overview()).body, 'payments');
  assert.deepEqual([again.count, again.unmatched.count, again.unmatched.totalCents, again.unmatched.page], [4, 3, 45000, '/customers/etransfers']);
  await call('PUT', '/api/connections/wom', { paused: true });
  assert.equal(section((await overview()).body, 'balances').state, 'paused', 'paused: still the last known figures, marked');
});

test('renewals and retainers in 30 days (client services and our costs), relationships and leads with no next step, quiet clients', async (t) => {
  const { local, overview, section, clock, ctx } = await setup(t);
  const longAgo = Date.parse(NOW) - 90 * 86_400_000;
  const clientId = local('client', { name: 'Lefty’s', status: 'active' }, { stampMs: longAgo });
  const accountId = local('account', { client_id: clientId, name: 'Lefty’s Vape Shop' }, { stampMs: longAgo });
  const rel = local('relationship', { account_id: accountId, business_id: BUSINESS_IDS.agency, kind: 'website', status: 'active' }, { stampMs: longAgo });
  local('service', { relationship_id: rel, name: 'Hosting', status: 'active', billing: 'flat', amount_cents: 48000, period: 'yearly', renewal_date: addDays(TODAY, 10) });
  local('service', { relationship_id: rel, name: 'Retainer', status: 'active', billing: 'flat', amount_cents: 50000, period: 'monthly', renewal_date: addDays(TODAY, 2) });
  local('service', { relationship_id: rel, name: 'Far off', status: 'active', renewal_date: addDays(TODAY, 45) });
  local('recurring_cost', { name: 'Domain', business_id: BUSINESS_IDS.agency, amount_cents: 2000, period: 'yearly', next_renewal: addDays(TODAY, 5), auto_renews: false });
  // A second client, recently active: not quiet; its relationship has a dated next step.
  const busy = local('client', { name: 'Busy Bee', status: 'active' });
  const busyAcc = local('account', { client_id: busy, name: 'Busy Bee Ltd' });
  const busyRel = local('relationship', { account_id: busyAcc, business_id: BUSINESS_IDS.consulting, kind: 'consulting', status: 'active' });
  local('task', { title: 'Send the proposal', owner: 'owner', business_id: BUSINESS_IDS.consulting, relationship_id: busyRel, client_id: busy, due_date: addDays(TODAY, 3) });
  local('activity', { client_id: busy, type: 'note', body: 'Met', at: new Date(clock.now()).toISOString() });
  local('lead', { name: 'Maple Dental', business_id: BUSINESS_IDS.agency, kind: 'website', stage: 'talking' });
  // A closed client's active relationship: flagged on Today and in the Friday review, so here too (one rule).
  const closed = local('client', { name: 'Old Shop', status: 'closed' });
  const closedAcc = local('account', { client_id: closed, name: 'Old Shop Inc' });
  local('relationship', { account_id: closedAcc, business_id: BUSINESS_IDS.consulting, kind: 'consulting', status: 'active' });
  const body = (await overview()).body;
  const renewals = section(body, 'renewals');
  assert.deepEqual(renewals.items.map((i) => [i.kind, i.name, i.date]), [
    ['service', 'Retainer', addDays(TODAY, 2)], ['cost', 'Domain', addDays(TODAY, 5)], ['service', 'Hosting', addDays(TODAY, 10)],
  ]);
  assert.deepEqual([renewals.count, renewals.services, renewals.costs], [3, 2, 1]);
  assert.equal(renewals.items[0].accountName, 'Lefty’s Vape Shop');
  const nns = section(body, 'noNextStep');
  assert.deepEqual(nns.items.map((i) => [i.kind, i.accountName ?? i.name]), [['relationship', 'Lefty’s Vape Shop'], ['relationship', 'Old Shop Inc'], ['lead', 'Maple Dental']]);
  assert.deepEqual([nns.relationships, nns.leads], [2, 1]);
  const { reviewNumbers } = await import('../src/modules/planner/automations.js');
  assert.equal(reviewNumbers({ crm: ctx.services.crm, planner: ctx.services.planner, services: ctx.services }, TODAY).noNextStep, 2, 'the Friday review’s count is the same');
  const quiet = section(body, 'quiet');
  assert.deepEqual(quiet.items.map((i) => i.name), ['Lefty’s'], 'quiet for 60 days (made 90 days ago, nothing since)');
  assert.equal(quiet.days, 60);
});

test('low stock: Stockroom’s order-soon items with something to reorder, most urgent first', async (t) => {
  const { db, overview, section } = await setup(t);
  db.prepare(`INSERT INTO stockroom_connection (id, hub_url, reader_key, secret_enc, set_at, set_by) VALUES (1, 'https://stockroom.example', 'suite.0123456789ab', 'v1:x:y:z', ?, 'owner')`).run(NOW);
  assert.equal(section((await overview()).body, 'lowStock').state, 'not_read');
  const body = { version: 1, as_of: NOW, items: [
    { sku: 'ZYN-CM6', name: 'Zyn Cool Mint 6mg', supplier_id: 1, supplier: 'Swedish Match', suggested_qty: 50, days_left: 3, runs_out_on: '2026-10-17', available: 12 },
    { sku: 'ALP-MF', name: 'ALP Mango', supplier_id: 2, supplier: 'ALP', suggested_qty: 20, days_left: 9, available: 30 },
    { sku: 'VELO-F', name: 'Velo Freeze', suggested_qty: 0, days_left: 40 },
    { sku: 'NEW', name: 'New flavour', suggested_qty: null },
  ] };
  db.prepare(`INSERT INTO stockroom_pulls (endpoint, hub_url, body, as_of, fetched_at, changed_at) VALUES ('order-soon', 'https://stockroom.example', ?, ?, ?, ?)`)
    .run(JSON.stringify(body), NOW, NOW, NOW);
  const low = section((await overview()).body, 'lowStock');
  assert.deepEqual([low.state, low.count], ['ok', 2]);
  assert.deepEqual(low.items.map((i) => [i.name, i.suggestedQty, i.daysLeft, i.supplier]), [['Zyn Cool Mint 6mg', 50, 3, 'Swedish Match'], ['ALP Mango', 20, 9, 'ALP']]);
});

test('sales: each business with sales, in our order, today / this week / this month, the combined total per currency', async (t) => {
  const { call, overview } = await setup(t);
  const add = (businessId, day, amount, extra = {}) => call('POST', '/api/sales/entries', { id: newId(), businessId, day, kind: 'sale', amount, ...extra });
  await add(BUSINESS_IDS.consulting, TODAY, 100000, { orders: 1 });
  await add(BUSINESS_IDS.agency, addDays(TODAY, -1), 250000);
  await add(BUSINESS_IDS.agency, TODAY, 5000, { currency: 'USD' });
  const { sales } = (await overview()).body;
  // Our businesses' order (wholesale, agency = GWND, consulting, Save Point Shop, retail, personal), only those with
  // sales: eBay's card is always on Money → Sales, but not set up and empty it doesn't put Save Point Shop here.
  assert.deepEqual(sales.businesses.map((b) => b.businessId), [BUSINESS_IDS.agency, BUSINESS_IDS.consulting]);
  const agency = sales.businesses[0];
  assert.deepEqual(agency.week.map((f) => [f.currency, f.total]), [['CAD', 250000], ['USD', 5000]]);
  assert.deepEqual(agency.today.map((f) => [f.currency, f.total]), [['USD', 5000]]);
  assert.deepEqual(sales.overall.week.map((f) => [f.currency, f.total, f.totalOnly]), [['CAD', 350000, true], ['USD', 5000, true]], 'never added across currencies');
});

test('items are capped (the count is the whole number); a bad `today` falls back to the server’s day', async (t) => {
  const { local, overview, section, call, base } = await setup(t);
  for (let i = 0; i < MAX_ITEMS + 5; i += 1) local('task', { title: `Old ${i}`, owner: 'shared', business_id: BUSINESS_IDS.personal, due_date: '2026-09-01' });
  const s = section((await overview()).body, 'overdue');
  assert.deepEqual([s.count, s.items.length], [MAX_ITEMS + 5, MAX_ITEMS]);
  const r = await call('GET', '/api/overview?today=2026-13-45');
  assert.equal(r.body.today, TODAY);
  assert.equal((await fetch(`${base}/api/overview`)).status, 401, 'signed in only');
});
