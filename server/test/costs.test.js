// Renewals and recurring costs (D6): the recurring_cost record type, the reminders 30 days before a
// client service renews and 14 days before one of our costs renews (each once: the scheduler again,
// Run now, the next day, a restart), a person's finish being final, a moved renewal date moving the
// task (or keeping a person's day), late and capped reminders, rolling auto-renewing costs forward,
// and the monthly totals. The server's local time zone is Toronto's.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { atLocal } from '../src/modules/automations/schedule.js';
import { SERVICE_RENEWALS_ID, COST_RENEWALS_ID, NEW_REMINDERS_CAP, whenText } from '../src/modules/costs/reminders.js';
import { checkCost } from '../src/modules/costs/service.js';
import { reviewNumbers, reviewLines } from '../src/modules/planner/automations.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;
const SAVE_POINT = BUSINESS_IDS.save_point;
/** Local time in Toronto as ms ("2026-10-21 08:00"). */
const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};

async function setup(t, { config = testConfig(tmpDir(t)), clock = testClock(), first = true } = {}) {
  const env = await startApp(t, config, { modules, now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const { sync, automations: autos } = env.ctx.services;
  const apply = (entity, op, fields, recordId, actor = 'owner') => {
    const r = sync.applyLocal({ actor, entity, op, recordId, fields });
    assert.ok(['applied', 'clash'].includes(r.status), JSON.stringify(r));
    return r.recordId;
  };
  const local = (entity, fields) => apply(entity, 'create', fields);
  const edit = (entity, id, fields, actor = 'owner') => apply(entity, 'update', fields, id, actor);
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const task = (id) => env.db.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id);
  const cost = (id) => env.db.prepare('SELECT * FROM costs_recurring WHERE id = ?').get(id);
  const tick = (id) => autos.tick().filter((r) => r.automation === id);
  /** Only D6's two run in tick() (the others are switched off). */
  if (first) {
    for (const a of autos.list()) {
      if (a.trigger.type === 'schedule') autos.setSettings(a.id, { enabled: [SERVICE_RENEWALS_ID, COST_RENEWALS_ID].includes(a.id) }, { actor: 'owner' });
    }
  }
  /** A client with one account and a relationship with one of our businesses. */
  const client = (name = 'Lefty’s', business = AGENCY, { kind = 'website', status = 'active' } = {}) => {
    const clientId = local('client', { name, status });
    const accountId = local('account', { client_id: clientId, name });
    const relId = local('relationship', { account_id: accountId, business_id: business, kind, status: 'active' });
    return { clientId, accountId, relId };
  };
  return { ...env, config, clock, users, sync, autos, apply, local, edit, setNow, tasks, task, cost, tick, client };
}

test('whenText: how far the renewal is from the day the task is due', () => {
  assert.equal(whenText('2026-11-20', '2026-10-21'), 'in 30 days');
  assert.equal(whenText('2026-11-20', '2026-11-19'), 'tomorrow');
  assert.equal(whenText('2026-11-20', '2026-11-20'), 'today');
  assert.equal(whenText('2026-11-20', '2026-11-21'), null);
});

test('recurring costs: a synced record type with its checks; refs to our business and (resold) a relationship', async (t) => {
  const env = await setup(t);
  const { relId } = env.client();
  const id = env.local('recurring_cost', {
    name: 'Hosting', business_id: AGENCY, vendor: 'Kinsta', amount_cents: 3500, period: 'monthly', next_renewal: '2026-11-01',
    auto_renews: true, payment_method: 'Visa ••4242', relationship_id: relId, resold_amount_cents: 6000,
  });
  const row = env.cost(id);
  assert.deepEqual([row.name, row.currency, row.status, row.auto_renews, row.created_by], ['Hosting', null, null, 1, 'owner']);
  const bad = (fields) => env.sync.applyLocal({ actor: 'owner', entity: 'recurring_cost', op: 'create', fields: { name: 'X', business_id: AGENCY, period: 'yearly', next_renewal: '2026-11-01', ...fields } });
  assert.equal(bad({ currency: 'usd' }).code, 'invalid_value');
  assert.equal(bad({ amount_cents: -1 }).code, 'invalid_value');
  assert.equal(bad({ resold_amount_cents: -5 }).code, 'invalid_value');
  assert.equal(bad({ period: 'weekly' }).code, 'invalid_value');
  assert.equal(bad({ next_renewal: null }).status, 'rejected');
  assert.equal(bad({ business_id: '01a1163c-1a00-7273-aed1-000000000000' }).code, 'not_found');
  assert.equal(bad({ currency: 'USD' }).status, 'applied');
  assert.deepEqual(checkCost({ op: 'update', fields: { currency: null, amount_cents: null } }), null, 'clearing is fine');
  assert.equal(bad({ anchor_day: 32 }).code, 'invalid_value');
  assert.equal(bad({ anchor_day: 0 }).code, 'invalid_value');
  assert.equal(bad({ anchor_day: 31 }).status, 'applied');
  // Only through sync: a direct write fails.
  assert.throws(() => env.db.prepare("UPDATE costs_recurring SET name = 'x'").run());
  // Devices learn it from /info (a plain, editable type).
  const s = sessionFor(env.ctx, env.users.owner);
  const info = await (await fetch(`${env.base}/api/sync/info`, { headers: { cookie: s.cookie } })).json();
  const def = info.entities.find((e) => e.entity === 'recurring_cost');
  assert.deepEqual(def.ops, ['create', 'update', 'delete']);
  assert.equal(def.fields.business_id.parent, true);
  assert.equal(def.fields.relationship_id.ref, 'relationship');
});

test('service renewal: one task 30 days ahead, due that day, for the business’s default owner — once (again, Run now, next day, restart); a person’s finish is final; a new date makes a new one', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const env = await setup(t, { config, clock });
  const { clientId, accountId, relId } = env.client('Lefty’s', AGENCY);
  const svc = env.local('service', { relationship_id: relId, name: 'Website care plan', status: 'active', amount_cents: 120000, period: 'yearly', renewal_date: '2026-11-20' });
  env.local('service', { relationship_id: relId, name: 'Old plan', status: 'cancelled', renewal_date: '2026-11-10' });
  env.local('service', { relationship_id: relId, name: 'Build', status: 'done', renewal_date: '2026-11-05' });

  env.setNow(at('2026-10-20 08:00'));
  const [r0] = env.tick(SERVICE_RENEWALS_ID);
  assert.equal(r0.createdCount, 0, '31 days ahead: not yet');
  assert.equal(r0.summary, 'Nothing renews soon');

  env.setNow(at('2026-10-21 07:49'));
  assert.deepEqual(env.tick(SERVICE_RENEWALS_ID), [], 'not 7:50 yet');
  env.setNow(at('2026-10-21 08:00'));
  const [r1] = env.tick(SERVICE_RENEWALS_ID);
  assert.equal(r1.summary, 'Made 1 reminder');
  const [task] = env.tasks();
  assert.equal(task.title, 'Renewal in 30 days: Website care plan for Lefty’s (Great White North Design)');
  assert.deepEqual([task.due_date, task.owner, task.business_id, task.client_id, task.account_id, task.relationship_id, task.created_by],
    ['2026-10-21', 'owner', AGENCY, clientId, accountId, relId, 'system']);
  assert.match(task.notes, /renews on Nov 20, 2026: \$1,200\/yr\./);
  assert.match(task.notes, /Set the service to Done or Cancelled/);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM automations_alerts').get().n, 0, 'silent by default');

  // Once: the scheduler again, Run now, the next day, a restart.
  assert.deepEqual(env.tick(SERVICE_RENEWALS_ID), []);
  assert.equal(env.autos.runNow(SERVICE_RENEWALS_ID).createdCount, 0);
  env.setNow(at('2026-10-22 08:00'));
  assert.equal(env.tick(SERVICE_RENEWALS_ID)[0].createdCount, 0);
  await env.close();
  const again = await setup(t, { config, clock, first: false });
  again.setNow(at('2026-10-23 08:00'));
  assert.equal(again.tick(SERVICE_RENEWALS_ID)[0].createdCount, 0);
  assert.equal(again.tasks().length, 1, 'one reminder for this renewal date, ever');

  // A person finishes it: final for this date (no new one, nothing reopened).
  again.edit('task', task.id, { done_at: new Date(at('2026-10-23 09:00')).toISOString() });
  again.setNow(at('2026-10-24 08:00'));
  const [r2] = again.tick(SERVICE_RENEWALS_ID);
  assert.equal(r2.createdCount, 0);
  assert.match(r2.summary, /1 renewal already handled by a person/);
  assert.ok(again.task(task.id).done_at);

  // Renewed for another year: the new date makes a new reminder when its day comes.
  again.edit('service', svc, { renewal_date: '2027-11-20' });
  again.setNow(at('2026-10-25 08:00'));
  assert.equal(again.tick(SERVICE_RENEWALS_ID)[0].createdCount, 0, 'a year away');
  again.setNow(at('2027-10-21 08:00'));
  assert.equal(again.tick(SERVICE_RENEWALS_ID)[0].createdCount, 1);
  assert.deepEqual(again.tasks('done_at IS NULL').map((x) => [x.title, x.due_date]),
    [['Renewal in 30 days: Website care plan for Lefty’s (Great White North Design)', '2027-10-21']]);
});

test('service renewal: a correction inside the window (or earlier) moves the open task (and back again); a person’s own day is kept and told once', async (t) => {
  const env = await setup(t);
  const { relId } = env.client('Maple Row', AGENCY);
  const a = env.local('service', { relationship_id: relId, name: 'Hosting', status: 'active', renewal_date: '2026-11-20' });
  const b = env.local('service', { relationship_id: relId, name: 'SEO', status: 'active', renewal_date: '2026-11-20' });
  env.setNow(at('2026-10-21 08:00'));
  assert.equal(env.tick(SERVICE_RENEWALS_ID)[0].createdCount, 2);
  const [ta, tb] = [a, b].map((id) => env.tasks('relationship_id = ? AND title LIKE ?', relId, `%: ${id === a ? 'Hosting' : 'SEO'} for%`)[0]);

  // A: moved two days later (its reminder day, Oct 23, has come): moved; then back (a typo fixed): moved again.
  env.edit('service', a, { renewal_date: '2026-11-22' });
  env.setNow(at('2026-10-25 08:00'));
  const [r1] = env.tick(SERVICE_RENEWALS_ID);
  assert.equal(r1.summary, 'Moved 1 reminder with its new date');
  assert.deepEqual([env.task(ta.id).due_date, env.task(ta.id).title, env.task(ta.id).done_at],
    ['2026-10-25', 'Renewal in 28 days: Hosting for Maple Row (Great White North Design)', null]);
  env.edit('service', a, { renewal_date: '2026-11-20' });
  env.setNow(at('2026-10-26 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.deepEqual([env.task(ta.id).due_date, env.task(ta.id).title], ['2026-10-26', 'Renewal in 25 days: Hosting for Maple Row (Great White North Design)'],
    'an earlier date: moved, due today');
  assert.equal(env.tasks('relationship_id = ?', relId).length, 2, 'moved, never a second task');

  // B: a person gives the task their own day; then the renewal moves inside the window: their day is kept, a line says so (once).
  env.edit('task', tb.id, { due_date: '2026-11-02' });
  env.edit('service', b, { renewal_date: '2026-11-24' });
  env.setNow(at('2026-10-27 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  const kept = env.task(tb.id);
  assert.deepEqual([kept.due_date, kept.done_at], ['2026-11-02', null]);
  assert.equal(kept.title, 'Renewal in 22 days: SEO for Maple Row (Great White North Design)', 'the title is still the suite’s: refreshed');
  assert.match(kept.notes, /The renewal date is now Nov 24, 2026 \(this task keeps the day you gave it\)\.$/);
  env.setNow(at('2026-10-28 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.equal(env.task(tb.id).notes, kept.notes, 'told once');
  // A person's own title is never put back.
  env.edit('task', tb.id, { title: 'Call Maple Row about SEO' });
  env.edit('service', b, { renewal_date: '2026-11-26' });
  env.setNow(at('2026-10-29 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.equal(env.task(tb.id).title, 'Call Maple Row about SEO');
  assert.equal(env.task(tb.id).done_at, null);
});

test('renewed for another period: the open reminder is FINISHED, never moved a year out — whether the run or the person comes first, and on a person’s own day; next year’s reminder comes on its day', async (t) => {
  const env = await setup(t);
  const { relId } = env.client('Brant Florists', AGENCY);
  const one = env.local('service', { relationship_id: relId, name: 'Care plan', status: 'active', renewal_date: '2026-11-20' });
  const two = env.local('service', { relationship_id: relId, name: 'Domain', status: 'active', renewal_date: '2026-11-20' });
  const three = env.local('service', { relationship_id: relId, name: 'SSL', status: 'active', renewal_date: '2026-11-20' });
  const cost = env.local('recurring_cost', { name: 'Insurance', business_id: PERSONAL, amount_cents: 120000, period: 'yearly', next_renewal: '2026-11-20', auto_renews: false });
  env.setNow(at('2026-10-21 08:00'));
  env.autos.tick();
  env.setNow(at('2026-11-06 08:00'));
  env.autos.tick();
  const taskOf = (name) => env.tasks('title LIKE ?', `%: ${name}%`)[0];
  const [t1, t2, t3, tc] = ['Care plan for', 'Domain for', 'SSL for', 'Insurance'].map(taskOf);
  assert.ok(t1 && t2 && t3 && tc);

  // 1. Renewed, then the run: the suite finishes it.
  env.edit('service', one, { renewal_date: '2027-11-20' });
  // 2. Renewed, and the person ticks the reminder before the run.
  env.edit('service', two, { renewal_date: '2027-11-20' });
  env.edit('task', t2.id, { done_at: new Date(at('2026-11-06 09:00')).toISOString() });
  // 3. The person gave the task their own day, then renewed.
  env.edit('task', t3.id, { due_date: '2026-11-10' });
  env.edit('service', three, { renewal_date: '2027-11-20' });
  // 4. A cost that doesn't renew on its own, its task on the person's own day: renewed.
  env.edit('task', tc.id, { due_date: '2026-11-12' });
  env.edit('recurring_cost', cost, { next_renewal: '2027-11-20' });
  env.setNow(at('2026-11-07 08:00'));
  const runs = env.autos.tick();
  const rs = runs.find((r) => r.automation === SERVICE_RENEWALS_ID);
  const rc = runs.find((r) => r.automation === COST_RENEWALS_ID);
  assert.match(rs.summary, /^Finished 2 reminders/);
  assert.match(rc.summary, /^Finished 1 reminder/);
  for (const task of [t1, t3, tc]) {
    const now = env.task(task.id);
    assert.ok(now.done_at, `${now.title} finished`);
    assert.match(now.notes, /Renewed: the next renewal is Nov 20, 2027 \(its reminder comes on (Oct 21|Nov 6), 2027\) — finished by the suite on Nov 7, 2026\.$/);
    assert.ok(!/377|days: .* 2027/.test(now.title), now.title);
    assert.ok(now.due_date < '2027-01-01', 'never moved a year out');
  }
  assert.equal(env.tasks('done_at IS NULL').length, 0);

  // Next year: each gets its reminder on its own day — the person's tick last year doesn't count for it.
  const made = () => env.autos.tick().reduce((n, r) => n + r.createdCount, 0);
  env.setNow(at('2027-10-20 08:00'));
  assert.equal(made(), 0);
  env.setNow(at('2027-10-21 08:00'));
  assert.equal(made(), 3);
  env.setNow(at('2027-11-06 08:00'));
  assert.equal(made(), 1);
  assert.deepEqual(env.tasks('done_at IS NULL').map((x) => [x.title.split(':')[0], x.due_date]).sort(), [
    ['Renewal in 30 days', '2027-10-21'], ['Renewal in 30 days', '2027-10-21'], ['Renewal in 30 days', '2027-10-21'], ['Renews in 14 days', '2027-11-06'],
  ]);
});

test('service renewal: closed clients and ended relationships get none (open ones finished with the reason); a paused relationship still does', async (t) => {
  const env = await setup(t);
  const c1 = env.client('Closing Co');
  const c2 = env.client('Ending Co');
  const c3 = env.client('Paused Co');
  const s1 = env.local('service', { relationship_id: c1.relId, name: 'Hosting', status: 'active', renewal_date: '2026-11-20' });
  env.local('service', { relationship_id: c2.relId, name: 'Hosting', status: 'active', renewal_date: '2026-11-20' });
  env.local('service', { relationship_id: c3.relId, name: 'Hosting', status: 'active', renewal_date: '2026-11-20' });
  env.edit('relationship', c3.relId, { status: 'paused' });
  env.setNow(at('2026-10-21 08:00'));
  assert.equal(env.tick(SERVICE_RENEWALS_ID)[0].createdCount, 3, 'paused still gets one');
  env.edit('client', c1.clientId, { status: 'closed' });
  env.edit('relationship', c2.relId, { status: 'ended' });
  env.setNow(at('2026-10-22 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.match(env.tasks('client_id = ?', c1.clientId)[0].notes, /The client was closed — finished by the suite/);
  assert.match(env.tasks('client_id = ?', c2.clientId)[0].notes, /The relationship ended — finished by the suite/);
  assert.equal(env.tasks('client_id = ?', c3.clientId)[0].done_at, null);
  // A closed client never gets a new one; reopened, the suite's own task comes back.
  env.edit('client', c1.clientId, { status: 'active' });
  env.setNow(at('2026-10-23 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.equal(env.tasks('client_id = ?', c1.clientId)[0].done_at, null, 'reopened by the suite');
  const closed = env.client('Closed Co', AGENCY, { status: 'closed' });
  env.local('service', { relationship_id: closed.relId, name: 'Hosting', status: 'active', renewal_date: '2026-11-21' });
  env.setNow(at('2026-10-24 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.equal(env.tasks('client_id = ?', closed.clientId).length, 0);
  void s1;
});

test('service renewal: added late → due today; cancelled, done, date cleared or deleted → finished with the reason; back again → reopened by the suite', async (t) => {
  const env = await setup(t);
  const { relId, clientId } = env.client('Brantford Auto Body', BUSINESS_IDS.consulting, { kind: 'consulting' });
  env.setNow(at('2026-10-21 08:00'));
  const s = env.local('service', { relationship_id: relId, name: 'Coaching', status: 'active', billing: 'hourly', rate_cents: 9500, renewal_date: '2026-10-31' });
  const [r] = env.tick(SERVICE_RENEWALS_ID);
  assert.equal(r.createdCount, 1);
  let [task] = env.tasks();
  assert.deepEqual([task.title, task.due_date], ['Renewal in 10 days: Coaching for Brantford Auto Body (Business consulting)', '2026-10-21']);
  assert.match(task.notes, /\$95 \/ hour/);

  env.edit('service', s, { status: 'cancelled' });
  env.setNow(at('2026-10-22 08:00'));
  assert.match(env.tick(SERVICE_RENEWALS_ID)[0].summary, /^Finished 1 reminder$/);
  task = env.task(task.id);
  assert.ok(task.done_at);
  assert.match(task.notes, /The service was cancelled — finished by the suite on Oct 22, 2026\.$/);

  // Back to active (same date): the suite reopens the task it finished, due today.
  env.edit('service', s, { status: 'active' });
  env.setNow(at('2026-10-23 08:00'));
  assert.match(env.tick(SERVICE_RENEWALS_ID)[0].summary, /^Reopened 1 reminder$/);
  task = env.task(task.id);
  assert.deepEqual([task.done_at, task.due_date], [null, '2026-10-23']);
  assert.match(task.notes, /reopened by the suite on Oct 23, 2026\.$/);
  assert.equal(env.tasks().length, 1);

  env.edit('service', s, { renewal_date: null });
  env.setNow(at('2026-10-24 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.match(env.task(task.id).notes, /Its renewal date was cleared — finished by the suite/);

  // Deleted (here: its client): finished too.
  env.edit('service', s, { renewal_date: '2026-11-01' });
  env.setNow(at('2026-10-25 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.ok(env.task(task.id).done_at, 'a new date is a new task: the finished one stays finished');
  const open = env.tasks('done_at IS NULL');
  assert.equal(open.length, 1);
  env.apply('client', 'delete', undefined, clientId);
  env.setNow(at('2026-10-26 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.match(env.task(open[0].id).notes, /The service \(or its relationship, account or client\) was deleted — finished by the suite/);
  // Done: finished as well (a new service under a new client).
  const other = env.client('Other');
  const s2 = env.local('service', { relationship_id: other.relId, name: 'Logo', status: 'active', renewal_date: '2026-11-15' });
  env.setNow(at('2026-10-27 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  env.edit('service', s2, { status: 'done' });
  env.setNow(at('2026-10-28 08:00'));
  env.tick(SERVICE_RENEWALS_ID);
  assert.match(env.tasks('client_id = ?', other.clientId)[0].notes, /The service was marked done — finished by the suite/);
  // A renewal that has gone by makes nothing.
  env.local('service', { relationship_id: other.relId, name: 'Past', status: 'active', renewal_date: '2026-10-01' });
  env.setNow(at('2026-10-29 08:00'));
  assert.equal(env.tick(SERVICE_RENEWALS_ID)[0].createdCount, 0);
});

test('service renewal: at most 20 new a run, soonest first; the rest the next day', async (t) => {
  const env = await setup(t);
  const { relId } = env.client('Big Client');
  for (let i = 0; i < NEW_REMINDERS_CAP + 5; i += 1) {
    env.local('service', { relationship_id: relId, name: `Site ${String(i).padStart(2, '0')}`, status: 'active', renewal_date: `2026-11-${String(1 + (i % 20)).padStart(2, '0')}` });
  }
  env.setNow(at('2026-10-21 08:00'));
  const [r] = env.tick(SERVICE_RENEWALS_ID);
  assert.equal(r.createdCount, NEW_REMINDERS_CAP);
  assert.match(r.summary, /^Made 20 reminders; 5 more waiting \(made on the next days\)$/);
  assert.ok(!env.tasks().some((x) => x.title.includes('Site 19')), 'the latest renewals wait');
  env.setNow(at('2026-10-22 08:00'));
  assert.equal(env.tick(SERVICE_RENEWALS_ID)[0].createdCount, 5);
  assert.equal(env.tasks().length, NEW_REMINDERS_CAP + 5);
});

test('recurring cost: one task 14 days ahead for the business’s default owner — once; a person’s finish is final; resold costs name the client', async (t) => {
  const config = testConfig(tmpDir(t));
  const clock = testClock();
  const env = await setup(t, { config, clock });
  const domain = env.local('recurring_cost', { name: 'Domain leftys.ca', business_id: AGENCY, vendor: 'Namecheap', amount_cents: 2000, period: 'yearly', next_renewal: '2026-11-30', auto_renews: false });
  env.local('recurring_cost', { name: 'Home insurance', business_id: PERSONAL, amount_cents: 140000, period: 'yearly', next_renewal: '2026-11-30', auto_renews: true, payment_method: 'Chequing' });
  const store = env.local('recurring_cost', { name: 'eBay store', business_id: SAVE_POINT, amount_cents: 2795, period: 'monthly', next_renewal: '2026-11-30', auto_renews: true });
  const leftys = env.client('Lefty’s');
  env.local('recurring_cost', { name: 'Hosting', business_id: AGENCY, amount_cents: 30000, period: 'yearly', next_renewal: '2026-11-30', relationship_id: leftys.relId, resold_amount_cents: 48000, currency: 'CAD' });
  env.local('recurring_cost', { name: 'Old app', business_id: AGENCY, amount_cents: 100, period: 'yearly', next_renewal: '2026-11-30', status: 'cancelled' });

  env.setNow(at('2026-11-15 08:00'));
  assert.equal(env.tick(COST_RENEWALS_ID)[0].createdCount, 0, '15 days ahead: not yet');
  env.setNow(at('2026-11-16 07:54'));
  assert.deepEqual(env.tick(COST_RENEWALS_ID), [], 'not 7:55 yet');
  env.setNow(at('2026-11-16 08:00'));
  const [r] = env.tick(COST_RENEWALS_ID);
  assert.equal(r.createdCount, 3, 'not the monthly one that renews on its own, not the cancelled one');
  const byTitle = Object.fromEntries(env.tasks().map((x) => [x.title, x]));
  assert.deepEqual(Object.keys(byTitle).sort(), [
    'Renews in 14 days: Domain leftys.ca ($20/yr)', 'Renews in 14 days: Home insurance ($1,400/yr)', 'Renews in 14 days: Hosting ($300/yr)',
  ]);
  const d = byTitle['Renews in 14 days: Domain leftys.ca ($20/yr)'];
  assert.deepEqual([d.due_date, d.owner, d.business_id, d.client_id], ['2026-11-16', 'owner', AGENCY, null]);
  assert.match(d.notes, /^Domain leftys\.ca from Namecheap renews on Nov 30, 2026: \$20\/yr\.\nIt doesn’t renew on its own/);
  const h = byTitle['Renews in 14 days: Home insurance ($1,400/yr)'];
  assert.deepEqual([h.owner, h.business_id], ['shared', PERSONAL], 'Personal’s default owner: the shared list');
  assert.match(h.notes, /paid with Chequing\.\nIt renews on its own/);
  const ho = byTitle['Renews in 14 days: Hosting ($300/yr)'];
  assert.deepEqual([ho.client_id, ho.account_id, ho.relationship_id], [leftys.clientId, leftys.accountId, null]);
  assert.match(ho.notes, /Resold to Lefty’s: they pay \$480\/yr\./);
  assert.equal(env.cost(store).next_renewal, '2026-11-30');

  // Once: again, Run now, next day, restart.
  assert.deepEqual(env.tick(COST_RENEWALS_ID), []);
  assert.equal(env.autos.runNow(COST_RENEWALS_ID).createdCount, 0);
  await env.close();
  const again = await setup(t, { config, clock, first: false });
  again.setNow(at('2026-11-17 08:00'));
  assert.equal(again.tick(COST_RENEWALS_ID)[0].createdCount, 0);
  assert.equal(again.tasks().length, 3);

  // A person finishes the domain one: final for Nov 30.
  again.edit('task', d.id, { done_at: new Date(at('2026-11-17 09:00')).toISOString() });
  again.setNow(at('2026-11-18 08:00'));
  assert.match(again.tick(COST_RENEWALS_ID)[0].summary, /1 renewal already handled by a person/);
  assert.equal(again.tasks('done_at IS NULL').length, 2);

  // The domain isn't auto-renewing: once its date passes it stays (Overdue — renewed? on the page),
  // and the person sets the next one, which brings a new reminder when its day comes.
  again.setNow(at('2026-12-01 08:00'));
  again.tick(COST_RENEWALS_ID);
  assert.equal(again.cost(domain).next_renewal, '2026-11-30', 'not rolled: it doesn’t renew on its own');
  again.edit('recurring_cost', domain, { next_renewal: '2027-11-30' });
  again.setNow(at('2027-11-16 08:00'));
  const made = again.tick(COST_RENEWALS_ID)[0];
  assert.ok(again.tasks('done_at IS NULL AND due_date = ?', '2027-11-16').some((x) => x.title === 'Renews in 14 days: Domain leftys.ca ($20/yr)'), made.summary);
});

test('recurring cost: auto-renewing ones roll forward once their date has passed (their open reminder finished); monthly ones never get reminders', async (t) => {
  const env = await setup(t);
  const yearly = env.local('recurring_cost', { name: 'Adobe', business_id: AGENCY, amount_cents: 70000, period: 'yearly', next_renewal: '2026-10-20', auto_renews: true });
  const monthly = env.local('recurring_cost', { name: 'Phone plan', business_id: PERSONAL, amount_cents: 6500, period: 'monthly', next_renewal: '2026-09-15', auto_renews: true });
  const quarterly = env.local('recurring_cost', { name: 'Accounting app', business_id: AGENCY, amount_cents: 9000, period: 'quarterly', next_renewal: '2026-10-06', auto_renews: true });
  const once = env.local('recurring_cost', { name: 'Logo licence', business_id: AGENCY, amount_cents: 50000, period: 'once', next_renewal: '2026-10-01', auto_renews: true });
  const off = env.local('recurring_cost', { name: 'Gone', business_id: AGENCY, period: 'yearly', next_renewal: '2026-10-01', auto_renews: true, status: 'cancelled' });

  env.setNow(at('2026-10-09 08:00'));
  const [r1] = env.tick(COST_RENEWALS_ID);
  assert.deepEqual([env.cost(monthly).next_renewal, env.cost(quarterly).next_renewal], ['2026-10-15', '2027-01-06'], 'rolled forward in one jump');
  assert.deepEqual([env.cost(once).next_renewal, env.cost(off).next_renewal, env.cost(yearly).next_renewal], ['2026-10-01', '2026-10-01', '2026-10-20']);
  assert.match(r1.summary, /^Moved Phone plan to Oct 15, 2026, Accounting app to Jan 6, 2027 \(renewed on their own\); made 1 reminder$/);
  assert.equal(env.cost(monthly).updated_by, 'system');
  const [adobe] = env.tasks();
  assert.equal(adobe.title, 'Renews in 11 days: Adobe ($700/yr)', 'made late: due today');

  // The renewal day itself: not rolled yet. The day after: rolled, and its reminder finished.
  env.setNow(at('2026-10-20 08:00'));
  env.tick(COST_RENEWALS_ID);
  assert.equal(env.cost(yearly).next_renewal, '2026-10-20');
  env.setNow(at('2026-10-21 08:00'));
  const [r2] = env.tick(COST_RENEWALS_ID);
  assert.match(r2.summary, /Moved Adobe to Oct 20, 2027 \(renewed on its own\)/);
  assert.equal(env.cost(yearly).next_renewal, '2027-10-20');
  const done = env.task(adobe.id);
  assert.ok(done.done_at);
  assert.match(done.notes, /Renewed on its own on Oct 20, 2026; the next renewal is Oct 20, 2027 — finished by the suite on Oct 21, 2026\.$/);
  // Next year's reminder comes 14 days before.
  env.setNow(at('2027-10-06 08:00'));
  env.tick(COST_RENEWALS_ID);
  assert.deepEqual(env.tasks("done_at IS NULL AND title LIKE '%Adobe%'").map((x) => [x.title, x.due_date]), [['Renews in 14 days: Adobe ($700/yr)', '2027-10-06']]);
  // (The quarterly one, rolled to Oct 6 meanwhile without a run on its 14th day, got one due today.)
  assert.deepEqual(env.tasks("done_at IS NULL AND title LIKE '%Accounting%'").map((x) => x.title), ['Renews today: Accounting app ($90/qtr)']);

  // A cost switched to monthly-and-automatic while its reminder is open: finished with the reason.
  const t2 = env.local('recurring_cost', { name: 'Figma', business_id: AGENCY, amount_cents: 2000, period: 'yearly', next_renewal: '2027-10-15', auto_renews: false });
  env.setNow(at('2027-10-07 08:00'));
  env.tick(COST_RENEWALS_ID);
  const figma = env.tasks('title LIKE ?', '%Figma%')[0];
  env.edit('recurring_cost', t2, { period: 'monthly', auto_renews: true });
  env.setNow(at('2027-10-08 08:00'));
  env.tick(COST_RENEWALS_ID);
  assert.match(env.task(figma.id).notes, /It renews monthly on its own \(no reminders for those\) — finished by the suite/);
  // Cancelled: finished too.
  env.edit('recurring_cost', yearly, { status: 'cancelled' });
  env.setNow(at('2027-10-09 08:00'));
  env.tick(COST_RENEWALS_ID);
  assert.equal(env.tasks('done_at IS NULL').length, 0);
});

test('month-end: a monthly cost billed on the 31st rolls Jan 31 → Feb 28 → Mar 31 day by day, as in one jump; the billing day is set by the suite when missing', async (t) => {
  const env = await setup(t);
  // Made without a billing day (server code, or a cost from before the field): the first roll sets it.
  const daily = env.local('recurring_cost', { name: 'Seat A', business_id: AGENCY, amount_cents: 1000, period: 'monthly', next_renewal: '2027-01-31', auto_renews: true });
  const jump = env.local('recurring_cost', { name: 'Seat B', business_id: AGENCY, amount_cents: 1000, period: 'monthly', next_renewal: '2027-01-31', auto_renews: true });
  const set = env.local('recurring_cost', { name: 'Seat C', business_id: AGENCY, amount_cents: 1000, period: 'monthly', next_renewal: '2027-02-28', auto_renews: true, anchor_day: 30 });
  // Seat B is paused (cancelled) during the daily runs, then active again to roll in one jump.
  env.edit('recurring_cost', jump, { status: 'cancelled' });
  const seen = [];
  for (const day of ['2027-02-01', '2027-02-15', '2027-03-01', '2027-03-15', '2027-04-01']) {
    env.setNow(at(`${day} 08:00`));
    env.autos.tick();
    seen.push(env.cost(daily).next_renewal);
  }
  assert.deepEqual(seen, ['2027-02-28', '2027-02-28', '2027-03-31', '2027-03-31', '2027-04-30']);
  assert.equal(env.cost(daily).anchor_day, 31, 'set from the date at the first roll');
  assert.equal(env.cost(daily).updated_by, 'system');
  assert.deepEqual([env.cost(set).next_renewal, env.cost(set).anchor_day], ['2027-04-30', 30], 'its own billing day kept');
  env.edit('recurring_cost', jump, { status: 'active' });
  env.setNow(at('2027-04-02 08:00'));
  env.autos.runNow(COST_RENEWALS_ID);
  assert.equal(env.cost(jump).next_renewal, '2027-04-30', 'one jump: the same date');
  assert.equal(env.cost(jump).anchor_day, 31);
});

test('monthly totals for the overview (D15), costs renewing soon, and the Friday review counting them', async (t) => {
  const env = await setup(t);
  const costs = env.ctx.services.costs;
  env.local('recurring_cost', { name: 'Hosting', business_id: AGENCY, amount_cents: 3500, period: 'monthly', next_renewal: '2026-10-15', auto_renews: true });
  env.local('recurring_cost', { name: 'Domain', business_id: AGENCY, amount_cents: 2400, period: 'yearly', next_renewal: '2026-11-30' });
  env.local('recurring_cost', { name: 'Figma', business_id: AGENCY, amount_cents: 1500, period: 'quarterly', next_renewal: '2026-12-01', currency: 'USD' });
  env.local('recurring_cost', { name: 'Insurance', business_id: PERSONAL, amount_cents: 120000, period: 'yearly', next_renewal: '2027-03-01' });
  env.local('recurring_cost', { name: 'Logo', business_id: AGENCY, amount_cents: 50000, period: 'once', next_renewal: '2026-10-20' });
  env.local('recurring_cost', { name: 'Old', business_id: PERSONAL, amount_cents: 999, period: 'monthly', next_renewal: '2026-10-20', status: 'cancelled' });
  // A resold cost whose client was deleted: what we pay still counts, the resold side doesn't.
  const gone = env.client('Gone Co');
  env.local('recurring_cost', { name: 'Gone hosting', business_id: PERSONAL, amount_cents: 0, period: 'yearly', next_renewal: '2027-05-01', relationship_id: gone.relId, resold_amount_cents: 99900 });
  const kept = env.client('Kept Co');
  env.local('recurring_cost', { name: 'Kept hosting', business_id: PERSONAL, amount_cents: 0, period: 'yearly', next_renewal: '2027-05-01', relationship_id: kept.relId, resold_amount_cents: 12000 });
  env.apply('client', 'delete', undefined, gone.clientId);
  const totals = costs.monthlyTotals();
  assert.equal(totals.overall.find((o) => o.currency === 'CAD').resold_yearly_cents, 12000, 'only the live client’s resold side');
  assert.deepEqual(totals.businesses.map((b) => [b.name, b.currency, b.count, b.monthly_cents, b.yearly_cents]), [
    ['Great White North Design', 'CAD', 2, 3700, 44400],
    ['Great White North Design', 'USD', 1, 500, 6000],
    ['Personal', 'CAD', 3, 10000, 120000],
  ]);
  assert.deepEqual(totals.overall.map((o) => [o.currency, o.monthly_cents, o.yearly_cents]), [['CAD', 13700, 164400], ['USD', 500, 6000]]);
  assert.deepEqual(costs.renewingBetween('2026-10-09', '2026-11-08').map((c) => c.name), ['Hosting', 'Logo']);

  const { crm, planner } = env.ctx.services;
  const n = reviewNumbers({ crm, planner, services: env.ctx.services }, '2026-10-09');
  assert.deepEqual([n.renewals, n.costRenewals], [0, 2]);
  assert.equal(reviewLines(n)[1], '• 2 renewals in the next 30 days (0 client services, 2 of our costs)');
});
