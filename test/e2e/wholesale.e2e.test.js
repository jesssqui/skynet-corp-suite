// The Order Manager connection (D1) in the browser, on a Mac and on an iPhone: the Connections page
// shows the real 'wom' row (last event, what waits for a client, the address to enter, a new secret
// shown once — and it works), a linked client's timeline shows its orders and payments (filtered to
// Orders, the account's spend and last order) — on the phone in airplane mode too — and the
// "Waiting for a client" list links one, whose orders then show on that client's page.
// Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT, startServer, launch, watch, signIn, iphone, shot, airplane } from './helpers.js';
import { womKit, postEvents, sampleStream } from '../../server/test/fixtures/wom.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function setup(t) {
  const server = await startServer(t);
  const { ctx } = server;
  const wholesale = ctx.services.wholesale;
  const secret = wholesale.makeSecret({ actor: 'owner' });
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  // Lefty's (linked) with the sample stream; Northwind's Corner Store waits for a client.
  const lefty = make('client', { name: 'Lefty’s', status: 'active' });
  const vape = make('account', { client_id: lefty, name: 'Lefty’s Vape Shop' });
  const northwind = make('client', { name: 'Northwind Holdings', status: 'active' });
  make('account', { client_id: northwind, name: 'Northwind Corner Store' });
  const sample = sampleStream();
  const om = womKit();
  const corner = om.customer({ business_name: 'Northwind Corner Store', contact_name: 'Robin Ortega', email: 'robin@northwind.example', phone: '5195550142' });
  const cornerOrder = om.order(corner, [{ name: 'Velo Freeze 10mg', quantity: 6, unit_price_cents: 500 }], { order_date: '2026-10-06' });
  const res = await postEvents(server.direct, secret, [...sample.events, om.customerCreated(corner), om.orderPlaced(cornerOrder), om.paymentRecorded(om.payment(cornerOrder, 3390))]);
  assert.ok(res.body.results.every((r) => r.status === 'applied'));
  wholesale.linkToClient(sample.customer.customer_uid, { clientId: lefty, accountId: vape }, { actor: 'owner' });
  return { server, lefty, vape, northwind, corner, cornerOrder };
}

async function connectionsRow(page, server, label) {
  await page.goto(`${server.base}/system/connections`);
  const card = page.locator('[data-connection="wom"][data-state="on"]');
  await card.waitFor(WAIT);
  await card.getByTestId('queue-wom').filter({ hasText: '2 records from 1 customer waiting for a client' }).waitFor(WAIT);
  assert.notEqual(await card.getByTestId('last-success-wom').textContent(), 'Last successNever');
  await card.getByTestId('wom-url').filter({ hasText: 'http://host.docker.internal:3100' }).waitFor(WAIT);
  // Made by the owner: "by you" on the owner's Mac, "by your partner" on the partner's phone.
  await card.getByTestId('wom-secret-state').filter({ hasText: label === 'mac' ? 'by you. It can’t be shown again.' : 'by your partner. It can’t be shown again.' }).waitFor(WAIT);
  assert.equal(await card.getByRole('switch').count(), 1, 'it can be switched off');
  await shot(page, `d1-connections-${label}`);
  assert.equal(await noSideways(page), 0);
}

test('Mac: the wom row and a new secret; a linked client’s timeline; the waiting list links a customer', async (t) => {
  const { server, lefty, northwind, corner } = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);

  await connectionsRow(page, server, 'mac');
  // A new secret: confirm, shown once, and it is the one the receiver now takes.
  const card = page.locator('[data-connection="wom"]');
  await card.getByRole('button', { name: 'New secret…' }).click();
  await card.getByRole('button', { name: 'Make a new secret' }).click();
  const secret = (await card.getByTestId('wom-secret').textContent()).trim();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  await shot(page, 'd1-connections-new-secret');
  const om = womKit();
  assert.equal((await postEvents(server.direct, secret, [om.customerCreated(om.customer({ business_name: 'Test Signal Co' }))])).status, 200, 'the new secret works');
  await page.reload();
  await card.getByTestId('wom-secret-state').waitFor(WAIT);
  assert.equal(await card.getByTestId('wom-secret').count(), 0, 'never shown again');

  // The linked client's timeline: orders, payments, returns, refunds beside the CRM, with figures.
  await page.goto(`${server.base}/crm/clients/${lefty}`);
  await page.locator('[data-wholesale="wholesale_order"]').first().waitFor(WAIT);
  assert.equal(await page.locator('[data-wholesale="wholesale_order"]').count(), 5);
  assert.equal(await page.locator('[data-wholesale="wholesale_entry"]').count(), 8);
  await page.getByTestId('account-wholesale-figures').filter({ hasText: 'Spend $124.58 · 4 orders · last order' }).waitFor(WAIT);
  await page.getByTestId('client-wholesale').filter({ hasText: '$11.30 store credit' }).waitFor(WAIT);
  await page.getByText('Age-restricted').waitFor(WAIT);
  await page.locator('[data-wholesale="wholesale_order"][data-status="cancelled"]').getByText('Cancelled').waitFor(WAIT);
  await page.locator('#tl-type').selectOption('order');
  await page.getByTestId('timeline-count').filter({ hasText: '13' }).waitFor(WAIT);
  await shot(page, 'd1-client-timeline-mac');
  assert.equal(await noSideways(page), 0);

  // Waiting for a client: link Northwind's store from the list.
  await page.goto(`${server.base}/crm`);
  await page.getByRole('link', { name: 'Order Manager customers waiting for a client' }).click();
  await page.waitForURL(/\/wholesale$/, WAIT);
  const row = page.locator(`[data-customer="${corner.customer_uid}"]`);
  await row.getByText('Northwind Corner Store').waitFor(WAIT);
  await row.getByText('1 order · spend $30 · last order').waitFor(WAIT);
  await page.getByTestId('waiting-counts').waitFor(WAIT);
  await shot(page, 'd1-waiting-mac');
  assert.equal(await noSideways(page), 0);
  await row.getByRole('button', { name: 'Link to a client…' }).click();
  const sheet = page.getByTestId('link-sheet');
  await sheet.getByLabel('Find the client').fill('Northwind');
  await sheet.getByRole('button', { name: /Northwind Holdings/ }).click();
  assert.equal(await sheet.locator('#link-account option:checked').textContent(), 'Northwind Corner Store', 'the account named like the customer is picked');
  await sheet.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByText('Linked to Northwind Holdings').waitFor(WAIT);
  assert.equal(server.ctx.services.crm.liveLinks('wom', corner.customer_uid).length, 1);
  await page.getByRole('radio', { name: 'Linked' }).click();
  await page.locator(`[data-customer="${corner.customer_uid}"]`).getByRole('link', { name: 'Northwind Holdings' }).click();
  await page.locator('[data-wholesale="wholesale_order"]').waitFor(WAIT);
  await page.getByTestId('account-wholesale-figures').filter({ hasText: 'Spend $30 · 1 order' }).waitFor(WAIT);
  assert.equal(northwind, page.url().split('/').pop());
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('iPhone: the wom row; the linked client’s orders and payments on the timeline, offline too', async (t) => {
  const { server, lefty } = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext(iphone());
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'sam', server.users.partner.totpSecret);
  await connectionsRow(page, server, 'iphone');

  await page.goto(`${server.base}/crm/clients/${lefty}`);
  await page.locator('[data-wholesale="wholesale_entry"]').first().waitFor(WAIT);
  await page.getByTestId('account-wholesale-figures').filter({ hasText: 'Spend $124.58' }).waitFor(WAIT);
  await shot(page, 'd1-client-timeline-iphone');
  assert.equal(await noSideways(page), 0);

  // Airplane mode, reload: the service worker serves the app, the device's copy the records.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, WAIT);
  await airplane(context, server, true);
  await page.reload();
  await page.locator('[data-wholesale="wholesale_order"]').first().waitFor(WAIT);
  assert.equal(await page.locator('[data-wholesale="wholesale_order"]').count(), 5);
  assert.equal(await page.locator('[data-wholesale="wholesale_entry"][data-status="live"]').count(), 8);
  await page.locator('[data-wholesale="wholesale_entry"]', { hasText: 'Payment' }).first().waitFor(WAIT);
  await shot(page, 'd1-client-timeline-iphone-offline');
  // The waiting list needs the server: it says so.
  await page.goto(`${server.base}/wholesale`).catch(() => {});
  await page.getByText('Can’t reach the suite server').waitFor(WAIT);
  await airplane(context, server, false);
  assert.deepEqual(errors, []);
});
