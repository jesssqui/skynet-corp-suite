// Planning (C4b) against the real engine and server, with two devices: a goal edited on both
// (different fields merge, the same field clashes — later stamp wins, the other value kept for
// review), the goal sheet sending only what changed, carrying a goal over, a task sorted onto a
// goal offline, and each person's day length. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { WORKDAY_IDS, weekStart, addDays, isUnplannedTask } from '@suite/shared/planner';
import { startServer, makeDevice, row } from './helpers.js';
import { goalForm, goalValues, editChanges } from '../src/modules/planner/goalForm.js';
import { carryOverCandidates, carryFields, goalChange, dayMinutesFor, unplannedTasks } from '../src/modules/planner/plan.js';
import { taskForm, taskValues, goalPick } from '../src/modules/planner/taskForm.js';

const W = BUSINESS_IDS.wholesale;
const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;

async function twoDevices(t) {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  return { server, mac, phone };
}

test('a goal edited on both devices: the Mac’s sheet sends only what changed, so the partner’s progress survives; the same field clashes', async (t) => {
  const { server, mac, phone } = await twoDevices(t);
  const m = mac.engine;
  const monday = weekStart(localDate());
  const id = await m.create('goal', { kind: 'week', period: monday, business_id: W, title: 'Follow up 5 quiet wholesale customers', target: 5, progress: 0, owner: 'owner' });
  await m.syncNow();
  await phone.engine.syncNow();

  // The Mac opens the goal's sheet; meanwhile the partner logs progress and adds a note on the phone.
  const start = goalValues(await m.get('goal', id));
  await phone.engine.update('goal', id, { progress: 2, notes: 'Called Cedar Lane and Birch & Co' });
  await phone.engine.syncNow();
  await m.syncNow();
  assert.equal((await m.get('goal', id)).progress, 2, 'the Mac shows it behind the open sheet');

  // The Mac changes the target and the owner, and saves: only those two fields go.
  const edit = editChanges(goalForm, start, { ...start, target: '6', owner: 'shared' });
  assert.deepEqual(edit.fields, { target: 6, owner: 'shared' });
  await m.update('goal', id, edit.fields);
  await m.syncNow();
  await phone.engine.syncNow();
  const saved = row(server.db, 'planner_goals', id);
  assert.deepEqual([saved.progress, saved.notes, saved.target, saved.owner], [2, 'Called Cedar Lane and Birch & Co', 6, 'shared'], 'both changes survive');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);

  // Both rename it at once, offline: the later stamp wins, the other title is kept for review.
  mac.online = false;
  phone.online = false;
  await phone.engine.update('goal', id, { title: 'Follow up 6 quiet customers' });
  await new Promise((r) => setTimeout(r, 5));
  await m.update('goal', id, { title: 'Call 6 quiet wholesale customers' });
  phone.online = true;
  await phone.engine.syncNow();
  mac.online = true;
  await m.syncNow();
  await phone.engine.syncNow();
  assert.equal(row(server.db, 'planner_goals', id).title, 'Call 6 quiet wholesale customers', 'the later edit wins');
  const clash = server.db.prepare("SELECT * FROM sync_clashes WHERE field = 'title'").get();
  assert.ok(clash, 'the other title is kept for review');
  const onPhone = await phone.engine.get('goal', id);
  assert.equal(onPhone.title, 'Call 6 quiet wholesale customers');
  assert.equal(onPhone._sync.clashes.length, 1, 'the clash shows on the record');
  // Validation: a target of 0, a negative progress, an empty title.
  const bad = goalForm.toFields({ ...start, title: ' ', target: '0', progress: '-1' });
  assert.deepEqual(Object.keys(bad.problems).sort(), ['progress', 'target', 'title']);
});

test('carrying a goal over makes a copy the other device sees once; a task sorted onto a goal offline reaches the server', async (t) => {
  const { server, mac, phone } = await twoDevices(t);
  const m = mac.engine;
  const p = phone.engine;
  const today = localDate();
  const monday = weekStart(today);
  const last = addDays(monday, -7);
  const old = await m.create('goal', { kind: 'week', period: last, business_id: AGENCY, title: 'Finish the Maple Row homepage', target: 1, progress: 0, owner: 'owner' });
  await m.syncNow();
  await p.syncNow();
  const goals = await m.list('goal');
  const [candidate] = carryOverCandidates(goals, { kind: 'week', from: last, to: monday });
  assert.equal(candidate.id, old);
  const copy = await m.create('goal', carryFields(candidate, monday, { me: 'owner', position: 0 }));
  await m.syncNow();
  await p.syncNow();
  assert.deepEqual(carryOverCandidates(await p.list('goal'), { kind: 'week', from: last, to: monday }), [], 'the phone sees it carried');
  const saved = row(server.db, 'planner_goals', copy);
  assert.deepEqual([saved.period, saved.carried_from, saved.title, saved.business_id], [monday, old, 'Finish the Maple Row homepage', AGENCY]);
  assert.equal(row(server.db, 'planner_goals', old).period, last, 'the old goal is left as it was');

  // The partner captured a task with no day (Personal by default) and sorts it onto the goal, offline.
  const id = await p.create('task', taskForm.toFields(taskValues(null, { today, me: 'partner', initial: { owner: 'partner', business_id: PERSONAL, title: 'Send the homepage proofs' } })).fields);
  await p.syncNow();
  const goalsById = new Map((await p.list('goal')).map((g) => [g.id, g]));
  assert.equal(unplannedTasks(await p.list('task'), { goalsById, me: 'partner' }).length, 1, 'to sort');
  phone.online = false;
  await p.update('task', id, goalChange(await p.get('task', id), goalsById.get(copy)));
  assert.equal(isUnplannedTask(await p.get('task', id), goalsById), false, 'sorted at once on the phone');
  assert.equal(row(server.db, 'planner_tasks', id).goal_id, null, 'not on the server yet');
  phone.online = true;
  await p.syncNow();
  const task = row(server.db, 'planner_tasks', id);
  assert.deepEqual([task.goal_id, task.business_id], [copy, AGENCY], 'filed under the goal and its business');
  // The task sheet does the same when a goal is picked.
  assert.deepEqual(goalPick({ business_id: PERSONAL, goal_id: '' }, copy, goalsById), { business_id: AGENCY, goal_id: copy });
});

test('each person’s day length: synced, one record each, the default until set', async (t) => {
  const { server, mac, phone } = await twoDevices(t);
  const workdays = await mac.engine.list('workday');
  assert.deepEqual(workdays.map((w) => w.id).sort(), [WORKDAY_IDS.owner, WORKDAY_IDS.partner].sort());
  assert.equal(dayMinutesFor(workdays, 'owner'), 480);
  await phone.engine.update('workday', WORKDAY_IDS.partner, { day_minutes: 330 });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const after = await mac.engine.list('workday');
  assert.deepEqual([dayMinutesFor(after, 'partner'), dayMinutesFor(after, 'owner')], [330, 480], 'the Mac sees the partner’s day; the owner’s is untouched');
  assert.equal(row(server.db, 'planner_workdays', WORKDAY_IDS.partner).updated_by, 'partner');
});
