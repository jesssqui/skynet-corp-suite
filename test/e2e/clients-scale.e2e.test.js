// The client screens on a phone holding 3,000 clients (~33,000 CRM records): the list, a client
// page, saving a note and going back stay quick. Timings are printed; the limits asserted are
// generous (slow machines). Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone } from './helpers.js';

const CLIENTS = 3000;
const BUSINESSES = [BUSINESS_IDS.wholesale, BUSINESS_IDS.agency, BUSINESS_IDS.consulting];

function seed({ ctx, db }) {
  const apply = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'partner', entity, op: 'create', fields });
    if (r.status !== 'applied') throw new Error(`${entity}: ${r.code} ${r.reason}`);
    return r.recordId;
  };
  let records = 0;
  db.transaction(() => {
    for (let i = 0; i < CLIENTS; i += 1) {
      const n = String(i).padStart(4, '0');
      const business = BUSINESSES[i % 3];
      const client = apply('client', { name: `Client ${n} Group`, status: i % 10 ? 'active' : 'closed', tags: 'seed' });
      const accounts = [0, 1].map((k) => apply('account', { client_id: client, name: `Store ${n}-${k}`, city: 'Simcoe', postal_code: 'N3Y 4K3' }));
      const contacts = [0, 1].map((k) => apply('contact', {
        client_id: client, account_id: accounts[k], name: `Person ${n}-${k}`, email: `p${n}${k}@example.test`, phone: `519${k ? 6 : 5}55${n}`,
      }));
      const rel = apply('relationship', { account_id: accounts[0], business_id: business, kind: 'wholesale', status: 'active' });
      apply('service', { relationship_id: rel, name: 'Retainer', status: 'active', amount_cents: 50000, period: 'monthly' });
      apply('consent', { contact_id: contacts[0], business_id: business, withdrawn: false, date: '2026-05-01', kind: 'express' });
      for (let k = 0; k < 3; k += 1) {
        apply('activity', {
          client_id: client, account_id: accounts[k % 2], business_id: business, type: k ? 'call' : 'note',
          body: `Seeded ${k} ${'x'.repeat(60)}`, at: `2026-0${k + 1}-15T15:00:00.000Z`,
        });
      }
      records += 11;
    }
  })();
  return records;
}

test(`${CLIENTS} clients: list, client page, saving a note and going back stay quick on a phone`, async (t) => {
  const server = await startServer(t);
  const records = seed(server);
  const { base, users } = server;
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  let t0 = Date.now();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await page.locator('[data-testid="sync-bar-text"]', { hasText: 'All changes saved' }).waitFor({ timeout: 180_000 });
  console.log(`# first download of ${records} CRM records: ${Date.now() - t0} ms`);

  const times = {};
  const time = async (name, fn) => {
    const s = Date.now();
    await fn();
    times[name] = Date.now() - s;
    console.log(`# ${name}: ${times[name]} ms`);
  };
  const row = page.locator('[data-client-row]').first();
  await time('list, cold', async () => {
    await page.getByRole('link', { name: 'Clients' }).first().click();
    await row.waitFor(WAIT);
  });
  assert.equal(await page.locator('[data-client-row]').count(), 50, 'pages of 50');
  const search = page.getByRole('searchbox', { name: 'Search clients' });
  await time('search by phone', async () => {
    await search.fill('(519) 655-1234');
    await page.locator('[data-client-row]', { hasText: 'Client 1234 Group' }).waitFor(WAIT);
  });
  await time('client page from the list, right after the search', async () => {
    await page.locator('[data-client-row]', { hasText: 'Client 1234 Group' }).getByRole('link').click();
    await page.getByTestId('timeline-count').filter({ hasText: /^3$/ }).waitFor(WAIT);
  });
  await page.getByRole('toolbar', { name: 'Quick capture' }).getByRole('button', { name: 'Add note' }).click();
  await page.getByRole('dialog').locator('#act-body').fill('Measured note');
  await time('saving a note until it shows', async () => {
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('[data-activity-id]', { hasText: 'Measured note' }).waitFor(WAIT);
  });
  await barSays(page, 'All changes saved');
  await time('back to the list', async () => {
    await page.goBack();
    await page.locator('[data-client-row]', { hasText: 'Client 1234 Group' }).waitFor(WAIT);
  });
  await time('client page from the list, again', async () => {
    await page.locator('[data-client-row]', { hasText: 'Client 1234 Group' }).getByRole('link').click();
    await page.getByTestId('timeline-count').filter({ hasText: /^4$/ }).waitFor(WAIT);
  });
  await time('client page, after a reload (cold)', async () => {
    await page.reload();
    await page.getByTestId('timeline-count').filter({ hasText: /^4$/ }).waitFor(WAIT);
  });
  for (const [name, ms] of Object.entries(times)) assert.ok(ms < 4000, `${name}: ${ms} ms`);
  assert.deepEqual(errors, []);
});
