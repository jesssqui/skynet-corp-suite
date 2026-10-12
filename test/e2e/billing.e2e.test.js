// Quotes and invoices (D17/D18) in the browser, on an iPhone and on a Mac: a quote for a lead drafted from the lead's
// page, its lines written during an outage (Approve disabled until the connection is back), approved and sent (its
// number, the email sheet — the suite sends nothing), the lead moves to Quoted; Accepted… wins the lead (one client);
// Make the invoice → approved and issued → a payment recorded → Paid, and the overview's sales for Great White North
// Design show it; a credit note (the invoice's lines copied, one kept) issued → the overview's figure goes down by it.
// Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;

function seed(ctx) {
  const r = ctx.services.sync.applyLocal({
    actor: 'owner', entity: 'lead', op: 'create',
    fields: { name: 'Alpha Bakery', contact_name: 'Pat Baker', email: 'pat@alphabakery.ca', business_id: AGENCY, kind: 'website', stage: 'talking', stage_changed_at: new Date().toISOString(), owner: 'owner' },
  });
  assert.equal(r.status, 'applied');
  ctx.services.billing.putSettings(AGENCY, { legal_name: 'Great White North Design', address: '12 Main St\nSimcoe, ON', hst_number: '123456789 RT0001', payment_instructions: 'Interac e-Transfer to pay@example.ca' }, { actor: 'owner' });
  return { leadId: r.recordId };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function addLine(page, { description, price, exempt = false }) {
  await page.getByRole('button', { name: 'Add a line' }).click();
  const form = page.getByTestId('line-form');
  await form.locator('#line-description').fill(description);
  await form.locator('#line-price').fill(price);
  if (exempt) await form.getByLabel('No HST on this line').check();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await form.waitFor({ state: 'detached', ...WAIT });
}
async function approve(page, button, total) {
  await page.getByRole('button', { name: button }).click();
  const sheet = page.getByTestId('approve-form');
  await sheet.getByTestId('approve-total').getByText(total).waitFor(WAIT);
  await sheet.getByRole('button', { name: button.replace('…', '') }).click();
  const email = page.getByTestId('email-sheet');
  await email.waitFor(WAIT);
  await email.getByText('The suite doesn’t send email').waitFor(WAIT);
  await email.getByRole('button', { name: 'Done' }).click();
}
const overviewTotal = async (page, base) => {
  await page.goto(`${base}/overview`);
  const tile = page.locator(`[data-testid="overview-business"][data-business="${AGENCY}"]`);
  await tile.waitFor(WAIT);
  return tile;
};

async function walkThrough(page, context, server, { leadId }, label) {
  const phone = label === 'iPhone';
  await page.goto(`${server.base}/crm/leads/${leadId}`);
  await page.getByRole('link', { name: 'New quote' }).click();
  const sheet = page.getByTestId('new-doc-form');
  await sheet.getByTestId('doc-lead').getByText('Alpha Bakery').waitFor(WAIT);
  await sheet.locator('#doc-title').fill('New website');
  await sheet.getByRole('button', { name: 'Make the draft' }).click();
  await page.waitForURL(/\/costs\/billing\/quotes\//, WAIT);
  const quoteId = page.url().split('/quotes/')[1];
  await page.getByTestId('doc-to').getByText('Alpha Bakery').waitFor(WAIT);

  // The lines, written with no connection: saved on the device; approving waits for the connection.
  await airplane(context, server, true);
  await barSays(page, 'Offline');
  await addLine(page, { description: 'Website design and build', price: '2500' });
  await addLine(page, { description: 'Domain, first year (resold)', price: '25', exempt: true });
  await page.getByTestId('doc-total').getByText('$2,850.00').waitFor(WAIT);
  assert.ok(await page.getByRole('button', { name: 'Approve and send…' }).isDisabled(), 'approving needs the server');
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on a draft');
  await shot(page, `d17-draft-${label.toLowerCase()}`, { fullPage: false });
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  await page.reload(); // the settings (the next number) read again now the server can be reached
  await page.locator('button:has-text("Approve and send…"):enabled').waitFor(WAIT);

  // Approve and send: the number, the email sheet; the lead is Quoted; a follow-up task.
  await approve(page, 'Approve and send…', '$2,850.00');
  await page.getByTestId('doc-number').getByText('Quote GWND-Q-0001').waitFor(WAIT);
  await page.getByTestId('doc-status').getByText('Sent').waitFor(WAIT);
  const lead = server.db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId);
  assert.deepEqual([lead.stage, lead.value_cents], ['quoted', 252500]);
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM planner_tasks WHERE lead_id = ? AND title = 'Follow up on quote GWND-Q-0001 for Alpha Bakery'").get(leadId).n, 1);
  const pdf = await page.request.get(`${server.base}/api/billing/pdf/quote/${quoteId}`);
  assert.equal(pdf.headers()['content-type'], 'application/pdf');
  assert.ok((await pdf.body()).toString('latin1').includes('(GWND-Q-0001)'));

  // Accepted: wins the lead (the client is made, once).
  await page.getByRole('button', { name: 'Accepted…' }).click();
  const win = page.getByTestId('win-form');
  await win.getByTestId('accept-wins').waitFor(WAIT);
  await win.getByRole('button', { name: 'Mark accepted' }).click();
  await page.getByTestId('doc-status').getByText('Accepted').waitFor(WAIT);
  const won = await until(() => {
    const r = server.db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId);
    return r.stage === 'won' ? r : null;
  }, 'the lead won on the server');
  assert.equal(server.db.prepare("SELECT COUNT(*) AS n FROM crm_clients WHERE name = 'Alpha Bakery'").get().n, 1);
  await until(() => server.db.prepare('SELECT client_id FROM billing_quotes WHERE id = ?').get(quoteId).client_id === won.won_client_id, 'the quote names the client');
  await until(() => server.db.prepare("SELECT done_at FROM planner_tasks WHERE lead_id = ? AND title LIKE 'Follow up%'").get(leadId).done_at, 'the follow-up finished');

  // The invoice from it: issued, then paid.
  await page.getByRole('button', { name: 'Make the invoice' }).click();
  await page.waitForURL(/\/costs\/billing\/invoices\//, WAIT);
  await page.getByTestId('doc-total').getByText('$2,850.00').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  await approve(page, 'Approve and issue…', '$2,850.00');
  await page.getByTestId('doc-number').getByText('Invoice GWND-INV-0001').waitFor(WAIT);
  await page.getByTestId('doc-status').getByText('Unpaid').waitFor(WAIT);
  await page.getByRole('button', { name: 'Record a payment…' }).click();
  const pay = page.getByTestId('payment-form');
  assert.equal(await pay.locator('#pay-amount').inputValue(), '2850');
  await pay.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('doc-status').getByText('Paid', { exact: true }).waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on an invoice');
  await shot(page, `d18-invoice-${label.toLowerCase()}`, { fullPage: false });
  await until(() => server.db.prepare("SELECT SUM(total) AS t FROM sales_daily WHERE source = 'invoices'").get().t === 285000, 'the payment in sales');
  const invoiceUrl = page.url();

  // The overview's sales for Great White North Design: the paid invoice.
  let tile = await overviewTotal(page, server.base);
  await tile.getByText('$2,850').first().waitFor(WAIT);

  // A credit note: the invoice's lines copied, the website line taken off — $25 back.
  await page.goto(invoiceUrl);
  await page.getByRole('button', { name: 'Credit note…' }).click();
  await page.waitForURL(/\/costs\/billing\/credit-notes\//, WAIT);
  await page.getByRole('button', { name: 'Copy the invoice’s lines' }).click();
  await page.getByRole('button', { name: 'Edit Website design and build' }).click();
  await page.getByTestId('line-form').getByRole('button', { name: 'Delete…' }).click();
  await page.getByTestId('line-form').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByTestId('doc-total').getByText('$25.00').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  await approve(page, 'Approve and issue…', '$25.00');
  await page.getByTestId('doc-number').getByText('Credit note GWND-CN-0001').waitFor(WAIT);
  await until(() => server.db.prepare("SELECT SUM(total) AS t FROM sales_daily WHERE source = 'invoices'").get().t === 282500, 'the credit note in sales');
  tile = await overviewTotal(page, server.base);
  await tile.getByText('$2,825').first().waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the overview');

  // Money → Billing lists them.
  await page.goto(`${server.base}/costs/billing?tab=invoice&show=all`);
  await page.getByTestId('billing-list').getByText('GWND-INV-0001').waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the list');
}

for (const [label, options] of [['iPhone', iphone()], ['Mac', { viewport: { width: 1280, height: 900 } }]]) {
  test(`${label}: a lead's quote drafted offline, sent, accepted (the lead won); its invoice issued and paid, in the overview's sales; a credit note takes some back`, async (t) => {
    const server = await startServer(t);
    const data = seed(server.ctx);
    const browser = await launch(t);
    const context = await browser.newContext(options);
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');
    await walkThrough(page, context, server, data, label);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
