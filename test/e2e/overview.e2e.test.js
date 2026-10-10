// The overview and sales entered by hand (D11) in the browser, on an iPhone (390 px, then 320 px) and on a Mac: an
// invoice and a credit note entered by hand on Money → Sales → "Sales entered by hand", the business's card in Sales,
// then the overview — reached from the sidebar on the Mac and from Today on the phone (no ninth tab) — with the
// business's sales today, the combined total, and "To deal with": an overdue task (with its link), the helpdesk not
// connected yet (D14), the Order Manager and Stockroom not connected. No sideways scrolling. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { localDate } from '@suite/shared/time';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, shot } from './helpers.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function enter(page, { kind = 'Sale', business, amount, orders, note }) {
  await page.getByTestId('entry-add').click();
  const sheet = page.getByTestId('entry-sheet');
  await sheet.getByRole('radio', { name: kind }).click();
  await sheet.getByLabel('Business').selectOption({ label: business });
  await sheet.getByLabel('Amount').fill(amount);
  if (orders) await sheet.getByLabel('Orders (optional)').fill(orders);
  if (note) await sheet.getByLabel('Note (optional)').fill(note);
  await sheet.getByRole('button', { name: 'Save' }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
}

async function walkThrough(page, server, label) {
  const phone = label === 'iPhone';
  // Money → Sales → Sales entered by hand.
  await nav(page, 'Money');
  await page.getByRole('radio', { name: 'Sales' }).click();
  await page.waitForURL(/\/costs\/sales$/, WAIT);
  await page.getByTestId('sales-entries-link').click();
  await page.waitForURL(/\/costs\/sales\/entries$/, WAIT);
  await page.getByText('Nothing entered by hand yet').waitFor(WAIT);
  await enter(page, { business: 'Business consulting', amount: '1,500', orders: '1', note: 'Invoice 2026-031 · Maple Dental' });
  await enter(page, { kind: 'Credit note', business: 'Business consulting', amount: '200', note: 'Credit note on invoice 031' });
  const rows = page.getByTestId('entries').locator('[data-entry]');
  await rows.filter({ hasText: '−$200' }).filter({ hasText: 'Credit note' }).waitFor(WAIT);
  await rows.filter({ hasText: '$1,500' }).filter({ hasText: '1 order' }).waitFor(WAIT);
  await page.getByTestId('entries-sum').filter({ hasText: '2 entries · together $1,300' }).waitFor(WAIT);
  // Saved twice by a double tap is one entry (the id is made when the sheet opens): change the sale's note instead.
  await rows.filter({ hasText: '$1,500' }).click();
  await page.getByTestId('entry-sheet').getByLabel('Note (optional)').fill('Invoice 2026-031');
  await page.getByTestId('entry-sheet').getByRole('button', { name: 'Save' }).click();
  await rows.filter({ hasText: 'Invoice 2026-031' }).waitFor(WAIT);
  assert.equal(await rows.count(), 2);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the entries page');
  await shot(page, `d11-entries-${label.toLowerCase()}`);

  // Its card on Money → Sales.
  await page.getByRole('link', { name: '← All sales' }).click();
  const card = page.getByTestId('sales-store').filter({ hasText: 'Business consulting' });
  await card.locator('[data-period="today"]').filter({ hasText: '$1,300' }).waitFor(WAIT);
  await card.getByText('Entered by hand ·').waitFor(WAIT);

  // The overview: the sidebar on a Mac; on a phone there is no tab for it — Today links to it.
  if (phone) {
    assert.equal(await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview', exact: true }).count(), 0, 'no ninth tab');
    await nav(page, 'Today');
    await page.getByTestId('today-overview').click();
  } else {
    await nav(page, 'Overview');
  }
  await page.waitForURL(/\/overview$/, WAIT);
  const tile = page.getByTestId('overview-business').filter({ hasText: 'Business consulting' });
  await tile.locator('[data-period="today"]').filter({ hasText: '$1,300' }).waitFor(WAIT);
  await tile.getByText('Includes sales entered by hand').waitFor(WAIT);
  await page.getByTestId('overview-overall').locator('[data-period="today"]').filter({ hasText: '$1,300' }).waitFor(WAIT);
  const overdue = page.locator('[data-section="overdue"]');
  await overdue.getByRole('link', { name: /Send the October invoices/ }).waitFor(WAIT);
  assert.equal(await overdue.getAttribute('data-count'), '1');
  await page.locator('[data-section="support"]').getByText('Not connected yet · comes with the helpdesk (D14).').waitFor(WAIT);
  await page.locator('[data-section="balances"]').getByTestId('section-state').filter({ hasText: /Order Manager is set up/ }).waitFor(WAIT);
  await page.locator('[data-section="lowStock"]').getByTestId('section-state').filter({ hasText: /Stockroom is set up/ }).waitFor(WAIT);
  await page.locator('[data-section="noNextStep"]').getByRole('link', { name: /Lefty’s Vape Shop/ }).waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the overview at 390 px');
  await shot(page, `d11-overview-${label.toLowerCase()}`);
  if (phone) {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(200);
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the overview at 320 px');
    await shot(page, 'd11-overview-iphone-320');
    await page.goto(`${server.base}/costs/sales/entries`);
    await page.getByTestId('entries').waitFor(WAIT);
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the entries page at 320 px');
    await page.getByTestId('entry-add').click();
    await page.getByTestId('entry-sheet').waitFor(WAIT);
    assert.ok((await noSideways(page)) <= 0, 'nor with its sheet open');
    await shot(page, 'd11-entry-sheet-iphone-320');
    await page.getByTestId('entry-sheet').getByRole('button', { name: 'Cancel' }).click();
    await page.goto(`${server.base}/overview`);
  }
  // The overdue task's line opens it on Tasks.
  await overdue.getByRole('link', { name: /Send the October invoices/ }).click();
  await page.waitForURL(/\/tasks\?open=/, WAIT);
}

for (const [label, device] of [['iPhone', () => iphone()], ['Mac', () => ({ viewport: { width: 1280, height: 900 } })]]) {
  test(`${label}: sales entered by hand, then the overview — sales per business and what needs dealing with`, async (t) => {
    const server = await startServer(t);
    const { sync } = server.ctx.services;
    const local = (entity, fields) => sync.applyLocal({ actor: 'owner', entity, op: 'create', fields }).recordId;
    local('task', { title: 'Send the October invoices', owner: 'owner', business_id: BUSINESS_IDS.consulting, due_date: addDays(localDate(), -2) });
    const client = local('client', { name: 'Lefty’s', status: 'active' });
    const account = local('account', { client_id: client, name: 'Lefty’s Vape Shop' });
    local('relationship', { account_id: account, business_id: BUSINESS_IDS.agency, kind: 'website', status: 'active' });
    const browser = await launch(t);
    const context = await browser.newContext(device());
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');
    await walkThrough(page, server, label);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
