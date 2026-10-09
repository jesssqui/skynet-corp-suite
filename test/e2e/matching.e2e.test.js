// Matching and suggestions (D2) in the browser, on a Mac and on an iPhone: a customer linked
// automatically shows how ("Linked automatically (same email)") and is undone from the Linked tab
// (what it puts back is listed first; the age mark comes off); the Suggestions tab shows customers
// beside the clients they may be — Link… picks the client and keeps the reason, Not the same takes a
// pair away and Show dismissed brings it back — and possible duplicate clients; the Friday review
// counts them; the client page's account card says how it was linked and undoes it. On the phone:
// the same review list, no sideways scroll, and offline it says it needs the server.
// Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, iphone, shot, airplane } from './helpers.js';
import { womKit, postEvents } from '../../server/test/fixtures/wom.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function setup(t) {
  const server = await startServer(t);
  const { ctx } = server;
  const secret = ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const client = (name, { account = name, business = 'agency', contact = null, street = null, postal = null } = {}) => {
    const clientId = make('client', { name, status: 'active' });
    const accountId = make('account', { client_id: clientId, name: account, age_restricted: false, street, postal_code: postal });
    make('relationship', { account_id: accountId, business_id: BUSINESS_IDS[business], kind: business === 'consulting' ? 'consulting' : 'website', status: 'active' });
    if (contact) make('contact', { client_id: clientId, account_id: accountId, ...contact });
    return { clientId, accountId };
  };
  const harbour = client('Harbour Smoke', { account: 'Harbour Smoke Shop', contact: { name: 'Dana Reyes', email: 'dana@harbour.example' } });
  const lefty = client('Lefty’s', { business: 'consulting' });
  const maple = client('Maple Holdings', { account: 'Maple Grocery', street: '88 Queen Street North', postal: 'N3Y 2B4' });
  client('Green Leaf', { contact: { name: 'Al', phone: '5195550144' } });
  client('Green Leaf Dispensary', { contact: { name: 'Al G', phone: '5195550144' } });

  const om = womKit();
  const byEmail = om.customer({ business_name: 'Harbour Smoke & Vape', contact_name: 'Dana', email: 'dana@harbour.example' });
  const byName = om.customer({ business_name: 'Leftys Cannabis Dispensary', contact_name: 'Lefty', phone: '2265550188' });
  const byAddress = om.customer({
    business_name: 'QuickStop Market', contact_name: 'Ana',
    address: { line1: '88 Queen St. N', line2: null, city: 'Simcoe', province: 'ON', postal_code: 'N3Y 2B4', country: 'Canada' },
  });
  const order = om.order(byEmail, [{ name: 'Zyn Cool Mint 6mg', quantity: 10, unit_price_cents: 650 }], { order_date: '2026-10-06' });
  const res = await postEvents(server.direct, secret, [byEmail, byName, byAddress].map((c) => om.customerCreated(c)).concat(om.orderPlaced(order)));
  assert.ok(res.body.results.every((r) => r.status === 'applied'));
  assert.equal(ctx.services.crm.liveLinks('wom', byEmail.customer_uid)[0]?.matched_by, 'auto', 'linked automatically on arrival');
  return { server, harbour, lefty, maple, byEmail, byName, byAddress };
}

test('Mac: undo an automatic link; link from a suggestion; Not the same and back; duplicates; the Friday review; undo on the client page', async (t) => {
  const { server, harbour, lefty, byEmail, byName, byAddress } = await setup(t);
  const crm = server.ctx.services.crm;
  const browser = await launch(t);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);

  // The client page first: its account card says how, and the order is on the timeline.
  await page.goto(`${server.base}/crm/clients/${harbour.clientId}`);
  await page.getByTestId('link-line').filter({ hasText: 'Linked automatically (same email) to an Order Manager customer' }).waitFor(WAIT);
  await page.locator('[data-wholesale="wholesale_order"]').waitFor(WAIT);

  // Linked tab: how it was linked; Undo link… lists what it puts back, then does it.
  await page.goto(`${server.base}/wholesale?tab=linked`);
  const linkedRow = page.locator(`[data-customer="${byEmail.customer_uid}"]`);
  await linkedRow.getByTestId('link-how').filter({ hasText: 'Linked automatically (same email)' }).waitFor(WAIT);
  await shot(page, 'd2-linked-mac');
  await linkedRow.getByRole('button', { name: 'Undo link…' }).click();
  const undo = page.getByTestId('undo-link-sheet');
  await undo.getByTestId('undo-restore').getByText('“Harbour Smoke Shop” is no longer marked age-restricted (as before the link)').waitFor(WAIT);
  await undo.getByTestId('undo-restore').getByText(/The wholesale relationship of “Harbour Smoke Shop”, made by the link, is removed/).waitFor(WAIT);
  await shot(page, 'd2-undo-sheet-mac', { fullPage: false });
  await undo.getByRole('button', { name: 'Undo the link' }).click();
  await page.getByTestId('wholesale-done').filter({ hasText: 'Harbour Smoke & Vape is waiting for a client again.' }).waitFor(WAIT);
  assert.equal(crm.liveLinks('wom', byEmail.customer_uid).length, 0);
  assert.equal(crm.liveAccount(harbour.accountId).age_restricted, false);

  // Suggestions: the name match, the address match, the undone one (not linked again), duplicates.
  await page.getByRole('radio', { name: /^Suggestions/ }).click();
  const list = page.getByTestId('suggestions-list');
  const nameCard = list.locator(`[data-suggestion="${byName.customer_uid}|${lefty.clientId}"]`);
  await nameCard.getByText('Similar name: “Lefty’s”').waitFor(WAIT);
  await list.locator(`[data-suggestion^="${byAddress.customer_uid}|"]`).getByText(/^Same address: 88 Queen Street North/).waitFor(WAIT);
  await list.locator(`[data-suggestion="${byEmail.customer_uid}|${harbour.clientId}"]`).getByText('A link between them was undone before').waitFor(WAIT);
  await page.getByTestId('duplicates-list').getByText('Same phone: (519) 555-0144').waitFor(WAIT);
  await shot(page, 'd2-suggestions-mac');
  assert.equal(await noSideways(page), 0);

  // Link… from a suggestion: the client is picked, the reason kept on the link.
  await nameCard.getByRole('button', { name: 'Link…' }).click();
  const sheet = page.getByTestId('link-sheet');
  await sheet.getByTestId('link-client').getByText('Lefty’s').waitFor(WAIT);
  await sheet.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByText('Linked to Lefty’s').waitFor(WAIT);
  const [made] = crm.liveLinks('wom', byName.customer_uid);
  assert.deepEqual([made.matched_by, made.match_reason, made.account_id], ['approved', 'similar name', lefty.accountId]);
  await nameCard.waitFor({ state: 'detached', ...WAIT });

  // Not the same: gone; Show dismissed → Suggest again: back.
  const addrCard = list.locator(`[data-suggestion^="${byAddress.customer_uid}|"]`);
  await addrCard.getByRole('button', { name: 'Not the same' }).click();
  await addrCard.waitFor({ state: 'detached', ...WAIT });
  await page.getByRole('button', { name: 'Show dismissed' }).click();
  const dismissed = page.getByTestId('dismissed-list');
  await dismissed.getByText('QuickStop Market').waitFor(WAIT);
  await dismissed.getByRole('button', { name: 'Suggest again' }).click();
  await addrCard.waitFor(WAIT);

  // Duplicates: Not the same.
  const dup = page.getByTestId('duplicates-list').locator('li').first();
  await dup.getByRole('button', { name: 'Not the same' }).click();
  await page.getByText('No possible duplicates').waitFor(WAIT);

  // The Friday review counts what is left and links to it.
  await page.goto(`${server.base}/plan/review`);
  const line = page.getByTestId('review-matches');
  await line.filter({ hasText: '2 Order Manager customers may already be clients' }).waitFor(WAIT);
  await line.getByRole('link', { name: 'Review them' }).click();
  await page.waitForURL(/\/wholesale\?tab=suggestions$/, WAIT);

  // Undo from the client page's account card (the link made from the suggestion).
  await page.goto(`${server.base}/crm/clients/${lefty.clientId}`);
  const card = page.getByTestId('link-line').filter({ hasText: 'Linked by you (similar name)' });
  await card.waitFor(WAIT);
  await card.getByRole('button', { name: 'Undo this link' }).click();
  await page.getByTestId('undo-link-sheet').getByRole('button', { name: 'Undo the link' }).click();
  await page.getByTestId('link-undone').waitFor(WAIT);
  await page.getByTestId('link-line').waitFor({ state: 'detached', ...WAIT });
  assert.equal(crm.liveLinks('wom', byName.customer_uid).length, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('iPhone: the review list side by side fits the phone; offline it says it needs the server; Undo offline changes nothing', async (t) => {
  const { server, byName, lefty, harbour } = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext(iphone());
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'sam', server.users.partner.totpSecret);

  await page.goto(`${server.base}/wholesale?tab=suggestions`);
  const card = page.getByTestId('suggestions-list').locator(`[data-suggestion="${byName.customer_uid}|${lefty.clientId}"]`);
  await card.getByTestId('match-customer').getByText('Leftys Cannabis Dispensary').waitFor(WAIT);
  await card.getByTestId('match-client').getByRole('link', { name: 'Lefty’s' }).waitFor(WAIT);
  await shot(page, 'd2-suggestions-iphone');
  assert.equal(await noSideways(page), 0);
  await card.getByRole('button', { name: 'Link…' }).click();
  await page.getByTestId('link-sheet').getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByText('Linked to Lefty’s').waitFor(WAIT);
  assert.equal(server.ctx.services.crm.liveLinks('wom', byName.customer_uid)[0].created_by, 'partner');

  // The client page works offline; undoing a link needs the server and says so.
  await page.goto(`${server.base}/crm/clients/${harbour.clientId}`);
  await page.getByTestId('link-line').filter({ hasText: 'Linked automatically (same email)' }).waitFor(WAIT);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, WAIT);
  await airplane(context, server, true);
  await page.reload();
  const line = page.getByTestId('link-line').filter({ hasText: 'Linked automatically (same email)' });
  await line.waitFor(WAIT);
  await line.getByRole('button', { name: 'Undo this link' }).click();
  await page.getByTestId('undo-link-sheet').getByText('Can’t reach the suite server: undoing a link needs it (nothing was changed).').waitFor(WAIT);
  await shot(page, 'd2-undo-offline-iphone', { fullPage: false });
  await page.getByTestId('undo-link-sheet').getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`${server.base}/wholesale?tab=suggestions`).catch(() => {});
  await page.getByText('Can’t reach the suite server').waitFor(WAIT);
  await airplane(context, server, false);
  assert.equal(server.ctx.services.crm.liveLinks('wom', (await server.ctx.services.wholesale.list('linked')).customers.find((c) => c.clientId === harbour.clientId).uid).length, 1);
  assert.deepEqual(errors, []);
});
