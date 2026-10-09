// D2 on a device: a contact made on the phone matches an Order Manager customer by email → the
// server links it automatically; the phone pulls the link (with why) and the customer's records;
// undo → the link and records leave the phone and the account's age mark is as the phone made it.
// Plus the screens' wording (how a link was made, the reason a link from a suggestion carries, the
// Friday review's line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { startServer, makeDevice } from './helpers.js';
import { postEvents, womKit } from '../../server/test/fixtures/wom.js';
import { sessionFor } from '../../server/test/helpers.js';
import { cachedLists } from '../src/modules/crm/data.js';
import { linkHowText, suggestionReason, customerAddressText, matchesSummary } from '../src/modules/wholesale/logic.js';

test('a contact made on a phone links an Order Manager customer automatically; undo takes it all off the phone again', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const secret = server.ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const phone = await makeDevice(t, server, 'partner');
  const e = phone.engine;
  const om = womKit();
  const c = om.customer({ business_name: 'Harbour Smoke & Vape', email: 'dana@harbour.example' });
  const o = om.order(c, [{ name: 'Zyn', quantity: 4, unit_price_cents: 650 }]);
  assert.equal((await postEvents(server.base, secret, [om.customerCreated(c), om.orderPlaced(o)])).status, 200);

  // Made on the phone (offline first), typed with capitals: stored clean, then synced.
  phone.online = false;
  const clientId = await e.create('client', { name: 'Harbour Smoke', status: 'active' });
  const accountId = await e.create('account', { client_id: clientId, name: 'Harbour Smoke Shop', age_restricted: false });
  // A GWND client (a client with no relationship yet would only be suggested).
  await e.create('relationship', { account_id: accountId, business_id: BUSINESS_IDS.agency, kind: 'website', status: 'active' });
  await e.create('contact', { client_id: clientId, account_id: accountId, name: 'Dana', email: ' Dana@Harbour.EXAMPLE' });
  phone.online = true;
  await e.syncNow();
  // The minute pass (here by hand): linked automatically.
  assert.deepEqual(server.ctx.services.wholesale.matching.pass().linked, [c.customer_uid]);
  await e.syncNow();
  let [links, orders, accounts] = await cachedLists(e, ['link', 'wholesale_order', 'account']);
  const [link] = links.records;
  assert.deepEqual([link.matched_by, link.match_reason, link.account_id], ['auto', 'same email', accountId]);
  assert.equal(linkHowText(link, 'partner'), 'Linked automatically (same email)');
  assert.equal(orders.where('client_id', clientId).length, 1);
  assert.equal(accounts.byId().get(accountId).age_restricted, true);

  const res = await fetch(`${server.base}/api/wholesale/customers/${c.customer_uid}/unlink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, cookie: sessionFor(server.ctx, server.users.owner).cookie },
    body: '{}',
  });
  assert.equal(res.status, 200);
  await e.syncNow();
  [links, orders, accounts] = await cachedLists(e, ['link', 'wholesale_order', 'account']);
  assert.equal(links.records.length, 0);
  assert.equal(orders.records.length, 0);
  assert.equal(accounts.byId().get(accountId).age_restricted, false, 'as the phone made it');
});

test('wording: how a link was made, the reason a suggestion’s link carries, the address, the Friday review line', () => {
  assert.equal(linkHowText({ matched_by: 'auto', match_reason: 'same phone' }, 'owner'), 'Linked automatically (same phone)');
  assert.equal(linkHowText({ matchedBy: 'approved', reason: 'similar name', by: 'owner' }, 'owner'), 'Linked by you (similar name)');
  assert.equal(linkHowText({ matched_by: 'approved', _sync: { createdBy: 'partner' } }, 'owner'), 'Linked by your partner');
  assert.equal(linkHowText({ matched_by: 'approved', created_by: 'owner' }, null), 'Linked');
  assert.equal(linkHowText(null, 'owner'), null);
  assert.equal(suggestionReason({ reasons: [{ kind: 'name' }, { kind: 'address' }] }), 'same address');
  assert.equal(suggestionReason({ reasons: [{ kind: 'name' }, { kind: 'phone' }] }), 'same phone');
  assert.equal(suggestionReason({ reasons: [] }), null);
  assert.equal(customerAddressText({ line1: '12 Main St', line2: 'Unit 4', city: 'Simcoe', province: 'ON', postal_code: 'N3Y 4K3' }), '12 Main St, Unit 4, Simcoe ON N3Y 4K3');
  assert.equal(customerAddressText({ line1: null, city: null }), null);
  assert.equal(matchesSummary({ customers: 0, duplicates: 0 }), 'Nothing to review: no possible matches.');
  assert.equal(matchesSummary({ customers: 1, duplicates: 2 }), '1 Order Manager customer may already be a client · 2 possible duplicates among clients');
  assert.equal(matchesSummary({ customers: 3, duplicates: 0 }), '3 Order Manager customers may already be clients');
  assert.equal(matchesSummary(null), null);
});
