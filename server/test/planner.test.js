// The planner (C4a): tasks and inbox items registered with sync (fields, refs, column types), the
// module's checks, references parked as not_found until their record arrives, tasks that outlive
// a deleted client, the owner for automated tasks, and the guard refusing direct writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { createHlc } from '@suite/shared/hlc';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { PLANNER_ENTITY_NAMES, ESTIMATE_MAX_MINUTES, automatedTaskOwner } from '@suite/shared/planner';
import { modules } from '../src/modules/index.js';
import { PLANNER_ENTITIES } from '../src/modules/planner/entities.js';
import { checkTask } from '../src/modules/planner/service.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, quietLog } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const PERSONAL = BUSINESS_IDS.personal;

async function setup(t) {
  const env = await startApp(t, testConfig(tmpDir(t)), { modules });
  const users = await ensureTestUsers(env.ctx);
  return { ...env, users };
}

/** A phone or Mac signed in as `actor`: steps with its own clock, push, pull. */
function makeDevice(env, actor) {
  const { cookie, deviceId: id } = sessionFor(env.ctx, env.users[actor]);
  const clock = createHlc(id);
  const d = {
    id,
    cursor: null,
    headers: { 'content-type': 'application/json', cookie, origin: env.base },
    step(op, entity, recordId, fields) {
      return { key: newId(), entity, recordId, op, ...(fields ? { fields } : {}), hlc: clock.now(), ...(d.cursor ? { seen: d.cursor } : {}) };
    },
    async one(step) {
      const res = await fetch(`${env.base}/api/sync/push`, { method: 'POST', headers: d.headers, body: JSON.stringify({ steps: [step] }) });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      clock.receive(body.hlc);
      return body.results[0];
    },
    async create(entity, fields, recordId = newId()) {
      const r = await d.one(d.step('create', entity, recordId, fields));
      assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
      return recordId;
    },
    async pull() {
      const out = new Map();
      for (;;) {
        const res = await fetch(`${env.base}/api/sync/pull?${new URLSearchParams(d.cursor ? { since: d.cursor } : {})}`, { headers: d.headers });
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

const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const n = (db, sql, ...args) => db.prepare(sql).get(...args).n;

test('the planner registers task and inbox_item with sync: fields, refs, ops; columns match the field types', async (t) => {
  const { ctx, db } = await setup(t);
  const info = ctx.services.sync.info();
  const mine = info.entities.filter((e) => e.module === 'planner');
  assert.deepEqual(mine.map((e) => e.entity), [...PLANNER_ENTITY_NAMES]);
  const by = Object.fromEntries(mine.map((e) => [e.entity, e]));
  assert.deepEqual(by.task.ops, ['create', 'update', 'delete']);
  assert.deepEqual(by.inbox_item.ops, ['create', 'update', 'delete']);
  assert.deepEqual(by.task.fields.owner, { type: 'enum', required: true, values: ['owner', 'partner', 'shared'] });
  assert.deepEqual(by.task.fields.business_id, { type: 'id', required: true, ref: 'business', parent: true }, 'a task belongs to one of our businesses');
  for (const f of ['client_id', 'account_id', 'relationship_id']) {
    assert.equal(by.task.fields[f].parent, undefined, `${f} is a plain ref: deleting a client must not hide the person's tasks`);
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(by.task.fields).filter(([, f]) => f.ref).map(([k, f]) => [k, f.ref])),
    { business_id: 'business', client_id: 'client', account_id: 'account', relationship_id: 'relationship' },
  );
  assert.deepEqual(by.task.fields.due_date, { type: 'date' });
  assert.deepEqual(by.task.fields.due_time, { type: 'text', max: 5 });
  assert.deepEqual(by.task.fields.estimate_minutes, { type: 'integer' });
  assert.deepEqual(by.task.fields.done_at, { type: 'datetime' });
  assert.deepEqual(by.task.fields.top_on, { type: 'date' });
  assert.deepEqual(by.inbox_item.fields.source.values, ['typed', 'phone', 'siri', 'share']);
  assert.deepEqual(by.inbox_item.fields.captured_at, { type: 'datetime', required: true });
  assert.deepEqual(by.inbox_item.fields.became_id, { type: 'id' }, 'no ref: what it became may be deleted later');
  // Column types (registration refuses a mismatch; this documents the table).
  const types = (table) => Object.fromEntries(db.prepare('SELECT name, type FROM pragma_table_info(?)').all(table).map((c) => [c.name, c.type]));
  const task = types('planner_tasks');
  assert.deepEqual([task.estimate_minutes, task.flagged, task.due_date, task.due_time, task.done_at], ['INTEGER', 'INTEGER', 'TEXT', 'TEXT', 'TEXT']);
  assert.ok(PLANNER_ENTITIES.every((e) => e.table.startsWith('planner_')));
});

test('the planner needs the CRM: registered without it, the server refuses to start', async (t) => {
  const config = testConfig(tmpDir(t));
  const db = openDb(config.dbPath);
  t.after(() => db.close());
  const noCrm = modules.filter((m) => m.name !== 'crm');
  await assert.rejects(createApp({ config, db, log: quietLog, modules: noCrm }), /planner needs the crm module/);
});

test('tasks and inbox items are created, changed, finished and deleted through device steps, with who and when', async (t) => {
  const env = await setup(t);
  const { db } = env;
  const mac = makeDevice(env, 'owner');
  const phone = makeDevice(env, 'partner');
  const client = await mac.create('client', { name: 'Northwind Holdings', status: 'active' });
  const account = await mac.create('account', { client_id: client, name: 'Cloud Vape Co' });
  const rel = await mac.create('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });

  const item = await phone.create('inbox_item', { text: 'Ask about the Friday order', source: 'phone', captured_at: nowIso() });
  const task = await mac.create('task', {
    title: 'Ask about the Friday order', owner: 'owner', business_id: W, client_id: client, account_id: account,
    relationship_id: rel, due_date: '2026-10-09', due_time: '09:30', estimate_minutes: 15,
  });
  await mac.pull(); // it has seen the item (else its edit would clash with the item's creation)
  assert.equal((await mac.one(mac.step('update', 'inbox_item', item, { cleared_at: nowIso(), became_entity: 'task', became_id: task }))).status, 'applied');
  const saved = row(db, 'planner_tasks', task);
  assert.deepEqual([saved.owner, saved.due_time, saved.estimate_minutes, saved.created_by, saved.done_at], ['owner', '09:30', 15, 'owner', null]);
  assert.equal(row(db, 'planner_inbox_items', item).created_by, 'partner');
  assert.equal(row(db, 'planner_inbox_items', item).updated_by, 'owner');

  // Handoff: one field. Finishing: done_at. Undo: done_at back to null.
  assert.equal((await mac.one(mac.step('update', 'task', task, { owner: 'partner' }))).status, 'applied');
  await phone.pull();
  const done = nowIso();
  assert.equal((await phone.one(phone.step('update', 'task', task, { done_at: done }))).status, 'applied');
  assert.deepEqual([row(db, 'planner_tasks', task).owner, row(db, 'planner_tasks', task).done_at], ['partner', done]);
  assert.equal((await phone.one(phone.step('update', 'task', task, { done_at: null }))).status, 'applied');
  assert.equal(row(db, 'planner_tasks', task).done_at, null);

  // Pulled with who and when; deletes are soft.
  const pulled = (await mac.pull()).get(`task/${task}`);
  assert.equal(pulled.fields.relationship_id, rel);
  assert.equal(pulled.meta.createdBy, 'owner');
  assert.equal(pulled.meta.updatedBy, 'partner');
  assert.equal((await mac.one(mac.step('delete', 'task', task))).status, 'applied');
  assert.ok(row(db, 'planner_tasks', task).deleted_at);
});

test('the task checks: "HH:MM" times, a time needs a date, estimates 1 minute to a week', async (t) => {
  const env = await setup(t);
  const { db } = env;
  const d = makeDevice(env, 'owner');
  const base = { title: 'Water the plants', owner: 'shared', business_id: PERSONAL };
  const refused = async (step, pattern) => {
    const r = await d.one(step);
    assert.deepEqual([r.status, r.code], ['rejected', 'invalid_value'], JSON.stringify(r));
    assert.match(r.reason, pattern);
  };
  await refused(d.step('create', 'task', newId(), { ...base, due_date: '2026-10-09', due_time: '9:30' }), /HH:MM/);
  await refused(d.step('create', 'task', newId(), { ...base, due_date: '2026-10-09', due_time: '24:00' }), /HH:MM/);
  await refused(d.step('create', 'task', newId(), { ...base, due_time: '09:30' }), /needs a due date/);
  await refused(d.step('create', 'task', newId(), { ...base, estimate_minutes: 0 }), /estimate_minutes/);
  await refused(d.step('create', 'task', newId(), { ...base, estimate_minutes: ESTIMATE_MAX_MINUTES + 1 }), /estimate_minutes/);
  assert.equal(n(db, 'SELECT count(*) AS n FROM planner_tasks'), 0, 'nothing written');

  const id = await d.create('task', { ...base, due_date: '2026-10-09', due_time: '23:59', estimate_minutes: ESTIMATE_MAX_MINUTES });
  // An update that clears the date and sets a time in the same step contradicts itself.
  await refused(d.step('update', 'task', id, { due_date: null, due_time: '08:00' }), /needs a due date/);
  // Each field on its own is fine (the other device may change the other one): readers ignore a
  // time without a date, and the screens clear both together.
  assert.equal((await d.one(d.step('update', 'task', id, { due_time: '08:00' }))).status, 'applied');
  assert.equal((await d.one(d.step('update', 'task', id, { due_date: null, due_time: null }))).status, 'applied');
  assert.deepEqual([row(db, 'planner_tasks', id).due_date, row(db, 'planner_tasks', id).due_time], [null, null]);
  // The rule itself: only the step's own values (right in any arrival order).
  assert.equal(checkTask({ op: 'update', fields: { due_time: '10:00' }, current: { due_date: null } }), null);
  assert.equal(checkTask({ op: 'delete' }), null);
  assert.equal(checkTask({ op: 'create', fields: { due_date: '2026-10-09', due_time: null, estimate_minutes: null } }), null);
});

test('references: a task naming a record not here yet is not_found (retried later); a deleted client keeps its tasks', async (t) => {
  const env = await setup(t);
  const { db } = env;
  const mac = makeDevice(env, 'owner');
  const phone = makeDevice(env, 'partner');

  // The phone made a client and a task for it offline; the task arrives first (say, after a restore).
  const client = newId();
  const early = phone.step('create', 'task', newId(), { title: 'Send the Q4 plan', owner: 'owner', business_id: BUSINESS_IDS.agency, client_id: client });
  const r1 = await phone.one(early);
  assert.deepEqual([r1.status, r1.code], ['rejected', 'not_found']);
  assert.deepEqual(r1.missing, { field: 'client_id', entity: 'client', id: client }, 'names what it waits for');
  assert.equal(n(db, 'SELECT count(*) AS n FROM planner_tasks'), 0);
  await phone.create('client', { name: 'Green Leaf Holdings', status: 'active' }, client);
  assert.equal((await phone.one(early)).status, 'applied', 'the same step, retried unchanged, applies');

  // A business that isn't one of ours, an account and a relationship that don't exist: not_found too.
  const nope = await mac.one(mac.step('create', 'task', newId(), { title: 'x', owner: 'owner', business_id: newId() }));
  assert.deepEqual([nope.code, nope.missing.entity], ['not_found', 'business']);
  const noAcct = await mac.one(mac.step('create', 'task', newId(), { title: 'x', owner: 'owner', business_id: W, account_id: newId() }));
  assert.deepEqual([noAcct.code, noAcct.missing.field], ['not_found', 'account_id']);
  const noRel = await mac.one(mac.step('create', 'task', newId(), { title: 'x', owner: 'owner', business_id: W, relationship_id: newId() }));
  assert.deepEqual([noRel.code, noRel.missing.field], ['not_found', 'relationship_id']);

  // The client is deleted (a mistake): its task stays live, still naming it — shown as "deleted".
  await mac.pull();
  assert.equal((await mac.one(mac.step('delete', 'client', client))).status, 'applied');
  const task = row(db, 'planner_tasks', early.recordId);
  assert.deepEqual([task.deleted_at, task.client_id], [null, client]);
  // A plain ref may name a deleted record: a new task for it is accepted (it isn't what the task belongs to).
  await mac.pull();
  const later = await mac.one(mac.step('create', 'task', newId(), { title: 'Close out the file', owner: 'owner', business_id: W, client_id: client }));
  assert.equal(later.status, 'applied');
  const pulled = await phone.pull();
  assert.equal(pulled.get(`client/${client}`).deleted, true);
  assert.equal(pulled.get(`task/${early.recordId}`).deleted, false);
});

test('nothing writes around the sync steps: direct SQL on the planner tables fails', async (t) => {
  const { db, ctx } = await setup(t);
  const sync = ctx.services.sync;
  const task = sync.applyLocal({ entity: 'task', op: 'create', fields: { title: 'Renew the domain', owner: 'shared', business_id: PERSONAL } });
  const item = sync.applyLocal({ entity: 'inbox_item', op: 'create', fields: { text: 'Idea', source: 'typed', captured_at: nowIso() } });
  assert.deepEqual([task.status, item.status], ['applied', 'applied']);
  for (const table of PLANNER_ENTITIES.map((e) => e.table)) {
    assert.throws(() => db.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(newId()), /written only through the sync module/, table);
    assert.throws(() => db.prepare(`UPDATE ${table} SET deleted_at = 'x'`).run(), /written only through the sync module/, table);
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /written only through the sync module/, table);
  }
  assert.equal(row(db, 'planner_tasks', task.recordId).created_by, 'system');
  assert.equal(ctx.services.planner.openInboxCount(), 1);
});

test('automated tasks go to the business’s default owner; hand-made ones are the screens’ business', async (t) => {
  const { ctx } = await setup(t);
  const planner = ctx.services.planner;
  assert.equal(planner.automatedOwnerFor(W), 'owner');
  assert.equal(planner.automatedOwnerFor(BUSINESS_IDS.save_point), 'partner');
  assert.equal(planner.automatedOwnerFor(BUSINESS_IDS.retail), 'shared');
  assert.equal(planner.automatedOwnerFor(PERSONAL), 'shared');
  assert.equal(planner.automatedOwnerFor(newId()), 'shared', 'unknown business: the shared list');
  // Change a business's default: automated tasks follow it.
  assert.equal(ctx.services.sync.applyLocal({ actor: 'owner', entity: 'business', op: 'update', recordId: BUSINESS_IDS.retail, fields: { default_owner: 'partner' } }).status, 'applied');
  assert.equal(planner.automatedOwnerFor(BUSINESS_IDS.retail), 'partner');
  assert.equal(automatedTaskOwner({ default_owner: 'bogus' }), 'shared');
  assert.equal(automatedTaskOwner(null), 'shared');
});

test('two people change one task at once: a reassignment and a finish both apply; the same field clashes', async (t) => {
  const env = await setup(t);
  const { db } = env;
  const mac = makeDevice(env, 'owner');
  const phone = makeDevice(env, 'partner');
  const task = await mac.create('task', { title: 'Pack the Cloud Vape order', owner: 'owner', business_id: W, due_date: '2026-10-08' });
  await mac.pull();
  await phone.pull();
  assert.equal((await phone.one(phone.step('update', 'task', task, { done_at: nowIso() }))).status, 'applied');
  assert.equal((await mac.one(mac.step('update', 'task', task, { owner: 'partner', title: 'Pack the Cloud Vape order (40 tins)' }))).status, 'applied');
  const r = row(db, 'planner_tasks', task);
  assert.ok(r.done_at);
  assert.deepEqual([r.owner, r.title], ['partner', 'Pack the Cloud Vape order (40 tins)']);
  assert.equal(n(db, 'SELECT count(*) AS n FROM sync_clashes'), 0, 'different fields: nothing to review');
  // Both move the due date at once: the later stamp wins and the other value is kept for review.
  assert.equal((await phone.one(phone.step('update', 'task', task, { due_date: '2026-10-10' }))).status, 'applied');
  const clash = await mac.one(mac.step('update', 'task', task, { due_date: '2026-10-12' }));
  assert.equal(clash.status, 'clash');
  assert.equal(n(db, "SELECT count(*) AS n FROM sync_clashes WHERE field = 'due_date'"), 1);
});
