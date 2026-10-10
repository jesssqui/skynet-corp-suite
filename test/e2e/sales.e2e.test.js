// WooCommerce stores and Sales (D12) in the browser, on an iPhone and on a Mac, against a fake WooCommerce
// (server/test/fixtures/wooStore.js, a store in Vancouver): the "WooCommerce stores" card on System → Connections
// (Add a store: the Read confirmation required, the key checked and saved), the store's own card, Money → Sales
// (today / this week / this month per store, the combined total), the store's page with an order looked up by number
// and by email (first name only), and every call to the store a GET. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeWoo, order, STORE_KEY, STORE_SECRET } from '../../server/test/fixtures/wooStore.js';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, shot } from './helpers.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function fakeStore(t) {
  const store = await startFakeWoo(t, { name: 'Northern Tins', timezone: 'America/Vancouver' });
  const today = store.localNow(Date.now()).slice(0, 10);
  store.state.orders = [
    // Today in the store: $25 of goods − $2 coupon = $23 net (plus tax and shipping).
    order({ id: 101, created: `${today}T00:01:00`, items: [{ name: 'Cool Mint 6mg', sku: 'NT-CM6', qty: 2, price: 12.5 }], coupon: 2, tax: 3.25, shipping: 8, first: 'Robin', last: 'Quincey', email: 'robin.q@example.com' }),
    order({ id: 102, status: 'cancelled', created: `${today}T00:02:00`, items: [{ name: 'Citrus', sku: 'NT-C', qty: 9, price: 10 }] }),
  ];
  store.state.shipments['101'] = [{ tracking_provider: 'Canada Post', tracking_number: '7023 0000 1111', tracking_link: 'https://www.canadapost-postescanada.ca/track', date_shipped: today }];
  return store;
}

async function walkThrough(page, server, store, label) {
  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Connections' }).click();
  await page.waitForURL(/\/system\/connections$/, WAIT);
  const hub = page.locator('[data-connection="woocommerce"]');
  await hub.getByTestId('queue-woocommerce').filter({ hasText: 'No stores yet' }).waitFor(WAIT);
  await hub.getByTestId('woo-add-open').click();
  await hub.getByLabel('Store address').fill(store.url);
  await hub.getByLabel('Consumer key').fill(STORE_KEY);
  await hub.getByLabel('Consumer secret').fill(STORE_SECRET);
  assert.equal(await hub.getByTestId('woo-add-submit').isDisabled(), true, 'not without the Read confirmation');
  await hub.getByText(/doesn’t tell the suite which permission/).waitFor(WAIT);
  await hub.getByLabel('This key was made with permission “Read”').check();
  await hub.getByTestId('woo-add-submit').click();
  await hub.getByText(/Northern Tins is connected/).waitFor(WAIT);
  const card = page.locator('[data-connection^="woo-"]');
  await card.getByRole('heading', { name: 'Northern Tins (WooCommerce)' }).waitFor(WAIT);
  await card.getByTestId('woo-store').getByText(/key …/).waitFor(WAIT);
  assert.ok(!(await page.content()).includes(STORE_SECRET.slice(3)), 'the secret is never shown');
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Connections');
  await shot(page, `d12-woo-connections-${label.toLowerCase()}`);

  // Money → Sales.
  await nav(page, 'Money');
  await page.getByRole('radio', { name: 'Sales' }).click();
  await page.waitForURL(/\/costs\/sales$/, WAIT);
  const storeCard = page.getByTestId('sales-store').filter({ hasText: 'Northern Tins' });
  for (let i = 0; i < 20; i += 1) {
    if (await storeCard.locator('[data-period="today"]').filter({ hasText: '$23' }).count()) break;
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.waitForTimeout(500);
  }
  await storeCard.locator('[data-period="today"]').filter({ hasText: '$23' }).filter({ hasText: '1 order' }).waitFor(WAIT);
  await page.getByTestId('sales-overall').locator('[data-period="today"]').filter({ hasText: '$23' }).waitFor(WAIT);
  await storeCard.getByText(/Updated .* its day is \d{4}-\d{2}-\d{2} \(America\/Vancouver\)/).waitFor(WAIT);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Sales');
  await shot(page, `d12-sales-${label.toLowerCase()}`);

  // The store's page: an order by number, then by email.
  await storeCard.getByRole('link', { name: 'Northern Tins' }).click();
  await page.waitForURL(/\/costs\/sales\/woo\//, WAIT);
  await page.getByLabel('Order number or the customer’s email').fill('#101');
  await page.getByRole('button', { name: 'Look up' }).click();
  const found = page.getByTestId('sales-order').filter({ hasText: 'Order #101' });
  await found.getByText('for Robin').waitFor(WAIT);
  await found.getByText('2 × Cool Mint 6mg (NT-CM6)').waitFor(WAIT);
  await found.getByText('Canada Post Expedited').waitFor(WAIT);
  await found.getByTestId('sales-tracking').getByText(/Canada Post 7023 0000 1111/).waitFor(WAIT);
  const text = await page.content();
  for (const s of ['Quincey', 'robin.q@example.com', '5195550100', '12 Main St']) assert.ok(!text.includes(s), `${s} isn’t shown`);
  await page.getByLabel('Order number or the customer’s email').fill('Robin.Q@example.com');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByTestId('sales-order').filter({ hasText: 'Order #101' }).waitFor(WAIT);
  await page.getByLabel('Order number or the customer’s email').fill('99999');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByTestId('sales-no-orders').waitFor(WAIT);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the store page');
  await shot(page, `d12-store-${label.toLowerCase()}`);
  // Nothing about the order stayed on the device.
  const kept = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.ok(!kept.includes('Robin') && !kept.includes('robin.q'));

  for (const r of store.requests) assert.deepEqual([r.method, r.bodyLength], ['GET', 0], r.path);
}

for (const [label, device] of [['iPhone', () => iphone()], ['Mac', () => ({ viewport: { width: 1280, height: 900 } })]]) {
  test(`${label}: a WooCommerce store added on Connections, its totals on Money → Sales, an order looked up`, async (t) => {
    const server = await startServer(t);
    const store = await fakeStore(t);
    const browser = await launch(t);
    const context = await browser.newContext(device());
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');
    await walkThrough(page, server, store, label);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
