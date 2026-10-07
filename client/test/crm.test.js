// The browser sync engine with the CRM's real record types (C3a): clean contact details made on
// the device, records made offline in order, a record waiting for the one it belongs to, and a
// note added while the other person deleted the client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowIso } from '@suite/shared/time';
import { BUSINESS_IDS, OUR_BUSINESSES } from '@suite/shared/crm';
import { SyncError } from '../src/sync/engine.js';
import { startServer, makeDevice, row } from './helpers.js';

const W = BUSINESS_IDS.wholesale;

test('the device stores contact details in their clean form and refuses what can’t be cleaned', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const phone = await makeDevice(t, server, 'owner');
  const e = phone.engine;
  assert.deepEqual((await e.list('business', { sort: 'position' })).map((b) => b.id), OUR_BUSINESSES.map((b) => b.id), 'seeded businesses arrive');

  const client = await e.create('client', { name: 'Mike’s group', status: 'active', tags: ' vip, Referral ,vip ' });
  const account = await e.create('account', { client_id: client, name: 'Lefty’s', postal_code: 'n3y4k3' });
  const contact = await e.create('contact', {
    client_id: client, account_id: account, name: 'Mike', email: '  Mike@Leftys.CA ', phone: '+1 (519) 555-0100 ext. 7',
  });
  const shown = await e.get('contact', contact);
  assert.deepEqual([shown.email, shown.phone], ['mike@leftys.ca', '5195550100'], 'shown as it will be stored');
  assert.equal((await e.get('client', client)).tags, 'vip, Referral');
  assert.equal((await e.get('account', account)).postal_code, 'N3Y 4K3');

  // The same value typed another way is no change at all.
  assert.equal(await e.update('contact', contact, { email: 'MIKE@leftys.ca', phone: '519.555.0100' }), false);
  // Clearing with spaces clears it.
  assert.equal(await e.update('contact', contact, { phone: '   ' }), true);
  assert.equal((await e.get('contact', contact)).phone, null);
  for (const fields of [{ email: 'mike at leftys' }, { phone: '555' }]) {
    await assert.rejects(e.update('contact', contact, fields), (err) => err instanceof SyncError && err.code === 'invalid_value', JSON.stringify(fields));
  }

  await e.syncNow();
  assert.equal(e.status().attention, 0, 'the server took every change');
  const saved = row(server.db, 'crm_contacts', contact);
  assert.deepEqual([saved.email, saved.phone], ['mike@leftys.ca', null]);
});

test('offline: a client with its account, contact, consent, relationship and a note go out in order', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const phone = await makeDevice(t, server, 'owner');
  const e = phone.engine;
  phone.online = false;
  const client = await e.create('client', { name: 'Cloud Nine', status: 'active' });
  const account = await e.create('account', { client_id: client, name: 'Cloud Nine Vape', age_restricted: true });
  const contact = await e.create('contact', { client_id: client, account_id: account, name: 'Dana', email: 'dana@cloudnine.ca' });
  await e.create('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-10-07', kind: 'express' });
  await e.create('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  await e.create('activity', { client_id: client, account_id: account, business_id: W, type: 'call', body: 'Wants 40 tins Friday', at: nowIso() });
  assert.equal(e.status().waiting, 6);
  await e.syncNow();
  assert.equal(e.status().phase, 'offline');

  phone.online = true;
  await e.syncNow();
  assert.deepEqual([e.status().waiting, e.status().attention], [0, 0]);
  const page = await (await fetch(`${server.base}/api/crm/clients/${client}`, { headers: { cookie: phone.cookie } })).json();
  assert.equal(page.accounts[0].age_restricted, true);
  assert.equal(page.accounts[0].relationships[0].kind, 'wholesale');
  assert.equal(page.contacts[0].consent[W].given, true);
  assert.equal(page.activities[0].body, 'Wants 40 tins Friday');
});

test('a record whose client hasn’t reached the server waits (parked) and goes in once it has', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  // A made the client offline; B already has its id (say, it was re-sent after a restore).
  a.online = false;
  const client = await a.engine.create('client', { name: 'Lefty’s', status: 'active' });
  await b.engine.create('account', { client_id: client, name: 'Dispensary' });
  await b.engine.syncNow();
  assert.deepEqual([b.engine.status().waiting, b.engine.status().parked, b.engine.status().attention], [1, 1, 0], 'waiting, not refused');

  a.online = true;
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual([b.engine.status().waiting, b.engine.status().attention], [0, 0]);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM crm_accounts WHERE client_id = ?').get(client).n, 1);
});

test('a note added offline to a client the other person deleted keeps the client, flagged, on both devices', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const client = await a.engine.create('client', { name: 'Lefty’s', status: 'active' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  b.online = false;
  await b.engine.create('activity', { client_id: client, type: 'call', body: 'Wants a quote', at: nowIso() });
  await a.engine.remove('client', client);
  await a.engine.syncNow();
  assert.equal(await a.engine.get('client', client), null, 'gone on A');

  b.online = true;
  await b.engine.syncNow();
  assert.equal(b.engine.status().attention, 0);
  const onB = await b.engine.get('client', client);
  assert.equal(onB._sync.flagged, true);
  assert.equal(onB._sync.clashes[0].kind, 'delete');
  await a.engine.syncNow();
  const onA = await a.engine.get('client', client);
  assert.ok(onA, 'back on A');
  assert.equal(onA._sync.clashes[0].winner.value._child.entity, 'activity');
  // Keep it: settled for both.
  await a.engine.resolveClash(onA._sync.clashes[0].id, 'keep_winner');
  assert.equal((await a.engine.get('client', client))._sync.flagged, false);
  assert.equal(row(server.db, 'crm_clients', client).flagged, 0);
});
