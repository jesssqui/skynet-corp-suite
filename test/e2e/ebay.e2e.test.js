// eBay (D13) in the browser, on an iPhone and on a Mac, against a fake eBay (server/test/fixtures/ebayFake.js): a month
// entered by hand while eBay isn't connected fills Save Point Shop's card on Money → Sales; then the keyset on System →
// Connections, Sign in to eBay (the consent page opens; the Mac comes back through the suite's /ebay/accepted page, the
// iPhone pastes the address eBay showed), the read: the month becomes eBay's own (the hand-entered one shown as
// replaced), and the order waiting to ship is a task. Every call to eBay a GET of orders or the token POST. D13b: the
// breakdown (Items, Shipping, Before tax, Tax, Total) — total only for the hand-entered month —, at 390 and 320 px wide,
// and the App ID typed in the RuName box caught before saving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeEbay, ebayOrder, APP_ID, CERT_ID, RU_NAME } from '../../server/test/fixtures/ebayFake.js';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, shot } from './helpers.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

async function walkThrough(page, context, server, ebay, label) {
  // 1. Not connected: a month by hand fills the card.
  await nav(page, 'Money');
  await page.getByRole('radio', { name: 'Sales' }).click();
  await page.waitForURL(/\/costs\/sales$/, WAIT);
  const card = page.getByTestId('sales-store').filter({ hasText: 'Save Point Shop (eBay)' });
  await card.getByText(/Not connected: set it up/).waitFor(WAIT);
  await card.getByRole('link', { name: 'Months, and entering one by hand' }).click();
  await page.waitForURL(/\/costs\/sales\/ebay$/, WAIT);
  await page.getByLabel('Total sales (CAD)').fill('999.99');
  await page.getByLabel('Orders (optional)').fill('12');
  await page.getByRole('button', { name: 'Save the month' }).click();
  await page.locator(`[data-month="${thisMonth()}"][data-shown="manual"]`).getByText('Entered by hand · 12 orders').waitFor(WAIT);
  await page.getByTestId('ebay-card').locator('[data-period="month"]').filter({ hasText: '$999.99' }).waitFor(WAIT);
  await page.getByTestId('ebay-card').getByText(/This month entered by hand/).waitFor(WAIT);
  // D13b: a hand-entered month has its total only — no breakdown beside it.
  await page.getByTestId('ebay-breakdown').locator('[data-breakdown="month"]').getByText('Entered by hand: total only').waitFor(WAIT);
  await page.locator(`[data-month="${thisMonth()}"]`).getByTestId('month-breakdown').getByText('Entered by hand: total only').waitFor(WAIT);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the eBay page');
  await shot(page, `d13-ebay-manual-${label.toLowerCase()}`);

  // 2. The keyset and the sign-in.
  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Connections' }).click();
  await page.waitForURL(/\/system\/connections$/, WAIT);
  const panel = page.getByTestId('ebay-settings');
  await panel.getByText('Not set up: enter the keyset from eBay’s developer site.').waitFor(WAIT);
  await panel.getByLabel('App ID (Client ID)').fill(APP_ID);
  await panel.getByLabel('Cert ID (Client Secret)').fill(CERT_ID);
  // D13b: the App ID pasted in the RuName box is caught before saving, with where the RuName is.
  await panel.getByLabel('RuName (eBay Redirect URL name)').fill(APP_ID);
  await panel.getByText(/That’s the App ID, not the RuName: on developer\.ebay\.com/).waitFor(WAIT);
  assert.ok(await panel.getByTestId('ebay-save-keys').isDisabled());
  await panel.getByLabel('RuName (eBay Redirect URL name)').fill(RU_NAME);
  await panel.getByTestId('ebay-save-keys').click();
  await panel.getByText(/Keyset saved\. Next: sign in to eBay/).waitFor(WAIT);
  assert.ok(!(await page.content()).includes(CERT_ID), 'the Cert ID is never shown again');
  if (label === 'Mac') {
    // D13b: a keyset saved before the guard with the App ID as its RuName: the card says so and won't open eBay with it.
    server.db.prepare('UPDATE ebay_connection SET ru_name = app_id').run();
    await page.reload();
    await panel.getByTestId('ebay-runame-problem').getByText(/That’s the App ID, not the RuName/).waitFor(WAIT);
    await panel.getByText(/its RuName isn’t right: save the keyset again/).waitFor(WAIT);
    assert.ok(await panel.getByTestId('ebay-sign-in').isDisabled());
    await shot(page, 'd13b-ebay-runame-problem-mac');
    await panel.getByRole('button', { name: 'Enter the keyset again' }).click();
    await panel.getByLabel('App ID (Client ID)').fill(APP_ID);
    await panel.getByLabel('Cert ID (Client Secret)').fill(CERT_ID);
    await panel.getByLabel('RuName (eBay Redirect URL name)').fill(RU_NAME);
    await panel.getByTestId('ebay-save-keys').click();
    await panel.getByText(/Keyset saved\. Next: sign in to eBay/).waitFor(WAIT);
    assert.equal(await panel.getByTestId('ebay-runame-problem').count(), 0);
  }
  const popupP = context.waitForEvent('page');
  await panel.getByTestId('ebay-sign-in').click();
  const popup = await popupP;
  const consent = new URL(popup.url());
  assert.equal(consent.pathname, '/oauth2/authorize');
  assert.equal(consent.searchParams.get('scope'), 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly');
  await popup.close();
  const back = ebay.authorize(consent.searchParams.get('state'), { accept: `${server.base}/ebay/accepted` });
  if (label === 'Mac') {
    await page.goto(back.url);
    await page.getByTestId('ebay-accepted').getByText(/Signed in to eBay/).waitFor(WAIT);
    assert.ok(!page.url().includes('code='), 'the code leaves the address bar');
    await page.getByRole('link', { name: 'Back to Connections' }).click();
  } else {
    await panel.getByLabel('The address eBay showed after “I agree”').fill(back.url);
    await panel.getByTestId('ebay-finish').click();
  }
  await page.getByTestId('ebay-settings').getByText(/Signed in as thesavepointshop|Signed in: reading eBay/).waitFor(WAIT);
  for (let i = 0; i < 20 && !(await server.ctx.services.ebay.info()).lastSuccessAt; i += 1) await new Promise((r) => setTimeout(r, 200));
  await page.reload();
  await page.getByTestId('ebay-read').waitFor(WAIT);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Connections');
  await shot(page, `d13-ebay-connections-${label.toLowerCase()}`);

  // 3. eBay's own month ($56.50 + $45) replaces the one entered by hand (kept, shown as replaced).
  await nav(page, 'Money');
  await page.getByRole('radio', { name: 'Sales' }).click();
  await page.getByTestId('sales-store').filter({ hasText: 'Save Point Shop (eBay)' }).getByRole('link', { name: 'Months, and entering one by hand' }).click();
  const row = page.locator(`[data-month="${thisMonth()}"][data-shown="real"]`);
  await row.getByText('From eBay (replaces the month entered by hand)').waitFor(WAIT);
  await row.getByText('$101.50').first().waitFor(WAIT);
  await page.getByTestId('ebay-card').locator('[data-period="month"]').filter({ hasText: '$101.50' }).waitFor(WAIT);
  // D13b: what eBay's total is made of — the card's month and the month's line, from eBay's own days.
  const monthParts = page.getByTestId('ebay-breakdown').locator('[data-breakdown="month"]');
  for (const text of ['Items', '$85', 'Shipping', '$10', 'Before tax', '$95', 'Tax', '$6.50', 'Total (after tax)', '$101.50']) {
    await monthParts.getByText(text, { exact: true }).waitFor(WAIT);
  }
  await row.getByTestId('month-breakdown').getByText('Items $85 · Shipping $10 · Before tax $95 · Tax $6.50').waitFor(WAIT);
  await page.getByTestId('ebay-breakdown-note').getByText(/refunds come off Items/).waitFor(WAIT);
  if (label === 'iPhone') {
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the breakdown (390 px)');
    const size = page.viewportSize();
    await page.setViewportSize({ width: 320, height: size.height });
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the breakdown (320 px)');
    await shot(page, 'd13b-ebay-breakdown-320');
    await page.setViewportSize(size);
  }
  await shot(page, `d13-ebay-months-${label.toLowerCase()}`);

  // 4. The order waiting to ship is a task (synced like any task).
  await page.reload();
  await barSays(page, 'All changes saved');
  await nav(page, 'Tasks');
  await page.waitForURL(/\/tasks/, WAIT);
  await page.getByText('Ship eBay order 77-SHIP: 1 item').first().waitFor(WAIT);

  // The consent page is opened by the browser (the person's), never fetched by the server: left out here.
  for (const r of ebay.requests.filter((x) => x.path !== '/oauth2/authorize')) {
    assert.ok((r.method === 'GET' && r.path === '/sell/fulfillment/v1/order') || (r.method === 'POST' && r.path === '/identity/v1/oauth2/token'), `${r.method} ${r.path}`);
  }
}

for (const [label, device] of [['iPhone', () => iphone()], ['Mac', () => ({ viewport: { width: 1280, height: 900 } })]]) {
  test(`${label}: eBay — a month by hand, the keyset and sign-in, eBay's own month replacing it, an order to ship`, async (t) => {
    const ebay = await startFakeEbay(t);
    const server = await startServer(t, { env: { EBAY_API_URL: ebay.url, EBAY_AUTH_URL: ebay.url, EBAY_TIME_ZONE: 'America/Toronto' } });
    ebay.orders = [
      ebayOrder({ id: '76-SOLD', created: new Date(Date.now() - 60_000).toISOString(), items: [{ title: 'Pokémon Red', sku: 'GB-RED', qty: 2, price: 20 }], shipping: 10, tax: 6.5 }),
      ebayOrder({ id: '77-SHIP', created: new Date(Date.now() - 30_000).toISOString(), status: 'NOT_STARTED', shipBy: new Date(Date.now() + 2 * 86_400_000).toISOString() }),
    ];
    const browser = await launch(t);
    const context = await browser.newContext(device());
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');
    await walkThrough(page, context, server, ebay, label);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
