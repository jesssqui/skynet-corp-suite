// The planner against the real engine and server, with two devices: the Mac's task sheet is open
// while the partner reassigns or finishes the task on the phone — saving on the Mac sends only
// what it changed, so both changes survive. Plus an inbox item captured offline turned into a task,
// a call's next step clearing the "No next step" flag, and a task outliving its deleted client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { nowIso, localDate } from '@suite/shared/time';
import { relationshipsWithoutNextStep } from '@suite/shared/planner';
import { startServer, makeDevice, row } from './helpers.js';
import { taskForm, taskValues, editChanges } from '../src/modules/planner/taskForm.js';
import { captureFields, clearedFields, nextStepFields, titleFromText } from '../src/modules/planner/logic.js';

const W = BUSINESS_IDS.wholesale;

async function twoDevices(t) {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  return { server, mac, phone };
}

test('the Mac’s open task sheet doesn’t undo the partner’s reassignment or finish: only changed fields are saved', async (t) => {
  const { server, mac, phone } = await twoDevices(t);
  const m = mac.engine;
  const today = localDate();
  const a = await m.create('task', { title: 'Pack the Cloud Vape order', owner: 'owner', business_id: W, due_date: today });
  const b = await m.create('task', { title: 'Order more labels', owner: 'owner', business_id: W, estimate_minutes: 15 });
  await m.syncNow();
  await phone.engine.syncNow();

  // The Mac opens both tasks' sheets…
  const startA = taskValues(await m.get('task', a), { today });
  const startB = taskValues(await m.get('task', b), { today });
  // …meanwhile the partner takes over task A (the handoff) and finishes task B, and the Mac pulls that in.
  await phone.engine.update('task', a, { owner: 'partner' });
  await phone.engine.update('task', b, { done_at: nowIso() });
  await phone.engine.syncNow();
  await m.syncNow();
  assert.equal((await m.get('task', a)).owner, 'partner', 'the Mac shows the handoff behind the open sheet');

  // The Mac edits other fields and saves.
  const editA = editChanges(taskForm, startA, { ...startA, title: 'Pack the Cloud Vape order (40 tins)', estimate: '30' });
  assert.deepEqual(editA.fields, { title: 'Pack the Cloud Vape order (40 tins)', estimate_minutes: 30 });
  await m.update('task', a, editA.fields);
  const editB = editChanges(taskForm, startB, { ...startB, notes: 'The 2x3 ones', top: true });
  assert.deepEqual(editB.fields, { notes: 'The 2x3 ones', top_on: today });
  await m.update('task', b, editB.fields);
  await m.syncNow();
  await phone.engine.syncNow();

  const savedA = row(server.db, 'planner_tasks', a);
  assert.deepEqual([savedA.owner, savedA.title, savedA.estimate_minutes], ['partner', 'Pack the Cloud Vape order (40 tins)', 30], 'both changes survive');
  const savedB = row(server.db, 'planner_tasks', b);
  assert.ok(savedB.done_at, 'still done');
  assert.equal(savedB.notes, 'The 2x3 ones');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0, 'different fields: nothing to review');
  for (const dev of [m, phone.engine]) {
    const r = await dev.get('task', a);
    assert.deepEqual([r.owner, r.estimate_minutes], ['partner', 30]);
    assert.ok((await dev.get('task', b)).done_at);
  }
});

test('captured offline on the phone, made a task (two writes, no connection), on the server once back', async (t) => {
  const { server, phone } = await twoDevices(t);
  const p = phone.engine;
  phone.online = false;
  const item = await p.create('inbox_item', captureFields('Call the sign maker\nAbout the window decal', { source: 'phone', now: nowIso() }));
  const { title, notes } = titleFromText((await p.get('inbox_item', item)).text);
  const id = await p.create('task', { ...taskForm.toFields(taskValues(null, { today: localDate(), initial: { owner: 'partner', business_id: BUSINESS_IDS.personal, title, notes } })).fields });
  await p.update('inbox_item', item, clearedFields({ entity: 'task', id, now: nowIso() }));
  assert.equal((await p.list('inbox_item', { where: (i) => !i.cleared_at })).length, 0, 'the inbox is clear on the phone');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM planner_tasks').get().n, 0, 'nothing reached the server yet');
  phone.online = true;
  await p.syncNow();
  const task = row(server.db, 'planner_tasks', id);
  assert.deepEqual([task.title, task.notes, task.owner, task.created_by], ['Call the sign maker', 'About the window decal', 'partner', 'partner']);
  const saved = row(server.db, 'planner_inbox_items', item);
  assert.deepEqual([saved.source, saved.became_entity, saved.became_id], ['phone', 'task', id]);
  assert.ok(saved.cleared_at);
});

test('a call logged with a next step clears the relationship’s flag, on both devices; a deleted client keeps its tasks', async (t) => {
  const { mac, phone } = await twoDevices(t);
  const m = mac.engine;
  const client = await m.create('client', { name: 'Northwind Holdings', status: 'active' });
  const account = await m.create('account', { client_id: client, name: 'Cloud Vape Co' });
  const rel = await m.create('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  const flagged = async (dev) => {
    const lists = await dev.listMany(['client', 'account', 'relationship', 'task']);
    return relationshipsWithoutNextStep({ clients: lists.client, accounts: lists.account, relationships: lists.relationship, tasks: lists.task }).map((r) => r.id);
  };
  assert.deepEqual(await flagged(m), [rel]);

  // The call and its next step (the ActivityForm's save: two creates).
  await m.create('activity', { client_id: client, account_id: account, business_id: W, type: 'call', body: 'Wants 40 tins Friday', at: nowIso() });
  const next = nextStepFields({ title: 'Confirm Friday delivery', date: '2026-10-09', relationshipId: rel }, {
    clientId: client, me: 'owner', relationshipsById: new Map([[rel, await m.get('relationship', rel)]]),
  });
  const taskId = await m.create('task', next.fields);
  assert.deepEqual(await flagged(m), [], 'cleared on the Mac at once (offline too)');
  await m.syncNow();
  await phone.engine.syncNow();
  assert.deepEqual(await flagged(phone.engine), [], 'and on the phone');

  // Finished: the flag is back (no open next step).
  await phone.engine.update('task', taskId, { done_at: nowIso() });
  assert.deepEqual(await flagged(phone.engine), [rel]);

  // The client deleted by mistake: its task is still listed (a plain ref), its relationship isn't flagged.
  await m.syncNow();
  await m.remove('client', client);
  assert.ok(await m.get('task', taskId), 'the task stays');
  assert.equal((await m.get('task', taskId)).client_id, client, 'still naming the client (shown as deleted)');
  assert.equal(await m.get('client', client), null);
  assert.deepEqual(await flagged(m), []);
});
