// The client screens' edit forms against the real engine and two devices: an edit sends only the
// fields the person changed since the sheet opened, so the other person's change that arrives
// while it is open survives (it used to be silently put back). Plus engine.listMany.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { toDateTimeInput } from '../src/ui/format.js';
import { startServer, makeDevice, row } from './helpers.js';
import {
  valuesFrom, editChanges, isDirty, activityAt, clientForm, contactForm, serviceForm,
} from '../src/modules/crm/formFields.js';

async function twoDevices(t) {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  return { server, mac, phone };
}

test('an open edit sheet doesn’t undo the other person’s change: only changed fields are saved', async (t) => {
  const { server, mac, phone } = await twoDevices(t);
  const m = mac.engine;
  const client = await m.create('client', { name: 'Northwind Holdings', status: 'active' });
  const contact = await m.create('contact', { client_id: client, name: 'Robin Ortega', role: 'Owner', phone: '5195550100' });
  await m.syncNow();
  await phone.engine.syncNow();

  // The Mac opens the contact's and the client's edit sheets (the snapshots)…
  const contactStart = valuesFrom(contactForm, await m.get('contact', contact));
  const clientStart = valuesFrom(clientForm, await m.get('client', client));
  // …meanwhile the partner changes the phone and closes the client, and the Mac pulls that in.
  await phone.engine.update('contact', contact, { phone: '(519) 555-0199' });
  await phone.engine.update('client', client, { status: 'closed' });
  await phone.engine.syncNow();
  await m.syncNow();
  assert.equal((await m.get('contact', contact)).phone, '5195550199', 'the Mac shows the new phone behind the open sheet');

  // The Mac changes only the role and the client's notes, and saves.
  const contactEdit = editChanges(contactForm, contactStart, { ...contactStart, role: 'Store manager' });
  assert.deepEqual(contactEdit, { fields: { role: 'Store manager' }, problems: {} });
  await m.update('contact', contact, contactEdit.fields);
  const clientEdit = editChanges(clientForm, clientStart, { ...clientStart, notes: 'Prefers mornings' });
  assert.deepEqual(clientEdit.fields, { notes: 'Prefers mornings' });
  await m.update('client', client, clientEdit.fields);
  await m.syncNow();
  await phone.engine.syncNow();

  const saved = row(server.db, 'crm_contacts', contact);
  assert.deepEqual([saved.phone, saved.role], ['5195550199', 'Store manager'], 'both changes survive');
  const c = row(server.db, 'crm_clients', client);
  assert.deepEqual([c.status, c.notes], ['closed', 'Prefers mornings'], 'the client stays closed');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0, 'different fields: nothing to review');
  for (const dev of [m, phone.engine]) {
    const p = await dev.get('contact', contact);
    assert.deepEqual([p.phone, p.role], ['5195550199', 'Store manager']);
  }
});

test('edit changes: nothing changed sends nothing; money typed in dollars; problems stop the save', () => {
  const service = { id: 's', name: 'Retainer', status: 'active', amount_cents: 150000, rate_cents: null, sessions: 4, billing: 'flat', period: 'monthly' };
  const start = valuesFrom(serviceForm, service);
  assert.equal(start.amount, '1500');
  assert.equal(start.sessions, 4);
  assert.deepEqual(editChanges(serviceForm, start, start), { fields: {}, problems: {} });
  assert.equal(isDirty(start, start), false);
  assert.deepEqual(editChanges(serviceForm, start, { ...start, amount: '1,500.00' }).fields, {}, 'the same amount typed another way is no change');
  assert.deepEqual(editChanges(serviceForm, start, { ...start, amount: '1750.5' }).fields, { amount_cents: 175050 });
  const bad = editChanges(serviceForm, start, { ...start, amount: 'lots', sessions: '2.5' });
  assert.deepEqual(Object.keys(bad.problems).sort(), ['amount', 'sessions']);
  assert.deepEqual(bad.fields, {});
  assert.equal(isDirty(start, { ...start, scope: 'Monthly posts' }), true);
  const fresh = valuesFrom(contactForm, null);
  assert.equal(isDirty(fresh, { ...fresh }), false);
  assert.equal(isDirty(fresh, { ...fresh, name: 'R' }), true);
});

test('listMany gives each type as list() does, reading parents once', async (t) => {
  const { mac } = await twoDevices(t);
  const e = mac.engine;
  const client = await e.create('client', { name: 'A', status: 'active' });
  const gone = await e.create('client', { name: 'B', status: 'active' });
  const account = await e.create('account', { client_id: client, name: 'A1' });
  await e.create('account', { client_id: gone, name: 'B1' });
  await e.create('relationship', { account_id: account, business_id: BUSINESS_IDS.wholesale, kind: 'wholesale', status: 'active' });
  await e.remove('client', gone);
  const many = await e.listMany(['client', 'account', 'relationship', 'business']);
  for (const entity of Object.keys(many)) {
    assert.deepEqual(many[entity].map((r) => r.id), (await e.list(entity)).map((r) => r.id), entity);
  }
  assert.deepEqual(many.account.map((a) => a.name), ['A1'], 'the deleted client’s account is hidden');
});

test('quick capture: "When" left alone means the moment of saving; changed means what was typed', () => {
  const opened = toDateTimeInput('2026-10-07T13:00:00.000Z');
  const saving = new Date('2026-10-07T13:25:41.000Z');
  assert.equal(activityAt(opened, opened, saving), '2026-10-07T13:25:41.000Z', 'not when the sheet opened');
  assert.equal(activityAt(opened, '2026-10-06T09:30', saving), new Date(2026, 9, 6, 9, 30).toISOString(), 'back-dated');
  assert.equal(activityAt(opened, '', saving), null);
});
