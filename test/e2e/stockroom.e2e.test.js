// Stock tasks from Stockroom (D16) in the browser, on an iPhone and on a Mac, against a fake Stockroom
// (its read-only suite API, server/test/fixtures/stockroomHub.js): the Stockroom card on System →
// Connections (not set up → a store's code refused → the suite code pasted and checked → what each
// read brought → Pull now), the tasks it made on the Tasks page, and switched off (Pull now
// disabled, no calls). Every call the suite made was a GET. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeHub } from '../../server/test/fixtures/stockroomHub.js';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, shot } from './helpers.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function fakeStockroom(t) {
  const hub = await startFakeHub(t);
  hub.state.deliveries = {
    purchase_orders: 'here', today: null, counts: { orders: 1, tins: 120, overdue: 0 },
    items: [{
      po_id: 1, number: 'PO-0001', supplier: 'Northern Pouch Supply', supplier_id: 7, status: 'confirmed', expected_on: null, overdue: false,
      confirmed_at: new Date().toISOString(), confirmed_by: 'jessy', remaining_tins: 120,
      lines: [{ sku: 'NP-1', sku_id: 1, name: 'Cool Mint 6mg', brand: 'Northern', supplier_code: 'N1', ordered: 120, received: 0, remaining: 120 }],
    }],
  };
  hub.state.differences = {
    threshold_tins: 3, open: 1, truncated: false,
    items: [{ id: 4, sku: 'NP-2', sku_id: 2, name: 'Citrus 4mg', brand: 'Northern', count_id: 'c', count_type: 'weekly', counted_at: new Date().toISOString(), expected: 30, counted: 24, variance: -6, reason: null, value_cents: -3000, opened_at: new Date().toISOString(), opened_by: 'sam' }],
  };
  return hub;
}

async function walkThrough(page, server, hub, label) {
  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Connections' }).click();
  await page.waitForURL(/\/system\/connections$/, WAIT);
  const card = page.locator('[data-connection="stockroom"]');
  await page.locator('[data-connection="stockroom"][data-state="on"]').waitFor(WAIT);
  await card.getByTestId('queue-stockroom').filter({ hasText: 'Not set up' }).waitFor(WAIT);
  const field = card.getByTestId('stockroom-code');
  await field.fill('SL1.not-the-suite-code');
  await card.getByText(/That is a store’s code/).waitFor(WAIT);
  assert.equal(await card.getByRole('button', { name: 'Connect' }).isDisabled(), true);
  await field.fill(hub.code);
  await card.getByRole('button', { name: 'Connect' }).click();
  await card.getByTestId('stockroom-url').filter({ hasText: hub.url }).waitFor(WAIT);
  await card.getByRole('button', { name: 'Pull now' }).click();
  await card.getByTestId('stockroom-reads').filter({ hasText: '1 delivery expected · 1 difference open' }).waitFor(WAIT);
  await card.getByTestId('stockroom-reads').filter({ hasText: 'Deliveries: Read' }).waitFor(WAIT);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Connections');
  await shot(page, `d16-stockroom-${label.toLowerCase()}`);

  // The tasks it made, on the Tasks page (synced like any task).
  await page.reload();
  await barSays(page, 'All changes saved');
  await nav(page, 'Tasks');
  await page.waitForURL(/\/tasks/, WAIT);
  await page.getByText('Receive delivery PO-0001 from Northern Pouch Supply: 120 tins').first().waitFor(WAIT);
  await page.getByText('Investigate count difference: Citrus 4mg (NP-2), -6 tins').first().waitFor(WAIT);

  // Switched off: Pull now is disabled and nothing is called.
  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Connections' }).click();
  const before = hub.requests.length;
  await card.getByRole('switch').click();
  await page.locator('[data-connection="stockroom"][data-state="paused"]').waitFor(WAIT);
  await page.reload();
  await page.locator('[data-connection="stockroom"][data-state="paused"]').waitFor(WAIT);
  assert.equal(await page.locator('[data-connection="stockroom"]').getByTestId('stockroom-pull').isDisabled(), true);
  assert.equal(hub.requests.length, before, 'no calls while switched off');
  for (const r of hub.requests) assert.deepEqual([r.method, r.bodyLength], ['GET', 0]);
}

for (const [label, device] of [['iPhone', () => iphone()], ['Mac', () => ({ viewport: { width: 1280, height: 900 } })]]) {
  test(`${label}: the Stockroom card — the code checked and saved, what was read, Pull now, the tasks it made, switched off`, async (t) => {
    const server = await startServer(t);
    const hub = await fakeStockroom(t);
    const browser = await launch(t);
    const context = await browser.newContext(device());
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');
    await walkThrough(page, server, hub, label);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
