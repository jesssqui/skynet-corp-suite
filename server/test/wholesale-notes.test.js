// Notes and follow-ups from the Order Manager (D5, its A11 events): note.added / note.deleted held by
// note_uid and shown on a linked client's timeline as wholesale_note records; followup.changed held on
// the customer and turned into one "Follow up with …" task (the follow-up automation). Replays, mixes
// of backfill and live events, deletes before adds, unlinking and linking, a customer deleted there,
// restores — each note shows once, each follow-up has at most one open task.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { eventProblem } from '../src/modules/wholesale/events.js';
import { FOLLOW_UP_ID, followUpKey } from '../src/modules/wholesale/followUps.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';
import { womKit, postEvents } from './fixtures/wom.js';

const W = BUSINESS_IDS.wholesale;
const statuses = (results) => results.map((r) => r.status);

async function setup(t, { config = testConfig(tmpDir(t)), clock = testClock() } = {}) {
  const env = await startApp(t, config, { modules, now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const { sync, automations: autos, wholesale: svc, planner } = env.ctx.services;
  const local = (entity, fields, op = 'create', recordId, actor = 'owner') => {
    const r = sync.applyLocal({ actor, entity, op, recordId, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
    return r.recordId;
  };
  const client = (name = 'Lefty’s') => {
    const clientId = local('client', { name, status: 'active' });
    const accountId = local('account', { client_id: clientId, name });
    return { clientId, accountId };
  };
  /** Link an Order Manager customer to an account (a link made by a person or D2), attached at once. */
  const link = (customer, { accountId }) => {
    const id = local('link', { account_id: accountId, app: 'wom', external_id: customer.customer_uid, matched_by: 'approved' });
    svc.reconcile({ only: [customer.customer_uid] });
    return id;
  };
  const unlink = (linkId, customer) => {
    local('link', null, 'delete', linkId);
    svc.reconcile({ only: [customer.customer_uid] });
  };
  const apply = (events) => statuses(svc.applyEvents(events));
  const notes = (where = '1', ...args) => env.db.prepare(`SELECT * FROM wholesale_notes WHERE deleted_at IS NULL AND ${where} ORDER BY at, id`).all(...args);
  const held = (uid) => env.db.prepare('SELECT * FROM wholesale_held_notes WHERE uid = ?').get(uid);
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const followTasks = () => tasks("title LIKE 'Follow up with%'");
  const runs = () => env.db.prepare('SELECT * FROM automations_runs WHERE automation_id = ? ORDER BY started_at, id').all(FOLLOW_UP_ID);
  const card = (uid) => env.db.prepare('SELECT * FROM wholesale_customers WHERE customer_uid = ? AND deleted_at IS NULL').get(uid);
  const relOf = (accountId) => env.db.prepare('SELECT id FROM crm_relationships WHERE account_id = ? AND business_id = ? AND deleted_at IS NULL').get(accountId, W)?.id;
  return { ...env, config, clock, users, sync, autos, svc, planner, local, client, link, unlink, apply, notes, held, tasks, followTasks, runs, card, relOf };
}

// ---- the events' shapes ---------------------------------------------------------------------------

test('A11’s three events: the exact shapes are accepted; malformed ones are refused with a plain-English reason', () => {
  const om = womKit();
  const c = om.customer();
  const n = om.note(c, { type: 'call' });
  assert.equal(eventProblem(om.noteAdded(n)), null);
  assert.equal(eventProblem(om.noteAdded(n, { backfill: true })), null);
  assert.equal(eventProblem(om.noteAdded({ ...n, written_by: null, number: null })), null);
  assert.equal(eventProblem(om.noteDeleted(n)), null, 'no reason = deleted by hand');
  for (const reason of ['customer_deleted', 'gone', 'gone_after_restore']) assert.equal(eventProblem(om.noteDeleted(n, { reason })), null);
  assert.equal(eventProblem(om.noteDeleted({ note_uid: n.note_uid, number: null, customer_uid: null }, { reason: 'gone' })), null, 'a delete with nothing remembered but the uid');
  assert.equal(eventProblem(om.followUpChanged(c, '2026-10-20')), null);
  assert.equal(eventProblem(om.followUpChanged(c, null)), null);
  assert.equal(eventProblem(om.followUpChanged(c, null, { done: true })), null);

  const bad = [
    [om.noteAdded({ ...n, note_uid: 'abc' }), /note_uid/],
    [om.noteAdded({ ...n, customer_uid: undefined }), /customer_uid/],
    [om.noteAdded({ ...n, type: 'sms' }), /type must be one of note, call, email, meeting, follow_up/],
    [om.noteAdded({ ...n, body: 5 }), /body must be text/],
    [om.noteAdded({ ...n, at: 'yesterday' }), /at must be an ISO date-time/],
    [om.noteAdded({ ...n, number: 1.5 }), /number/],
    [om.noteAdded({ ...n, written_by: 7 }), /written_by/],
    [{ ...om.noteAdded(n), data: { by: 'admin' } }, /data.note is missing/],
    [om.noteDeleted(n, { reason: 'lost' }), /reason must be one of/],
    [om.noteDeleted({ ...n, note_uid: null }), /note_uid/],
    [om.followUpChanged(c, '20/10/2026'), /YYYY-MM-DD or null/],
    [om.followUpChanged({ customer_uid: 'x' }, null), /customer_uid/],
    [{ ...om.followUpChanged(c, null), data: { by: 'admin', customer_uid: c.customer_uid, follow_up_date: null } }, /done must be true or false/],
    [om.followUpChanged(c, '2026-10-20', { done: true }), /done can only be true when follow_up_date is null/],
    [{ ...om.noteAdded(n), version: 2 }, /Version 2 of note.added/],
  ];
  for (const [e, re] of bad) assert.match(eventProblem(e) ?? '', re);
});

test('over HTTP: notes and follow-ups apply, replays answer duplicate, a malformed one is refused and the rest still apply', async (t) => {
  const env = await setup(t);
  const secret = env.svc.makeSecret({ actor: 'owner' });
  const om = womKit();
  const c = om.customer();
  const n = om.note(c);
  const events = [om.customerCreated(c), om.noteAdded(n), om.noteAdded({ ...om.note(c), type: 'sms' }), om.followUpChanged(c, '2026-10-20')];
  const first = await postEvents(env.base, secret, events);
  assert.equal(first.status, 200);
  assert.deepEqual(statuses(first.body.results), ['applied', 'applied', 'refused', 'applied']);
  assert.match(first.body.results[2].reason, /type must be one of/);
  const again = await postEvents(env.base, secret, events);
  assert.deepEqual(statuses(again.body.results), ['duplicate', 'duplicate', 'refused', 'duplicate']);
  assert.equal(env.held(n.note_uid).body, n.body);
});

// ---- notes ------------------------------------------------------------------------------------------

test('notes wait with their unlinked customer (counted), show on the timeline once linked, leave on unlink and come back', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer({ business_name: 'Lefty’s Vape Shop' });
  const call = om.note(c, { type: 'call', body: 'Wants Zyn 3mg next time', at: '2026-10-01T14:00:00.000Z', written_by: 'sam' });
  const done = om.note(c, { type: 'follow_up', body: 'Followed up', at: '2026-10-02T15:00:00.000Z' });
  assert.deepEqual(env.apply([om.customerCreated(c), om.noteAdded(call), om.noteAdded(done)]), ['applied', 'applied', 'applied']);
  assert.equal(env.notes().length, 0, 'nothing on devices while unlinked');
  const w = env.svc.waitingCounts();
  assert.equal(w.notes, 2);
  const row = env.svc.list('waiting').customers[0];
  assert.equal(row.notes, 2, 'the waiting list says how many notes wait');
  assert.match(env.svc.describe().queueLabel, /0 records and 2 notes from 1 customer waiting for a client/);

  const { accountId, clientId } = env.client();
  const linkId = env.link(c, { accountId });
  const shown = env.notes();
  assert.deepEqual(shown.map((r) => [r.type, r.body, r.written_by, r.at, r.number]), [
    ['call', 'Wants Zyn 3mg next time', 'sam', '2026-10-01T14:00:00.000Z', call.number],
    ['follow_up', 'Followed up', 'admin', '2026-10-02T15:00:00.000Z', done.number],
  ]);
  assert.ok(shown.every((r) => r.account_id === accountId && r.client_id === clientId && r.customer_uid === c.customer_uid && r.created_by === 'system'));
  assert.equal(env.svc.waitingCounts().notes, 0);
  assert.equal(env.svc.lastActivityAtByClient().get(clientId), '2026-10-02T15:00:00.000Z', 'a note there counts as activity');

  env.unlink(linkId, c);
  assert.equal(env.notes().length, 0, 'unlinked: off the devices');
  assert.equal(env.held(call.note_uid).deleted, 0, 'kept in the holding area');
  env.link(c, { accountId });
  assert.equal(env.notes().length, 2, 'linked again: back');
});

test('the Done when: replays (same keys, new keys, backfill and live mixed) show each note once; an add for a held note updates it', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = env.client();
  env.apply([om.customerCreated(c)]);
  env.link(c, { accountId });
  const a = om.note(c, { body: 'First' });
  const b = om.note(c, { type: 'email', body: 'Sent the price list' });
  const live = [om.noteAdded(a), om.noteAdded(b), om.followUpChanged(c, '2026-10-20')];
  assert.deepEqual(env.apply(live), ['applied', 'applied', 'applied']);
  assert.deepEqual(env.apply(live), ['duplicate', 'duplicate', 'duplicate'], 'the same keys: duplicate');
  // "Forget everything" + "Send existing" there: the same notes again as backfill, new keys.
  assert.deepEqual(env.apply([om.customerCreated(c, { backfill: true }), om.noteAdded(a, { backfill: true }), om.noteAdded(b, { backfill: true }),
    om.followUpChanged(c, '2026-10-20', { backfill: true })]), ['applied', 'applied', 'applied', 'applied']);
  assert.equal(env.notes().length, 2, 'each note once');
  assert.equal(env.followTasks().length, 1, 'one follow-up task');
  // An add for a note already held: its latest snapshot wins.
  env.apply([om.noteAdded({ ...a, body: 'First (fixed)' })]);
  assert.deepEqual(env.notes().map((r) => r.body).sort(), ['First (fixed)', 'Sent the price list']);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM wholesale_notes').get().n, 2, 'updated in place: no extra records ever made');
});

test('a deleted note leaves the timeline (kept and marked in the holding area); a tombstone keeps a stale add out; a backfill add brings one back', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = env.client();
  env.apply([om.customerCreated(c)]);
  env.link(c, { accountId });
  const n = om.note(c, { body: 'Deleted by hand later' });
  env.apply([om.noteAdded(n)]);
  assert.equal(env.notes().length, 1);
  env.apply([om.noteDeleted(n)]);
  assert.equal(env.notes().length, 0, 'deleted on devices');
  assert.deepEqual([env.held(n.note_uid).deleted, env.held(n.note_uid).deleted_reason, env.held(n.note_uid).body], [1, 'deleted', 'Deleted by hand later']);

  // The delete of a note the suite never had (its add was refused before D5 and is "sent again" later).
  const ghost = om.note(c, { body: 'Never seen' });
  assert.deepEqual(env.apply([om.noteDeleted(ghost)]), ['applied']);
  assert.deepEqual([env.held(ghost.note_uid).deleted, env.held(ghost.note_uid).snapshot], [1, null], 'a tombstone');
  assert.deepEqual(env.apply([om.noteAdded(ghost)]), ['applied'], 'the late add is applied (answered) …');
  assert.equal(env.held(ghost.note_uid).deleted, 1, '… but the note stays deleted');
  assert.equal(env.held(ghost.note_uid).body, 'Never seen', 'its text is kept for the record');
  assert.equal(env.notes().length, 0);
  // The same for a deleted note sent again live.
  env.apply([om.noteAdded(n)]);
  assert.equal(env.notes().length, 0);
  // A backup import brought both back there: the catch-up sends them as backfill adds → live again.
  env.apply([om.noteAdded(n, { backfill: true }), om.noteAdded(ghost, { backfill: true })]);
  assert.deepEqual(env.notes().map((r) => r.body).sort(), ['Deleted by hand later', 'Never seen']);
  // gone_after_restore: deleted again (held deletes sent there).
  env.apply([om.noteDeleted(n, { reason: 'gone_after_restore', backfill: true })]);
  assert.deepEqual(env.notes().map((r) => r.body), ['Never seen']);
  assert.equal(env.held(n.note_uid).deleted_reason, 'gone_after_restore');
});

test('a deleted customer’s notes leave the timeline; a note delete after the customer’s own delete is accepted; back again, its live notes return', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = env.client();
  const keep = om.note(c, { body: 'Kept' });
  const gone = om.note(c, { body: 'Deleted with the customer' });
  env.apply([om.customerCreated(c), om.noteAdded(keep), om.noteAdded(gone), om.followUpChanged(c, '2026-10-20')]);
  env.link(c, { accountId });
  assert.equal(env.notes().length, 2);
  assert.equal(env.card(c.customer_uid).follow_up_date, '2026-10-20');
  // Deleted there while the notes switch was off: the customer goes first, its notes' deletes later ('gone').
  assert.deepEqual(env.apply([om.customerDeleted(c)]), ['applied']);
  assert.equal(env.notes().length, 0, 'the customer is deleted there: its notes leave the timeline');
  assert.equal(env.card(c.customer_uid).follow_up_date, null, 'and its follow-up is forgotten (as the Order Manager does)');
  assert.deepEqual(env.apply([om.noteDeleted(gone, { reason: 'gone', backfill: true })]), ['applied'], 'accepted for a customer marked gone');
  // A backup import there brought the customer back with one of the notes.
  env.apply([om.customerCreated(c, { backfill: true })]);
  assert.deepEqual(env.notes().map((r) => r.body), ['Kept']);
});

test('notes whose customer the suite never heard of are held (a stub customer) and attach once it is linked', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const n = om.note(c);
  assert.deepEqual(env.apply([om.noteAdded(n)]), ['applied']);
  const stub = env.db.prepare('SELECT * FROM wholesale_held_customers WHERE uid = ?').get(c.customer_uid);
  assert.ok(stub && stub.snapshot === null, 'a stub, filled in when its customer.created arrives');
  env.apply([om.customerCreated(c)]);
  const { accountId } = env.client();
  env.link(c, { accountId });
  assert.equal(env.notes().length, 1);
});

test('devices can’t create, change or delete Order Manager notes', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId, clientId } = env.client();
  env.apply([om.customerCreated(c), om.noteAdded(om.note(c, { body: 'From there' }))]);
  env.link(c, { accountId });
  const [rec] = env.notes();
  const dev = sessionFor(env.ctx, env.users.owner);
  const { createHlc } = await import('@suite/shared/hlc');
  const { newId } = await import('@suite/shared/ids');
  const clock = createHlc(dev.deviceId);
  const step = (op, recordId, fields) => ({ key: newId(), entity: 'wholesale_note', recordId, op, hlc: clock.now(), ...(fields ? { fields } : {}) });
  const res = await fetch(`${env.base}/api/sync/push`, {
    method: 'POST',
    headers: { cookie: dev.cookie, origin: env.base, 'content-type': 'application/json', 'x-suite-device': dev.deviceId },
    body: JSON.stringify({ steps: [
      step('create', newId(), { account_id: accountId, client_id: clientId, customer_uid: c.customer_uid, note_uid: newId(), type: 'note', at: new Date().toISOString() }),
      step('update', rec.id, { body: 'changed' }),
      step('delete', rec.id),
    ] }),
  }).then((r) => r.json());
  assert.deepEqual(res.results.map((r) => [r.status, r.code]), Array(3).fill(['rejected', 'op_not_allowed']), JSON.stringify(res));
  assert.equal(env.notes()[0].body, 'From there');
});

// ---- follow-ups -------------------------------------------------------------------------------------

test('follow-up set → one task due that day for the wholesale default owner; moved → the same task moves; done / cleared → finished', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer({ business_name: 'Lefty’s Vape Shop' });
  const { accountId, clientId } = env.client('Lefty’s');
  env.apply([om.customerCreated(c)]);
  env.link(c, { accountId });
  assert.deepEqual(env.apply([om.followUpChanged(c, '2026-10-20')]), ['applied']);
  let [task] = env.followTasks();
  assert.equal(task.title, 'Follow up with Lefty’s');
  assert.deepEqual([task.due_date, task.owner, task.business_id, task.client_id, task.account_id, task.relationship_id, task.done_at],
    ['2026-10-20', env.planner.automatedOwnerFor(W), W, clientId, accountId, env.relOf(accountId), null]);
  assert.match(task.notes, /Mark it done in the Order Manager too/);
  assert.equal(env.card(c.customer_uid).follow_up_date, '2026-10-20', 'the card shows the next follow-up');

  env.apply([om.followUpChanged(c, '2026-10-27')]);
  const all = env.followTasks();
  assert.equal(all.length, 1, 'moved, not a second task');
  assert.equal(all[0].id, task.id);
  assert.equal(all[0].due_date, '2026-10-27');

  // Done there: followup.changed { null, done } then the follow_up note.
  const doneNote = om.note(c, { type: 'follow_up', body: 'Followed up' });
  env.apply([om.followUpChanged(c, null, { done: true }), om.noteAdded(doneNote)]);
  [task] = env.followTasks();
  assert.ok(task.done_at, 'finished');
  assert.match(task.notes, /Done in the Order Manager — finished by the suite/);
  assert.equal(env.notes("type = 'follow_up'").length, 1, 'and the follow-up note is on the timeline');
  assert.equal(env.card(c.customer_uid).follow_up_date, null);

  // A new follow-up later (even the same day as before) is a new task; cleared by hand → finished as cleared.
  env.apply([om.followUpChanged(c, '2026-10-27')]);
  const open = env.followTasks().filter((x) => !x.done_at);
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, task.id, 'a new task for the new follow-up');
  env.apply([om.followUpChanged(c, null)]);
  assert.match(env.tasks('id = ?', open[0].id)[0].notes, /Cleared in the Order Manager — finished by the suite/);
  assert.equal(env.followTasks().filter((x) => !x.done_at).length, 0);
  // Every run was one per event, none for nothing.
  assert.ok(env.runs().every((r) => r.status === 'ok'));
});

test('replays never duplicate: the same follow-up again (new keys, backfill, a restart’s check) finds its task; a person’s finish is final for that date', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = env.client();
  env.apply([om.customerCreated(c)]);
  env.link(c, { accountId });
  const set = om.followUpChanged(c, '2026-10-20');
  env.apply([set]);
  env.apply([set]); // duplicate key
  env.apply([om.followUpChanged(c, '2026-10-20', { backfill: true })]);
  assert.equal(env.followTasks().length, 1);
  const before = env.runs().length;
  env.svc.checkFollowUps();
  assert.equal(env.runs().length, before, 'nothing to change: no run at all');
  // A person finishes it in the suite; the Order Manager still says Oct 20 (they forgot to mark it there).
  const [task] = env.followTasks();
  env.local('task', { done_at: new Date().toISOString() }, 'update', task.id, 'owner');
  env.apply([om.followUpChanged(c, '2026-10-20', { backfill: true })]);
  env.svc.checkFollowUps();
  assert.equal(env.followTasks().length, 1, 'not made again for the same follow-up');
  assert.equal(env.autos.runNow(FOLLOW_UP_ID).summary, 'Nothing to change; 1 follow-up already handled by a person');
  // Moved there to another day: a follow-up is still wanted → a new task.
  env.apply([om.followUpChanged(c, '2026-11-03')]);
  const open = env.followTasks().filter((x) => !x.done_at);
  assert.deepEqual(open.map((x) => x.due_date), ['2026-11-03']);
});

test('a day the person gave the task is kept when the Order Manager’s date moves (told once in the notes); a person’s title too', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = env.client();
  env.apply([om.customerCreated(c), om.followUpChanged(c, '2026-10-20')]);
  env.link(c, { accountId });
  const [task] = env.followTasks();
  env.local('task', { due_date: '2026-10-22', title: 'Call Lefty about the 3mg' }, 'update', task.id, 'partner');
  env.apply([om.followUpChanged(c, '2026-10-25')]);
  let now = env.tasks('id = ?', task.id)[0];
  assert.deepEqual([now.due_date, now.title], ['2026-10-22', 'Call Lefty about the 3mg'], 'the person’s day and title stay');
  assert.match(now.notes, /The follow-up date in the Order Manager is now Oct\. 25, 2026|The follow-up date in the Order Manager is now Oct 25, 2026/);
  const runs = env.runs().length;
  env.svc.checkFollowUps();
  env.apply([om.followUpChanged(c, '2026-10-25', { backfill: true })]);
  assert.equal(env.runs().length, runs, 'told once');
  now = env.tasks('id = ?', task.id)[0];
  assert.equal(now.notes.split('is now').length, 2);
});

test('unlinked customers get no task; linking brings the current follow-up; unlinking finishes it; linking again reopens it; a deleted customer’s is finished', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  // A backfill follow-up (turning the switch on there) for a customer not linked yet.
  env.apply([om.customerCreated(c, { backfill: true }), om.followUpChanged(c, '2026-10-20', { backfill: true })]);
  assert.equal(env.followTasks().length, 0);
  assert.equal(env.runs().length, 0, 'not even a run row');
  assert.equal(env.svc.list('waiting').customers[0].followUpDate, '2026-10-20', 'the waiting list shows it');
  const { accountId } = env.client();
  const linkId = env.link(c, { accountId });
  let [task] = env.followTasks();
  assert.equal(task.due_date, '2026-10-20', 'linked: the backfilled follow-up is a task');
  env.unlink(linkId, c);
  [task] = env.followTasks();
  assert.match(task.notes, /Unlinked from the Order Manager customer — finished by the suite/);
  // Linked again (by a person on the Wholesale page): the suite's finished task is reopened.
  const { status } = await fetch(`${env.base}/api/wholesale/customers/${c.customer_uid}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: env.base, cookie: sessionFor(env.ctx, env.users.owner).cookie },
    body: JSON.stringify({ clientId: env.ctx.services.crm.liveAccount(accountId).client_id, accountId }),
  });
  assert.equal(status, 200);
  const again = env.followTasks();
  assert.equal(again.length, 1);
  assert.deepEqual([again[0].id, again[0].done_at, again[0].due_date], [task.id, null, '2026-10-20']);
  assert.match(again[0].notes, /is open in the Order Manager — reopened by the suite/);
  // Deleted there.
  env.apply([om.customerDeleted(c)]);
  assert.match(env.tasks('id = ?', task.id)[0].notes, /Deleted in the Order Manager — finished by the suite/);
  assert.equal(env.followTasks().filter((x) => !x.done_at).length, 0);
});

test('an account moved to another client takes its follow-up task with it', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const first = env.client('First');
  const second = env.client('Second');
  env.apply([om.customerCreated(c), om.followUpChanged(c, '2026-10-20')]);
  const linkId = env.link(c, { accountId: first.accountId });
  env.unlink(linkId, c);
  env.link(c, { accountId: second.accountId });
  const open = env.followTasks().filter((x) => !x.done_at);
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].client_id, open[0].account_id], [second.clientId, second.accountId]);
  assert.equal(open[0].title, 'Follow up with Second');
});

test('switched off, follow-ups make nothing; Run now (switched on again) catches up every customer', async (t) => {
  const env = await setup(t);
  const om = womKit();
  const c = om.customer();
  const { accountId } = env.client();
  env.autos.setSettings(FOLLOW_UP_ID, { enabled: false }, { actor: 'owner' });
  env.apply([om.customerCreated(c), om.followUpChanged(c, '2026-10-20')]);
  env.link(c, { accountId });
  assert.equal(env.followTasks().length, 0);
  const run = env.autos.runNow(FOLLOW_UP_ID);
  assert.equal(run.status, 'ok');
  assert.match(run.summary, /^Made “Follow up with Lefty’s \(Oct/);
  assert.equal(env.followTasks().length, 1);
  assert.equal(env.autos.runNow(FOLLOW_UP_ID).summary, 'Nothing to change');
});

test('followUpKey: customer, episode, date', () => {
  assert.equal(followUpKey({ uid: 'u', follow_up_episode: 2, follow_up_date: '2026-10-20' }), 'u:2:2026-10-20');
});

// ---- restore -----------------------------------------------------------------------------------------

async function backupOf(env, config) {
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(`${config.backup.offsiteDir}/.suite-backup-target`, '');
  return runBackup({ db: env.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
}

test('a restore keeps the held notes and follow-ups (as the Order Manager last said) and re-projects them; tasks follow', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  const first = await setup(t, { config });
  const om = womKit();
  const c = om.customer();
  const { accountId } = first.client();
  const a = om.note(c, { body: 'Before the backup' });
  first.apply([om.customerCreated(c), om.noteAdded(a)]);
  first.link(c, { accountId });
  const backup = await backupOf(first, config);
  // After the backup: a note deleted, a new one, a follow-up set.
  const b = om.note(c, { body: 'After the backup' });
  const after = [om.noteDeleted(a), om.noteAdded(b), om.followUpChanged(c, '2026-10-20')];
  assert.deepEqual(first.apply(after), ['applied', 'applied', 'applied']);
  assert.equal(first.followTasks().length, 1);
  await first.close();

  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const again = await setup(t, { config });
  await again.svc.reconcileAll();
  again.svc.checkFollowUps();
  assert.deepEqual(again.notes().map((r) => r.body), ['After the backup'], 'the deleted note stays deleted, the new one is there');
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM wholesale_notes WHERE deleted_at IS NULL GROUP BY note_uid HAVING n > 1').all().length, 0);
  const open = again.followTasks().filter((x) => !x.done_at);
  assert.deepEqual(open.map((x) => x.due_date), ['2026-10-20'], 'the follow-up set after the backup has its task again');
  assert.equal(again.card(c.customer_uid).follow_up_date, '2026-10-20');
  // The Order Manager resending what it delivered changes nothing.
  assert.deepEqual(again.apply(after), ['duplicate', 'duplicate', 'duplicate']);
});

test('a restore of a backup made before D5 (no notes table, no follow-up columns) still keeps the held notes and follow-ups', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  const first = await setup(t, { config });
  const backup = await backupOf(first, config);
  // Make the backup look like one from before D5.
  {
    const old = new Database(backup.file);
    old.exec(`DROP TABLE wholesale_held_notes; DROP TABLE wholesale_notes;
      ALTER TABLE wholesale_held_customers DROP COLUMN follow_up_date; ALTER TABLE wholesale_held_customers DROP COLUMN follow_up_done;
      ALTER TABLE wholesale_held_customers DROP COLUMN follow_up_at; ALTER TABLE wholesale_held_customers DROP COLUMN follow_up_episode;
      ALTER TABLE wholesale_customers DROP COLUMN follow_up_date;
      DELETE FROM schema_migrations WHERE module = 'wholesale' AND name = '004_notes.sql';`);
    old.close();
  }
  const om = womKit();
  const c = om.customer();
  const { accountId } = first.client();
  first.apply([om.customerCreated(c), om.noteAdded(om.note(c, { body: 'Since D5' })), om.followUpChanged(c, '2026-10-20')]);
  first.link(c, { accountId });
  await first.close();
  const lines = [];
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /wholesale_held_notes/.test(l)), lines.join('\n'));
  const again = await setup(t, { config });
  const held = again.db.prepare('SELECT follow_up_date FROM wholesale_held_customers WHERE uid = ?').get(c.customer_uid);
  assert.equal(held.follow_up_date, '2026-10-20');
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM wholesale_held_notes').get().n, 1);
});
