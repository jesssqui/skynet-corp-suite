// Bringing clients in (C7) in the browser: a 20-line brain dump typed into Quick add becomes 20
// clients (on the iPhone and on the Mac, and on the server); the same list again is all "Already
// here" and makes nothing; a brain dump saved offline reaches the server later; an accounting CSV
// imported twice makes nothing the second time. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const DUMP = [
  'Harbour Lights Bakery - website, social retainer - Ada Moss ada@harbourlights.test 519-555-0101',
  'Birch & Bark | consulting | Ben Cole | 519.555.0102',
  'Northwind Holdings (Green Leaf Dispensary) — website — owner: Robin Ortega robin@greenleaf.test',
  'Kettle Creek Outfitters; web; #referral; cy@kettlecreek.test; notes: wants a quote before spring',
  'Lakeview Dental, dee@lakeviewdental.test',
  'Maple Row Farms – social – (226) 555-0106',
  'Pinecrest Motors | website + social media | Gus Hale | gus@pinecrest.test',
  'Silver Birch Spa - consulting - hana@silverbirch.test - 519 555 0108',
  'Old Mill Coffee; design; Ivy Lund; ivy@oldmill.test',
  'Red Barn Antiques — 1-519-555-0110 — Jack Moss',
  'Tidewater Kayaks | seo | kai@tidewater.test',
  'Copper Kettle Diner - web - Lena Park - +1 (519) 555-0112',
  'Blue Heron Books, social, mo@blueheron.test',
  'Fernwood Florist | wholesale | Nia Ross | 519-555-0114',
  'Granite Peak Fitness - website - oscar@granitepeak.test',
  'Willow Creek Vet — consulting — 226.555.0116 — Dr. Paula Quinn',
  'Sunset Surf Shop; instagram; quinn@sunsetsurf.test',
  'Iron Gate Brewing | website, social | Rae Stone | rae@irongate.test | 519 555 0118',
  'Lighthouse Realty - consulting coaching - sam@lighthouse.test',
  'Wildflower Yoga Studio, tia@wildfloweryoga.test, 519-555-0120',
];
const NAMES = DUMP.map((l) => l.split(/ - | \| |; |, | — | – /)[0].replace(/ \(.*\)$/, ''));

const count = (db, table, where = 'deleted_at IS NULL') => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const rowsWith = (page, status) => page.locator(`[data-qa-row][data-status="${status}"]`);

async function openQuickAdd(page) {
  await page.getByRole('link', { name: 'Clients', exact: true }).first().click();
  await page.getByRole('button', { name: 'Quick add' }).click();
  await page.locator('#qa-text').waitFor(WAIT);
}

/** Paste the list; the preview shows one row per line, all new. */
async function pasteAndCheck(page, lines, status = 'new') {
  await page.locator('#qa-text').fill(lines.join('\n'));
  await rowsWith(page, status).nth(lines.length - 1).waitFor(WAIT);
  assert.equal(await page.locator('[data-qa-row]').count(), lines.length);
  assert.equal(await rowsWith(page, status).count(), lines.length, `all ${status}`);
}

/** What the server holds after the 20-line dump. */
function checkServer(db) {
  assert.equal(count(db, 'crm_clients'), 20);
  assert.deepEqual(db.prepare('SELECT name FROM crm_clients ORDER BY name').pluck().all(), [...NAMES].sort());
  assert.equal(count(db, 'crm_accounts'), 20);
  assert.equal(count(db, 'crm_contacts'), 20, 'every line had an email or phone');
  assert.equal(count(db, 'crm_relationships'), 23, 'one per business and kind named, the default for the rest');
  const robin = db.prepare(`SELECT p.name, p.role, p.email, a.name AS account, k.name AS client FROM crm_contacts p
    JOIN crm_accounts a ON a.id = p.account_id JOIN crm_clients k ON k.id = p.client_id WHERE p.email = 'robin@greenleaf.test'`).get();
  assert.deepEqual(robin, { name: 'Robin Ortega', role: 'Owner', email: 'robin@greenleaf.test', account: 'Green Leaf Dispensary', client: 'Northwind Holdings' });
  assert.equal(db.prepare("SELECT phone FROM crm_contacts WHERE name = 'Lena Park'").get().phone, '5195550112');
  const harbour = db.prepare(`SELECT r.business_id, r.kind, r.notes FROM crm_relationships r JOIN crm_accounts a ON a.id = r.account_id
    WHERE a.name = 'Harbour Lights Bakery' ORDER BY r.kind`).all();
  assert.deepEqual(harbour.map((r) => [r.business_id, r.kind, r.notes]), [[BUSINESS_IDS.agency, 'social', 'social retainer'], [BUSINESS_IDS.agency, 'website', null]]);
  assert.equal(db.prepare("SELECT k.tags FROM crm_clients k WHERE name = 'Kettle Creek Outfitters'").get().tags, 'referral');
  assert.equal(count(db, 'crm_relationships', `business_id = '${BUSINESS_IDS.wholesale}'`), 1, 'wholesale when named');
}

/** Save, wait for it to reach the server, and see the 20 in the client list. */
async function saveAndConfirm(page, db) {
  const save = page.getByTestId('qa-save');
  assert.equal(await save.textContent(), 'Add 20 clients');
  await save.click();
  await page.getByTestId('qa-result').filter({ hasText: 'Added 20 clients' }).waitFor(WAIT);
  assert.equal(await rowsWith(page, 'done').count(), 20, 'every row marked added');
  assert.equal(await save.isDisabled(), true, 'nothing left to add: a second tap does nothing');
  await barSays(page, 'All changes saved');
  await until(() => count(db, 'crm_clients') === 20, '20 clients on the server');
  checkServer(db);
  await page.getByRole('link', { name: 'See them in Clients' }).click();
  await page.getByTestId('client-list').waitFor(WAIT);
  assert.equal(await page.locator('[data-client-row]').count(), 20, '20 clients in the list');
}

/** The same list again: all "Already here", nothing to add, nothing made. */
async function pasteAgain(page, db) {
  // Back to Quick add (the list is still there, every line added), then a new list.
  await page.getByRole('button', { name: 'Quick add' }).click();
  await rowsWith(page, 'done').nth(19).waitFor(WAIT);
  await page.getByRole('button', { name: 'Start a new list' }).click();
  assert.equal(await page.locator('#qa-text').inputValue(), '');
  await pasteAndCheck(page, DUMP, 'same');
  await page.locator('[data-qa-row="1"]').getByText('Already here').waitFor(WAIT);
  assert.equal(await page.getByTestId('qa-save').isDisabled(), true);
  assert.equal(await page.getByTestId('qa-save').textContent(), 'Nothing to add');
  assert.equal(count(db, 'crm_clients'), 20, 'nothing new');
}

test('iPhone: a 20-line brain dump becomes 20 clients; again = all already here; one saved offline syncs later', async (t) => {
  const server = await startServer(t);
  const { base, db, users } = server;
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  await openQuickAdd(page);
  await pasteAndCheck(page, DUMP);
  // The preview, as cards: what each line makes; the default business for lines without one.
  const lake = page.locator('[data-qa-row="5"]');
  await lake.getByText('No business named: using the default').waitFor(WAIT);
  await lake.getByText('Contact: Lakeview Dental · dee@lakeviewdental.test').waitFor(WAIT);
  await page.locator('[data-qa-row="1"]').getByText('Makes client, account, 2 relationships, contact').waitFor(WAIT);
  // Fix a row in its sheet: tap targets are full size.
  const edit = page.locator('[data-qa-row="2"]').getByRole('button', { name: 'Edit line 2' });
  assert.ok((await edit.boundingBox()).height >= 44, 'Edit is a full tap target');
  assert.ok((await page.locator('[data-qa-row="2"] .qa-chip').first().boundingBox()).height >= 44, 'business toggles too');
  await edit.click();
  const sheet = page.getByRole('dialog');
  assert.equal(await sheet.locator('#qa-client').inputValue(), 'Birch & Bark');
  await sheet.locator('#qa-role').fill('Owner');
  await sheet.getByRole('button', { name: 'Done', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'c7-quickadd-phone', { fullPage: false });
  await page.locator('[data-qa-row="1"]').scrollIntoViewIfNeeded();
  await shot(page, 'c7-quickadd-phone-preview', { fullPage: false });

  await saveAndConfirm(page, db);
  assert.equal(db.prepare("SELECT role FROM crm_contacts WHERE name = 'Ben Cole'").get().role, 'Owner', 'the edit was saved');
  await pasteAgain(page, db);
  await shot(page, 'c7-quickadd-phone-again', { fullPage: false });

  // Offline: saved on the phone, on the server once it is back.
  await airplane(phone, server, true);
  await barSays(page, 'Offline');
  await page.getByRole('button', { name: 'Start a new list' }).click();
  const offline = ['Cedar Point Cabins - website - ana@cedarpoint.test', 'Lowbanks Marina | social | 905 555 0122 | Ian Shaw'];
  await pasteAndCheck(page, offline);
  await page.getByTestId('qa-save').click();
  await page.getByTestId('qa-result').filter({ hasText: 'Added 2 clients on this device' }).waitFor(WAIT);
  await barSays(page, 'Offline ·');
  assert.equal(count(db, 'crm_clients'), 20, 'not on the server yet');
  await airplane(phone, server, false);
  await barSays(page, 'All changes saved');
  await until(() => count(db, 'crm_clients') === 22, 'the offline clients on the server');
  assert.equal(db.prepare("SELECT p.name FROM crm_contacts p WHERE p.phone = '9055550122'").get().name, 'Ian Shaw');

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

const CSV = [
  'Customer Name,Email,Phone,Contact First Name,Contact Last Name,Address Line 1,City,Province/State,Postal Code/Zip Code,Country,Website',
  'Harbour Lights Bakery Ltd,ada@harbourlights.test,,Ada,Moss,12 Main St,Port Dover,ON,N0A 1N0,Canada,', // already here (email)
  'Old Mill Coffee Roasters,orders@oldmillroasters.test,519-555-0130,Ola,Berg,3 Mill Rd,Simcoe,ON,n3y4k3,Canada,', // maybe the same
  'Bayview Tire & Auto,service@bayviewtire.test,519-555-0131,Pat,Doe,,Delhi,ON,,Canada,bayviewtire.test',
  '"Smith, Jones & Partners LLP",office@sjp.test,"(519) 555-0132",Quinn,Smith,"40 King St, Suite 2",Simcoe,ON,N3Y 1A1,Canada,',
  'Turkey Point Tackle,,555-0133,Roy,Tan,,Turkey Point,ON,,Canada,',
  'Long Point Eco Tours,hello@lpeco.test,,Sue,Vale,,Port Rowan,ON,,Canada,',
  'St. Williams Winery,info@stwilliams.test,519 555 0135,,,,St. Williams,ON,,Canada,',
  'Delhi Hardware,"sales@delhihw.test",519.555.0136,Uma,West,"88 Main St\nRear entrance",Delhi,ON,,Canada,',
].join('\r\n');

test('Mac: the brain dump in a table edited in place; a CSV imported twice creates nothing the second time', async (t) => {
  const server = await startServer(t);
  const { base, db, users } = server;
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  await openQuickAdd(page);
  await pasteAndCheck(page, DUMP);
  const table = page.getByTestId('qa-preview');
  assert.equal(await table.evaluate((n) => n.tagName), 'TABLE', 'a table on a wide screen');
  // Fix a cell in place: a typo in a name, then a business switched on for one row.
  await page.locator('#qa-text').fill(DUMP.join('\n').replace('Tidewater Kayaks', 'Tidewatr Kayaks'));
  await page.locator('[data-qa-row="11"] input[aria-label="Line 11: client"]').waitFor(WAIT);
  assert.equal(await page.getByLabel('Line 11: client').inputValue(), 'Tidewatr Kayaks');
  await page.getByLabel('Line 11: client').fill('Tidewater Kayaks');
  await page.locator('[data-qa-row="11"]').getByRole('button', { name: 'Consulting' }).click();
  assert.equal(await page.locator('[data-qa-row="11"]').getByRole('button', { name: 'Consulting' }).getAttribute('aria-pressed'), 'true');
  await page.locator('[data-qa-row="11"]').getByRole('button', { name: 'Consulting' }).click(); // and off again
  await page.locator('[data-qa-row="11"]').getByText('Makes client, account, relationship, contact').waitFor(WAIT);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'c7-quickadd-mac', { fullPage: false });
  await page.getByRole('heading', { name: 'Preview' }).evaluate((h) => h.scrollIntoView());
  await shot(page, 'c7-quickadd-mac-preview', { fullPage: false });
  await saveAndConfirm(page, db);
  await pasteAgain(page, db);
  await shot(page, 'c7-quickadd-mac-again', { fullPage: false });

  // The CSV import: mapping detected, preview flagged, import, then the same file again.
  await page.goto(`${base}/crm/import`);
  const upload = (name) => page.locator('#imp-file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(`﻿${CSV}`) });
  await upload('customers.csv');
  await page.getByTestId('imp-file-name').filter({ hasText: '8 rows · looks like a Wave export' }).waitFor(WAIT);
  assert.equal(await page.locator('#map-name option:checked').textContent(), 'Customer Name');
  assert.equal(await page.locator('#map-email option:checked').textContent(), 'Email');
  assert.equal(await page.locator('#map-postal option:checked').textContent(), 'Postal Code/Zip Code');
  assert.equal(await page.locator('#map-company option:checked').textContent(), '— Not in this file —');
  await page.locator('#imp-business').selectOption({ label: 'Business consulting · Consulting' });
  await shot(page, 'c7-import-mapping-mac');
  await page.getByTestId('imp-preview').click();
  const counts = page.getByTestId('imp-counts');
  await counts.getByText('New 6').waitFor(WAIT);
  await counts.getByText('Already here 1').waitFor(WAIT);
  await counts.getByText('Maybe the same 1').waitFor(WAIT);
  const harbour = page.locator('[data-imp-row="2"]');
  await harbour.getByText('Already here').waitFor(WAIT);
  await harbour.getByRole('link', { name: 'Harbour Lights Bakery' }).waitFor(WAIT);
  await page.locator('[data-imp-row="6"]').getByText(/555-0133.*area code/).waitFor(WAIT);
  // The similar one: add only what's missing (a new contact and the consulting relationship on Old Mill Coffee).
  await page.getByLabel('Row 3: what to do').selectOption({ label: 'Add only what’s missing' });
  await page.locator('[data-imp-row="3"]').getByText('“Add only what’s missing” adds a contact, Business consulting · Consulting').waitFor(WAIT);
  assert.equal(await page.getByTestId('imp-commit').textContent(), 'Import 6 clients + 1 existing');
  await counts.evaluate((n) => n.scrollIntoView());
  await page.evaluate(() => window.scrollBy(0, -60));
  await shot(page, 'c7-import-preview-mac', { fullPage: false });
  await page.getByTestId('imp-commit').click();
  await page.getByTestId('imp-result').filter({ hasText: 'Imported: 6 new clients · 1 filled in · 1 skipped' }).waitFor(WAIT);
  assert.equal(count(db, 'crm_clients'), 26);
  const oldMill = db.prepare(`SELECT k.name AS client, p.email FROM crm_contacts p JOIN crm_clients k ON k.id = p.client_id WHERE p.email = 'orders@oldmillroasters.test'`).get();
  assert.deepEqual(oldMill, { client: 'Old Mill Coffee', email: 'orders@oldmillroasters.test' }, 'added to the existing client');
  assert.equal(db.prepare("SELECT street FROM crm_accounts WHERE name = 'Delhi Hardware'").get().street, '88 Main St Rear entrance');
  await page.getByTestId('imp-batches').locator('[data-batch-id]').first().getByText('by you').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  // The device received the imported clients through its next sync.
  await page.getByRole('link', { name: 'See your clients' }).click();
  await page.getByTestId('client-list').waitFor(WAIT);
  await page.locator('[data-client-row]').nth(25).waitFor(WAIT);
  assert.equal(await page.locator('[data-client-row]').count(), 26, 'imported clients on the Mac');

  // The same file again: everything was imported before (or is already here); nothing to import.
  await page.goto(`${base}/crm/import`);
  await upload('customers.csv');
  await page.getByTestId('imp-preview').click();
  await counts.getByText('Imported before 7').waitFor(WAIT);
  await counts.getByText('Already here 1').waitFor(WAIT);
  assert.equal(await page.getByTestId('imp-commit').textContent(), 'Nothing new to import');
  assert.equal(await page.getByTestId('imp-commit').isDisabled(), true);
  assert.equal(count(db, 'crm_clients'), 26, 'nothing new');
  assert.equal(count(db, 'crm_import_batches', '1 = 1'), 1);
  await shot(page, 'c7-import-again-mac', { fullPage: false });

  // Offline, the page says it needs a connection.
  await airplane(mac, server, true);
  await page.getByTestId('imp-offline').waitFor(WAIT);
  assert.equal(await page.getByTestId('imp-preview').isDisabled(), true);
  await airplane(mac, server, false);

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});
