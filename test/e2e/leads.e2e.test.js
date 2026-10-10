// Leads and the pipeline (D8) in the browser, on an iPhone and on a Mac, during an outage: a new lead on
// the Pipeline (a tab of Clients), flagged "No next step" on the pipeline, its page and Today; a call
// logged with a next step clears the flag; moved to Talking; Won… makes the client (shown at once, with
// the lead and its call on the client's timeline); back online everything is saved once. Then the
// cross-sell list turns a current client into a lead. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;

function seed(ctx) {
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const ids = {};
  ids.client = make('client', { name: 'Lefty’s Lounge', status: 'active' });
  ids.account = make('account', { client_id: ids.client, name: 'Lefty’s Lounge' });
  ids.rel = make('relationship', { account_id: ids.account, business_id: AGENCY, kind: 'website', status: 'active' });
  ids.contact = make('contact', { client_id: ids.client, account_id: ids.account, name: 'Lou', email: 'lou@leftys.ca' });
  // A dated task for the relationship, so Today's "No next step" shows only the lead.
  make('task', { title: 'Site check-in', owner: 'owner', business_id: AGENCY, relationship_id: ids.rel, account_id: ids.account, client_id: ids.client, due_date: addDays(localDate(), 30) });
  return { today: localDate(), ids };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function walkThrough(page, context, server, { today, ids }, label) {
  const phone = label === 'iPhone';
  await nav(page, 'Clients');
  await page.waitForURL(/\/crm$/, WAIT);
  await page.getByRole('radio', { name: 'Pipeline' }).click();
  await page.waitForURL(/\/crm\/pipeline/, WAIT);

  // An outage from here on: everything below is made on the device first.
  await airplane(context, server, true);
  await barSays(page, 'Offline');
  await page.getByRole('button', { name: 'New lead' }).click();
  const form = page.getByTestId('lead-form');
  await form.locator('#lead-name').fill('Alpha Bakery');
  await form.locator('#lead-contact').fill('Pat Baker');
  await form.locator('#lead-email').fill('Pat@AlphaBakery.ca');
  await form.locator('#lead-business').selectOption({ label: 'Great White North Design' });
  await form.locator('#lead-kind').selectOption({ label: 'Website' });
  await form.locator('#lead-value').fill('2500');
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the lead sheet open');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/\/crm\/leads\//, WAIT);
  const leadId = page.url().split('/crm/leads/')[1];
  await page.getByTestId('lead-flag').getByText('No next step').waitFor(WAIT);

  // Flagged on the pipeline (the Lead column) and on Today.
  await page.getByRole('link', { name: '← Pipeline' }).click();
  const card = page.locator(`[data-lead-id="${leadId}"]`);
  await card.getByTestId('lead-no-next-step').waitFor(WAIT);
  await page.getByTestId('pipeline-lead-total').getByText('1 · $2,500').waitFor(WAIT);
  await page.getByTestId('pipeline-flagged').waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the pipeline');
  await shot(page, `d8-pipeline-${label.toLowerCase()}`, { fullPage: false });
  await nav(page, 'Today');
  await page.getByTestId('no-next-step-leads').locator(`[data-lead-id="${leadId}"]`).waitFor(WAIT);

  // A call with its next step clears the flag.
  await page.getByTestId('no-next-step-leads').getByRole('link', { name: 'Alpha Bakery' }).click();
  await page.getByRole('button', { name: 'Log call' }).click();
  const call = page.getByTestId('lead-activity-form');
  await call.locator('#lead-act-body').fill('Wants online ordering');
  await call.locator('#lead-next-title').fill('Send the website proposal');
  await call.locator('#lead-next-date').fill(addDays(today, 2));
  await call.getByRole('button', { name: 'Save', exact: true }).click();
  await call.waitFor({ state: 'detached', ...WAIT });
  await page.getByTestId('lead-flag').waitFor({ state: 'detached', ...WAIT });
  await page.getByTestId('lead-tasks').getByText('Send the website proposal').waitFor(WAIT);
  await page.getByTestId('lead-timeline').getByText('Wants online ordering').waitFor(WAIT);

  // Talking, then won: the client is made at once, offline.
  await page.getByRole('button', { name: 'Move to Talking' }).click();
  await page.getByTestId('lead-stage').getByText('Talking').waitFor(WAIT);
  await page.getByTestId('lead-timeline').getByText('Lead → Talking').waitFor(WAIT);
  await page.getByRole('button', { name: 'Won…' }).click();
  const win = page.getByTestId('win-form');
  await win.getByText('Makes the client').waitFor(WAIT);
  await win.getByRole('button', { name: 'Mark won' }).click();
  await page.waitForURL(/\/crm\/clients\//, WAIT);
  const clientId = page.url().split('/crm/clients/')[1];
  await page.getByRole('heading', { name: 'Alpha Bakery' }).first().waitFor(WAIT);
  await page.getByTestId('client-leads').locator(`[data-lead-id="${leadId}"]`).getByText('Won').waitFor(WAIT);
  const timeline = page.getByTestId('timeline');
  await timeline.getByText('Wants online ordering').waitFor(WAIT);
  await timeline.getByText('Lead “Alpha Bakery”: Talking → Won').waitFor(WAIT);
  await timeline.getByText(/Won the lead “Alpha Bakery”: Website with Great White North Design/).waitFor(WAIT);
  await page.getByTestId('contacts').getByText('Pat Baker').waitFor(WAIT);
  await barSays(page, 'Offline ·');
  assert.equal(server.db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId), undefined, 'not on the server yet');

  // Back online: saved once.
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  const lead = await until(() => {
    const r = server.db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(leadId);
    return r?.stage === 'won' ? r : null;
  }, 'the won lead on the server');
  assert.equal(lead.won_client_id, clientId);
  assert.equal(lead.email, 'pat@alphabakery.ca');
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM crm_clients WHERE name = 'Alpha Bakery'").get().n, 1);
  const rel = server.db.prepare('SELECT * FROM crm_relationships WHERE id = ?').get(lead.won_relationship_id);
  assert.deepEqual([rel.business_id, rel.kind, rel.status, rel.start_date], [AGENCY, 'website', 'active', today]);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE lead_id = ? AND due_date IS NOT NULL').get(leadId).n, 1);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM crm_lead_activities WHERE lead_id = ?').get(leadId).n, 3, 'the call and two stage rows');

  // On the phone, the won column (this month); on the Mac it is beside the open ones.
  await page.goto(`${server.base}/crm/pipeline`);
  if (phone) await page.getByRole('radio', { name: /^Won/ }).click();
  await page.getByTestId('pipeline-won').locator(`[data-lead-id="${leadId}"]`).waitFor(WAIT);

  // The cross-sell list: Lefty’s Lounge (a website, no social media) → Make a lead.
  await page.getByRole('radio', { name: 'Cross-sell' }).click();
  const line = page.locator(`[data-cross-sell="${ids.account}:website-social"]`);
  await line.getByText('No email consent').waitFor(WAIT);
  if (phone) assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Cross-sell');
  await line.getByRole('button', { name: 'Make a lead' }).click();
  await page.waitForURL(/\/crm\/leads\//, WAIT);
  await page.getByTestId('lead-client').getByText('Lefty’s Lounge').waitFor(WAIT);
  const made = await until(() => server.db.prepare("SELECT * FROM crm_leads WHERE source = 'cross_sell'").get(), 'the cross-sell lead on the server');
  assert.deepEqual([made.client_id, made.account_id, made.business_id, made.kind, made.stage], [ids.client, ids.account, AGENCY, 'social', 'lead']);
}

for (const [label, options] of [['iPhone', iphone()], ['Mac', { viewport: { width: 1280, height: 900 } }]]) {
  test(`${label}: a lead made, flagged, given a next step and won during an outage; the cross-sell list makes a lead`, async (t) => {
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
