// The client screens (C3b) in the browser: the plan's one-owner, three-business example entered
// through the screens on an iPhone and on a Mac, the timeline filtered by our business and by
// theirs, the client list's business filter and search (a phone typed another way), and a note
// added during an outage that reaches the server once it is back. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const AGENCY = 'Great White North Design';

/** Fill and save the open sheet: fields = [[selector, value]] (select → option label, checkbox → true). */
async function fillSheet(page, fields, save = 'Save') {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor(WAIT);
  for (const [sel, value] of fields) {
    const el = dialog.locator(sel);
    const tag = await el.evaluate((n) => `${n.tagName}:${n.type}`);
    if (tag.startsWith('SELECT')) await el.selectOption({ label: value });
    else if (tag === 'INPUT:checkbox') await el.setChecked(value);
    else await el.fill(value);
  }
  await dialog.getByRole('button', { name: save, exact: true }).click();
  try {
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
  } catch (err) {
    throw new Error(`the sheet stayed open: ${await dialog.innerText()}`, { cause: err });
  }
}

const account = (page, name) => page.locator('[data-account-id]', { has: page.getByRole('heading', { name, exact: true }) });
const relationship = (page, accountName, kind) => account(page, accountName).locator('[data-relationship-id]', { hasText: kind });

/** The plan's example: one owner/group, three businesses, what each of ours does for them. */
async function enterExample(page) {
  await page.getByRole('link', { name: 'Clients' }).first().click();
  await page.getByText('No clients yet').waitFor(WAIT);
  await page.getByRole('button', { name: 'New client' }).click();
  await fillSheet(page, [['#client-name', 'Northwind Holdings'], ['#client-tags', 'multi-store, referral']]);
  await page.getByTestId('client-name').filter({ hasText: 'Northwind Holdings' }).waitFor(WAIT);

  const addAccount = async (fields) => {
    await page.getByRole('button', { name: 'Add account' }).click();
    await fillSheet(page, fields);
  };
  await addAccount([
    ['#account-name', 'Green Leaf Dispensary'], ['#account-city', 'Simcoe'], ['#account-region', 'ON'],
    ['#account-postal', 'n3y4k3'], ['#account-website', 'greenleaf.test'], ['#account-age', true],
  ]);
  await addAccount([['#account-name', 'Cloud Vape Co'], ['#account-age', true]]);
  await addAccount([['#account-name', 'Northwind Holdings Inc']]);
  await account(page, 'Northwind Holdings Inc').waitFor(WAIT);

  const addRelationship = async (accountName, business, kind) => {
    await account(page, accountName).getByRole('button', { name: 'Add relationship' }).click();
    await fillSheet(page, [['#rel-business', business], ...(kind ? [['#rel-kind', kind]] : []), ['#rel-start', '2026-03-01']]);
  };
  await addRelationship('Green Leaf Dispensary', AGENCY); // kind pre-filled: Website
  await addRelationship('Green Leaf Dispensary', AGENCY, 'Social media');
  await addRelationship('Cloud Vape Co', 'Wholesale'); // pre-filled: Wholesale
  await addRelationship('Northwind Holdings Inc', 'Business consulting'); // pre-filled: Consulting
  await relationship(page, 'Northwind Holdings Inc', 'Consulting').waitFor(WAIT);

  await relationship(page, 'Green Leaf Dispensary', 'Website').getByRole('button', { name: 'Add service' }).click();
  await fillSheet(page, [['#svc-name', 'Website build'], ['#svc-stage', 'Design'], ['#svc-billing', 'Flat fee'], ['#svc-amount', '3,000'], ['#svc-period', 'One-off']]);
  await relationship(page, 'Green Leaf Dispensary', 'Social media').getByRole('button', { name: 'Add service' }).click();
  await fillSheet(page, [['#svc-name', 'Social retainer'], ['#svc-billing', 'Flat fee'], ['#svc-amount', '1500'], ['#svc-period', 'Monthly'], ['#svc-renewal', '2027-03-01']]);
  await page.getByText('$1,500 / month').waitFor(WAIT);
  await page.getByText('$3,000 one-off').waitFor(WAIT);

  await page.getByRole('button', { name: 'Add contact' }).click();
  await fillSheet(page, [
    ['#contact-name', 'Robin Ortega'], ['#contact-role', 'Owner'], ['#contact-account', 'Cloud Vape Co'],
    ['#contact-email', ' Robin@CloudVape.TEST '], ['#contact-phone', '519.555.0100'], ['#contact-channel', 'Text message'],
  ]);
  const contact = page.locator('[data-contact-id]', { hasText: 'Robin Ortega' });
  await contact.getByRole('link', { name: '(519) 555-0100' }).waitFor(WAIT);
  assert.equal(await contact.getByRole('link', { name: 'robin@cloudvape.test' }).getAttribute('href'), 'mailto:robin@cloudvape.test');
  assert.equal(await contact.getByRole('link', { name: '(519) 555-0100' }).getAttribute('href'), 'tel:5195550100');
  await contact.getByRole('button', { name: 'Record consent' }).click();
  await fillSheet(page, [['#consent-business', 'Wholesale'], ['#consent-kind', 'Express — they said yes'], ['#consent-source', 'Signed up at the counter']], 'Record');
  await contact.locator(`[data-consent-business="${BUSINESS_IDS.wholesale}"][data-consent-state="given"]`).waitFor(WAIT);
  assert.equal(await contact.locator(`[data-consent-business="${BUSINESS_IDS.agency}"]`).getAttribute('data-consent-state'), 'none', 'consent is per business');

  // Notes and calls on different accounts and businesses, and one about the client in general.
  const capture = async (button, fields) => {
    await page.getByRole('button', { name: button }).first().click();
    await fillSheet(page, fields);
  };
  await capture('Add note', [['#act-body', 'Q4 social plan drafted'], ['#act-account', 'Green Leaf Dispensary'], ['#act-business', AGENCY]]);
  await capture('Log call', [['#act-body', 'Wants 40 tins Friday'], ['#act-account', 'Cloud Vape Co'], ['#act-business', 'Wholesale'], ['#act-at', '2026-10-06T15:30']]);
  await capture('Add note', [['#act-type', 'Meeting'], ['#act-body', 'Growth plan session booked'], ['#act-account', 'Northwind Holdings Inc'], ['#act-business', 'Business consulting']]);
  await capture('Add note', [['#act-body', 'Met the owner at the trade show']]);
  await page.getByTestId('timeline-count').filter({ hasText: /^4$/ }).waitFor(WAIT);
}

const timelineTexts = (page) => page.getByTestId('timeline').locator('[data-activity-id] p').allTextContents();

async function checkTimelineFilters(page) {
  await page.locator('#tl-business').selectOption({ label: AGENCY });
  await page.getByTestId('timeline-count').filter({ hasText: '1 of 4' }).waitFor(WAIT);
  assert.deepEqual(await timelineTexts(page), ['Q4 social plan drafted'], 'agency only');
  await page.locator('#tl-business').selectOption({ label: 'All' });
  await page.locator('#tl-account').selectOption({ label: 'Cloud Vape Co' });
  await page.getByTestId('timeline-count').filter({ hasText: '1 of 4' }).waitFor(WAIT);
  assert.deepEqual(await timelineTexts(page), ['Wants 40 tins Friday'], 'the vape shop only');
  // Quick capture starts from the timeline's filter.
  await page.getByRole('button', { name: 'Add note' }).first().click();
  const dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('#act-account option:checked').textContent(), 'Cloud Vape Co');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('#tl-account').selectOption({ label: 'All' });
  await page.locator('#tl-type').selectOption({ label: 'Call' });
  assert.deepEqual(await timelineTexts(page), ['Wants 40 tins Friday']);
  await page.locator('#tl-type').selectOption({ label: 'All' });
  await page.getByTestId('timeline-count').filter({ hasText: /^4$/ }).waitFor(WAIT);
}

async function checkList(page) {
  await page.getByRole('link', { name: 'Clients', exact: true }).first().click();
  const row = page.locator('[data-client-row]', { hasText: 'Northwind Holdings' });
  await row.waitFor(WAIT);
  assert.equal(await row.locator('[data-business-chip]').count(), 3, 'agency, wholesale and consulting chips');
  await row.getByText('Green Leaf Dispensary').waitFor(WAIT);
  await row.getByText(/^Last activity /).waitFor(WAIT);
  const business = page.locator('#clients-business');
  await business.selectOption({ label: 'Save Point Shop' });
  await page.getByText('No clients match').waitFor(WAIT);
  await business.selectOption({ label: 'Wholesale' });
  await row.waitFor(WAIT);
  await business.selectOption({ label: 'All our businesses' });
  const search = page.getByRole('searchbox', { name: 'Search clients' });
  for (const q of ['(519) 555-01', '+1 519 555 0100', 'dispensary', 'robin@cloud', 'ortega northwind']) {
    await search.fill(q);
    await row.waitFor(WAIT);
    assert.equal(await page.locator('[data-client-row]').count(), 1, q);
  }
  await search.fill('nobody at all');
  await page.getByText('No clients match').waitFor(WAIT);
  await search.fill('');
  await row.waitFor(WAIT);
}

function checkServer(db) {
  const rels = db.prepare(`SELECT a.name AS account, r.kind, r.business_id FROM crm_relationships r JOIN crm_accounts a ON a.id = r.account_id
    ORDER BY a.name, r.kind`).all();
  assert.deepEqual(rels.map((r) => [r.account, r.kind]), [
    ['Cloud Vape Co', 'wholesale'], ['Green Leaf Dispensary', 'social'], ['Green Leaf Dispensary', 'website'], ['Northwind Holdings Inc', 'consulting'],
  ]);
  assert.deepEqual(db.prepare('SELECT name, amount_cents, period FROM crm_services ORDER BY name').all().map((s) => [s.name, s.amount_cents, s.period]),
    [['Social retainer', 150000, 'monthly'], ['Website build', 300000, 'once']], 'dollars stored as cents');
  const p = db.prepare('SELECT * FROM crm_contacts').get();
  assert.deepEqual([p.email, p.phone, p.preferred_channel], ['robin@cloudvape.test', '5195550100', 'text']);
  const k = db.prepare('SELECT * FROM crm_consents').get();
  assert.deepEqual([k.business_id, k.kind, k.withdrawn, k.expires_on], [BUSINESS_IDS.wholesale, 'express', 0, null]);
  assert.equal(db.prepare('SELECT postal_code FROM crm_accounts WHERE name = ?').get('Green Leaf Dispensary').postal_code, 'N3Y 4K3');
  assert.equal(db.prepare('SELECT count(*) AS n FROM crm_accounts WHERE age_restricted = 1').get().n, 2);
  const call = db.prepare("SELECT * FROM crm_activities WHERE type = 'call'").get();
  assert.equal(call.at, new Date(2026, 9, 6, 15, 30).toISOString(), 'a back-dated call keeps the time typed (browser and Node share a time zone here)');
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('iPhone: the plan’s example entered and filtered; search by phone; a note made in an outage reaches the server', async (t) => {
  const server = await startServer(t);
  const { base, db, users } = server;
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  await enterExample(page);
  await barSays(page, 'All changes saved');
  checkServer(db);
  await checkTimelineFilters(page);
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the client page');
  // The capture bar sits above the tab bar, with full-size tap targets, without scrolling.
  const bar = page.getByRole('toolbar', { name: 'Quick capture' });
  const box = await bar.getByRole('button', { name: 'Add note' }).boundingBox();
  const tabbar = await page.locator('.shell-tabbar').boundingBox();
  assert.ok(box.height >= 44 && box.y + box.height <= tabbar.y + 1 && box.y > 0, `capture bar placed ${JSON.stringify(box)} above ${JSON.stringify(tabbar)}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'c3b-client-phone');
  await shot(page, 'c3b-client-phone-screen', { fullPage: false }); // as it looks: the capture bar above the tab bar

  await checkList(page);
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the list');
  await shot(page, 'c3b-list-phone');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'c3b-list-phone-dark', { fullPage: false });
  await page.emulateMedia({ colorScheme: 'light' });

  // An outage: the note is saved on the phone and goes out when the server is back.
  await page.locator('[data-client-row]', { hasText: 'Northwind Holdings' }).getByRole('link').click();
  await page.getByTestId('client-name').waitFor(WAIT);
  await airplane(phone, server, true);
  await barSays(page, 'Offline');
  await bar.getByRole('button', { name: 'Add note' }).click();
  await page.getByRole('dialog').locator('#act-body').fill('Dropped off a sample pack');
  await shot(page, 'c3b-quick-note-phone', { fullPage: false });
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await barSays(page, 'Offline · 1 change waiting');
  const offlineNote = page.locator('[data-activity-id]', { hasText: 'Dropped off a sample pack' });
  await offlineNote.getByText('Waiting to sync').waitFor(WAIT);
  await offlineNote.getByText('by you').waitFor(WAIT);
  assert.equal(db.prepare("SELECT count(*) AS n FROM crm_activities WHERE body = 'Dropped off a sample pack'").get().n, 0);
  await airplane(phone, server, false);
  await barSays(page, 'All changes saved');
  const note = await until(() => db.prepare("SELECT * FROM crm_activities WHERE body = 'Dropped off a sample pack'").get(), 'the offline note on the server');
  assert.deepEqual([note.type, note.created_by, note.account_id, note.business_id], ['note', 'owner', null, null]);

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('Mac: the example entered on a wide screen (records left, timeline right); the partner sees who logged what', async (t) => {
  const server = await startServer(t);
  const { base, db, users } = server;
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  await enterExample(page);
  await barSays(page, 'All changes saved');
  checkServer(db);
  await checkTimelineFilters(page);
  const accounts = await page.getByTestId('accounts').boundingBox();
  const timeline = await page.getByTestId('timeline').boundingBox();
  assert.ok(timeline.x > accounts.x + accounts.width - 1, 'the timeline sits beside the accounts');
  assert.ok(timeline.y < accounts.y + 300, 'and starts near the top');
  await page.locator('[data-activity-id]', { hasText: 'Wants 40 tins Friday' }).getByText('by you').waitFor(WAIT);
  await shot(page, 'c3b-client-mac');
  await checkList(page);
  await shot(page, 'c3b-list-mac');

  // Close the client: it leaves the active list and is found under Closed.
  await page.locator('[data-client-row]', { hasText: 'Northwind Holdings' }).getByRole('link').click();
  await page.getByRole('button', { name: 'Close client' }).click();
  await page.getByRole('button', { name: 'Reopen' }).waitFor(WAIT);
  await page.getByRole('link', { name: 'Clients', exact: true }).first().click();
  await page.getByText('No clients match').waitFor(WAIT);
  await page.getByRole('radio', { name: 'Closed' }).click();
  await page.locator('[data-client-row]', { hasText: 'Northwind Holdings' }).waitFor(WAIT);

  // The partner's device: the same client, with who logged each note.
  const other = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p2 = await other.newPage();
  await signIn(p2, base, 'sam', users.partner.totpSecret);
  await p2.goto(`${base}/crm?status=all`);
  await p2.locator('[data-client-row]', { hasText: 'Northwind Holdings' }).getByRole('link').click();
  await p2.locator('[data-activity-id]', { hasText: 'Wants 40 tins Friday' }).getByText('by your partner').waitFor(WAIT);

  // A mistake deleted (behind a confirm): only that record goes; nothing under it is deleted.
  await page.locator('[data-client-row]', { hasText: 'Northwind Holdings' }).getByRole('link').click();
  await account(page, 'Northwind Holdings Inc').getByRole('button', { name: 'Edit account Northwind Holdings Inc' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Delete…' }).click();
  await dialog.getByText('Only for a mistake').waitFor(WAIT);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await account(page, 'Northwind Holdings Inc').waitFor({ state: 'detached', ...WAIT });
  await barSays(page, 'All changes saved');
  assert.equal(db.prepare("SELECT count(*) AS n FROM crm_accounts WHERE deleted_at IS NOT NULL").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM crm_relationships WHERE deleted_at IS NULL AND kind = 'consulting'").get().n, 1, 'its relationship is hidden, not deleted');

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});
