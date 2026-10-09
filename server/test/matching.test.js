// Matching and suggestions (D2): the plan's table (same email / same phone typed two ways → linked
// automatically; similar business name and same address → suggested; two "Mike"s → nothing), the
// ambiguous cases (two clients with the email, email and phone on different clients, several accounts,
// a closed client, an account already linked, the email on a "couldn't be cleaned" list, a deleted
// customer, out-of-scope clients), "Not the same" (remembered across a restart and a restore, cleared by
// "Suggest again"), undo (auto and approved links, a new account, a made client, things changed since,
// links from before D2), duplicate clients in the CRM, the switch and Run now, the one alert per pass,
// a client edited on a device picked up by the next pass, and the cost at thousands of records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/log.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { AUTO_LINK_ID } from '../src/modules/wholesale/matchService.js';
import { buildCrmIndex, matchCustomer, customerContact, inScope } from '../src/modules/wholesale/matching.js';
import { tmpDir, testConfig, ensureTestUsers, sessionFor } from './helpers.js';
import { womKit, postEvents } from './fixtures/wom.js';

const W = BUSINESS_IDS;

/** A suite with every module, an owner session and the shared secret; helpers to make CRM records. */
async function setup(t, { config = testConfig(tmpDir(t)), secret = true } = {}) {
  const db = openDb(config.dbPath);
  const { app, ctx } = await createApp({ config, db, log: createLogger('test', 'silent') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    server.close(() => { db.close(); resolve(); });
  });
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = await ensureTestUsers(ctx);
  const owner = sessionFor(ctx, users.owner);
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { cookie: owner.cookie, origin: base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let shared = null;
  if (secret) shared = (await call('POST', '/api/wholesale/connection/secret', {})).body.secret;
  const post = async (events) => {
    const r = await postEvents(base, shared, events);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.results.every((x) => x.status === 'applied'), JSON.stringify(r.body));
    return r;
  };
  const local = (entity, fields, op = 'create', recordId, actor = 'owner') => {
    const r = ctx.services.sync.applyLocal({ actor, entity, op, recordId, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
    return r.recordId;
  };
  /**
   * A client the way people make them: one account (or `accounts` names), a relationship with
   * `business` (default GWND website; null = none), contacts [{ name, email, phone, account }].
   */
  const client = (name, { accounts = [name], business = 'agency', kind = 'website', status = 'active', contacts = [], street = null, postal = null } = {}) => {
    const clientId = local('client', { name, status });
    const accountIds = accounts.map((a) => local('account', { client_id: clientId, name: a, age_restricted: false, street, postal_code: postal }));
    if (business) local('relationship', { account_id: accountIds[0], business_id: W[business], kind, status: 'active' });
    const contactIds = contacts.map((p) => local('contact', {
      client_id: clientId, name: p.name, email: p.email ?? null, phone: p.phone ?? null,
      account_id: p.account === undefined ? null : accountIds[p.account],
    }));
    return { clientId, accountIds, accountId: accountIds[0], contactIds };
  };
  const svc = ctx.services.wholesale;
  const m = svc.matching;
  const linksOf = (uid) => db.prepare("SELECT * FROM crm_links WHERE app = 'wom' AND external_id = ? AND deleted_at IS NULL").all(uid);
  const held = (uid) => db.prepare('SELECT * FROM wholesale_held_customers WHERE uid = ?').get(uid);
  const pairsOf = (uid) => m.suggestions({ limit: 200 }).suggestions.filter((s) => s.customer.uid === uid);
  const alerts = () => db.prepare("SELECT * FROM automations_alerts WHERE source = ? ORDER BY at, id").all(AUTO_LINK_ID);
  const live = (table, where = '1 = 1', ...args) => db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND ${where}`).all(...args);
  return { config, db, ctx, base, call, secret: shared, post, local, client, svc, m, linksOf, held, pairsOf, alerts, live, close };
}

const om = () => womKit();

// ---- the plan's table ----------------------------------------------------------------------------

test('the plan’s table: same email and same phone (typed two ways) link; similar name and same address are suggested; two “Mike”s nothing', async (t) => {
  const env = await setup(t);
  const { client, post, linksOf, held, pairsOf, ctx, live } = env;
  const harbour = client('Harbour Smoke', { accounts: ['Harbour Smoke Shop'], contacts: [{ name: 'Dana Reyes', email: 'Dana@Harbour.example ' }] });
  // Typed with dots in the suite; the Order Manager sends its own clean form.
  const riverside = client('Riverside Convenience', { contacts: [{ name: 'Sam', phone: '519.555.0177' }] });
  const lefty = client('Lefty’s', { business: 'consulting', kind: 'consulting' });
  const maple = client('Maple Holdings', { accounts: ['Maple Grocery'], street: '88 Queen Street North', postal: 'n3y 2b4' });
  const northside = client('Northside Auto', { contacts: [{ name: 'Mike' }] });

  const k = om();
  const byEmail = k.customer({ business_name: 'Harbour Smoke & Vape', contact_name: 'Dana', email: 'dana@harbour.example' });
  const byPhone = k.customer({ business_name: 'Riverside Variety', contact_name: 'Sam', phone: '5195550177' });
  const byName = k.customer({ business_name: 'Leftys Cannabis Dispensary', contact_name: 'Lefty' });
  const byAddress = k.customer({
    business_name: 'QuickStop Market', contact_name: 'Ana',
    address: { line1: '88 Queen St. N', line2: 'Unit 2', city: 'Simcoe', province: 'ON', postal_code: 'N3Y 2B4', country: 'Canada' },
  });
  const mike = k.customer({ business_name: 'Southside Variety', contact_name: 'Mike', address: { line1: null, line2: null, city: 'Delhi', province: 'ON', postal_code: null, country: 'Canada' } });
  const order = k.order(byEmail, [{ name: 'Zyn Cool Mint', quantity: 10, unit_price_cents: 650 }]);
  await post([...[byEmail, byPhone, byName, byAddress, mike].map((c) => k.customerCreated(c)), k.orderPlaced(order)]);

  // Same email: linked automatically, to the client's only account, as the suite, with the reason.
  const [emailLink] = linksOf(byEmail.customer_uid);
  assert.ok(emailLink, 'linked');
  assert.deepEqual([emailLink.account_id, emailLink.matched_by, emailLink.match_reason, emailLink.created_by], [harbour.accountId, 'auto', 'same email', 'system']);
  assert.equal(held(byEmail.customer_uid).account_id, harbour.accountId, 'attached at once');
  assert.equal(live('wholesale_orders', 'client_id = ?', harbour.clientId).length, 1, 'its order is on the client’s timeline');
  assert.equal(ctx.services.crm.liveAccount(harbour.accountId).age_restricted, true);
  assert.ok(ctx.services.crm.accountRelationships(harbour.accountId).some((r) => r.kind === 'wholesale'));
  // Same phone, typed two different ways: linked automatically.
  const [phoneLink] = linksOf(byPhone.customer_uid);
  assert.deepEqual([phoneLink?.account_id, phoneLink?.match_reason], [riverside.accountId, 'same phone']);

  // Similar business name: suggested (never linked).
  assert.equal(linksOf(byName.customer_uid).length, 0);
  const [nameSugg] = pairsOf(byName.customer_uid);
  assert.equal(nameSugg.client.id, lefty.clientId);
  assert.deepEqual(nameSugg.reasons.map((r) => r.kind), ['name']);
  assert.equal(nameSugg.strong, false);
  // Same street and postal code, different names: suggested, with the account.
  assert.equal(linksOf(byAddress.customer_uid).length, 0);
  const [addrSugg] = pairsOf(byAddress.customer_uid);
  assert.deepEqual([addrSugg.client.id, addrSugg.accountId, addrSugg.reasons[0].kind], [maple.clientId, maple.accountId, 'address']);
  assert.match(addrSugg.reasons[0].text, /^Same address: 88 Queen Street North/);
  // Two "Mike"s: people's names are never compared — nothing at all.
  assert.equal(linksOf(mike.customer_uid).length, 0);
  assert.deepEqual(pairsOf(mike.customer_uid), []);
  assert.equal(northside.contactIds.length, 1);

  // The waiting list and the Linked tab say how.
  const linked = (await env.call('GET', '/api/wholesale/linked')).body.customers;
  const row = linked.find((c) => c.uid === byEmail.customer_uid);
  assert.deepEqual([row.link.matchedBy, row.link.reason, row.link.by], ['auto', 'same email', 'system']);
  const waiting = (await env.call('GET', '/api/wholesale/waiting')).body.customers.map((c) => c.uid).sort();
  assert.deepEqual(waiting, [byName, byAddress, mike].map((c) => c.customer_uid).sort());
});

test('ambiguous strong matches are suggestions, never links — each says why', async (t) => {
  const env = await setup(t);
  const { client, post, linksOf, pairsOf, local, svc } = env;
  const a = client('Corner Store North', { contacts: [{ name: 'Robin', email: 'shared@corner.example' }] });
  const b = client('Corner Store South', { contacts: [{ name: 'Robin O.', email: 'shared@corner.example' }] });
  const mail = client('Mailbox Co', { contacts: [{ name: 'Ann', email: 'ann@mailbox.example' }] });
  const phone = client('Phone Booth Ltd', { contacts: [{ name: 'Ann', phone: '2265550111' }] });
  const several = client('Two Shops Group', { accounts: ['Two Shops East', 'Two Shops West'], contacts: [{ name: 'Lee', email: 'lee@twoshops.example' }] });
  const named = client('Named Account Group', { accounts: ['Named East', 'Named West'], contacts: [{ name: 'Kim', email: 'kim@named.example', account: 1 }] });
  const closed = client('Closed Shop', { status: 'closed', contacts: [{ name: 'Jo', email: 'jo@closed.example' }] });
  const taken = client('Taken Account', { contacts: [{ name: 'Al', email: 'al@taken.example' }] });
  const retail = client('Retail Only', { business: 'retail', kind: 'website', contacts: [{ name: 'Ren', email: 'ren@retail.example' }] });
  const none = client('No Business Yet', { business: null, contacts: [{ name: 'Nia', email: 'nia@nobusiness.example' }] });

  const k = om();
  const shared = k.customer({ business_name: 'Corner Store', email: 'shared@corner.example' });
  const split = k.customer({ business_name: 'Ann’s', email: 'ann@mailbox.example', phone: '2265550111' });
  const severalC = k.customer({ business_name: 'Two Shops', email: 'lee@twoshops.example' });
  const namedC = k.customer({ business_name: 'Named West', email: 'kim@named.example' });
  const closedC = k.customer({ business_name: 'Closed Shop', email: 'jo@closed.example' });
  const first = k.customer({ business_name: 'Taken One', email: 'al@taken.example' });
  const second = k.customer({ business_name: 'Taken Two', email: 'al@taken.example' });
  const retailC = k.customer({ business_name: 'Somewhere Else', email: 'ren@retail.example' });
  const noneC = k.customer({ business_name: 'Nobody Inc', email: 'nia@nobusiness.example' });
  const problem = k.customer({ business_name: 'Typo Shop', email: null, contact_problems: [{ field: 'email', as_typed: 'al@taken' }] });
  await post([k.customerCreated(first)]);
  assert.equal(linksOf(first.customer_uid)[0]?.account_id, taken.accountId, 'the first one with the email is linked');
  await post([shared, split, severalC, namedC, closedC, second, retailC, noneC, problem].map((c) => k.customerCreated(c)));

  const why = (c, clientId) => pairsOf(c.customer_uid).find((s) => s.client.id === clientId);
  // Two clients share the email: a suggestion for each.
  assert.equal(linksOf(shared.customer_uid).length, 0);
  assert.deepEqual(pairsOf(shared.customer_uid).map((s) => s.client.id).sort(), [a.clientId, b.clientId].sort());
  assert.match(why(shared, a.clientId).why, /on 2 clients: pick the right one/);
  assert.equal(why(shared, a.clientId).strong, true);
  // Email on one client, phone on another.
  assert.equal(linksOf(split.customer_uid).length, 0);
  assert.deepEqual(pairsOf(split.customer_uid).map((s) => s.client.id).sort(), [mail.clientId, phone.clientId].sort());
  // Several accounts, the contact names none.
  assert.equal(linksOf(severalC.customer_uid).length, 0);
  assert.equal(why(severalC, several.clientId).why, 'The client has several accounts: pick one');
  // Several accounts, the contact names one: linked there.
  assert.equal(linksOf(namedC.customer_uid)[0]?.account_id, named.accountIds[1]);
  // A closed client.
  assert.equal(linksOf(closedC.customer_uid).length, 0);
  assert.equal(why(closedC, closed.clientId).why, 'The client is closed');
  // The account is already linked to another Order Manager customer.
  assert.equal(linksOf(second.customer_uid).length, 0);
  assert.equal(why(second, taken.clientId).why, 'That account is already linked to another Order Manager customer');
  // Out of scope (retail only): nothing. No business yet: in scope.
  assert.deepEqual(pairsOf(retailC.customer_uid), []);
  assert.equal(linksOf(retailC.customer_uid).length, 0);
  assert.equal(linksOf(noneC.customer_uid)[0]?.account_id, none.accountId);
  // An email the Order Manager couldn't clean is never matched.
  assert.deepEqual(pairsOf(problem.customer_uid), []);
  assert.equal(retail.contactIds.length, 1);

  // A deleted customer is never linked, even when it matches.
  const gone = k.customer({ business_name: 'Gone Shop', email: 'gone@gone.example' });
  await post([k.customerCreated(gone), k.customerDeleted(gone)]);
  client('Gone Shop Client', { contacts: [{ name: 'G', email: 'gone@gone.example' }] });
  assert.deepEqual(svc.matching.pass().linked, []);
  assert.equal(linksOf(gone.customer_uid).length, 0);
  assert.ok(local);
});

test('pure rules: scope, clean values only, the shared-placeholder limit', () => {
  assert.equal(inScope([]), true, 'no relationship yet');
  assert.equal(inScope([W.agency, W.retail]), true);
  assert.equal(inScope([W.save_point]), false);
  assert.deepEqual(customerContact({ email: 'Bob@X.ca', phone: '519-555-0100' }), { email: null, phone: null }, 'not the stored form: not matched');
  assert.deepEqual(customerContact({ email: 'bob@x.ca', phone: '5195550100' }), { email: 'bob@x.ca', phone: '5195550100' });
  assert.deepEqual(customerContact({ email: 'bob@x.ca', phone: '5195550100', contactProblems: [{ field: 'phone' }] }), { email: 'bob@x.ca', phone: null });
  // An email on 11 clients is a placeholder: nobody is matched on it.
  const clients = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, name: `Shop ${i}`, status: 'active' }));
  const accounts = clients.map((c) => ({ id: `a-${c.id}`, client_id: c.id, name: c.name }));
  const contacts = clients.map((c) => ({ id: `p-${c.id}`, client_id: c.id, account_id: null, name: 'Front desk', email: 'info@chain.example' }));
  const index = buildCrmIndex({ clients, accounts, contacts, relationships: [] });
  const r = matchCustomer({ uid: 'u', businessName: 'Zzz', email: 'info@chain.example' }, index);
  assert.deepEqual([r.auto, r.suggestions.length], [null, 0]);
});

// ---- "Not the same" ------------------------------------------------------------------------------

test('“Not the same” is remembered across a restart and a restore; “Suggest again” brings the pair back', async (t) => {
  const config = testConfig(tmpDir(t));
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(`${config.backup.offsiteDir}/.suite-backup-target`, '');
  const first = await setup(t, { config });
  const lefty = first.client('Lefty’s');
  const twin = first.client('Corner A', { contacts: [{ name: 'X', email: 'x@corner.example' }] });
  first.client('Corner B', { contacts: [{ name: 'X', email: 'x@corner.example' }] });
  const k = om();
  const c = k.customer({ business_name: 'Leftys Cannabis Dispensary' });
  await first.post([k.customerCreated(c)]);
  assert.equal(first.pairsOf(c.customer_uid).length, 1);
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });

  const res = await first.call('POST', '/api/wholesale/matches/not-same', { kind: 'customer', a: c.customer_uid, b: lefty.clientId });
  assert.equal(res.status, 200);
  assert.equal(res.body.counts.customers, 0);
  assert.deepEqual(first.pairsOf(c.customer_uid), []);
  const dup = (await first.call('GET', '/api/wholesale/matches/duplicates')).body;
  assert.equal(dup.total, 1, 'two clients with the same email: a possible duplicate');
  const [dx] = dup.duplicates;
  assert.equal((await first.call('POST', '/api/wholesale/matches/not-same', { kind: 'clients', a: dx.b.id, b: dx.a.id })).status, 200, 'either order');
  assert.equal((await first.call('GET', '/api/wholesale/matches/duplicates')).body.total, 0);
  assert.equal((await first.call('POST', '/api/wholesale/matches/not-same', { kind: 'nope', a: 'x', b: 'y' })).status, 400);
  await first.close();

  // A restore of the backup made before the decisions: they are kept (like the holding area).
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const again = await setup(t, { config, secret: false });
  await again.svc.reconcileAll();
  assert.deepEqual(again.pairsOf(c.customer_uid), [], 'not suggested again after a restore');
  assert.equal(again.m.duplicates().total, 0);
  const dismissed = (await again.call('GET', '/api/wholesale/matches/dismissed')).body.dismissed;
  assert.deepEqual(dismissed.map((d) => d.kind).sort(), ['clients', 'customer']);
  assert.ok(dismissed.some((d) => d.first === 'Leftys Cannabis Dispensary' && d.second === 'Lefty’s'));

  const clear = await again.call('POST', '/api/wholesale/matches/suggest-again', { kind: 'customer', a: c.customer_uid, b: lefty.clientId });
  assert.equal(clear.status, 200);
  assert.equal(again.pairsOf(c.customer_uid).length, 1, 'suggested again');
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM wholesale_match_decisions').get().n, 1, 'cleared rows go');
  assert.ok(twin);
});

test('“Not the same” on a strong match stops the automatic link too', async (t) => {
  const env = await setup(t);
  const c1 = env.client('Bright Vapes', { contacts: [{ name: 'Bo', email: 'bo@bright.example' }] });
  const k = om();
  // The switch off while the customer arrives: it waits, suggested; then "Not the same", then on again.
  env.ctx.services.automations.setSettings(AUTO_LINK_ID, { enabled: false }, { actor: 'owner' });
  const c = k.customer({ business_name: 'Bright', email: 'bo@bright.example' });
  await env.post([k.customerCreated(c)]);
  const [s] = env.pairsOf(c.customer_uid);
  assert.deepEqual([s.client.id, s.auto, s.why], [c1.clientId, true, 'Linking automatically is switched off (System → Automations)']);
  env.m.notSame({ kind: 'customer', a: c.customer_uid, b: c1.clientId }, { actor: 'owner' });
  env.ctx.services.automations.setSettings(AUTO_LINK_ID, { enabled: true }, { actor: 'owner' });
  assert.deepEqual(env.m.pass().linked, []);
  assert.equal(env.linksOf(c.customer_uid).length, 0);
});

// ---- the switch, Run now, the alert, devices ------------------------------------------------------

test('switched off nothing links; Run now links; one alert per pass, listing at most five', async (t) => {
  const env = await setup(t);
  const autos = env.ctx.services.automations;
  autos.setSettings(AUTO_LINK_ID, { enabled: false }, { actor: 'owner' });
  const k = om();
  const customers = [];
  for (let i = 0; i < 7; i += 1) {
    env.client(`Shop Number ${i}`, { contacts: [{ name: `Owner ${i}`, email: `owner${i}@shops.example` }] });
    customers.push(k.customer({ business_name: `OM Shop ${i}`, email: `owner${i}@shops.example` }));
  }
  await env.post(customers.slice(0, 1).map((c) => k.customerCreated(c)));
  assert.equal(env.linksOf(customers[0].customer_uid).length, 0, 'off: not linked');
  assert.equal(env.alerts().length, 0);
  const run = autos.runNow(AUTO_LINK_ID, { actor: 'owner' });
  assert.equal(run.status, 'ok');
  assert.equal(run.summary, 'Linked 1 Order Manager customer automatically');
  await new Promise((r) => setImmediate(r));
  assert.ok(env.held(customers[0].customer_uid).account_id, 'Run now: linked and attached');

  autos.setSettings(AUTO_LINK_ID, { enabled: true }, { actor: 'owner' });
  await env.post(customers.slice(1).map((c) => k.customerCreated(c)));
  const alerts = env.alerts();
  assert.equal(alerts.length, 2, 'one alert for Run now, one for this request’s pass');
  const last = alerts[1];
  assert.equal(last.title, 'Linked 6 Order Manager customers automatically');
  assert.equal(last.link, '/wholesale?tab=linked');
  const lines = last.body.split('\n');
  assert.equal(lines.filter((l) => / · same email$/.test(l)).length, 5);
  assert.ok(lines.includes('and 1 more'));
  assert.ok(lines.includes('Undo any of them on Wholesale → Linked.'));
  assert.equal(autos.get(AUTO_LINK_ID).lastRun.summary, 'Linked 6 Order Manager customers automatically');
  assert.equal(autos.runNow(AUTO_LINK_ID, { actor: 'owner' }).summary, 'No customer to link automatically', 'Run now again: nothing left');
});

test('a contact added on a device later is picked up by the next pass (the minute pass); nothing changed = nothing recomputed', async (t) => {
  const env = await setup(t);
  const k = om();
  const c = k.customer({ business_name: 'Late Arrival', phone: '9055550190' });
  await env.post([k.customerCreated(c)]);
  assert.equal(env.linksOf(c.customer_uid).length, 0);
  const late = env.client('Late Arrival Holdings');
  assert.deepEqual(env.m.pass().linked, [], 'no contact yet');
  const before = env.m.state();
  assert.equal(env.m.state(), before, 'nothing changed: the same result, not worked out again');
  env.local('contact', { client_id: late.clientId, name: 'Pat', phone: '+1 (905) 555-0190' }, 'create', undefined, 'partner');
  assert.notEqual(env.m.state(), before, 'a change: worked out again');
  assert.deepEqual(env.m.pass().linked, [c.customer_uid]);
  assert.equal(env.held(c.customer_uid).account_id, late.accountId);
});

// ---- undo --------------------------------------------------------------------------------------------

test('undo of an automatic link puts both sides back: link gone, records off the timeline, age mark and relationship as before', async (t) => {
  const env = await setup(t);
  const { client, post, linksOf, held, ctx, live, call } = env;
  const crm = ctx.services.crm;
  const shop = client('Harbour Smoke', { contacts: [{ name: 'Dana', email: 'dana@harbour.example' }] });
  const k = om();
  const c = k.customer({ business_name: 'Harbour Smoke', email: 'dana@harbour.example' });
  const o = k.order(c, [{ name: 'Zyn', quantity: 5, unit_price_cents: 650 }]);
  await post([k.customerCreated(c), k.orderPlaced(o), k.paymentRecorded(k.payment(o, 3673))]);
  assert.equal(linksOf(c.customer_uid)[0].matched_by, 'auto');
  assert.equal(crm.liveAccount(shop.accountId).age_restricted, true);
  const rel = crm.accountRelationships(shop.accountId).find((r) => r.kind === 'wholesale');
  assert.ok(rel);
  assert.equal(live('wholesale_orders', 'account_id = ?', shop.accountId).length, 1);

  const preview = await call('GET', `/api/wholesale/customers/${c.customer_uid}/undo`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.links.map((l) => [l.matchedBy, l.reason]), [['auto', 'same email']]);
  assert.equal(preview.body.restore.length, 2, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.keep, []);
  assert.equal(linksOf(c.customer_uid).length, 1, 'the preview changes nothing');

  const res = await call('POST', `/api/wholesale/customers/${c.customer_uid}/unlink`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.undone.restore, preview.body.restore);
  assert.equal(linksOf(c.customer_uid).length, 0);
  assert.equal(held(c.customer_uid).account_id, null, 'back in Waiting');
  assert.ok((await call('GET', '/api/wholesale/waiting')).body.customers.some((x) => x.uid === c.customer_uid));
  assert.equal(live('wholesale_orders', 'account_id = ?', shop.accountId).length, 0, 'its order left the timeline');
  assert.equal(live('wholesale_entries', 'account_id = ?', shop.accountId).length, 0);
  assert.equal(crm.liveAccount(shop.accountId).age_restricted, false, 'the age mark as it was');
  assert.equal(crm.accountRelationships(shop.accountId).some((r) => r.id === rel.id), false, 'the relationship the link made is gone');
  assert.equal(crm.accountRelationships(shop.accountId).length, 1, 'the client’s own GWND relationship stays');
  assert.ok(crm.liveRecord('client', shop.clientId), 'the client stays');
  // Not linked automatically again (still suggested, with why).
  assert.deepEqual(env.m.pass().linked, []);
  const [s] = env.pairsOf(c.customer_uid);
  assert.deepEqual([s.client.id, s.why], [shop.clientId, 'A link between them was undone before']);
  // Linking it again by hand works, and puts everything back on.
  assert.equal((await call('POST', `/api/wholesale/customers/${c.customer_uid}/link`, { clientId: shop.clientId, accountId: shop.accountId, reason: 'same email' })).status, 200);
  assert.equal(live('wholesale_orders', 'account_id = ?', shop.accountId).length, 1);
  assert.deepEqual([linksOf(c.customer_uid)[0].matched_by, linksOf(c.customer_uid)[0].match_reason], ['approved', 'same email']);
  assert.equal(crm.liveAccount(shop.accountId).age_restricted, true);
});

test('undo of approved links: a new account and a made client are removed when untouched, kept (with why) when used since', async (t) => {
  const env = await setup(t);
  const { client, post, linksOf, ctx, call, local } = env;
  const crm = ctx.services.crm;
  const k = om();
  const a = k.customer({ business_name: 'Fresh Account Co', contact_name: 'Fay', email: 'fay@fresh.example' });
  const b = k.customer({ business_name: 'Made Client Inc', contact_name: 'Mo', phone: '4165550123' });
  const c = k.customer({ business_name: 'Touched Client Inc', contact_name: 'Tia' });
  const d = k.customer({ business_name: 'Tasked Relationship', contact_name: 'Ty' });
  await post([a, b, c, d].map((x) => k.customerCreated(x)));
  const holder = client('Holder Group');
  const tasked = client('Tasked Group');

  // Link to a new account under an existing client, then undo: the account goes; the client stays.
  assert.equal((await call('POST', `/api/wholesale/customers/${a.customer_uid}/link`, { clientId: holder.clientId })).status, 200);
  const made = linksOf(a.customer_uid)[0].account_id;
  assert.notEqual(made, holder.accountId);
  let r = await call('POST', `/api/wholesale/customers/${a.customer_uid}/unlink`, {});
  assert.deepEqual(r.body.undone.restore, ['The account “Fresh Account Co” the link made is removed']);
  assert.equal(crm.liveRecord('account', made), null);
  assert.ok(crm.liveRecord('client', holder.clientId));
  assert.equal(crm.liveAccount(holder.accountId).age_restricted, false, 'the client’s other account untouched');

  // Create a client, then undo: client (with its account, contact, relationship) removed.
  r = await call('POST', `/api/wholesale/customers/${b.customer_uid}/create-client`, {});
  assert.equal(r.status, 200);
  const madeClient = r.body.customer.clientId;
  assert.ok(crm.getClient(madeClient).contacts.length === 1);
  r = await call('POST', `/api/wholesale/customers/${b.customer_uid}/unlink`, {});
  assert.deepEqual(r.body.undone.restore, ['The client “Made Client Inc” the link made is removed, with its account and contact']);
  assert.equal(crm.liveRecord('client', madeClient), null);
  assert.ok(r.body.customer.uid === b.customer_uid && !r.body.customer.accountId);

  // Create a client, a note added to it since: it stays (with why), the link and the age mark go.
  r = await call('POST', `/api/wholesale/customers/${c.customer_uid}/create-client`, {});
  const kept = r.body.customer.clientId;
  const keptAccount = r.body.customer.accountId;
  local('activity', { client_id: kept, type: 'note', body: 'Met them at the show', at: '2026-10-01T15:00:00.000Z' });
  r = await call('POST', `/api/wholesale/customers/${c.customer_uid}/unlink`, {});
  assert.ok(crm.liveRecord('client', kept));
  assert.ok(r.body.undone.keep.includes('The client “Touched Client Inc” the link made stays: notes, services or consent were added to it'), JSON.stringify(r.body.undone));
  assert.ok(r.body.undone.restore.includes('The account “Touched Client Inc” the link made is removed'), JSON.stringify(r.body.undone));
  assert.equal(linksOf(c.customer_uid).length, 0);

  // An existing account: a person's task names the relationship the link made, and the account was renamed: both kept.
  assert.equal((await call('POST', `/api/wholesale/customers/${d.customer_uid}/link`, { clientId: tasked.clientId, accountId: tasked.accountId })).status, 200);
  const rel = crm.accountRelationships(tasked.accountId).find((x) => x.kind === 'wholesale');
  local('task', { title: 'Send the price list', owner: 'owner', business_id: W.wholesale, relationship_id: rel.id, account_id: tasked.accountId, client_id: tasked.clientId });
  const preview = (await call('GET', `/api/wholesale/customers/${d.customer_uid}/undo`)).body;
  assert.ok(preview.keep.includes('The wholesale relationship of “Tasked Group” stays: a task of yours names it'), JSON.stringify(preview));
  assert.ok(preview.restore.includes('“Tasked Group” is no longer marked age-restricted (as before the link)'));
  local('account', { age_restricted: false }, 'update', tasked.accountId);
  local('account', { age_restricted: true }, 'update', tasked.accountId); // changed and back: still as the link left it
  r = await call('POST', `/api/wholesale/customers/${d.customer_uid}/unlink`, {});
  assert.ok(crm.accountRelationships(tasked.accountId).some((x) => x.id === rel.id), 'kept');
  assert.equal(crm.liveAccount(tasked.accountId).age_restricted, false);
  assert.equal(keptAccount !== null, true);
});

test('undo when another customer still uses the account, and for a link made before D2 kept track', async (t) => {
  const env = await setup(t);
  const { client, post, linksOf, ctx, call, db } = env;
  const crm = ctx.services.crm;
  const k = om();
  const x = k.customer({ business_name: 'Twin One' });
  const y = k.customer({ business_name: 'Twin Two' });
  await post([k.customerCreated(x), k.customerCreated(y)]);
  const twin = client('Twins');
  for (const c of [x, y]) assert.equal((await call('POST', `/api/wholesale/customers/${c.customer_uid}/link`, { clientId: twin.clientId, accountId: twin.accountId })).status, 200);
  // y's link made the age mark and the relationship; x is still on the account, so they stay.
  const first = linksOf(x.customer_uid)[0];
  const r = await call('POST', `/api/wholesale/customers/${x.customer_uid}/unlink`, {});
  assert.deepEqual(r.body.undone.restore, []);
  assert.ok(r.body.undone.keep.some((s) => /another Order Manager customer is still linked/.test(s)), JSON.stringify(r.body.undone));
  assert.equal(crm.liveAccount(twin.accountId).age_restricted, true);
  assert.ok(first);

  // A link from before D2: no record of what it changed — only the link goes, and the page says so.
  db.prepare('DELETE FROM wholesale_link_changes WHERE customer_uid = ?').run(y.customer_uid);
  const res = await call('POST', `/api/wholesale/customers/${y.customer_uid}/unlink`, {});
  assert.equal(res.body.undone.tracked, false);
  assert.match(res.body.undone.keep[0], /^Only the link is undone: it was made before the suite kept track/);
  assert.equal(crm.liveAccount(twin.accountId).age_restricted, true, 'nothing else changed');
  assert.ok(crm.accountRelationships(twin.accountId).some((rr) => rr.kind === 'wholesale'));
  assert.equal(linksOf(y.customer_uid).length, 0);
});

test('undo finishes the suite’s open tasks for the customer: its ship task at once, its follow-up at once', async (t) => {
  const env = await setup(t);
  const { client, post, call, db } = env;
  const k = om();
  const shop = client('Packed Shop', { contacts: [{ name: 'Pia', email: 'pia@packed.example' }] });
  const c = k.customer({ business_name: 'Packed Shop', email: 'pia@packed.example' });
  const o = k.order(c, [{ name: 'Zyn', quantity: 2, unit_price_cents: 650 }], { packing: 'packed' });
  await post([k.customerCreated(c), k.orderPlaced(o), k.orderPacked(o), k.followUpChanged(c, '2026-10-20')]);
  const tasks = () => db.prepare('SELECT title, done_at, notes FROM planner_tasks WHERE deleted_at IS NULL AND client_id = ? ORDER BY title').all(shop.clientId);
  assert.deepEqual(tasks().map((x) => [x.title, Boolean(x.done_at)]), [['Follow up with Packed Shop', false], ['Ship order #1 for Packed Shop', false]]);
  await call('POST', `/api/wholesale/customers/${c.customer_uid}/unlink`, {});
  const after = tasks();
  assert.ok(after.every((x) => x.done_at), JSON.stringify(after));
  assert.ok(after.every((x) => /Unlinked from the Order Manager customer|isn’t linked here any more/.test(x.notes)));
});

// ---- duplicates in the CRM and the counts ---------------------------------------------------------------

test('possible duplicate clients: a shared email or phone, or similar names at the same address — never across scope', async (t) => {
  const env = await setup(t);
  const { client, m } = env;
  const a = client('Green Leaf', { contacts: [{ name: 'Al', phone: '519 555 0144' }] });
  const b = client('Green Leaf Dispensary', { contacts: [{ name: 'Al G', phone: '(519) 555-0144' }] });
  const c = client('Corner Variety', { street: '10 Queen Street', postal: 'N3Y1A1' });
  const d = client('The Corner Variety Store', { street: '10 Queen St.', postal: 'n3y 1a1' });
  client('Different Name Entirely', { street: '10 Queen St', postal: 'N3Y 1A1' });
  client('Save Point Buyer', { business: 'save_point', kind: 'website', contacts: [{ name: 'Al', phone: '5195550144' }] });
  const { duplicates, total } = m.duplicates();
  assert.equal(total, 2, JSON.stringify(duplicates.map((x) => [x.a.name, x.b.name])));
  const names = duplicates.map((x) => [x.a.name, x.b.name].sort().join(' / ')).sort();
  assert.deepEqual(names, ['Corner Variety / The Corner Variety Store', 'Green Leaf / Green Leaf Dispensary']);
  const phone = duplicates.find((x) => [x.a.id, x.b.id].includes(a.clientId));
  assert.deepEqual(phone.reasons, [{ kind: 'phone', text: 'Same phone: (519) 555-0144' }]);
  const addr = duplicates.find((x) => [x.a.id, x.b.id].includes(c.clientId));
  assert.match(addr.reasons[0].text, /^Similar names at the same address/);
  assert.ok(b && d);
  const counts = (await env.call('GET', '/api/wholesale/matches/counts')).body;
  assert.deepEqual([counts.duplicates, counts.customers, counts.total, counts.autoLinking], [2, 0, 2, true]);
});

// ---- cost ------------------------------------------------------------------------------------------

test('cost: 3,000 clients and 1,000 waiting customers — a pass, the review list, a pass with nothing changed', async (t) => {
  const env = await setup(t);
  const { db, ctx } = env;
  const sync = ctx.services.sync;
  // Bulk records straight through sync (as the import does), 3,000 clients each with an account and a contact.
  db.transaction(() => {
    for (let i = 0; i < 3000; i += 1) {
      const clientId = sync.applyLocal({ actor: 'owner', entity: 'client', op: 'create', fields: { name: `Client ${i} Holdings`, status: 'active' } }).recordId;
      const accountId = sync.applyLocal({ actor: 'owner', entity: 'account', op: 'create', fields: { client_id: clientId, name: `Client ${i} Store`, street: `${i} Main St`, postal_code: 'N3Y 4K3' } }).recordId;
      sync.applyLocal({ actor: 'owner', entity: 'contact', op: 'create', fields: { client_id: clientId, account_id: accountId, name: `Owner ${i}`, email: `owner${i}@clients.example`, phone: `519555${String(i).padStart(4, '0')}` } });
    }
  })();
  const k = om();
  const events = [];
  for (let i = 0; i < 1000; i += 1) {
    // 100 match strongly, 100 by name ("Client 150 Store Ltd" ~ "Client 150 Store"), the rest share only "Store".
    const name = i < 100 ? `OM ${i}` : (i < 200 ? `Client ${i} Store Ltd` : `Waiting ${i} Store`);
    events.push(k.customerCreated(k.customer({ business_name: name, email: i < 100 ? `owner${i}@clients.example` : `w${i}@om.example`, address: null })));
  }
  ctx.services.automations.setSettings(AUTO_LINK_ID, { enabled: false }, { actor: 'owner' });
  for (let i = 0; i < events.length; i += 50) await env.post(events.slice(i, i + 50));
  ctx.services.automations.setSettings(AUTO_LINK_ID, { enabled: true }, { actor: 'owner' });

  let t0 = performance.now();
  const { linked } = env.m.pass();
  const passMs = performance.now() - t0;
  await env.svc.reconcileAll();
  assert.equal(linked.length, 100);
  t0 = performance.now();
  const list = env.m.suggestions({ limit: 50 });
  const listMs = performance.now() - t0;
  t0 = performance.now();
  env.m.pass();
  const idleMs = performance.now() - t0;
  console.log(`# matching cost: pass + 100 links ${passMs.toFixed(0)} ms (index ${env.m.state().ms} ms), review list ${listMs.toFixed(0)} ms, idle pass ${idleMs.toFixed(1)} ms`);
  assert.equal(list.total, 100, 'a name suggestion for each “Client N Store Ltd”');
  assert.ok(passMs < 5000, `pass ${passMs} ms`);
  assert.ok(idleMs < 50, `idle pass ${idleMs} ms`);
});
