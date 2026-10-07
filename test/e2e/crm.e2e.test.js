// The CRM's records in the browser (C3a): the Clients page shows our businesses from each person's
// side, and the plain record forms pick only the right kind of record and store clean contact details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot } from './helpers.js';

test('Clients page and plain CRM forms: owners from each side, ref pickers, clean email and phone', async (t) => {
  const server = await startServer(t);
  const { base, users, db } = server;
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  await page.getByRole('link', { name: 'Clients' }).first().click();
  await page.getByText('Great White North Design').waitFor(WAIT);
  assert.equal(await page.getByText('You', { exact: true }).count(), 3, 'wholesale, agency and consulting are the owner’s');
  assert.equal(await page.getByText('Shared list', { exact: true }).count(), 2);
  await shot(page, 'crm-clients-phone');

  await page.goto(`${base}/sync/data/client`);
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Lefty’s');
  await page.getByLabel('Status').selectOption('active');
  await page.getByLabel('Tags (optional)').fill(' vip, VIP, referral ');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('[data-record-id]').first().waitFor(WAIT);

  await page.goto(`${base}/sync/data/contact`);
  await page.getByRole('button', { name: 'Add' }).click();
  await page.locator('#new-client_id option', { hasText: 'Lefty’s' }).waitFor({ state: 'attached', ...WAIT });
  assert.deepEqual(await page.locator('#new-client_id option').allTextContents(), ['Choose…', 'Lefty’s'], 'only clients to pick from');
  await page.locator('#new-client_id').selectOption({ label: 'Lefty’s' });
  await page.getByLabel('Name', { exact: true }).fill('Mike');
  assert.equal(await page.locator('#new-email').getAttribute('type'), 'email');
  assert.equal(await page.locator('#new-phone').getAttribute('type'), 'tel');
  await page.locator('#new-email').fill('Mike@Leftys.CA');
  await page.locator('#new-phone').fill('+1 (519) 555-0100');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('(519) 555-0100').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  const saved = await until(() => db.prepare('SELECT * FROM crm_contacts').get(), 'the contact on the server');
  assert.deepEqual([saved.email, saved.phone], ['mike@leftys.ca', '5195550100']);
  assert.equal(db.prepare('SELECT tags FROM crm_clients').get().tags, 'vip, referral');

  // The client is deleted elsewhere (nothing cascades): its contact is hidden here too, and can be shown.
  const clientId = db.prepare('SELECT id FROM crm_clients').get().id;
  assert.equal(server.ctx.services.sync.applyLocal({ actor: 'partner', entity: 'client', op: 'delete', recordId: clientId }).status, 'applied');
  await page.goto(`${base}/sync/data/contact`);
  await page.getByTestId('hidden-records').filter({ hasText: '1 hidden' }).waitFor(WAIT);
  assert.equal(await page.locator('[data-record-id]').count(), 0);
  await page.getByRole('button', { name: 'Show them' }).click();
  await page.locator('[data-record-id]').first().waitFor(WAIT);
  await page.goto(`${base}/crm`);
  await page.getByText('Great White North Design').waitFor(WAIT);
  const contactRow = page.locator('a[href="/sync/data/contact"]');
  await contactRow.filter({ hasText: /contact\s*0/ }).waitFor(WAIT);

  // The partner's Mac: the same businesses, said from their side.
  const mac = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p2 = await mac.newPage();
  await signIn(p2, base, 'sam', users.partner.totpSecret);
  await p2.goto(`${base}/crm`);
  await p2.getByText('Save Point Shop').waitFor(WAIT);
  assert.equal(await p2.getByText('You', { exact: true }).count(), 1, 'Save Point Shop is the partner’s');
  assert.equal(await p2.getByText('Your partner', { exact: true }).count(), 3);
  await shot(p2, 'crm-clients-mac');

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});
