// Projects and playbooks (D9) on the server: the four record types and their checks (a run's copy of
// its steps is append-only), tasks naming their run, the automation that makes a repeating run's later
// months (once per run and month, a week ahead, from the run's own copy — editing the playbook changes
// only future runs; the offer rule checked again; nothing for stopped runs, closed clients or archived
// businesses), and a renewal date set by a run picked up by D6's reminders. The device side of running a
// playbook is in client/test/playbooks.test.js. Toronto time; invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { atLocal } from '../src/modules/automations/schedule.js';
import { MONTHS_ID } from '../src/modules/playbooks/automations.js';
import { SERVICE_RENEWALS_ID } from '../src/modules/costs/reminders.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;
const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};

async function setup(t, { config = testConfig(tmpDir(t)), clock = testClock() } = {}) {
  const env = await startApp(t, config, { modules, now: clock.now });
  await ensureTestUsers(env.ctx);
  const { sync, automations: autos } = env.ctx.services;
  for (const a of autos.list()) {
    if (a.trigger.type === 'schedule') autos.setSettings(a.id, { enabled: [MONTHS_ID, SERVICE_RENEWALS_ID].includes(a.id) }, { actor: 'owner' });
  }
  const apply = (entity, op, fields, recordId, actor = 'owner') => {
    const r = sync.applyLocal({ actor, entity, op, recordId, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
    return r.recordId;
  };
  const local = (entity, fields) => apply(entity, 'create', fields);
  const edit = (entity, id, fields) => apply(entity, 'update', fields, id);
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY due_date, title`).all(...args);
  const tick = (id) => autos.tick().filter((r) => r.automation === id);
  const client = (name, kinds = ['website']) => {
    const clientId = local('client', { name, status: 'active' });
    const accountId = local('account', { client_id: clientId, name });
    const rels = kinds.map((kind) => local('relationship', { account_id: accountId, business_id: AGENCY, kind, status: 'active' }));
    return { clientId, accountId, relId: rels[0] };
  };
  /** A retainer playbook (two task steps + an offer) and a run of it, as a device makes them (the run's copy of each step). */
  const retainer = ({ clientIds, start = '2026-10-15', end = null }) => {
    const pb = local('playbook', { name: 'Content retainer', business_id: AGENCY, repeat: 'monthly', for_client: true, kind: 'social' });
    const steps = [
      { position: 1, title: 'Plan the posts', stage: 'Plan', offset_amount: 0, owner: 'runner', estimate_minutes: 60 },
      { position: 2, title: 'Content due', stage: 'Create', offset_amount: 7, owner: 'shared', links: 'Brand guide https://example.com/brand' },
      { position: 3, title: 'Offer a website', stage: 'Grow', offset_amount: 20, only_if_lacks_business: AGENCY, only_if_lacks_kind: 'website' },
    ];
    const stepIds = steps.map((s) => local('playbook_step', { playbook_id: pb, ...s }));
    const run = local('playbook_run', {
      playbook_id: pb, name: 'Content retainer — Lefty’s', business_id: AGENCY, repeat: 'monthly', client_id: clientIds.clientId,
      account_id: clientIds.accountId, relationship_id: clientIds.relId, start_date: start, end_date: end, runner: 'partner', status: 'active',
      playbook_name: 'Content retainer',
    });
    // The first month (the device's) left the offer out — they had a website then, say — so a later month may make it, once.
    const runSteps = steps.map((s, i) => local('run_step', { run_id: run, step_id: stepIds[i], ...s, outcome: s.only_if_lacks_kind ? 'skipped' : 'task' }));
    return { pb, stepIds, run, runSteps };
  };
  return { ...env, clock, sync, autos, apply, local, edit, setNow, tasks, tick, client, retainer };
}

test('the record types: checks, the run’s copy is append-only, tasks name their run, only through sync', async (t) => {
  const env = await setup(t);
  const c = env.client('Lefty’s');
  const pb = env.local('playbook', { name: 'Website launch', business_id: AGENCY, for_client: true, kind: 'website' });
  const bad = (entity, fields) => env.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
  assert.equal(bad('playbook_step', { playbook_id: pb, title: 'x', offset_amount: 3651 }).code, 'invalid_value', 'more than ten years of days');
  assert.equal(bad('playbook_step', { playbook_id: pb, title: 'x', offset_amount: 11, offset_unit: 'years' }).code, 'invalid_value');
  assert.equal(bad('playbook_step', { playbook_id: pb, title: 'x', offset_amount: -10, offset_unit: 'years' }).status, 'applied', 'before the start is fine');
  assert.equal(bad('playbook_step', { playbook_id: pb, title: 'x', estimate_minutes: 0 }).code, 'invalid_value');
  assert.equal(bad('playbook_step', { playbook_id: pb, title: 'x', service_amount_cents: -1 }).code, 'invalid_value');
  assert.equal(bad('playbook_step', { playbook_id: pb, title: 'x', owner: 'boss' }).code, 'invalid_value');
  const step = env.local('playbook_step', { playbook_id: pb, title: 'Go live', offset_amount: 2, offset_unit: 'months' });
  assert.equal(env.sync.applyLocal({ actor: 'owner', entity: 'playbook_step', op: 'update', recordId: step, fields: { offset_amount: 121 } }).code, 'invalid_value',
    'the stored unit (months) decides the limit');
  assert.equal(bad('playbook_run', { name: 'r', business_id: AGENCY, start_date: '2026-10-12', end_date: '2026-10-11', runner: 'owner' }).code, 'invalid_value');
  assert.equal(bad('playbook_run', { name: 'r', business_id: AGENCY, start_date: '2026-10-12' }).status, 'rejected', 'who ran it is required');
  const run = env.local('playbook_run', { playbook_id: pb, name: 'Website launch — Lefty’s', business_id: AGENCY, client_id: c.clientId, start_date: '2026-10-12', runner: 'owner' });
  const rs = env.local('run_step', { run_id: run, step_id: step, title: 'Go live', position: 1, outcome: 'task' });
  assert.equal(env.sync.applyLocal({ actor: 'owner', entity: 'run_step', op: 'update', recordId: rs, fields: { title: 'Changed' } }).code, 'op_not_allowed',
    'a run’s copy of a step never changes');
  const task = env.local('task', { title: 'Go live', owner: 'owner', business_id: AGENCY, due_date: '2026-10-12', run_id: run, run_step_id: rs });
  assert.deepEqual(env.db.prepare('SELECT run_id, run_step_id FROM planner_tasks WHERE id = ?').get(task), { run_id: run, run_step_id: rs });
  assert.throws(() => env.db.prepare("UPDATE playbooks_runs SET name = 'x' WHERE id = ?").run(run), /sync/i, 'direct writes are refused');
  // Deleting the playbook hides nothing of the run (plain ref).
  env.apply('playbook', 'delete', null, pb);
  assert.equal(env.ctx.services.playbooks.run(run).name, 'Website launch — Lefty’s');
  assert.equal(env.ctx.services.playbooks.runSteps(run).length, 1);
  const info = env.sync.info().entities.map((e) => e.entity);
  for (const e of ['playbook', 'playbook_step', 'playbook_run', 'run_step']) assert.ok(info.includes(e), e);
});

test('a repeating run: each later month once, a week ahead, from the run’s own copy; offers checked each month', async (t) => {
  const env = await setup(t);
  const c = env.client('Lefty’s', ['social']);
  const r = env.retainer({ clientIds: c, start: '2026-10-15' });
  // Month 0 (October) is the device's. Nothing for November before Nov 8.
  env.setNow(at('2026-11-07 09:00'));
  let runs = env.tick(MONTHS_ID);
  assert.equal(runs.length, 1);
  assert.equal(env.tasks('run_id = ?', r.run).length, 0, 'not yet');
  env.setNow(at('2026-11-08 09:00'));
  runs = env.tick(MONTHS_ID);
  const nov = env.tasks('run_id = ?', r.run);
  assert.deepEqual(nov.map((x) => [x.title, x.due_date, x.owner]), [
    ['Plan the posts · November 2026', '2026-11-15', 'partner'],
    ['Content due · November 2026', '2026-11-22', 'shared'],
    ['Offer a website · November 2026', '2026-12-05', 'partner'],
  ], 'whoever ran it (partner) and the shared list, as the steps say');
  assert.ok(nov.every((x) => x.client_id === c.clientId && x.account_id === c.accountId && x.relationship_id === c.relId && x.business_id === AGENCY));
  assert.deepEqual(nov.map((x) => x.run_step_id), r.runSteps);
  assert.match(nov[1].notes, /Files and links:\n- Brand guide: https:\/\/example\.com\/brand/);
  assert.match(nov[2].notes, /Email them about it only if Great White North Design has their email consent/, 'an offer says whose consent counts');
  assert.match(runs[0].summary, /Made 3 tasks for Content retainer — Lefty’s \(November 2026\)/);

  // Again the same day, Run now, the next day: never twice.
  env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  env.setNow(at('2026-11-09 09:00'));
  env.tick(MONTHS_ID);
  assert.equal(env.tasks('run_id = ?', r.run).length, 3);

  // Editing the playbook changes only future runs: December still comes from the run's copy.
  env.edit('playbook_step', r.stepIds[1], { title: 'Content due for approval (new wording)', offset_amount: 9 });
  env.apply('playbook_step', 'delete', null, r.stepIds[0]);
  // The playbook is renamed: later months' notes keep the name the run started with.
  env.edit('playbook', r.pb, { name: 'Renamed retainer' });
  env.setNow(at('2026-12-08 09:00'));
  runs = env.tick(MONTHS_ID);
  const dec = env.tasks("run_id = ? AND title LIKE '%December 2026'", r.run);
  assert.deepEqual(dec.map((x) => [x.title, x.due_date]), [['Plan the posts · December 2026', '2026-12-15'], ['Content due · December 2026', '2026-12-22']],
    'the offer is made once per run: not again in December');
  assert.match(dec[0].notes, /From the playbook “Content retainer”/);
});

test('no new months for a stopped run, a closed client, an archived business, after the end date; a restart makes nothing twice', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const env = await setup(t, { config, clock });
  const a = env.client('Alpha', ['social']);
  const b = env.client('Bravo', ['social']);
  const ra = env.retainer({ clientIds: a, start: '2026-10-15' });
  const rb = env.retainer({ clientIds: b, start: '2026-10-15', end: '2026-11-30' });
  env.edit('playbook_run', ra.run, { status: 'stopped' });
  env.setNow(at('2026-11-08 09:00'));
  env.tick(MONTHS_ID);
  assert.equal(env.tasks('run_id = ?', ra.run).length, 0, 'stopped');
  assert.equal(env.tasks('run_id = ?', rb.run).length, 3, 'November is before the end date');
  env.setNow(at('2026-12-08 09:00'));
  env.tick(MONTHS_ID);
  assert.equal(env.tasks('run_id = ?', rb.run).length, 3, 'December starts after the end date');

  env.edit('playbook_run', ra.run, { status: 'active' });
  env.edit('client', a.clientId, { status: 'closed' });
  const closed = env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.equal(env.tasks('run_id = ?', ra.run).length, 0);
  assert.match(closed.summary, /waiting: Content retainer — Lefty’s — its client is closed/);
  env.edit('client', a.clientId, { status: 'active' });
  env.edit('business', AGENCY, { archived: true });
  env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.equal(env.tasks('run_id = ?', ra.run).length, 0, 'archived business');
  env.edit('business', AGENCY, { archived: false });
  env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.deepEqual(env.tasks('run_id = ?', ra.run).map((x) => x.title).sort(), [
    'Content due · December 2026', 'Content due · November 2026', 'Offer a website · November 2026',
    'Plan the posts · December 2026', 'Plan the posts · November 2026',
  ], 'once everything is back: November (it runs to Dec 14, so it isn’t over) and December (a week ahead); the offer once');

  // A restart on the same database: nothing again.
  await env.close();
  const again = await startApp(t, config, { modules, now: clock.now });
  again.ctx.services.automations.runNow(MONTHS_ID, { actor: 'owner' });
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE deleted_at IS NULL AND run_id = ?').get(ra.run).n, 5);
});

test('a renewal date a run set on the client’s service gets D6’s reminder 30 days before', async (t) => {
  const env = await setup(t);
  const c = env.client('Lefty’s');
  // As the device's website-launch run writes it: Hosting renewing a year after the launch.
  env.local('service', { relationship_id: c.relId, name: 'Hosting', status: 'active', period: 'yearly', start_date: '2026-10-12', renewal_date: '2027-10-12' });
  env.setNow(at('2027-09-12 09:00'));
  env.tick(SERVICE_RENEWALS_ID);
  const [reminder] = env.tasks("title LIKE 'Renewal in 30 days%'");
  assert.equal(reminder.title, 'Renewal in 30 days: Hosting for Lefty’s (Great White North Design)');
  assert.equal(reminder.due_date, '2027-09-12');
});

test('the service without the CRM: nothing registered (the sync engine’s own tests)', async (t) => {
  const env = await startApp(t, testConfig(tmpDir(t)), { modules: modules.filter((m) => !['automations', 'crm', 'planner', 'wholesale', 'calendar', 'costs', 'stockroom'].includes(m.name)) });
  assert.equal(env.ctx.services.playbooks.enabled, false);
  assert.ok(!env.ctx.services.sync.info().entities.some((e) => e.entity === 'playbook'));
});

test('review fixes: a retainer waits while its relationship is paused, ended or deleted; an offer the first month made never repeats', async (t) => {
  const env = await setup(t);
  const c = env.client('Lefty’s', ['social']);
  const r = env.retainer({ clientIds: c, start: '2026-10-15' });
  env.edit('relationship', c.relId, { status: 'paused' });
  env.setNow(at('2026-11-08 09:00'));
  let out = env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.match(out.summary, /its relationship is paused/);
  env.edit('relationship', c.relId, { status: 'ended' });
  out = env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.match(out.summary, /its relationship is ended/);
  assert.equal(env.tasks('run_id = ?', r.run).length, 0);
  env.apply('relationship', 'delete', null, c.relId);
  out = env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.match(out.summary, /its relationship was deleted/);
  assert.equal(env.tasks('run_id = ?', r.run).length, 0, 'never carried on with no relationship');

  // A second client whose first month made the offer: later months never make it again.
  const b = env.client('Bravo', ['social']);
  const rb = env.retainer({ clientIds: b, start: '2026-10-15' });
  const offerCopy = env.ctx.services.playbooks.runSteps(rb.run).find((x) => x.only_if_lacks_kind);
  assert.equal(offerCopy.outcome, 'skipped');
  const rc = env.local('playbook_run', { name: 'Charlie', business_id: AGENCY, repeat: 'monthly', client_id: b.clientId, account_id: b.accountId, relationship_id: b.relId, start_date: '2026-10-15', runner: 'owner' });
  env.local('run_step', { run_id: rc, title: 'Offer a website', position: 1, only_if_lacks_business: AGENCY, only_if_lacks_kind: 'website', outcome: 'task' });
  env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.equal(env.tasks('run_id = ?', rc).length, 0, 'made in the first month: not again');
  assert.equal(env.tasks("run_id = ? AND title LIKE 'Offer%'", rb.run).length, 1, 'the other run’s offer, once');
});

test('review fixes: the offset limit is checked when only the unit changes; a run not finished saving makes no months', async (t) => {
  const env = await setup(t);
  const pb = env.local('playbook', { name: 'P', business_id: AGENCY });
  const step = env.local('playbook_step', { playbook_id: pb, title: 'Far', offset_amount: 100, offset_unit: 'days' });
  const r = env.sync.applyLocal({ actor: 'owner', entity: 'playbook_step', op: 'update', recordId: step, fields: { offset_unit: 'years' } });
  assert.equal(r.code, 'invalid_value', '100 years is too far');
  assert.equal(env.sync.applyLocal({ actor: 'owner', entity: 'playbook_step', op: 'update', recordId: step, fields: { offset_unit: 'weeks' } }).status, 'applied');
  const c = env.client('Delta', ['social']);
  const run = env.retainer({ clientIds: c, start: '2026-10-15' }).run;
  env.edit('playbook_run', run, { status: 'starting' });
  env.setNow(at('2026-11-08 09:00'));
  env.autos.runNow(MONTHS_ID, { actor: 'owner' });
  assert.equal(env.tasks('run_id = ?', run).length, 0);
});
