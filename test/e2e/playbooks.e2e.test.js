// Projects and playbooks (D9) in the browser, on an iPhone and on a Mac: from Tasks to Playbooks; during
// an outage the packing example is added and run — its four tasks on the shared list at once, saved once
// back online; then the website-launch example is run for a test client (the preview shows its renewals
// and the offer), which makes the GWND relationship, the Hosting and Domain renewals a year out and the
// follow-up two weeks out; a step edited afterwards changes nothing in that run; the client page shows
// the project. No sideways scrolling on a phone. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS, addMonths } from '@suite/shared/crm';
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
  const client = make('client', { name: 'Test Bakery', status: 'active' });
  const account = make('account', { client_id: client, name: 'Test Bakery' });
  return { today: localDate(), ids: { client, account } };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function walkThrough(page, context, server, { today, ids }, label) {
  const phone = label === 'iPhone';
  const flat = async (what) => { if (phone) assert.ok((await noSideways(page)) <= 0, `no sideways scrolling: ${what}`); };
  await nav(page, 'Tasks');
  await page.getByTestId('tasks-playbooks-link').click();
  await page.waitForURL(/\/playbooks$/, WAIT);
  await page.getByText('Nothing under way.').waitFor(WAIT);
  await flat('Playbooks');

  // An outage: the packing example is added and run on the device.
  await airplane(context, server, true);
  await barSays(page, 'Offline');
  await page.getByRole('button', { name: 'Add the example Packing a wholesale order' }).click();
  await page.waitForURL(/\/playbooks\/[0-9a-f-]+$/, WAIT);
  await page.getByText('Pick the products').waitFor(WAIT);
  await flat('a playbook');
  await page.getByRole('button', { name: 'Run…' }).click();
  const sheet = page.getByTestId('run-sheet');
  await sheet.locator('#run-name').fill('Packing — order #1042');
  await sheet.getByTestId('run-preview').getByText('Send the tracking number to the customer').waitFor(WAIT);
  await flat('the run sheet');
  await sheet.getByRole('button', { name: 'Run it' }).click();
  await page.waitForURL(/\/playbooks\/runs\//, WAIT);
  const packRun = page.url().split('/playbooks/runs/')[1];
  await page.getByTestId('run-progress-line').getByText('0 of 4 done · now: Packing').waitFor(WAIT);
  assert.equal(await page.getByTestId('run-checklist').locator('[data-owner-badge="shared"]').count(), 4, 'all four on the shared list');
  // Ticked offline: the progress moves at once.
  await page.getByRole('checkbox', { name: 'Done: Pick the products' }).click();
  await page.getByTestId('run-progress-line').getByText('1 of 4 done · now: Packing').waitFor(WAIT);
  await flat('a run');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE run_id = ?').get(packRun).n, 0, 'not on the server yet');
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  const packed = await until(() => {
    const rows = server.db.prepare('SELECT owner, done_at FROM planner_tasks WHERE run_id = ? AND deleted_at IS NULL').all(packRun);
    return rows.length === 4 ? rows : null;
  }, 'the packing tasks on the server');
  assert.ok(packed.every((r) => r.owner === 'shared'));
  assert.equal(packed.filter((r) => r.done_at).length, 1);
  await shot(page, `d9-run-${label.toLowerCase()}`, { fullPage: false });

  // The website launch for the test client: renewals a year out, the follow-up in two weeks.
  await page.getByRole('link', { name: 'Playbooks', exact: true }).first().click();
  await page.waitForURL(/\/playbooks$/, WAIT);
  await page.getByRole('button', { name: 'Add the example Website launch' }).click();
  await page.waitForURL(/\/playbooks\/[0-9a-f-]+$/, WAIT);
  const playbookUrl = page.url();
  await page.getByRole('button', { name: 'Run…' }).click();
  await sheet.locator('#run-find').fill('bakery');
  await sheet.locator('#run-client').selectOption({ label: 'Test Bakery' });
  const preview = sheet.getByTestId('run-preview');
  await preview.getByText('Adds the relationship Great White North Design · Website').waitFor(WAIT);
  await preview.locator('[data-preview-kind="renewal"]').first().getByText(/Hosting renews on/).waitFor(WAIT);
  await preview.getByText(/Offer social media/).waitFor(WAIT);
  await flat('the run sheet with a client');
  await sheet.getByRole('button', { name: 'Run it' }).click();
  await page.waitForURL(/\/playbooks\/runs\//, WAIT);
  const launchRun = page.url().split('/playbooks/runs/')[1];
  await page.getByText(/Adds Hosting, renewing on/).waitFor(WAIT);
  await page.getByTestId('run-progress-line').getByText('0 of 6 done · now: Launch').waitFor(WAIT);
  const yearOut = addMonths(today, 12);
  const services = await until(() => {
    const rows = server.db.prepare(`SELECT s.name, s.renewal_date FROM crm_services s JOIN crm_relationships r ON r.id = s.relationship_id
      WHERE r.account_id = ? AND s.deleted_at IS NULL ORDER BY s.name`).all(ids.account);
    return rows.length === 2 ? rows : null;
  }, 'the renewals on the server');
  assert.deepEqual(services, [{ name: 'Domain', renewal_date: yearOut }, { name: 'Hosting', renewal_date: yearOut }]);
  const followUp = await until(() => server.db.prepare("SELECT * FROM planner_tasks WHERE run_id = ? AND title LIKE 'Follow up%'").get(launchRun), 'the follow-up');
  assert.deepEqual([followUp.due_date, followUp.owner, followUp.client_id, followUp.business_id], [addDays(today, 14), 'owner', ids.client, AGENCY]);

  // Running it again for the same client says it is already under way.
  await page.goto(playbookUrl);
  await page.getByRole('button', { name: 'Run…' }).click();
  await sheet.locator('#run-find').fill('bakery');
  await sheet.locator('#run-client').selectOption({ label: 'Test Bakery' });
  await sheet.getByTestId('run-under-way').getByText('Already under way: Website launch — Test Bakery').waitFor(WAIT);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });

  // Edit the playbook's follow-up step: the run keeps its own copy.
  await page.getByRole('button', { name: 'Edit step Follow up: how is the new site working for them?' }).click();
  const step = page.getByTestId('step-form');
  await step.locator('#step-title').fill('Follow up by phone');
  await flat('the step sheet');
  await step.getByRole('button', { name: 'Save', exact: true }).click();
  await step.waitFor({ state: 'detached', ...WAIT });
  await page.getByRole('button', { name: 'Edit step Follow up by phone' }).waitFor(WAIT);
  await page.goto(`${server.base}/playbooks/runs/${launchRun}`);
  await page.getByTestId('run-checklist').getByText('Follow up: how is the new site working for them?').waitFor(WAIT);
  await until(() => server.db.prepare("SELECT 1 FROM playbooks_steps WHERE title = 'Follow up by phone'").get(), 'the edit on the server');
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM playbooks_run_steps WHERE run_id = ? AND title LIKE 'Follow up%' AND title <> 'Follow up by phone'").get(launchRun).n, 1);

  // The client page shows the project.
  await page.goto(`${server.base}/crm/clients/${ids.client}`);
  await page.getByTestId('client-projects').getByText('Website launch — Test Bakery').waitFor(WAIT);
  await flat('the client page');
}

for (const [label, options] of [['iPhone', iphone()], ['Mac', { viewport: { width: 1280, height: 900 } }]]) {
  test(`${label}: the packing playbook run offline onto the shared list; a website launch makes its renewals and follow-up; edits change only future runs`, async (t) => {
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

test('iPhone SE (320 px): the playbooks pages fit', async (t) => {
  const server = await startServer(t);
  const browser = await launch(t);
  const context = await browser.newContext({ ...iphone(), viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await page.goto(`${server.base}/playbooks`);
  await page.getByRole('button', { name: 'Add the example Website launch' }).click();
  await page.waitForURL(/\/playbooks\/[0-9a-f-]+$/, WAIT);
  await page.getByText('Final checks: forms, links, speed and phone layout').waitFor(WAIT);
  assert.ok((await noSideways(page)) <= 0, 'a playbook at 320 px');
  await page.getByRole('button', { name: 'Edit step Hosting' }).click();
  await page.getByTestId('step-form').locator('#step-service').waitFor(WAIT);
  assert.ok((await noSideways(page)) <= 0, 'the step sheet at 320 px');
});
