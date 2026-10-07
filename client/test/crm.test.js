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

test('records under a deleted parent are hidden on the device (list, get, counts) and come back with it', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const a = await makeDevice(t, server, 'owner');
  const b = await makeDevice(t, server, 'partner');
  const client = await a.engine.create('client', { name: 'Lefty’s', status: 'active' });
  const account = await a.engine.create('account', { client_id: client, name: 'Dispensary' });
  const contact = await a.engine.create('contact', { client_id: client, account_id: account, name: 'Mike' });
  const rel = await a.engine.create('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  await a.engine.create('service', { relationship_id: rel, name: 'Supply', status: 'active' });
  await a.engine.create('activity', { client_id: client, type: 'note', body: 'Hello', at: nowIso() });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual(new Set(b.engine.ancestorsOf('service')), new Set(['relationship', 'account', 'business', 'client']));
  assert.deepEqual(b.engine.ancestorsOf('client'), []);
  const counts = (e) => e.liveCounts(['client', 'account', 'contact', 'relationship', 'service', 'activity']);
  assert.deepEqual(await counts(b.engine), { client: 1, account: 1, contact: 1, relationship: 1, service: 1, activity: 1 });

  // A deletes the client (only the client: nothing cascades). On B everything under it goes from view.
  await a.engine.remove('client', client);
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.deepEqual(await counts(b.engine), { client: 0, account: 0, contact: 0, relationship: 0, service: 0, activity: 0 });
  assert.equal((await b.engine.list('service')).length, 0, 'two levels down, hidden too');
  assert.equal(await b.engine.get('contact', contact), null);
  assert.equal((await b.engine.list('contact', { orphans: true })).length, 1, 'still held on the device');
  assert.equal((await b.engine.get('contact', contact, { orphans: true })).name, 'Mike');
  assert.equal((await b.engine.list('business')).length, 6, 'not affected');
  await assert.rejects(b.engine.update('contact', contact, { role: 'Owner' }), (err) => err.code === 'not_found', 'hidden: not editable');
});

test('waiting changes keep when they started and say what they wait for; discarding a refused client moves its waiting contact to Needs attention', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  let now = Date.parse('2026-10-07T15:00:00.000Z');
  const phone = await makeDevice(t, server, 'owner', { engine: { wallClock: () => now } });
  const e = phone.engine;
  const client = await e.create('client', { name: 'Gone', status: 'active' });
  await e.syncNow();
  // The other person deletes the client; this phone pulls that, then (from a stale screen) adds to it.
  const mac = await makeDevice(t, server, 'partner');
  await mac.engine.remove('client', client);
  await mac.engine.syncNow();
  await e.syncNow();
  // A contact for the deleted client (refused: deleted), and a consent for that contact (waits for it).
  phone.online = false;
  const contact = await e.create('contact', { client_id: client, name: 'Mike', email: 'mike@x.ca' });
  await e.create('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-10-07', kind: 'express' });
  phone.online = true;
  await e.syncNow();
  const [refused] = await e.attentionList();
  assert.deepEqual([refused.step.entity, refused.code], ['contact', 'deleted']);
  let [waiting] = await e.waitingList();
  assert.equal(waiting.step.entity, 'consent');
  assert.deepEqual(waiting.parked.missing, { field: 'contact_id', entity: 'contact', id: contact }, 'says what it waits for');
  const since = waiting.parked.at;

  // Retried after later syncs: it keeps when it started waiting.
  now += 60 * 60 * 1000;
  await e.syncNow();
  [waiting] = await e.waitingList();
  assert.equal(waiting.parked.at, since, 'first seen kept');
  assert.notEqual(waiting.parked.triedAt, since, 'last try moves');

  // The refused contact is discarded: the consent can never be sent, so it moves to Needs attention.
  await e.discardAttention(refused.n);
  assert.deepEqual(await e.waitingList(), []);
  const [moved] = await e.attentionList();
  assert.deepEqual([moved.step.entity, moved.code], ['consent', 'parent_discarded']);
  assert.match(moved.reason, /contact_id: the contact it points to was discarded/);
  assert.equal(e.status().waiting, 0);
  await e.discardAttention(moved.n);
  assert.equal(e.status().attention, 0);
});

test('discarding a waiting create moves what waits for it to Needs attention', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const phone = await makeDevice(t, server, 'owner');
  const e = phone.engine;
  // An account for a client the server has never seen (e.g. lost in a restore): it waits.
  const ghost = '01a1163c-1a00-7273-aed1-000000000001';
  const account = await e.create('account', { client_id: ghost, name: 'Shop' });
  assert.equal(await e.get('account', account), null, 'hidden: what it belongs to isn’t here');
  await e.create('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  await e.syncNow();
  const waiting = await e.waitingList();
  assert.deepEqual(waiting.map((w) => [w.step.entity, w.step.op, w.parked.missing.entity]), [
    ['account', 'create', 'client'], ['relationship', 'create', 'account'],
  ]);
  await e.discardWaiting(waiting[0].n);
  assert.deepEqual(await e.waitingList(), []);
  const [moved] = await e.attentionList();
  assert.deepEqual([moved.step.entity, moved.code, moved.missing.entity], ['relationship', 'parent_discarded', 'account']);
});
