// The overview's business cards and goals scorecard (D15) in the browser, on an iPhone (390 px, then 320 px) and on a
// Mac: a monthly target for Business consulting set on the monthly plan in airplane mode (shown at once, "so far"
// needs a connection), saved once back online with what the month has brought so far; then the overview — the goals
// scorecard with the target's actual against it, the pace and the month's priority beside it — and every card with
// its figures or a clear "not connected" (the Order Manager, Stockroom, eBay, WooCommerce and the helpdesk aren't set
// up here). No sideways scrolling. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { addDays } from '@suite/shared/planner';
import { localDate } from '@suite/shared/time';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, shot, airplane } from './helpers.js';

const B = BUSINESS_IDS;
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function walkThrough(page, context, server, label) {
  const phone = label === 'iPhone';
  const month = localDate().slice(0, 7);
  // The monthly plan of this calendar month.
  await nav(page, 'Plan');
  await page.getByRole('link', { name: 'Month', exact: true }).click();
  await page.waitForURL(/\/plan\/month/, WAIT);
  await page.goto(`${server.base}/plan/month?month=${month}`);
  const targets = page.getByTestId(`month-targets-${B.consulting}`);
  await targets.getByText('No targets this month').waitFor(WAIT);

  // Set offline: shown at once; "so far" needs the server.
  await airplane(context, server, true);
  await page.getByRole('button', { name: 'Add a target for Business consulting' }).click();
  const sheet = page.getByTestId('target-form');
  await sheet.getByLabel('What to measure').selectOption({ label: 'Total sales' });
  await sheet.getByText(/every store, the Order Manager, eBay/).waitFor(WAIT);
  await sheet.getByLabel('Target ($)').fill('3,000');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  const item = targets.locator('[data-measure="sales"]');
  await item.getByTestId('target-value').filter({ hasText: 'Target $3,000' }).waitFor(WAIT);
  await item.getByTestId('target-so-far').filter({ hasText: 'needs a connection' }).waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the monthly plan');
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  await item.getByTestId('target-value').filter({ hasText: '$1,500 of $3,000' }).waitFor(WAIT);
  const saved = server.db.prepare('SELECT * FROM overview_targets WHERE deleted_at IS NULL').all();
  assert.deepEqual(saved.map((r) => [r.business_id, r.month, r.measure, r.amount, r.currency]), [[B.consulting, `${month}-01`, 'sales', 300000, null]]);
  await shot(page, `d15-month-targets-${label.toLowerCase()}`);
  // A second target: leads won (a count).
  await page.getByRole('button', { name: 'Add a target for Business consulting' }).click();
  await sheet.getByLabel('What to measure').selectOption({ label: 'Leads won' });
  await sheet.getByLabel('Target', { exact: true }).fill('2');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  await targets.locator('[data-measure="won_leads"]').getByTestId('target-value').filter({ hasText: '0 of 2' }).waitFor(WAIT);

  // The overview: the sidebar on a Mac; on a phone, from Today.
  if (phone) {
    await nav(page, 'Today');
    await page.getByTestId('today-overview').click();
  } else {
    await nav(page, 'Overview');
  }
  await page.waitForURL(/\/overview$/, WAIT);
  const goals = page.getByTestId('goals-scorecard');
  const consulting = goals.locator(`[data-business="${B.consulting}"]`);
  await consulting.getByText('$1,500 of $3,000').waitFor(WAIT);
  await consulting.locator('[data-status]').first().waitFor(WAIT);
  await consulting.getByText('Sign two retainers').waitFor(WAIT);
  await consulting.getByText('0 of 1 priority done').waitFor(WAIT);
  const card = (id) => page.locator(`[data-card="${id}"]`);
  await card('wholesale').getByTestId('card-state').filter({ hasText: 'Order Manager is set up' }).waitFor(WAIT);
  await card('stock').getByTestId('card-state').filter({ hasText: 'Stockroom is set up' }).waitFor(WAIT);
  await card('savePoint').getByTestId('card-state').filter({ hasText: 'eBay isn’t connected' }).waitFor(WAIT);
  await card('retail').getByTestId('retail-support').filter({ hasText: 'comes with the helpdesk (D14)' }).waitFor(WAIT);
  await card('web').locator('[data-row="rels"]').getByText('1 website').waitFor(WAIT);
  await card('web').locator('[data-row="renewals"]').getByText(/next: Hosting for Lefty’s Vape Shop/).waitFor(WAIT);
  await card('consulting').locator('[data-row="month"]').getByText('$1,500').waitFor(WAIT);
  await card('clients').locator('[data-row="active"]').getByText('1').waitFor(WAIT);
  await card('allBusinesses').locator('[data-business="together"]').waitFor(WAIT);
  assert.equal(await page.getByTestId('overview-card').count(), 8, 'every card');
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the overview at 390 px');
  await shot(page, `d15-overview-${label.toLowerCase()}`);
  if (phone) {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(200);
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the overview at 320 px');
    await shot(page, 'd15-overview-iphone-320');
    await page.goto(`${server.base}/plan/month?month=${month}`);
    await page.getByTestId(`month-targets-${B.consulting}`).waitFor(WAIT);
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the monthly plan at 320 px');
  } else {
    // On a Mac the cards sit side by side.
    const a = await card('wholesale').boundingBox();
    const b = await card('stock').boundingBox();
    assert.ok(Math.abs(a.y - b.y) < 2 && b.x > a.x, 'two or more across');
  }
  // The scorecard leads to the monthly plan.
  if (!phone) {
    await goals.getByRole('link', { name: 'Monthly plan ›' }).click();
    await page.waitForURL(/\/plan\/month\?month=/, WAIT);
  }
}

for (const [label, device] of [['iPhone', () => iphone()], ['Mac', () => ({ viewport: { width: 1280, height: 900 } })]]) {
  test(`${label}: monthly targets set offline on the plan, then the overview’s scorecard and every business card`, async (t) => {
    const server = await startServer(t);
    const { sync, sales } = server.ctx.services;
    const today = localDate();
    const local = (entity, fields) => sync.applyLocal({ actor: 'owner', entity, op: 'create', fields }).recordId;
    const client = local('client', { name: 'Lefty’s', status: 'active' });
    const account = local('account', { client_id: client, name: 'Lefty’s Vape Shop' });
    const rel = local('relationship', { account_id: account, business_id: B.agency, kind: 'website', status: 'active' });
    local('service', { relationship_id: rel, name: 'Hosting', status: 'active', billing: 'flat', amount_cents: 48000, period: 'yearly', renewal_date: addDays(today, 10) });
    local('goal', { kind: 'month', period: `${today.slice(0, 7)}-01`, business_id: B.consulting, title: 'Sign two retainers', target: 2, progress: 1 });
    sales.addEntry(newId(), { businessId: B.consulting, day: today, kind: 'sale', amount: 150000, orders: 1 }, { actor: 'owner' });
    const browser = await launch(t);
    const context = await browser.newContext(device());
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');
    await walkThrough(page, context, server, label);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
