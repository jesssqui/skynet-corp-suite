// The overview's business cards and the goals scorecard (D15): GET /api/overview's `cards` (wholesale, stock, web and
// social, consulting, Save Point Shop, clients, all businesses, retail stores — each with its data or a clear "not
// connected") and `goals` (each business's monthly targets against what the month brought, with the pace, beside its
// month priorities); GET /api/overview/targets for any month; the synced `target` record's rules. The plan's "done
// when": every card shows its data or a clear "not connected", and each target shows actual against target.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, testClock } from './helpers.js';
import { modules } from '../src/modules/index.js';
import { womKit, postEvents } from './fixtures/wom.js';
import { CARD_IDS } from '../src/modules/overview/service.js';
import { startFakeImap, email } from './fixtures/imapFake.js';
import { startFakeWoo, STORE_KEY, STORE_SECRET } from './fixtures/wooStore.js';

const B = BUSINESS_IDS;
const TODAY = '2026-10-14';
const NOW = '2026-10-14T15:00:00Z';

async function setup(t, { extraModules = [], config = {} } = {}) {
  const clock = testClock();
  clock.offsetMs = Date.parse(NOW) - Date.now();
  const env = await startApp(t, testConfig(tmpDir(t), config), { now: clock.now, modules: [...modules, ...extraModules] });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const call = async (method, url, body, session = owner) => {
    const res = await fetch(`${env.base}${url}`, {
      method, headers: { cookie: session.cookie, origin: env.base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const apply = (entity, fields, { op = 'create', recordId, actor = 'owner', stampMs } = {}) => env.ctx.services.sync.applyLocal({ actor, entity, op, ...(recordId ? { recordId } : {}), fields, ...(stampMs ? { stampMs } : {}) });
  const local = (entity, fields, opts) => {
    const r = apply(entity, fields, opts);
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const overview = async (today = TODAY) => (await call('GET', `/api/overview?today=${today}`)).body;
  const cardOf = (body, id) => body.cards.find((c) => c.id === id);
  const sale = (businessId, day, amount, extra = {}) => call('POST', '/api/sales/entries', { id: newId(), businessId, day, kind: 'sale', amount, ...extra });
  return { ...env, clock, call, apply, local, overview, cardOf, sale };
}

test('an empty suite: every card in the plan’s order, each with its figures or a clear “not connected”', async (t) => {
  const { overview, cardOf } = await setup(t);
  const body = await overview();
  assert.deepEqual(body.cards.map((c) => c.id), [...CARD_IDS]);
  assert.deepEqual(['wholesale', 'stock', 'savePoint', 'retail'].map((id) => cardOf(body, id).state), ['not_connected', 'not_connected', 'not_set_up', 'not_connected']);
  // The helpdesk (D14) is there but no support mailbox has been added: says where to add one.
  assert.deepEqual(cardOf(body, 'retail').support, { state: 'not_connected', setUp: 'System → Connections → Support mailboxes' });
  const web = cardOf(body, 'web');
  assert.deepEqual([web.state, web.relationships.total, web.services.active, web.renewals.count, web.pipeline.openCount], ['ok', 0, 0, 0, 0]);
  assert.deepEqual(Object.keys(web.relationships.byKind), ['website', 'social']);
  assert.deepEqual(Object.keys(cardOf(body, 'consulting').relationships.byKind), ['consulting']);
  const clients = cardOf(body, 'clients');
  assert.deepEqual([clients.state, clients.active, clients.newThisMonth, clients.quiet, clients.openLeads], ['ok', 0, 0, 0, 0]);
  const all = cardOf(body, 'allBusinesses');
  assert.deepEqual([all.state, all.months], ['ok', ['2026-08', '2026-09', '2026-10']]);
  assert.deepEqual([body.goals.state, body.goals.month, body.goals.businesses], ['ok', '2026-10', []]);
});

test('targets: each shows actual against target with the pace; priorities beside them; two set offline → the newer, the other offered for removal', async (t) => {
  const { local, apply, sale, overview, call } = await setup(t);
  // Sales this month: consulting $1,500 by hand (one order), $400 last month.
  await sale(B.consulting, '2026-10-02', 100000, { orders: 1 });
  await sale(B.consulting, TODAY, 50000);
  await sale(B.consulting, '2026-09-20', 40000);
  const target = (businessId, measure, amount, extra = {}) => local('target', { business_id: businessId, month: '2026-10-01', measure, amount, ...extra });
  const salesT = target(B.consulting, 'sales', 300000);
  target(B.consulting, 'net_sales', 200000);
  target(B.consulting, 'orders', 4);
  target(B.agency, 'new_clients', 2);
  target(B.agency, 'won_leads', 1);
  // New clients for GWND this month: a client whose first relationship with it started this month (counted once, with
  // a second one this month too), one whose first started in September (a second this month doesn't make it new), and
  // one with no start date (as an import makes them: not counted).
  const client = local('client', { name: 'Maple Dental', status: 'active' });
  const acc = local('account', { client_id: client, name: 'Maple Dental' });
  local('relationship', { account_id: acc, business_id: B.agency, kind: 'website', status: 'active', start_date: '2026-10-05' });
  local('relationship', { account_id: acc, business_id: B.agency, kind: 'social', status: 'active', start_date: '2026-10-09' });
  const older = local('client', { name: 'Harbour Books', status: 'active' });
  const olderAcc = local('account', { client_id: older, name: 'Harbour Books' });
  local('relationship', { account_id: olderAcc, business_id: B.agency, kind: 'social', status: 'active', start_date: '2026-09-05' });
  local('relationship', { account_id: olderAcc, business_id: B.agency, kind: 'website', status: 'active', start_date: '2026-10-03' });
  const imported = local('client', { name: 'From the accounting list', status: 'active' });
  const importedAcc = local('account', { client_id: imported, name: 'From the accounting list' });
  local('relationship', { account_id: importedAcc, business_id: B.agency, kind: 'website', status: 'active' });
  local('lead', { name: 'Harbour Books', business_id: B.agency, kind: 'website', stage: 'won', won_client_id: client, closed_at: '2026-10-10T15:00:00.000Z' });
  local('lead', { name: 'Old win', business_id: B.agency, kind: 'website', stage: 'won', won_client_id: client, closed_at: '2026-09-10T15:00:00.000Z' });
  // A month priority of consulting (C4b), shown beside its targets.
  local('goal', { kind: 'month', period: '2026-10-01', business_id: B.consulting, title: 'Sign two retainers', target: 2, progress: 1 });
  const body = await overview();
  const goals = body.goals;
  assert.deepEqual(goals.businesses.map((b) => b.businessId), [B.agency, B.consulting], 'our businesses’ order');
  const consulting = goals.businesses[1];
  const m = Object.fromEntries(consulting.targets.map((x) => [x.measure, x]));
  assert.deepEqual([m.sales.actual, m.sales.amount, m.sales.currency], [150000, 300000, 'CAD']);
  // Oct 14: 13 of 31 days complete — a straight line expects $1,258.06; $1,500 is ahead; carried on: $3,576.92.
  assert.deepEqual([m.sales.pace.status, m.sales.pace.expected, m.sales.pace.projected, m.sales.pace.pct], ['ahead', 125806, 357692, 50]);
  assert.deepEqual([m.net_sales.actual, m.net_sales.reason, m.net_sales.pace.status], [null, 'total_only', 'unknown'], 'sales entered by hand only have a total');
  assert.deepEqual([m.orders.actual, m.orders.partial, m.orders.pace.status], [1, true, 'behind']);
  assert.deepEqual(consulting.priorities.map((p) => [p.title, p.target, p.progress]), [['Sign two retainers', 2, 1]]);
  const agency = Object.fromEntries(goals.businesses[0].targets.map((x) => [x.measure, x]));
  assert.deepEqual([agency.new_clients.actual, agency.new_clients.pace.status], [1, 'on_pace'], 'Maple Dental only, once');
  assert.deepEqual([agency.won_leads.actual, agency.won_leads.pace.status], [1, 'reached']);

  // The same target set on another device offline: the one changed last is used, the other listed to remove.
  const twin = local('target', { business_id: B.consulting, month: '2026-10-01', measure: 'sales', amount: 500000 });
  const again = (await overview()).goals.businesses[1].targets.find((x) => x.measure === 'sales');
  assert.deepEqual([again.id, again.amount, again.extras], [twin, 500000, [salesT]]);

  // Any month on its own (the monthly plan's "so far"): September — missed / not set.
  local('target', { business_id: B.consulting, month: '2026-09-01', measure: 'sales', amount: 50000 });
  const sep = await call('GET', `/api/overview/targets?month=2026-09&today=${TODAY}`);
  assert.equal(sep.status, 200);
  const st = sep.body.businesses[0].targets[0];
  assert.deepEqual([st.actual, st.pace.status, st.pace.pct], [40000, 'missed', 80]);
  assert.equal((await call('GET', '/api/overview/targets?month=2026-9')).status, 400);

  // The record's rules (any arrival order): a month is a 1st, the amount above 0; business, month and measure never change.
  assert.equal(apply('target', { business_id: B.consulting, month: '2026-10-02', measure: 'sales', amount: 1 }).code, 'invalid_value');
  assert.equal(apply('target', { business_id: B.consulting, month: '2026-10-01', measure: 'sales', amount: 0 }).code, 'invalid_value');
  assert.equal(apply('target', { measure: 'orders' }, { op: 'update', recordId: twin }).code, 'invalid_value');
  assert.equal(apply('target', { currency: 'USD' }, { op: 'update', recordId: twin }).code, 'invalid_value', 'a different currency is a new target');
  assert.equal(apply('target', { amount: 450000 }, { op: 'update', recordId: twin }).status, 'applied');
  assert.ok((await call('GET', '/api/sync/info')).body.entities.some((e) => e.entity === 'target'), 'devices learn it (set offline)');
});

test('wholesale: this month’s and last month’s sales, owed and over 30 days, payments this month, quiet regulars, packed orders', async (t) => {
  const { call, overview, cardOf, base, clock, local, db } = await setup(t);
  const secret = (await call('POST', '/api/wholesale/connection/secret', {})).body.secret;
  assert.equal(cardOf(await overview(), 'wholesale').state, 'ok', 'set up: shown, even with nothing yet');
  const om = womKit();
  const at = (day) => `${day}T15:00:00.000Z`;
  const shop = om.customer({ business_name: 'Northwind Corner Store' });
  const sept = om.order(shop, [{ name: 'Zyn', quantity: 10, unit_price_cents: 1000 }], { order_date: '2026-09-02', created_at: at('2026-09-02') }); // 11300
  const oct = om.order(shop, [{ name: 'ALP', quantity: 5, unit_price_cents: 1000 }], { order_date: '2026-10-03', created_at: at('2026-10-03'), packing: 'packed' }); // 5650
  const paidOct = om.payment(oct, 2000, { created_at: at('2026-10-06') });
  const paidSep = om.payment(sept, 1000, { created_at: at('2026-09-30') });
  // A regular (weekly, four order days) who has gone quiet, linked to a client.
  const regular = om.customer({ business_name: 'Weekly Smoke Shop' });
  const weekly = [-100, -93, -86, -79].map((d) => om.order(regular, [{ name: 'Zyn', quantity: 1, unit_price_cents: 1000 }], { order_date: addDays(TODAY, d), created_at: at(addDays(TODAY, d)) }));
  const paidAll = weekly.map((o) => om.payment(o, 1130, { created_at: o.created_at }));
  const r = await postEvents(base, secret, [
    om.customerCreated(shop), om.orderPlaced(sept), om.orderPlaced(oct), om.paymentRecorded(paidOct), om.paymentRecorded(paidSep),
    om.customerCreated(regular), ...weekly.map((o) => om.orderPlaced(o)), ...paidAll.map((p) => om.paymentRecorded(p)),
  ], { ts: Math.floor(clock.now() / 1000) });
  assert.equal(r.status, 200);
  let card = cardOf(await overview(), 'wholesale');
  assert.equal(card.quietRegulars, 0, 'not linked: not one of our clients’ regulars');
  assert.equal((await call('POST', `/api/wholesale/customers/${regular.customer_uid}/create-client`, {})).status, 200);
  card = cardOf(await overview(), 'wholesale');
  assert.deepEqual(card.month.map((f) => [f.currency, f.total, f.orders]), [['CAD', 5650, 1]]);
  assert.deepEqual(card.lastMonth.map((f) => [f.currency, f.total, f.orders]), [['CAD', 11300, 1]]);
  // Owed: 11300 + 5650 − 3000 paid = 13950 by one customer; over 30 days: the September order, paid oldest first → 8300.
  assert.deepEqual(card.owing, { cents: 13950, customers: 1 });
  assert.deepEqual(card.overdue, { cents: 8300, customers: 1 });
  assert.deepEqual(card.paidThisMonth, { cents: 2000, payments: 1 }, 'October’s payments only');
  assert.equal(card.quietRegulars, 1);
  assert.deepEqual([card.toShip.orders, card.toShip.totalCents], [1, 5650]);
  // Closed client: no longer counted (as the flag and the check-ins).
  const { client_id: clientId } = db.prepare('SELECT client_id FROM wholesale_held_customers WHERE uid = ?').get(regular.customer_uid);
  local('client', { status: 'closed' }, { op: 'update', recordId: clientId });
  assert.equal(cardOf(await overview(), 'wholesale').quietRegulars, 0);
  await call('PUT', '/api/connections/wom', { paused: true });
  assert.equal(cardOf(await overview(), 'wholesale').state, 'paused');
});

test('stock: Stockroom’s last answers — counts, differences, reorders, deliveries; not read, revoked', async (t) => {
  const { db, overview, cardOf } = await setup(t);
  db.prepare(`INSERT INTO stockroom_connection (id, hub_url, reader_key, secret_enc, set_at, set_by) VALUES (1, 'https://stockroom.example', 'suite.0123456789ab', 'v1:x:y:z', ?, 'owner')`).run(NOW);
  assert.equal(cardOf(await overview(), 'stock').state, 'not_read');
  const put = (endpoint, body) => db.prepare(`INSERT INTO stockroom_pulls (endpoint, hub_url, body, as_of, fetched_at, changed_at) VALUES (?, 'https://stockroom.example', ?, ?, ?, ?)`)
    .run(endpoint, JSON.stringify({ version: 1, as_of: NOW, ...body }), NOW, NOW, NOW);
  put('counts', { last_full_count: { applied_at: '2026-10-05T14:00:00.000Z' }, last_spot_check: { applied_at: '2026-10-12T14:00:00.000Z' }, due: true, overdue: false, accuracy: { last_30_days: { pct_matched: 97.5 } } });
  put('differences', { threshold_tins: 3, open: 2, truncated: false, items: [{ id: 1, variance: -4, value_cents: -2600 }, { id: 2, variance: 1, value_cents: 650 }] });
  put('order-soon', { items: [
    { sku: 'A', name: 'Zyn Mint', supplier_id: 1, supplier: 'Swedish Match', suggested_qty: 50, status: 'out' },
    { sku: 'B', name: 'Zyn Citrus', supplier_id: 1, supplier: 'Swedish Match', suggested_qty: 20 },
    { sku: 'C', name: 'ALP Mango', supplier_id: 2, supplier: 'ALP', suggested_qty: 10 },
    { sku: 'D', name: 'Velo', suggested_qty: 0 },
  ] });
  put('deliveries', { counts: { orders: 2, tins: 300, overdue: 1 }, items: [{ po_id: 1, expected_on: '2026-10-20', overdue: false }, { po_id: 2, expected_on: '2026-10-10', overdue: true }] });
  const s = cardOf(await overview(), 'stock');
  assert.equal(s.state, 'ok');
  assert.deepEqual([s.counts.lastFullCountAt, s.counts.lastSpotCheckAt, s.counts.due, s.counts.pctMatched30Days], ['2026-10-05T14:00:00.000Z', '2026-10-12T14:00:00.000Z', true, 97.5]);
  assert.deepEqual([s.differences.open, s.differences.valueCents], [2, 3250]);
  assert.deepEqual([s.reorder.products, s.reorder.suppliers, s.reorder.out], [3, 2, 1]);
  assert.deepEqual([s.deliveries.expected, s.deliveries.tins, s.deliveries.overdue, s.deliveries.nextOn], [2, 300, 1, '2026-10-10']);
  db.prepare('UPDATE stockroom_connection SET revoked_at = ?').run(NOW);
  assert.equal(cardOf(await overview(), 'stock').state, 'revoked');
});

test('web and social, consulting: active relationships, services a month, renewals, the open pipeline, sales and costs', async (t) => {
  const { local, overview, cardOf, sale } = await setup(t);
  const c = local('client', { name: 'Lefty’s', status: 'active' });
  const a = local('account', { client_id: c, name: 'Lefty’s Vape Shop' });
  const web = local('relationship', { account_id: a, business_id: B.agency, kind: 'website', status: 'active' });
  local('relationship', { account_id: a, business_id: B.agency, kind: 'social', status: 'active' });
  local('relationship', { account_id: a, business_id: B.agency, kind: 'website', status: 'ended' });
  local('service', { relationship_id: web, name: 'Hosting', status: 'active', billing: 'flat', amount_cents: 48000, period: 'yearly', renewal_date: addDays(TODAY, 10) });
  local('service', { relationship_id: web, name: 'Care plan', status: 'active', billing: 'flat', amount_cents: 15000, period: 'monthly' });
  local('service', { relationship_id: web, name: 'Old build', status: 'done', billing: 'flat', amount_cents: 450000, period: 'once' });
  local('lead', { name: 'Maple Dental', business_id: B.agency, kind: 'website', stage: 'talking', value_cents: 300000, value_period: 'once' });
  local('lead', { name: 'Harbour Books', business_id: B.agency, kind: 'social', stage: 'quoted', value_cents: 50000, value_period: 'monthly' });
  local('lead', { name: 'Coaching', business_id: B.consulting, kind: 'consulting', stage: 'lead' });
  local('recurring_cost', { name: 'Server', business_id: B.agency, amount_cents: 2400, period: 'monthly', next_renewal: addDays(TODAY, 20), auto_renews: true });
  await sale(B.agency, TODAY, 120000);
  const body = await overview();
  const w = cardOf(body, 'web');
  assert.deepEqual([w.relationships.total, w.relationships.byKind], [2, { website: 1, social: 1 }]);
  // $480/yr = $40/mo, + $150/mo = $190/mo.
  assert.deepEqual([w.services.active, w.services.monthlyCents], [2, 19000]);
  assert.deepEqual([w.renewals.count, w.renewals.next.name, w.renewals.next.date], [1, 'Hosting', addDays(TODAY, 10)]);
  assert.deepEqual(w.pipeline.open, [{ stage: 'lead', count: 0 }, { stage: 'talking', count: 1 }, { stage: 'quoted', count: 1 }]);
  assert.deepEqual(w.pipeline.value, [{ currency: 'CAD', cents: 300000 + 600000 }], 'first-year value');
  assert.deepEqual(w.month.map((f) => [f.currency, f.total, f.totalOnly]), [['CAD', 120000, true]]);
  assert.deepEqual(w.costs.map((x) => [x.currency, x.monthlyCents]), [['CAD', 2400]]);
  const c2 = cardOf(body, 'consulting');
  // D18's `invoices` sales source is always there with the billing module: no "entered by hand only" note.
  assert.deepEqual([c2.relationships.total, c2.pipeline.openCount, c2.invoicesConnected], [0, 1, true]);
});

test('Save Point Shop: eBay not set up, with a month entered by hand; clients: active, new this month, quiet', async (t) => {
  const { call, overview, cardOf, local } = await setup(t);
  assert.equal((await call('PUT', '/api/sales/manual/ebay/2026-10', { total: 98700, orders: 21 })).status, 200);
  const longAgo = Date.parse(NOW) - 90 * 86_400_000;
  local('client', { name: 'Old friend', status: 'active' }, { stampMs: longAgo });
  local('client', { name: 'New this month', status: 'active' });
  local('client', { name: 'Closed', status: 'closed' });
  local('lead', { name: 'Open lead', business_id: B.agency, stage: 'lead' });
  const body = await overview();
  const sp = cardOf(body, 'savePoint');
  assert.deepEqual([sp.state, sp.monthFromManual, sp.toShip], ['not_set_up', true, null]);
  assert.deepEqual(sp.month.map((f) => [f.currency, f.total, f.orders, f.totalOnly]), [['CAD', 98700, 21, true]]);
  const cl = cardOf(body, 'clients');
  assert.deepEqual([cl.active, cl.newThisMonth, cl.quiet, cl.openLeads], [2, 1, 1, 1]);
});

test('all businesses: three months of sales beside recurring costs a month, per currency; Personal on its own line', async (t) => {
  const { local, overview, cardOf, sale } = await setup(t);
  await sale(B.agency, '2026-08-10', 100000);
  await sale(B.agency, '2026-10-02', 200000);
  await sale(B.agency, '2026-10-03', 5000, { currency: 'USD' });
  await sale(B.consulting, '2026-09-15', 30000);
  local('recurring_cost', { name: 'Hosting', business_id: B.agency, amount_cents: 120000, period: 'yearly', next_renewal: '2027-01-01' });
  local('recurring_cost', { name: 'Internet', business_id: B.personal, amount_cents: 9000, period: 'monthly', next_renewal: '2026-11-01' });
  const all = cardOf(await overview(), 'allBusinesses');
  assert.deepEqual(all.businesses.map((b) => [b.businessId, b.personal]), [[B.agency, false], [B.consulting, false], [B.personal, true]]);
  const agency = all.businesses[0];
  assert.deepEqual(agency.months.map((m) => [m.month, m.sales.map((f) => `${f.currency} ${f.total}`)]), [
    ['2026-08', ['CAD 100000']], ['2026-09', []], ['2026-10', ['CAD 200000', 'USD 5000']],
  ]);
  assert.deepEqual(agency.costs.map((c) => [c.currency, c.monthlyCents]), [['CAD', 10000]]);
  assert.deepEqual(all.together.months.map((m) => [m.month, m.sales.map((f) => `${f.currency} ${f.total}`)]), [
    ['2026-08', ['CAD 100000']], ['2026-09', ['CAD 30000']], ['2026-10', ['CAD 200000', 'USD 5000']],
  ]);
  assert.deepEqual(all.together.costs, [{ currency: 'CAD', monthlyCents: 10000 }], 'the home’s costs aren’t the businesses’');
});

test('retail stores: each store’s sales and state, and open tickets per store from the helpdesk (D14)', async (t) => {
  const { db, ctx, call, overview, cardOf } = await setup(t, { config: { HELPDESK_TEST_PLAIN_LOCALHOST: '1', HELPDESK_TIMEOUT_MS: '1500', WOO_TIMEOUT_MS: '1000' } });
  // A store removed earlier: its totals stay, it has no mailbox.
  db.prepare(`INSERT INTO sales_stores (source, store, name, business_id, currency, time_zone, updated_at) VALUES ('woo', 'tinsxpress.com', 'TinsXpress', ?, 'CAD', 'America/Toronto', ?)`).run(B.retail, NOW);
  db.prepare(`INSERT INTO sales_daily (source, store, day, business_id, currency, orders, items, gross, discounts, refunds, net, tax, shipping, total, fetched_at)
    VALUES ('woo', 'tinsxpress.com', ?, ?, 'CAD', 3, 5, 9000, 0, 0, 9000, 1170, 1000, 11170, ?)`).run(TODAY, B.retail, NOW);
  // A connected store (the fake WooCommerce) with its support mailbox (the fake IMAP server): the real D14 read.
  const woo = await startFakeWoo(t);
  const store = await call('POST', '/api/woocommerce/stores', { url: woo.url, key: STORE_KEY, secret: STORE_SECRET, readOnlyConfirmed: true });
  assert.equal(store.status, 201, JSON.stringify(store.body));
  const user = 'support@shop.example';
  const imap = await startFakeImap({ users: { [user]: 'app pass' }, folders: ['INBOX', 'Sent'] });
  t.after(() => imap.close());
  const mb = await call('POST', '/api/helpdesk/mailboxes', { name: 'Shop support', host: '127.0.0.1', port: imap.port, username: user, password: 'app pass', inboxFolder: 'INBOX', sentFolder: 'Sent', storeId: store.body.store.id });
  assert.equal(mb.status, 201, JSON.stringify(mb.body));
  await ctx.services.helpdesk.pullMailbox(mb.body.mailbox.id);
  imap.add('INBOX', email({ id: 'q1@example.com', from: 'Pat <pat@example.com>', subject: 'Where is my order?' }), { at: new Date(Date.parse(NOW) - 60_000).toISOString() });
  imap.add('INBOX', email({ id: 'q2@example.com', from: 'Sam <sam@example.com>', subject: 'Wrong flavour' }), { at: new Date(Date.parse(NOW) - 30_000).toISOString() });
  await ctx.services.helpdesk.pullRound({ force: true });
  const key = store.body.store.storeKey;
  assert.deepEqual(ctx.services.helpdesk.openTicketsByStore(), { [key]: 2 });
  const r = cardOf(await overview(), 'retail');
  assert.equal(r.state, 'ok');
  const byName = Object.fromEntries(r.stores.map((s) => [s.store, s]));
  assert.deepEqual([byName['tinsxpress.com'].state, byName['tinsxpress.com'].tickets, byName['tinsxpress.com'].today.map((f) => f.total)], ['removed', 0, [11170]]);
  assert.equal(byName[key].tickets, 2);
  assert.deepEqual(r.support, { state: 'ok', total: 2, unmatched: 0 });
  // Its failure says so on the support line; the stores still show.
  const real = ctx.services.helpdesk.openTicketsByStore;
  ctx.services.helpdesk.openTicketsByStore = () => { throw new Error('mailbox gone'); };
  t.after(() => { ctx.services.helpdesk.openTicketsByStore = real; });
  const broken = cardOf(await overview(), 'retail');
  assert.deepEqual([broken.state, broken.support.state, broken.stores.every((s) => s.tickets === null)], ['ok', 'error', true]);
});

test('one card failing says so; the rest and the goals still come', async (t) => {
  const { ctx, overview, cardOf } = await setup(t);
  ctx.services.stockroom.stockCard = () => { throw new Error('boom'); };
  const body = await overview();
  assert.equal(cardOf(body, 'stock').state, 'error');
  assert.equal(cardOf(body, 'clients').state, 'ok');
  assert.equal(body.goals.state, 'ok');
});

test('quick with 3,000 clients (one read for every card, the goals and “To deal with”)', async (t) => {
  const { db, ctx, overview, local, sale } = await setup(t);
  const { sync } = ctx.services;
  const ours = [B.agency, B.consulting, B.wholesale];
  db.transaction(() => {
    for (let i = 0; i < 3000; i += 1) {
      const l = (entity, fields) => sync.applyLocal({ entity, op: 'create', fields }).recordId;
      const c = l('client', { name: `Client ${i}`, status: i % 10 ? 'active' : 'closed' });
      const a = l('account', { client_id: c, name: `Shop ${i}` });
      const kind = ours[i % 3] === B.agency ? 'website' : ours[i % 3] === B.consulting ? 'consulting' : 'wholesale';
      const r = l('relationship', { account_id: a, business_id: ours[i % 3], kind, status: 'active', start_date: i % 7 ? '2025-01-01' : '2026-10-02' });
      if (i % 5 === 0) l('service', { relationship_id: r, name: 'Retainer', status: 'active', billing: 'flat', amount_cents: 10000, period: 'monthly', renewal_date: addDays(TODAY, i % 40) });
      if (i % 9 === 0) l('activity', { client_id: c, type: 'note', body: 'Met', at: '2026-10-01T12:00:00.000Z' });
      if (i % 11 === 0) l('lead', { name: `Lead ${i}`, business_id: ours[i % 2], kind: 'website', stage: 'talking', value_cents: 100000 });
    }
  })();
  for (const id of ours) local('target', { business_id: id, month: '2026-10-01', measure: 'new_clients', amount: 50 });
  await sale(B.agency, TODAY, 100000);
  await overview(); // warm
  const t0 = performance.now();
  const body = await overview();
  const ms = performance.now() - t0;
  assert.equal(body.cards.find((c) => c.id === 'clients').active, 2700);
  assert.ok(body.goals.businesses.every((b) => b.targets[0].actual > 0));
  t.diagnostic(`the overview with 3,000 clients: ${Math.round(ms)} ms`);
  assert.ok(ms < 2000, `the overview took ${Math.round(ms)} ms`);
});
