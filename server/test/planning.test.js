// Planning (C4b) on the server: goals (week goals and month priorities) and workdays registered with
// sync (fields, refs, column types), the period check, each person's workday made once at start,
// and the task.goal_id migration on a database that already has C4a tasks — old devices' steps
// without goal_id still apply. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '@suite/shared/ids';
import { createHlc } from '@suite/shared/hlc';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WORKDAY_IDS, MONTH_PRIORITY_LIMIT, isGoalPeriod, goalPeriodOf, dayMinutesOf, DEFAULT_DAY_MINUTES } from '@suite/shared/planner';
import { modules } from '../src/modules/index.js';
import planner from '../src/modules/planner/index.js';
import { PLANNER_ENTITIES } from '../src/modules/planner/entities.js';
import { checkTask, checkGoal } from '../src/modules/planner/service.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;
const MONDAY = '2026-10-05';

/** A device signed in as `actor` against `env` (which may be swapped for a restarted server). */
function makeDevice(holder, actor) {
  const { cookie, deviceId: id } = sessionFor(holder.env.ctx, holder.env.users[actor]);
  const clock = createHlc(id);
  const d = {
    id,
    cursor: null,
    headers: () => ({ 'content-type': 'application/json', cookie, origin: holder.env.base }),
    step(op, entity, recordId, fields) {
      return { key: newId(), entity, recordId, op, ...(fields ? { fields } : {}), hlc: clock.now(), ...(d.cursor ? { seen: d.cursor } : {}) };
    },
    async push(steps) {
      const res = await fetch(`${holder.env.base}/api/sync/push`, { method: 'POST', headers: d.headers(), body: JSON.stringify({ steps }) });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      clock.receive(body.hlc);
      return body.results;
    },
    async one(step) {
      return (await d.push([step]))[0];
    },
    async create(entity, fields, recordId = newId()) {
      const r = await d.one(d.step('create', entity, recordId, fields));
      assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
      return recordId;
    },
    async pull() {
      const out = new Map();
      for (;;) {
        const res = await fetch(`${holder.env.base}/api/sync/pull?${new URLSearchParams(d.cursor ? { since: d.cursor } : {})}`, { headers: d.headers() });
        const body = await res.json();
        clock.receive(body.hlc);
        for (const c of body.changes) out.set(`${c.entity}/${c.id}`, c);
        d.cursor = body.cursor;
        if (!body.hasMore) return out;
      }
    },
  };
  return d;
}

async function setup(t) {
  const env = await startApp(t, testConfig(tmpDir(t)), { modules });
  const users = await ensureTestUsers(env.ctx);
  const holder = { env: { ...env, users } };
  return holder;
}

const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const types = (db, table) => Object.fromEntries(db.prepare('SELECT name, type FROM pragma_table_info(?)').all(table).map((c) => [c.name, c.type]));

test('goals and workdays are registered with sync; task.goal_id is a plain ref; columns match the field types', async (t) => {
  const { env } = await setup(t);
  const by = Object.fromEntries(env.ctx.services.sync.info().entities.filter((e) => e.module === 'planner').map((e) => [e.entity, e]));
  const goal = by.goal;
  assert.deepEqual(goal.ops, ['create', 'update', 'delete']);
  assert.deepEqual(goal.fields.kind, { type: 'enum', required: true, values: ['week', 'month'] });
  assert.deepEqual(goal.fields.period, { type: 'date', required: true });
  assert.deepEqual(goal.fields.business_id, { type: 'id', required: true, ref: 'business', parent: true }, 'a goal belongs to one of our businesses (Personal included)');
  assert.deepEqual(goal.fields.title, { type: 'text', required: true, max: 300 });
  assert.deepEqual([goal.fields.target, goal.fields.progress], [{ type: 'number' }, { type: 'number' }]);
  assert.deepEqual(goal.fields.owner, { type: 'enum', values: ['owner', 'partner', 'shared'] }, 'optional: the screens default it to the maker');
  assert.deepEqual([goal.fields.done_at, goal.fields.position, goal.fields.carried_from], [{ type: 'datetime' }, { type: 'integer' }, { type: 'id' }]);
  assert.deepEqual(by.task.fields.goal_id, { type: 'id', ref: 'goal' }, 'not a parent: deleting a goal never hides its tasks');
  assert.deepEqual(by.workday.ops, ['create', 'update'], 'never deleted');
  assert.deepEqual(by.workday.fields, { actor: { type: 'enum', required: true, values: ['owner', 'partner'] }, day_minutes: { type: 'integer' } });

  const g = types(env.db, 'planner_goals');
  assert.deepEqual(
    [g.kind, g.period, g.business_id, g.title, g.target, g.progress, g.owner, g.done_at, g.position, g.carried_from, g.flagged],
    ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'REAL', 'REAL', 'TEXT', 'TEXT', 'INTEGER', 'TEXT', 'INTEGER'],
  );
  assert.equal(types(env.db, 'planner_tasks').goal_id, 'TEXT');
  assert.equal(types(env.db, 'planner_workdays').day_minutes, 'INTEGER');
  assert.ok(PLANNER_ENTITIES.every((e) => e.table.startsWith('planner_')));
});

test('each person’s workday is made once at start, with its fixed id, and survives a restart; devices edit it', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  const first = await startApp(t, config, { modules });
  const ids = first.db.prepare('SELECT id, actor, day_minutes, created_by FROM planner_workdays ORDER BY actor').all();
  assert.deepEqual(ids, [
    { id: WORKDAY_IDS.owner, actor: 'owner', day_minutes: null, created_by: 'system' },
    { id: WORKDAY_IDS.partner, actor: 'partner', day_minutes: null, created_by: 'system' },
  ]);
  assert.equal(dayMinutesOf(ids[0]), DEFAULT_DAY_MINUTES, 'null = 8 h');
  const users = await ensureTestUsers(first.ctx);
  const holder = { env: { ...first, users } };
  const phone = makeDevice(holder, 'partner');
  await phone.pull();
  assert.equal((await phone.one(phone.step('update', 'workday', WORKDAY_IDS.partner, { day_minutes: 360 }))).status, 'applied');
  const bad = await phone.one(phone.step('update', 'workday', WORKDAY_IDS.partner, { day_minutes: 10 }));
  assert.deepEqual([bad.status, bad.code], ['rejected', 'invalid_value']);
  const stray = await phone.one(phone.step('create', 'workday', newId(), { actor: 'partner' }));
  assert.deepEqual([stray.status, stray.code], ['rejected', 'invalid_value'], 'one per person, with its fixed id');
  const dup = await phone.one(phone.step('create', 'workday', WORKDAY_IDS.owner, { actor: 'owner' }));
  assert.deepEqual([dup.status, dup.code], ['rejected', 'already_exists']);
  const swap = await phone.one(phone.step('update', 'workday', WORKDAY_IDS.partner, { actor: 'owner' }));
  assert.deepEqual([swap.status, swap.code], ['rejected', 'invalid_value'], 'whose it is never changes');
  await first.close();

  const again = await startApp(t, config, { modules });
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM planner_workdays WHERE id IN (?, ?)').get(WORKDAY_IDS.owner, WORKDAY_IDS.partner).n, 2, 'not duplicated');
  assert.equal(row(again.db, 'planner_workdays', WORKDAY_IDS.partner).day_minutes, 360, 'the edit stays');
  assert.deepEqual(again.ctx.services.planner.seedWorkdays(), []);
});

test('the period check: a week goal’s period is a Monday, a month priority’s the 1st; kind and period change together', async (t) => {
  const holder = await setup(t);
  const { db } = holder.env;
  const d = makeDevice(holder, 'owner');
  const refused = async (step, pattern) => {
    const r = await d.one(step);
    assert.deepEqual([r.status, r.code], ['rejected', 'invalid_value'], JSON.stringify(r));
    assert.match(r.reason, pattern);
  };
  const base = { business_id: W, title: 'Follow up 5 quiet wholesale customers' };
  await refused(d.step('create', 'goal', newId(), { ...base, kind: 'week', period: '2026-10-07' }), /Monday/);
  await refused(d.step('create', 'goal', newId(), { ...base, kind: 'week', period: '2026-10-11' }), /Monday/, 'a Sunday ends the week, it doesn’t name it');
  await refused(d.step('create', 'goal', newId(), { ...base, kind: 'month', period: '2026-10-05' }), /1st/);
  await refused(d.step('create', 'goal', newId(), { ...base, kind: 'week', period: MONDAY, target: 0 }), /target/);
  await refused(d.step('create', 'goal', newId(), { ...base, kind: 'week', period: MONDAY, progress: -1 }), /progress/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM planner_goals').get().n, 0, 'nothing written');

  // Across a year end: Monday Dec 28, 2026 names the week of Dec 28 – Jan 3; Feb 1 a month.
  const week = await d.create('goal', { ...base, kind: 'week', period: '2026-12-28', target: 5, progress: 0 });
  await d.create('goal', { ...base, kind: 'month', period: '2027-02-01' });
  // An update with only one of kind/period is refused (it could pair with the other device's change).
  await refused(d.step('update', 'goal', week, { period: '2027-01-04' }), /together/);
  await refused(d.step('update', 'goal', week, { kind: 'month' }), /together/);
  await refused(d.step('update', 'goal', week, { kind: 'month', period: '2027-01-04' }), /1st/);
  assert.equal((await d.one(d.step('update', 'goal', week, { kind: 'week', period: '2027-01-04' }))).status, 'applied', 'moved to next week');
  assert.equal((await d.one(d.step('update', 'goal', week, { progress: 3.5, done_at: null, position: 2 }))).status, 'applied');
  assert.deepEqual([row(db, 'planner_goals', week).period, row(db, 'planner_goals', week).progress], ['2027-01-04', 3.5]);

  // Four month priorities for one business: warned about on screen, never refused (offline creates).
  for (let i = 0; i < MONTH_PRIORITY_LIMIT + 1; i += 1) {
    await d.create('goal', { kind: 'month', period: '2026-10-01', business_id: AGENCY, title: `Priority ${i + 1}` });
  }
  assert.equal(holder.env.ctx.services.planner.goals('month', '2026-10-01').length, 4);

  // The rule itself (only the step's own values).
  assert.equal(checkGoal({ op: 'delete' }), null);
  assert.equal(checkGoal({ op: 'update', fields: { title: 'x', target: null } }), null);
  assert.equal(isGoalPeriod('week', '2026-02-29'), false, 'not a date');
  assert.equal(isGoalPeriod('month', '2028-02-01'), true);
  assert.equal(goalPeriodOf({ kind: 'week', period: '2026-11-01' }), '2026-10-26', 'readers snap a stray period to its week');
});

test('task.goal_id: a task hangs off a goal; a deleted goal leaves its tasks live; a goal not here yet parks the step', async (t) => {
  const holder = await setup(t);
  const { db } = holder.env;
  const mac = makeDevice(holder, 'owner');
  const goal = newId();
  // The task arrives before its goal (made on another device offline): not_found, retried later.
  const early = mac.step('create', 'task', newId(), { title: 'Call Cloud Vape', owner: 'owner', business_id: W, goal_id: goal });
  const r = await mac.one(early);
  assert.deepEqual([r.code, r.missing], ['not_found', { field: 'goal_id', entity: 'goal', id: goal }]);
  await mac.create('goal', { kind: 'week', period: MONDAY, business_id: W, title: 'Follow up 5 quiet wholesale customers', target: 5, owner: 'owner' }, goal);
  assert.equal((await mac.one(early)).status, 'applied');
  assert.equal(row(db, 'planner_tasks', early.recordId).goal_id, goal);
  await mac.pull();
  assert.equal((await mac.one(mac.step('delete', 'goal', goal))).status, 'applied');
  assert.equal(row(db, 'planner_tasks', early.recordId).deleted_at, null, 'the task stays');
});

test('the goal_id migration on a database with C4a tasks: rows kept, old devices’ steps without goal_id still apply', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  // The C4a planner: only its first migration, and its record types without goal_id (no goals).
  const oldDir = path.join(dir, 'c4a-migrations');
  fs.mkdirSync(oldDir);
  fs.copyFileSync(path.join(planner.migrationsDir, '001_create_planner.sql'), path.join(oldDir, '001_create_planner.sql'));
  const c4a = PLANNER_ENTITIES.filter((e) => ['task', 'inbox_item'].includes(e.entity)).map((e) => {
    const { goal_id: _drop, ...fields } = e.fields;
    return { ...e, fields };
  });
  const oldPlanner = {
    name: 'planner',
    migrationsDir: oldDir,
    createService: ({ services }) => {
      for (const def of c4a) services.sync.registerEntity({ module: 'planner', ...def, ...(def.entity === 'task' ? { check: checkTask } : {}) });
      return {};
    },
  };
  const old = await startApp(t, config, { modules: modules.map((m) => (m.name === 'planner' ? oldPlanner : m)) });
  assert.equal(types(old.db, 'planner_tasks').goal_id, undefined, 'a C4a database');
  const users = await ensureTestUsers(old.ctx);
  const holder = { env: { ...old, users } };
  const mac = makeDevice(holder, 'owner');
  const phone = makeDevice(holder, 'partner');
  const kept = await mac.create('task', { title: 'Renew the domain', owner: 'shared', business_id: PERSONAL, due_date: '2026-10-09', estimate_minutes: 15 });
  await phone.pull();
  // The phone goes offline with C4a steps waiting in its outbox (an old build: no goal_id).
  const waitingCreate = phone.step('create', 'task', newId(), { title: 'Photograph the new arrivals', owner: 'partner', business_id: BUSINESS_IDS.save_point });
  const waitingUpdate = phone.step('update', 'task', kept, { estimate_minutes: 30 });
  await old.close();

  // C4b deploys: 002 adds goals, workdays and task.goal_id.
  const next = await startApp(t, config, { modules });
  holder.env = { ...next, users };
  const migrated = next.db.prepare("SELECT name FROM schema_migrations WHERE module = 'planner' ORDER BY name").all().map((m) => m.name);
  assert.deepEqual(migrated, ['001_create_planner.sql', '002_goals.sql']);
  const before = row(next.db, 'planner_tasks', kept);
  assert.deepEqual([before.title, before.due_date, before.estimate_minutes, before.goal_id], ['Renew the domain', '2026-10-09', 15, null], 'rows kept, goal_id empty');
  assert.equal(next.db.prepare('SELECT count(*) AS n FROM planner_workdays').get().n, 2);

  // The old phone comes back: its steps (no goal_id) apply.
  const results = await phone.push([waitingCreate, waitingUpdate]);
  assert.deepEqual(results.map((x) => x.status), ['applied', 'applied']);
  assert.equal(row(next.db, 'planner_tasks', waitingCreate.recordId).goal_id, null);
  assert.equal(row(next.db, 'planner_tasks', kept).estimate_minutes, 30);
  // And a new device can file the old task under a goal.
  const goal = await mac.create('goal', { kind: 'week', period: MONDAY, business_id: PERSONAL, title: 'Sort out the house admin' });
  await mac.pull();
  assert.equal((await mac.one(mac.step('update', 'task', kept, { goal_id: goal }))).status, 'applied');
  const pulled = await phone.pull();
  assert.equal(pulled.get(`task/${kept}`).fields.goal_id, goal);
  assert.equal(pulled.get(`goal/${goal}`).fields.title, 'Sort out the house admin');
});

test('a goal edited on two devices at once: different fields both apply, the same field clashes (later stamp wins)', async (t) => {
  const holder = await setup(t);
  const { db } = holder.env;
  const mac = makeDevice(holder, 'owner');
  const phone = makeDevice(holder, 'partner');
  const goal = await mac.create('goal', { kind: 'week', period: MONDAY, business_id: AGENCY, title: 'Finish the Lefty’s homepage', target: 1, progress: 0 });
  await mac.pull();
  await phone.pull();
  assert.equal((await phone.one(phone.step('update', 'goal', goal, { progress: 1 }))).status, 'applied');
  assert.equal((await mac.one(mac.step('update', 'goal', goal, { notes: 'Hero copy approved' }))).status, 'applied');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);
  assert.equal((await phone.one(phone.step('update', 'goal', goal, { title: 'Finish the Lefty’s homepage + menu' }))).status, 'applied');
  const clash = await mac.one(mac.step('update', 'goal', goal, { title: 'Launch the Lefty’s homepage' }));
  assert.equal(clash.status, 'clash');
  const saved = row(db, 'planner_goals', goal);
  assert.deepEqual([saved.progress, saved.notes, saved.title], [1, 'Hero copy approved', 'Launch the Lefty’s homepage']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sync_clashes WHERE field = 'title'").get().n, 1);
});
