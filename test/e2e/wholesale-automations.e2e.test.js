// Wholesale automations (D3) in the browser, on a Mac and on an iPhone: a linked Order Manager
// regular past their usual gap shows "Quiet regular" on the client list row, the client's header and
// the account's wholesale card (with their rhythm); the check-in, balance and ready-to-ship tasks the
// automations make land on the owner's Today; after a new order the flag is gone. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';
import { WAIT, startServer, launch, watch, signIn, iphone, shot } from './helpers.js';
import { womKit, postEvents } from '../../server/test/fixtures/wom.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function setup(t) {
  const server = await startServer(t);
  const { ctx } = server;
  const secret = ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const clientId = make('client', { name: 'Maple Corner Store', status: 'active' });
  const accountId = make('account', { client_id: clientId, name: 'Maple Corner Store' });
  make('contact', { client_id: clientId, account_id: accountId, name: 'Robin Ortega', email: 'robin@maple.example' });
  const other = make('client', { name: 'Birch Trading', status: 'active' });
  make('account', { client_id: other, name: 'Birch Trading' });
  // A weekly regular (usually every 7 days) whose last order was 30 days ago; paid for two orders, so (oldest
  // first, as the Order Manager's Balances page) the order from 37 days ago is owing over 30 days.
  const today = localDate();
  const om = womKit();
  const c = om.customer({ business_name: 'Maple Corner Store' });
  const order = (d) => om.order(c, [{ name: 'Velo Freeze 10mg', quantity: 4, unit_price_cents: 500 }], { order_date: d });
  const orders = [51, 44, 37, 30].map((n) => order(addDays(today, -n)));
  const packed = order(today);
  const events = [om.customerCreated(c), ...orders.map((o) => om.orderPlaced(o)), ...orders.slice(2).map((o) => om.paymentRecorded(om.payment(o, 2260)))];
  assert.equal((await postEvents(server.direct, secret, events)).status, 200);
  ctx.services.wholesale.linkToClient(c.customer_uid, { clientId, accountId }, { actor: 'owner' });
  return { server, ctx, secret, om, c, clientId, accountId, today, order, packed };
}

async function checkFlag(page, server, { clientId, label }) {
  await page.goto(`${server.base}/crm`);
  const row = page.locator(`[data-client-row="${clientId}"]`);
  await row.getByTestId('quiet-regular').waitFor(WAIT);
  assert.equal(await page.getByTestId('quiet-regular').count(), 1, 'only the quiet regular’s row');
  await shot(page, `d3-client-list-${label}`);
  assert.equal(await noSideways(page), 0);
  await page.goto(`${server.base}/crm/clients/${clientId}`);
  await page.getByTestId('quiet-regular-text').filter({ hasText: 'Usually orders every 7 days; none for 30' }).waitFor(WAIT);
  assert.equal(await page.getByTestId('quiet-regular').count(), 2, 'the client’s header and the account’s wholesale card');
  await shot(page, `d3-client-page-${label}`);
  assert.equal(await noSideways(page), 0);
}

test('Mac: the quiet-regular flag on the list and the client page; the automations’ tasks on Today; a new order clears the flag', async (t) => {
  const s = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, s.server.base, 'jessy', s.server.users.owner.totpSecret);
  await checkFlag(page, s.server, { clientId: s.clientId, label: 'mac' });

  // The automations (as the scheduler would): a check-in, a balance reminder; then a packed order.
  const autos = s.ctx.services.automations;
  assert.equal(autos.runNow('wholesale-check-in').createdCount, 1);
  assert.equal(autos.runNow('wholesale-balances').createdCount, 1);
  const res = await postEvents(s.server.direct, s.secret, [s.om.orderPlaced(s.packed), s.om.orderPacked({ ...s.packed, packing: { ...s.packed.packing, state: 'packed', packed_by: 'sam' } })]);
  assert.ok(res.body.results.every((r) => r.status === 'applied'));
  await page.goto(`${s.server.base}/`);
  await page.getByText('Check in with Maple Corner Store: no order in 30 days (usually every 7)').waitFor(WAIT);
  await page.getByText('Balance owing over 30 days: Maple Corner Store, $22.60 (1 order)').waitFor(WAIT);
  await page.getByText(`Ship order #${s.packed.number} for Maple Corner Store`).waitFor(WAIT);
  await shot(page, 'd3-today-mac');

  // The new order (placed and packed today) moved the rhythm on: no flag anywhere.
  await page.goto(`${s.server.base}/crm/clients/${s.clientId}`);
  await page.getByTestId('account-wholesale-figures').filter({ hasText: '5 orders' }).waitFor(WAIT);
  assert.equal(await page.getByTestId('quiet-regular').count(), 0);
  await page.goto(`${s.server.base}/crm`);
  await page.locator(`[data-client-row="${s.clientId}"]`).waitFor(WAIT);
  assert.equal(await page.getByTestId('quiet-regular').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('iPhone: the quiet-regular flag on the list and the client page; never on a closed client', async (t) => {
  const s = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext(iphone());
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, s.server.base, 'sam', s.server.users.partner.totpSecret);
  await checkFlag(page, s.server, { clientId: s.clientId, label: 'iphone' });
  // A closed client never shows it (check-ins skip closed clients too).
  assert.equal(s.ctx.services.sync.applyLocal({ actor: 'owner', entity: 'client', op: 'update', recordId: s.clientId, fields: { status: 'closed' } }).status, 'applied');
  await page.goto(`${s.server.base}/crm?status=all`);
  await page.locator(`[data-client-row="${s.clientId}"]`).getByText('Closed').waitFor(WAIT);
  assert.equal(await page.getByTestId('quiet-regular').count(), 0);
  await page.goto(`${s.server.base}/crm/clients/${s.clientId}`);
  await page.getByTestId('account-wholesale-figures').waitFor(WAIT);
  assert.equal(await page.getByTestId('quiet-regular').count(), 0);
  assert.equal(await page.getByTestId('quiet-regular-text').count(), 0);
  assert.deepEqual(errors, []);
});
