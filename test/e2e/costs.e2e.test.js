// Renewals and recurring costs (D6) in the browser, on an iPhone and on a Mac: the Costs page by
// business with its monthly and yearly totals, an overdue cost that doesn't renew on its own, a
// cost added during an outage (shown at once, saved once back online), an edit, a resold cost on the
// client page, and the Friday review listing costs renewing in 30 days. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;

function seed(ctx) {
  const today = localDate();
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const ids = {};
  ids.client = make('client', { name: 'Lefty’s Lounge', status: 'active' });
  ids.account = make('account', { client_id: ids.client, name: 'Lefty’s Lounge' });
  ids.rel = make('relationship', { account_id: ids.account, business_id: AGENCY, kind: 'website', status: 'active' });
  ids.hosting = make('recurring_cost', {
    name: 'Hosting', business_id: AGENCY, vendor: 'Kinsta', amount_cents: 3500, period: 'monthly', next_renewal: addDays(today, 20), auto_renews: true,
    relationship_id: ids.rel, resold_amount_cents: 6000,
  });
  ids.domain = make('recurring_cost', { name: 'Domain leftyslounge.ca', business_id: AGENCY, amount_cents: 2400, period: 'yearly', next_renewal: addDays(today, -3), auto_renews: false });
  ids.insurance = make('recurring_cost', { name: 'Home insurance', business_id: PERSONAL, amount_cents: 120000, period: 'yearly', next_renewal: addDays(today, 10), payment_method: 'Chequing' });
  return { today, ids };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const costRow = (db, where, ...args) => db.prepare(`SELECT * FROM costs_recurring WHERE ${where}`).get(...args);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function walkThrough(page, context, server, { today, ids }, label) {
  await nav(page, 'Costs');
  await page.waitForURL(/\/costs/, WAIT);
  // Totals: $35/mo + $24/yr (agency), $1,200/yr (home) → $1,644/yr, $137/mo.
  await page.getByTestId('costs-total').getByText('$137/mo · $1,644/yr').waitFor(WAIT);
  await page.getByTestId('costs-total').getByText('Resold to clients: $60/mo · $720/yr').waitFor(WAIT);
  const agency = page.locator(`section[data-business-id="${AGENCY}"]`);
  await agency.getByTestId('costs-business-total').getByText('$37/mo · $444/yr').waitFor(WAIT);
  const domain = page.locator(`[data-cost-id="${ids.domain}"]`);
  await domain.getByText(/^Overdue — renewed\?/).waitFor(WAIT);
  await page.locator(`[data-cost-id="${ids.hosting}"]`).getByTestId('cost-resold').getByText('Resold to Lefty’s Lounge: they pay $60/mo').waitFor(WAIT);
  await page.locator(`[data-cost-id="${ids.insurance}"]`).getByText('Renews in 10 days').waitFor(WAIT);
  if (label === 'iPhone') {
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Costs');
    const tab = await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Costs', exact: true }).boundingBox();
    assert.ok(tab.height >= 44 && tab.width >= 44, `the Costs tab is a full tap target (${tab.width} × ${tab.height})`);
  }
  await shot(page, `d6-costs-${label.toLowerCase()}`, { fullPage: false });

  // An outage: a new cost is added and shown at once, with the totals; saved once back online.
  await airplane(context, server, true);
  await barSays(page, 'Offline');
  await page.getByRole('button', { name: 'New cost' }).click();
  const sheet = page.getByTestId('cost-form');
  await sheet.locator('#cost-name').fill('Phone plan');
  await sheet.locator('#cost-business').selectOption({ label: 'Personal' });
  await sheet.locator('#cost-amount').fill('65');
  await sheet.locator('#cost-period').selectOption({ label: 'Monthly' });
  await sheet.locator('#cost-next').fill(addDays(today, 5));
  await sheet.locator('#cost-auto').check();
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the cost sheet open');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  const personal = page.locator(`section[data-business-id="${PERSONAL}"]`);
  await personal.getByText('Phone plan').waitFor(WAIT);
  await personal.getByTestId('costs-business-total').getByText('$165/mo · $1,980/yr').waitFor(WAIT);
  await barSays(page, 'Offline ·');
  assert.equal(costRow(server.db, 'name = ?', 'Phone plan'), undefined, 'not on the server yet');
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  const phonePlan = await until(() => costRow(server.db, 'name = ?', 'Phone plan'), 'the new cost on the server');
  assert.deepEqual([phonePlan.business_id, phonePlan.amount_cents, phonePlan.period, phonePlan.auto_renews, phonePlan.currency, phonePlan.created_by],
    [PERSONAL, 6500, 'monthly', 1, 'CAD', 'owner']);

  // Renewed: the domain's next date is set; it is no longer overdue.
  await domain.getByRole('button', { name: 'Edit Domain leftyslounge.ca' }).click();
  await sheet.locator('#cost-next').fill(addDays(today, 362));
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  await domain.getByText(/^Renews /).waitFor(WAIT);
  await until(() => costRow(server.db, 'id = ?', ids.domain).next_renewal === addDays(today, 362), 'the new date on the server');

  // The client page: the resold cost under its relationship.
  await page.goto(`${server.base}/crm/clients/${ids.client}`);
  await page.locator(`[data-relationship-id="${ids.rel}"]`).getByTestId('resold-costs').getByText('Hosting — we pay $35/mo, they pay $60/mo').waitFor(WAIT);

  // The Friday review: costs renewing in the next 30 days beside the services.
  await page.goto(`${server.base}/plan/review`);
  const costs = page.getByTestId('review-cost-renewals');
  await costs.getByText('Home insurance').waitFor(WAIT);
  await costs.getByText('Phone plan').waitFor(WAIT);
  await costs.getByText('Hosting').waitFor(WAIT);
  assert.equal(await costs.getByText('Domain leftyslounge.ca').count(), 0, 'renews next year');
  await page.getByTestId('review-renewals-count').filter({ hasText: '3' }).waitFor(WAIT);
}

test('iPhone: the Costs page, a cost added during an outage, an edit, the resold line and the Friday review', async (t) => {
  const server = await startServer(t);
  const data = seed(server.ctx);
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  await walkThrough(page, phone, server, data, 'iPhone');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('Mac: the Costs page, a cost added during an outage, an edit, the resold line and the Friday review', async (t) => {
  const server = await startServer(t);
  const data = seed(server.ctx);
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  await walkThrough(page, mac, server, data, 'Mac');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});
