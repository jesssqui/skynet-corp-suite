// Automations (C8): triggers and periods (DST weeks), the minute scheduler (once per period,
// catch-up once after downtime, two servers on one database, failures retried), switches, Run now,
// events, alerts only for "alert" automations, and the planner's two automations — the Friday
// review list and relationships with no next step. The server's local time zone is Toronto's.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { checkTrigger, triggerText, clockText, isoWeekKey, periodOf, atLocal } from '../src/modules/automations/schedule.js';
import { RETRY_MS } from '../src/modules/automations/service.js';
import { relationshipsToChase } from '../src/modules/planner/automations.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, testClock } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const AGENCY = BUSINESS_IDS.agency;
const SPS = BUSINESS_IDS.save_point;
const PERSONAL = BUSINESS_IDS.personal;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Local time in Toronto as ms ("2026-10-16 08:00"). */
const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};
const local = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function setup(t, { config = testConfig(tmpDir(t)), clock = testClock() } = {}) {
  const env = await startApp(t, config, { modules, now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const sync = env.ctx.services.sync;
  const make = (entity, fields, { actor = 'owner', stampMs } = {}) => {
    const r = sync.applyLocal({ actor, entity, op: 'create', fields, ...(stampMs !== undefined ? { stampMs } : {}) });
    assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
    return r.recordId;
  };
  const update = (entity, id, fields, actor = 'owner') => {
    const r = sync.applyLocal({ actor, entity, op: 'update', recordId: id, fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
  };
  const remove = (entity, id) => assert.equal(sync.applyLocal({ actor: 'owner', entity, op: 'delete', recordId: id }).status, 'applied');
  const call = async (method, url, body, { session = owner } = {}) => {
    const res = await fetch(`${env.base}${url}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie } : {}), origin: env.base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  const autos = env.ctx.services.automations;
  return { ...env, config, clock, users, owner, sync, make, update, remove, call, setNow, autos };
}

const tasks = (db, where = '1', ...args) => db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
const alerts = (db) => db.prepare('SELECT * FROM automations_alerts ORDER BY at, id').all();
const okRuns = (db, id) => db.prepare("SELECT * FROM automations_runs WHERE automation_id = ? AND status = 'ok' ORDER BY started_at, id").all(id);

/** A test automation that only records when it ran (and can be told to fail or to create a task). */
function probe(autos, id, trigger, { fail = () => false, createTask = false, enabled = true } = {}) {
  const calls = [];
  autos.register({
    id, name: id, module: 'test', description: 'test probe', trigger, defaults: { enabled },
    run(_ctx, { nowMs, period, create }) {
      calls.push({ at: nowMs, key: period?.key });
      if (createTask) create('task', { title: `${id} ${period.key}`, owner: 'shared', business_id: PERSONAL }, { key: period.key });
      if (fail()) throw new Error('the probe failed on purpose');
      return { summary: 'probed' };
    },
  });
  return calls;
}

function offBuiltIns(autos) {
  for (const id of ['friday-review', 'no-next-step']) autos.setSettings(id, { enabled: false }, { actor: 'owner' });
}

// ---- triggers and periods -------------------------------------------------------------------------

test('triggers: checked, in plain English; periods and ISO weeks; 8:00 stays 8:00 across daylight-saving changes', () => {
  assert.equal(triggerText(checkTrigger({ type: 'schedule', every: 'week', day: 'fri', at: '08:00' })), 'Every Friday at 8:00 a.m.');
  assert.equal(triggerText(checkTrigger({ type: 'schedule', every: 'day', at: '07:30' })), 'Every day at 7:30 a.m.');
  assert.equal(triggerText(checkTrigger({ type: 'event', event: 'order.placed' })), 'When order.placed happens');
  assert.deepEqual(['00:15', '12:00', '13:05', '23:59'].map(clockText), ['12:15 a.m.', '12:00 p.m.', '1:05 p.m.', '11:59 p.m.']);
  for (const bad of [{}, { type: 'schedule', every: 'day', at: '7:30' }, { type: 'schedule', every: 'week', day: 'friday', at: '08:00' },
    { type: 'schedule', every: 'month', at: '08:00' }, { type: 'event', event: 'Order Placed' }, { type: 'cron' }]) {
    assert.throws(() => checkTrigger(bad), Error, JSON.stringify(bad));
  }
  assert.deepEqual(['2026-10-05', '2026-10-11', '2026-12-28', '2027-01-03', '2025-12-29', '2026-01-04'].map(isoWeekKey),
    ['2026-W41', '2026-W41', '2026-W53', '2026-W53', '2026-W01', '2026-W01']);

  const fri = { type: 'schedule', every: 'week', day: 'fri', at: '08:00' };
  // Fall back (Sun Nov 1 2026): Fri Oct 30 8:00 EDT = 12:00Z, Fri Nov 6 8:00 EST = 13:00Z.
  const oct = periodOf(fri, new Date(at('2026-10-28 12:00')));
  assert.deepEqual([oct.key, oct.start, oct.day], ['2026-W44', '2026-10-26', '2026-10-30']);
  assert.equal(oct.dueAt.toISOString(), '2026-10-30T12:00:00.000Z');
  assert.equal(oct.nextDueAt.toISOString(), '2026-11-06T13:00:00.000Z', '7 days and 1 hour later: still 8:00 a.m.');
  // Spring forward (Sun Mar 8 2026): 7 days less an hour.
  const mar = periodOf(fri, new Date(at('2026-03-06 09:00')));
  assert.equal(mar.nextDueAt - mar.dueAt, 7 * DAY - 60 * MIN);
  assert.equal(local(mar.nextDueAt.getTime()), '2026-03-13 08:00');
  // A Sunday belongs to the week that started on Monday.
  assert.equal(periodOf(fri, new Date(at('2026-10-11 23:59'))).key, '2026-W41');
  const day = periodOf({ type: 'schedule', every: 'day', at: '07:30' }, new Date(at('2026-10-31 12:00')));
  assert.equal(day.nextDueAt - day.dueAt, DAY + 60 * MIN, 'Oct 31 7:30 EDT to Nov 1 7:30 EST is 25 hours');
  assert.equal(local(day.nextDueAt.getTime()), '2026-11-01 07:30');
});

// ---- the scheduler -------------------------------------------------------------------------------

test('the scheduler runs each period once, at the local time, through daylight-saving weeks (clock moved by the test)', async (t) => {
  const env = await setup(t);
  offBuiltIns(env.autos);
  const daily = probe(env.autos, 'probe-daily', { type: 'schedule', every: 'day', at: '07:30' });
  const weekly = probe(env.autos, 'probe-weekly', { type: 'schedule', every: 'week', day: 'fri', at: '08:00' });
  const gap = probe(env.autos, 'probe-gap', { type: 'schedule', every: 'day', at: '02:30' }); // 2:30 doesn't exist on Mar 8

  // A look every 10 minutes from Fri Oct 30 to Tue Nov 10 (clocks go back on Sun Nov 1).
  for (let ms = at('2026-10-30 00:00'); ms < at('2026-11-10 00:00'); ms += 10 * MIN) {
    env.setNow(ms);
    env.autos.tick();
  }
  assert.deepEqual(daily.map((c) => local(c.at)), Array.from({ length: 11 }, (_, i) => {
    const d = new Date(2026, 9, 30 + i);
    return `${local(d.getTime()).slice(0, 10)} 07:30`;
  }), 'every day once, at 7:30 local, the day the clocks change included');
  assert.deepEqual(weekly.map((c) => [local(c.at), c.key]), [['2026-10-30 08:00', '2026-W44'], ['2026-11-06 08:00', '2026-W45']]);
  assert.deepEqual(weekly.map((c) => new Date(c.at).getUTCHours()), [12, 13], 'the same local time on both sides of the change');
  assert.equal(gap.length, 11);
  // The page's "last ran" is the clock's time.
  assert.equal(env.autos.get('probe-daily').lastRun.startedAt, new Date(at('2026-11-09 07:30')).toISOString());

  // Spring forward: a time that doesn't exist that night still runs once that day (at 3:30 EDT).
  gap.length = 0;
  for (let ms = at('2026-03-07 00:00'); ms < at('2026-03-10 00:00'); ms += 10 * MIN) {
    env.setNow(ms);
    env.autos.tick();
  }
  assert.deepEqual(gap.map((c) => local(c.at)), ['2026-03-07 02:30', '2026-03-08 03:30', '2026-03-09 02:30']);
});

test('after downtime, the current period is caught up once — not once per missed tick, and missed periods are not replayed', async (t) => {
  const env = await setup(t);
  offBuiltIns(env.autos);
  const daily = probe(env.autos, 'probe-daily', { type: 'schedule', every: 'day', at: '07:30' });
  const weekly = probe(env.autos, 'probe-weekly', { type: 'schedule', every: 'week', day: 'fri', at: '08:00' });
  env.setNow(at('2026-10-08 07:00'));
  env.autos.tick();
  assert.equal(daily.length + weekly.length, 0, 'not yet 7:30');
  assert.equal(env.autos.get('probe-weekly').nextRunAt, new Date(at('2026-10-09 08:00')).toISOString());

  // Down from Thursday 7:00 until Saturday noon: Friday's run and two 7:30s were missed.
  env.setNow(at('2026-10-10 12:00'));
  env.autos.tick();
  assert.deepEqual(weekly.map((c) => c.key), ['2026-W41'], 'the week, once');
  assert.deepEqual(daily.map((c) => c.key), ['2026-10-10'], 'today, once (Thursday and Friday are not replayed)');
  for (const s of ['2026-10-10 12:01', '2026-10-10 18:00', '2026-10-11 09:00']) {
    env.setNow(at(s));
    env.autos.tick();
  }
  assert.deepEqual(weekly.map((c) => c.key), ['2026-W41']);
  assert.deepEqual(daily.map((c) => c.key), ['2026-10-10', '2026-10-11']);

  // Down for ten days, Friday Oct 16 included: only the current week and day are considered.
  env.setNow(at('2026-10-21 10:00'));
  env.autos.tick();
  assert.deepEqual(weekly.map((c) => c.key), ['2026-W41'], 'W42 is not replayed; W43 is not due until Friday');
  assert.deepEqual(daily.map((c) => c.key), ['2026-10-10', '2026-10-11', '2026-10-21']);
  assert.equal(env.autos.get('probe-daily').nextRunAt, new Date(at('2026-10-22 07:30')).toISOString());
});

test('two servers on one database, and a restart, never run a period twice', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const a = await setup(t, { config, clock });
  const b = await setup(t, { config, clock });
  a.setNow(at('2026-10-16 08:05'));
  const ra = a.autos.tick();
  const rb = b.autos.tick();
  assert.deepEqual(ra.map((r) => r.automation).sort(), ['friday-review', 'no-next-step']);
  assert.deepEqual(rb, [], 'the second server finds the periods done');
  assert.equal(tasks(a.db, 'title = ?', 'Friday review').length, 1);
  await a.close();
  await b.close();
  const c = await setup(t, { config, clock });
  assert.deepEqual(c.autos.tick(), [], 'nor after a restart');
  assert.equal(okRuns(c.db, 'friday-review').length, 1);
  assert.equal(okRuns(c.db, 'friday-review')[0].run_key, 'friday-review:2026-W42');
  // The run key is unique in the table too (a second insert is refused by SQLite itself).
  assert.throws(() => c.db.prepare(`INSERT INTO automations_runs (id, automation_id, trigger, run_key, started_at, finished_at, status)
    VALUES ('x', 'friday-review', 'schedule', 'friday-review:2026-W42', 'a', 'b', 'ok')`).run(), /UNIQUE/);
});

test('a failed run changes nothing, is shown, and is retried no sooner than 15 minutes later', async (t) => {
  const env = await setup(t);
  offBuiltIns(env.autos);
  let failing = true;
  const calls = probe(env.autos, 'probe-fail', { type: 'schedule', every: 'day', at: '07:30' }, { fail: () => failing, createTask: true });
  env.setNow(at('2026-10-14 07:30'));
  const [run] = env.autos.tick();
  assert.equal(run.status, 'error');
  assert.match(run.error, /failed on purpose/);
  assert.equal(tasks(env.db, "title LIKE 'probe-fail%'").length, 0, 'the task it made was rolled back');
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM automations_made').get().n, 0);
  const view = env.autos.get('probe-fail');
  assert.equal(view.lastRun.status, 'error');
  assert.equal(view.nextRunAt, new Date(at('2026-10-14 07:30') + RETRY_MS).toISOString());
  env.setNow(at('2026-10-14 07:40'));
  assert.deepEqual(env.autos.tick(), []);
  failing = false;
  env.setNow(at('2026-10-14 07:45'));
  const [again] = env.autos.tick();
  assert.equal(again.status, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(tasks(env.db, "title LIKE 'probe-fail%'").length, 1);
  env.setNow(at('2026-10-14 09:00'));
  assert.deepEqual(env.autos.tick(), [], 'done for the day');
});

test('switches: off skips the scheduler but Run now still works; who changed it is kept; the API checks its input', async (t) => {
  const env = await setup(t);
  offBuiltIns(env.autos);
  const calls = probe(env.autos, 'probe-off', { type: 'schedule', every: 'day', at: '07:30' }, { createTask: true });
  const put = await env.call('PUT', '/api/automations/probe-off', { enabled: false });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.automation.enabled, put.body.automation.nextRunAt, put.body.automation.changedBy], [false, null, 'owner']);
  env.setNow(at('2026-10-14 08:00'));
  assert.deepEqual(env.autos.tick(), []);
  assert.equal(calls.length, 0);
  const run = await env.call('POST', '/api/automations/probe-off/run', {});
  assert.equal(run.status, 200);
  assert.deepEqual([run.body.run.status, run.body.run.trigger, run.body.run.actor, run.body.run.createdCount], ['ok', 'manual', 'owner', 1]);
  assert.equal(run.body.run.periodKey, '2026-10-14');
  assert.equal(run.body.automation.lastRun.id, run.body.run.id);
  const changes = env.db.prepare("SELECT field, value, actor, device_id FROM automations_changes WHERE automation_id = 'probe-off'").all();
  assert.deepEqual(changes.map((c) => [c.field, c.value, c.actor]), [['enabled', 0, 'owner']]);
  assert.ok(changes[0].device_id);

  assert.equal((await env.call('PUT', '/api/automations/probe-off', { enabled: 'no' })).status, 400);
  assert.equal((await env.call('PUT', '/api/automations/probe-off', { colour: 'red' })).status, 400);
  assert.equal((await env.call('PUT', '/api/automations/nope', { enabled: true })).status, 404);
  assert.equal((await env.call('POST', '/api/automations/nope/run', {})).status, 404);
  assert.equal((await env.call('GET', '/api/automations', undefined, { session: null })).status, 401);
  assert.equal((await env.call('POST', '/api/automations/probe-off/run', {}, { session: null })).status, 401);
  const list = await env.call('GET', '/api/automations');
  assert.deepEqual(list.body.automations.map((a) => a.id), ['friday-review', 'no-next-step', 'probe-off']);
  assert.equal(list.body.timeZone, 'America/Toronto');
});

test('events (for the D packages): one run per event key, none while switched off', async (t) => {
  const env = await setup(t);
  const seen = [];
  env.autos.register({
    id: 'probe-event', name: 'probe', module: 'test', description: 'test',
    trigger: { type: 'event', event: 'demo.happened', key: (d) => d.id },
    run(_ctx, { data }) { seen.push(data.id); return { summary: 'ok' }; },
  });
  assert.equal(env.autos.get('probe-event').when, 'When demo.happened happens');
  assert.equal(env.autos.get('probe-event').nextRunAt, null);
  assert.equal(env.autos.emit('demo.happened', { id: 'o-1' }).length, 1);
  assert.equal(env.autos.emit('demo.happened', { id: 'o-1' }).length, 0, 'the same event again is a no-op');
  assert.equal(env.autos.emit('demo.happened', { id: 'o-2' }).length, 1);
  assert.equal(env.autos.emit('other.thing', { id: 'o-3' }).length, 0);
  env.autos.setSettings('probe-event', { enabled: false }, { actor: 'partner' });
  assert.equal(env.autos.emit('demo.happened', { id: 'o-4' }).length, 0);
  assert.deepEqual(seen, ['o-1', 'o-2']);
});

// ---- the Friday review list ------------------------------------------------------------------------

test('Friday review: once a week, on the shared list under Personal, due Friday, with the review’s numbers and an alert', async (t) => {
  const env = await setup(t);
  const { make, update, remove, db } = env;
  // The week of Mon Oct 12 2026; "today" for the numbers is Fri Oct 16.
  const old = at('2026-07-01 10:00'); // made long ago (stamp in the past)
  // Overdue: two open (one each), one done, one deleted, one due today (not overdue).
  make('task', { title: 'Overdue mine', owner: 'owner', business_id: PERSONAL, due_date: '2026-10-12' });
  make('task', { title: 'Overdue partner', owner: 'partner', business_id: SPS, due_date: '2026-10-01' }, { actor: 'partner' });
  const done = make('task', { title: 'Done', owner: 'owner', business_id: PERSONAL, due_date: '2026-10-10' });
  update('task', done, { done_at: new Date().toISOString() });
  remove('task', make('task', { title: 'Deleted', owner: 'owner', business_id: PERSONAL, due_date: '2026-10-10' }));
  make('task', { title: 'Today', owner: 'owner', business_id: PERSONAL, due_date: '2026-10-16' });
  // Clients: quiet (activity 70 days ago), quiet (made 90 days ago, nothing since), busy, closed and old.
  const quiet = make('client', { name: 'Quiet Co', status: 'active' }, { stampMs: old });
  make('activity', { client_id: quiet, type: 'note', body: 'hello', at: '2026-08-07T15:00:00.000Z' });
  make('client', { name: 'Silent Ltd', status: 'active' }, { stampMs: old });
  const busy = make('client', { name: 'Busy Inc', status: 'active' }, { stampMs: old });
  make('activity', { client_id: busy, type: 'call', body: 'catch-up', at: '2026-10-01T15:00:00.000Z' });
  make('client', { name: 'Gone Corp', status: 'closed' }, { stampMs: old });
  // Renewals: one in 10 days, one in 40, one cancelled in 5; relationship with no next step: one.
  const acc = make('account', { client_id: busy, name: 'Busy Shop' });
  const rel = make('relationship', { account_id: acc, business_id: AGENCY, kind: 'website', status: 'active' });
  make('service', { relationship_id: rel, name: 'Hosting', status: 'active', renewal_date: '2026-10-26' });
  make('service', { relationship_id: rel, name: 'Domain', status: 'active', renewal_date: '2026-11-25' });
  make('service', { relationship_id: rel, name: 'Old plan', status: 'cancelled', renewal_date: '2026-10-21' });
  // This week's goals: one of two done.
  make('goal', { kind: 'week', period: '2026-10-12', business_id: W, title: 'Ship it', owner: 'owner' });
  const g = make('goal', { kind: 'week', period: '2026-10-12', business_id: AGENCY, title: 'Draft', owner: 'owner' });
  update('goal', g, { done_at: new Date().toISOString() });
  env.autos.setSettings('no-next-step', { enabled: false }, { actor: 'owner' }); // keep this test to the review

  env.setNow(at('2026-10-16 07:59'));
  assert.deepEqual(env.autos.tick(), []);
  env.setNow(at('2026-10-16 08:00'));
  const [run] = env.autos.tick();
  assert.equal(run.automation, 'friday-review');
  assert.match(run.summary, /^Made the Friday review for Friday, Oct 16: 2 overdue, 1 renewals, 2 quiet, 1 with no next step$/);
  const [review] = tasks(db, 'title = ?', 'Friday review');
  assert.deepEqual([review.owner, review.business_id, review.due_date, review.estimate_minutes, review.created_by],
    ['shared', PERSONAL, '2026-10-16', 15, 'system']);
  assert.equal(review.due_time, null);
  for (const line of ['• 2 overdue tasks (both of you and the shared list)', '• 1 renewal in the next 30 days',
    '• 2 active clients quiet for 60 days', '• 1 active relationship with no next step', '• This week’s goals: 1 of 2 done', '/plan/review']) {
    assert.ok(review.notes.includes(line), `notes have "${line}":\n${review.notes}`);
  }
  assert.match(review.notes, /^Prepared by the suite on Fri, Oct 16, 8:00 a\.m\./);
  // The alert (alert by default): both people get it, unread.
  const [alert] = alerts(db);
  assert.deepEqual([alert.source, alert.title, alert.link, alert.read_by_owner, alert.read_by_partner, alert.created_by],
    ['friday-review', 'The Friday review is ready', '/plan/review', null, null, 'system']);
  assert.match(alert.body, /2 overdue tasks/);
  assert.equal(run.alertId, alert.id);

  // Once a week: Run now and later looks the same week make nothing more.
  const again = await env.call('POST', '/api/automations/friday-review/run', {});
  assert.match(again.body.run.summary, /already there \(week of Oct 12\)/);
  assert.equal(again.body.run.createdCount, 0);
  env.setNow(at('2026-10-17 09:00'));
  assert.deepEqual(env.autos.tick(), []);
  assert.equal(tasks(db, 'title = ?', 'Friday review').length, 1);
  assert.equal(alerts(db).length, 1, 'no alert when nothing was made');

  // Next week: another one, due that Friday. With alert off: no alert.
  await env.call('PUT', '/api/automations/friday-review', { alert: false });
  env.setNow(at('2026-10-23 08:01'));
  const [next] = env.autos.tick();
  assert.equal(next.createdCount, 1);
  assert.deepEqual(tasks(db, 'title = ?', 'Friday review').map((x) => x.due_date), ['2026-10-16', '2026-10-23']);
  assert.equal(alerts(db).length, 1, 'silent: no new alert');
});

// ---- relationships with no next step -----------------------------------------------------------------

/** One client per case: the relationships the rule flags and the ones it must leave alone. */
function seedRelationships({ make, remove }) {
  const r = {};
  const client = make('client', { name: 'Northwind Holdings', status: 'active' });
  const acc = make('account', { client_id: client, name: 'Cloud Vape Co' });
  const site = make('account', { client_id: client, name: 'Northwind Online' });
  r.client = client;
  r.acc = acc;
  r.flagged = make('relationship', { account_id: acc, business_id: W, kind: 'wholesale', status: 'active' });
  r.agency = make('relationship', { account_id: site, business_id: AGENCY, kind: 'website', status: 'active' });
  r.covered = make('relationship', { account_id: site, business_id: BUSINESS_IDS.consulting, kind: 'consulting', status: 'active' });
  make('task', { title: 'Send the proposal', owner: 'owner', business_id: BUSINESS_IDS.consulting, relationship_id: r.covered, due_date: '2026-10-20' });
  r.undated = make('relationship', { account_id: acc, business_id: SPS, kind: 'social', status: 'active' });
  make('task', { title: 'Some day', owner: 'partner', business_id: SPS, relationship_id: r.undated }); // no date: still flagged
  r.paused = make('relationship', { account_id: acc, business_id: AGENCY, kind: 'social', status: 'paused' });
  r.ended = make('relationship', { account_id: acc, business_id: BUSINESS_IDS.retail, kind: 'wholesale', status: 'ended' });
  const closed = make('client', { name: 'Closed Co', status: 'closed' });
  r.closed = make('relationship', { account_id: make('account', { client_id: closed, name: 'Closed Shop' }), business_id: W, kind: 'wholesale', status: 'active' });
  const goneClient = make('client', { name: 'Deleted Client', status: 'active' });
  r.deletedClient = make('relationship', { account_id: make('account', { client_id: goneClient, name: 'Orphan Shop' }), business_id: W, kind: 'wholesale', status: 'active' });
  remove('client', goneClient);
  const goneAcc = make('account', { client_id: client, name: 'Deleted Account' });
  r.deletedAccount = make('relationship', { account_id: goneAcc, business_id: W, kind: 'wholesale', status: 'active' });
  remove('account', goneAcc);
  return r;
}

test('No next step: one task per flagged relationship, for the business’s default owner, due today — none for closed, paused, ended or deleted', async (t) => {
  const env = await setup(t);
  const r = seedRelationships(env);
  const { db } = env;
  env.autos.setSettings('friday-review', { enabled: false }, { actor: 'owner' });
  const services = env.ctx.services;
  assert.deepEqual(relationshipsToChase({ crm: services.crm, planner: services.planner }).map((x) => x.id).sort(), [r.flagged, r.agency, r.undated].sort());

  env.setNow(at('2026-10-14 07:30'));
  const [run] = env.autos.tick();
  assert.equal(run.automation, 'no-next-step');
  assert.equal(run.summary, 'Made 3 tasks');
  const made = tasks(db, "title LIKE 'Set the next step%'");
  const by = Object.fromEntries(made.map((x) => [x.relationship_id, x]));
  assert.deepEqual(Object.keys(by).sort(), [r.flagged, r.agency, r.undated].sort());
  const wholesale = by[r.flagged];
  assert.deepEqual([wholesale.title, wholesale.owner, wholesale.business_id, wholesale.account_id, wholesale.client_id, wholesale.due_date, wholesale.created_by],
    ['Set the next step for Cloud Vape Co (Wholesale)', 'owner', W, r.acc, r.client, '2026-10-14', 'system']);
  assert.equal(by[r.agency].title, 'Set the next step for Northwind Online (Great White North Design)');
  assert.equal(by[r.agency].owner, 'owner');
  assert.equal(by[r.undated].owner, 'partner', 'Save Point Shop’s default owner');
  // Silent by default: no alert. The flags are cleared (a dated open task names each relationship).
  assert.equal(alerts(db).length, 0);
  assert.deepEqual(relationshipsToChase({ crm: services.crm, planner: services.planner }), []);

  // Again (Run now, and tomorrow's run while they are open): nothing new.
  const again = await env.call('POST', '/api/automations/no-next-step/run', {});
  assert.deepEqual([again.body.run.summary, again.body.run.createdCount], ['Every active relationship has a next step', 0]);
  // Moved to no date: the relationship is flagged again, but its task is still open — never a second one.
  env.update('task', wholesale.id, { due_date: null });
  env.setNow(at('2026-10-15 07:30'));
  const [day2] = env.autos.tick();
  assert.equal(day2.summary, 'Nothing new (1 relationship still has its task open)');
  assert.equal(tasks(db, "title LIKE 'Set the next step%'").length, 3);
  // Done but still no next step: a new one the next run.
  env.update('task', wholesale.id, { done_at: new Date().toISOString() });
  env.setNow(at('2026-10-16 07:30'));
  const [day3] = env.autos.tick();
  assert.equal(day3.summary, 'Made 1 task');
  const latest = tasks(db, "title LIKE 'Set the next step%' AND done_at IS NULL AND relationship_id = ?", r.flagged);
  assert.deepEqual(latest.map((x) => x.due_date), ['2026-10-16']);
  // A deleted one doesn't block a new one either (it isn't open).
  env.remove('task', latest[0].id);
  const day3b = (await env.call('POST', '/api/automations/no-next-step/run', {})).body.run;
  assert.equal(day3b.summary, 'Made 1 task');
  // Closing the client: nothing more for its relationships.
  env.update('client', r.client, { status: 'closed' });
  for (const x of tasks(db, "title LIKE 'Set the next step%' AND done_at IS NULL")) env.update('task', x.id, { done_at: new Date().toISOString() });
  const closedRun = await env.call('POST', '/api/automations/no-next-step/run', {});
  assert.deepEqual([closedRun.body.run.createdCount, closedRun.body.run.summary], [0, 'Every active relationship has a next step']);
});

test('alerts only for automations set to alert: No next step is silent until switched to alert', async (t) => {
  const env = await setup(t);
  seedRelationships(env);
  let heard = [];
  const off = env.autos.onAlert((a) => heard.push(a)); // C5's seam
  env.autos.setSettings('friday-review', { enabled: false }, { actor: 'owner' });
  env.setNow(at('2026-10-14 07:30'));
  env.autos.tick();
  assert.equal(alerts(env.db).length, 0);
  assert.deepEqual(heard, []);
  // Alert on, and something to do again (a new flagged relationship).
  const put = await env.call('PUT', '/api/automations/no-next-step', { alert: true });
  assert.equal(put.body.automation.alert, true);
  const acc = env.make('account', { client_id: env.make('client', { name: 'Fresh Client', status: 'active' }), name: 'Fresh Shop' });
  env.make('relationship', { account_id: acc, business_id: W, kind: 'wholesale', status: 'active' });
  const run = (await env.call('POST', '/api/automations/no-next-step/run', {})).body.run;
  assert.equal(run.createdCount, 1);
  const [alert] = alerts(env.db);
  assert.deepEqual([alert.source, alert.title, alert.body, alert.link], ['no-next-step', '1 relationship needs a next step', 'Set the next step for Fresh Shop (Wholesale)', '/']);
  assert.deepEqual(heard.map((a) => a.id), [alert.id], 'the listener hears it after it is saved');
  // Nothing made: no alert even when set to alert.
  await env.call('POST', '/api/automations/no-next-step/run', {});
  assert.equal(alerts(env.db).length, 1);
  off();
  heard = [];
  // Devices may only mark alerts read.
  const sync = env.sync;
  assert.equal(sync.applyLocal({ actor: 'owner', entity: 'alert', op: 'update', recordId: alert.id, fields: { read_by_owner: true } }).status, 'applied');
  const bad = sync.applyLocal({ actor: 'owner', entity: 'alert', op: 'update', recordId: alert.id, fields: { title: 'changed' } });
  assert.deepEqual([bad.status, bad.code], ['rejected', 'invalid_value']);
  assert.equal(sync.applyLocal({ actor: 'owner', entity: 'alert', op: 'delete', recordId: alert.id }).status, 'rejected');
});
