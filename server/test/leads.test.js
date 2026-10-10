// Leads and the pipeline (D8), server side: the lead and lead_activity record types and their checks
// (lost needs a reason, won names its client), task.lead_id, the monthly trigger (the first workday of
// the month), the monthly cross-sell list (one task per business, once a month, the age-restricted rule,
// consent marks, nothing sent) and the leads-with-no-next-step automation (off by default, capped, never
// a second while its task is open). The server's local time zone is Toronto's.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS as B } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { atLocal, periodOf, triggerText, firstWorkday } from '../src/modules/automations/schedule.js';
import { LEAD_STEP_CAP, CROSS_SELL_NOTES_MAX, crossSellLines } from '../src/modules/planner/leadAutomations.js';
import { checkLead } from '../src/modules/crm/service.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock } from './helpers.js';

const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};
const ON = ['cross-sell', 'lead-no-next-step'];

async function setup(t, { start = '2026-10-30 12:00' } = {}) {
  const clock = testClock();
  clock.offsetMs = at(start) - Date.now();
  const env = await startApp(t, testConfig(tmpDir(t)), { modules, now: clock.now });
  await ensureTestUsers(env.ctx);
  const { sync, automations: autos } = env.ctx.services;
  const apply = (entity, op, fields, recordId, actor = 'owner') => sync.applyLocal({ actor, entity, op, recordId, fields });
  const local = (entity, fields, actor = 'owner') => {
    const r = apply(entity, 'create', fields, undefined, actor);
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const edit = (entity, id, fields) => {
    const r = apply(entity, 'update', fields, id);
    assert.equal(r.status, 'applied', JSON.stringify(r));
  };
  const setNow = (s) => { clock.offsetMs = at(s) - Date.now(); };
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const tick = (id) => autos.tick().filter((r) => r.automation === id);
  for (const a of autos.list()) {
    if (a.trigger.type === 'schedule') autos.setSettings(a.id, { enabled: a.id === 'cross-sell' }, { actor: 'owner' });
  }
  const client = (name, rels, { status = 'active', age = false, contact = null } = {}) => {
    const clientId = local('client', { name, status });
    const accountId = local('account', { client_id: clientId, name, ...(age ? { age_restricted: true } : {}) });
    for (const [business_id, kind] of rels) local('relationship', { account_id: accountId, business_id, kind, status: 'active' });
    const contactId = contact ? local('contact', { client_id: clientId, account_id: accountId, ...contact }) : null;
    return { clientId, accountId, contactId };
  };
  return { ...env, clock, sync, autos, apply, local, edit, setNow, tasks, tick, client };
}

test('the monthly trigger: the first workday of the month, in local time', () => {
  assert.equal(firstWorkday('2026-11-01'), '2026-11-02', 'Sunday → Monday');
  assert.equal(firstWorkday('2026-08-01'), '2026-08-03', 'Saturday → Monday');
  assert.equal(firstWorkday('2026-12-01'), '2026-12-01');
  const trigger = { type: 'schedule', every: 'month', at: '08:05' };
  assert.equal(triggerText(trigger), 'The first workday of each month at 8:05 a.m.');
  const p = periodOf(trigger, new Date(at('2026-11-20 10:00')));
  assert.equal(p.key, '2026-11');
  assert.equal(p.day, '2026-11-02');
  assert.equal(p.dueAt.getTime(), at('2026-11-02 08:05'));
  assert.equal(p.nextDueAt.getTime(), at('2026-12-01 08:05'));
});

test('leads: a synced record type; lost needs a reason, won names its client; their timeline is append-only; task.lead_id', async (t) => {
  const env = await setup(t);
  const lead = env.local('lead', { name: 'Brantford Auto Body', business_id: B.agency, stage: 'lead', email: ' Sam@BAB.ca ', phone: '+1 (519) 555-0100' });
  const row = env.db.prepare('SELECT * FROM crm_leads WHERE id = ?').get(lead);
  assert.deepEqual([row.email, row.phone, row.created_by], ['sam@bab.ca', '5195550100', 'owner'], 'stored in their clean forms');

  const refused = (fields) => env.apply('lead', 'update', fields, lead);
  assert.equal(refused({ stage: 'lost' }).code, 'invalid_value', 'lost needs a reason');
  assert.equal(refused({ stage: 'won' }).code, 'invalid_value', 'won needs its client');
  assert.equal(refused({ currency: 'usd' }).code, 'invalid_value');
  assert.equal(refused({ value_cents: -1 }).code, 'invalid_value');
  assert.equal(refused({ stage: 'done' }).code, 'invalid_value');
  env.edit('lead', lead, { stage: 'lost', lost_reason: 'timing', closed_at: '2026-10-30T16:00:00.000Z' });
  env.edit('lead', lead, { stage: 'lost', lost_note: 'Spring' }); // already lost with a reason
  assert.equal(checkLead({ op: 'update', fields: { stage: 'won' }, current: { won_client_id: 'x' } }), null);
  assert.equal(checkLead({ op: 'delete', fields: null }), null);
  // Review fix: keeping "Lost" from a stage clash applies the stage alone onto a lead the other device moved —
  // any stored reason counts; a step can't lose a lead while clearing its reason (or win one clearing its client).
  assert.equal(checkLead({ op: 'update', fields: { stage: 'lost' }, current: { stage: 'talking', lost_reason: 'price' } }), null);
  assert.equal(checkLead({ op: 'update', fields: { stage: 'lost', lost_reason: null }, current: { lost_reason: 'price' } }).code, 'invalid_value');
  assert.equal(checkLead({ op: 'update', fields: { stage: 'won', won_client_id: null }, current: { won_client_id: 'x' } }).code, 'invalid_value');
  assert.equal(checkLead({ op: 'create', fields: { stage: 'lost' }, current: null }).code, 'invalid_value');

  const act = env.local('lead_activity', { lead_id: lead, type: 'stage', stage_from: 'lead', stage_to: 'lost', at: '2026-10-30T16:00:00.000Z' });
  assert.equal(env.apply('lead_activity', 'update', { body: 'x' }, act).code, 'op_not_allowed', 'append-only');
  assert.equal(env.apply('lead_activity', 'create', { lead_id: '01a1163c-1a00-7273-aed1-000000000000', type: 'note', at: '2026-10-30T16:00:00.000Z' }).code, 'not_found');

  const task = env.local('task', { title: 'Call Sam', owner: 'owner', business_id: B.agency, lead_id: lead, due_date: '2026-11-03' });
  assert.equal(env.db.prepare('SELECT lead_id FROM planner_tasks WHERE id = ?').get(task).lead_id, lead);
  assert.equal(env.ctx.services.planner.taskState(task).leadId, lead);
  assert.equal(env.apply('task', 'create', { title: 'X', owner: 'owner', business_id: B.agency, lead_id: '01a1163c-1a00-7273-aed1-000000000000' }).code, 'not_found');
  // Won: names the client (and the relationship) it became.
  const { clientId } = env.client('Won Co', [[B.agency, 'website']]);
  const lead2 = env.local('lead', { name: 'Won Co', business_id: B.agency, stage: 'quoted' });
  env.edit('lead', lead2, { stage: 'won', won_client_id: clientId, closed_at: '2026-10-30T16:00:00.000Z' });
  // A win's own row names the client it went to and what it made (to find a lead won twice).
  const winRow = env.local('lead_activity', { lead_id: lead2, type: 'stage', stage_from: 'quoted', stage_to: 'won', at: '2026-10-30T16:00:00.000Z', won_client_id: clientId, won_made: `client:${clientId}` });
  assert.equal(env.db.prepare('SELECT won_client_id FROM crm_lead_activities WHERE id = ?').get(winRow).won_client_id, clientId);
  assert.deepEqual(env.ctx.services.crm.liveLeads().map((l) => l.id).sort(), [lead, lead2].sort());
  // Only through sync.
  assert.throws(() => env.db.prepare("UPDATE crm_leads SET name = 'x' WHERE id = ?").run(lead));
  // An inbox item can become a lead.
  const item = env.local('inbox_item', { text: 'Pat at the farmers market wants a site', captured_at: '2026-10-30T15:00:00.000Z' });
  env.edit('inbox_item', item, { cleared_at: '2026-10-30T16:00:00.000Z', became_entity: 'lead', became_id: lead });
});

test('cross-sell: one task per business on the first workday of the month, once; age-restricted accounts never for another brand', async (t) => {
  const env = await setup(t, { start: '2026-11-01 09:00' });
  const bab = env.client('Brantford Auto Body', [[B.agency, 'website']], { contact: { name: 'Sam', email: 'sam@bab.ca' } });
  env.local('consent', { contact_id: bab.contactId, business_id: B.agency, withdrawn: false, date: '2026-09-01', kind: 'express' });
  env.client('Coach Pat', [[B.consulting, 'consulting']], { contact: { name: 'Pat', email: 'pat@coach.ca' } });
  // A vape shop: wholesale only → on no list; with a website from the agency → only the agency's social list.
  env.client('Lefty’s Vape', [[B.wholesale, 'wholesale']], { age: true, contact: { name: 'Lefty', email: 'l@vape.ca' } });
  env.client('Smoke Hut', [[B.wholesale, 'wholesale'], [B.agency, 'website']], { age: true });
  env.client('Closed Co', [[B.agency, 'website']], { status: 'closed' });

  assert.deepEqual(env.tick('cross-sell'), [], 'Sunday Nov 1: the first workday is Monday');
  env.setNow('2026-11-02 08:04');
  assert.deepEqual(env.tick('cross-sell'), []);
  env.setNow('2026-11-02 08:06');
  const [run] = env.tick('cross-sell');
  assert.equal(run.status, 'ok', JSON.stringify(run));
  const made = env.tasks("title LIKE 'Cross-sell%'");
  assert.deepEqual(made.map((x) => [x.title, x.business_id, x.due_date]).sort(), [
    ['Cross-sell for November 2026: 1 client for Business consulting', B.consulting, '2026-11-02'],
    ['Cross-sell for November 2026: 3 clients for Great White North Design', B.agency, '2026-11-02'],
  ].sort((a, b) => a[0].localeCompare(b[0])));
  const agency = made.find((x) => x.business_id === B.agency);
  assert.match(agency.notes, /Brantford Auto Body: Website with us, no social media · Sam \(may email\)/);
  assert.match(agency.notes, /Coach Pat: Consulting client, no website from us · Pat \(no email consent: call or ask\)/);
  assert.match(agency.notes, /Smoke Hut: Website with us, no social media/, 'the agency already works with it');
  assert.match(agency.notes, /Nothing has been sent/);
  assert.match(agency.notes, /\(as of Nov 2, 2026\):/, 'the day in words');
  const consulting = made.find((x) => x.business_id === B.consulting);
  assert.doesNotMatch(consulting.notes, /Smoke Hut|Lefty/, 'consulting has no relationship with the age-restricted accounts');
  for (const x of made) assert.doesNotMatch(x.notes, /Lefty’s Vape|Closed Co/);
  assert.equal(agency.owner, env.ctx.services.planner.automatedOwnerFor(B.agency));

  // Once per month: the scheduler again, Run now and the next day make nothing new.
  env.setNow('2026-11-03 09:00');
  assert.deepEqual(env.tick('cross-sell'), []);
  assert.equal(env.autos.runNow('cross-sell').createdCount, 0);
  assert.equal(env.tasks("title LIKE 'Cross-sell%'").length, 2);
  // An open lead takes a line off next month's list; December 1 2026 is a Tuesday.
  env.local('lead', { name: 'Brantford Auto Body', business_id: B.agency, kind: 'social', stage: 'talking', client_id: bab.clientId, account_id: bab.accountId });
  env.setNow('2026-12-01 08:06');
  const [dec] = env.tick('cross-sell');
  assert.equal(dec.status, 'ok');
  const decAgency = env.tasks("title LIKE 'Cross-sell for December%' AND business_id = ?", B.agency)[0];
  assert.equal(decAgency.title, 'Cross-sell for December 2026: 2 clients for Great White North Design');
  assert.doesNotMatch(decAgency.notes, /no social media · Sam/);
});

test('cross-sell lines: capped, with the rest on the page', () => {
  const entry = (i) => ({ client: { name: `C${i}` }, account: { name: `C${i}` }, pair: { why: 'Why' }, contacts: [] });
  const lines = crossSellLines(Array.from({ length: CROSS_SELL_NOTES_MAX + 3 }, (_, i) => entry(i)));
  assert.equal(lines.length, CROSS_SELL_NOTES_MAX + 1);
  assert.match(lines.at(-1), /…and 3 more on the Cross-sell page/);
  assert.equal(lines[0], '• C0: Why · no contact on file');
});

test('leads with no next step: off by default; when on, one task per flagged lead, capped, never a second while open', async (t) => {
  const env = await setup(t);
  const def = env.autos.list().find((a) => a.id === 'lead-no-next-step');
  assert.deepEqual(def.defaults, { enabled: false, alert: false });
  env.autos.setSettings('lead-no-next-step', { enabled: true }, { actor: 'owner' });
  const leads = [];
  for (let i = 0; i < LEAD_STEP_CAP + 2; i += 1) {
    leads.push(env.local('lead', { name: `Lead ${String(i).padStart(2, '0')}`, business_id: B.agency, stage: 'lead', owner: i === 0 ? 'partner' : null }));
  }
  const covered = env.local('lead', { name: 'Covered', business_id: B.agency, stage: 'talking' });
  env.local('task', { title: 'Send the quote', owner: 'owner', business_id: B.agency, lead_id: covered, due_date: '2026-11-04' });
  env.local('lead', { name: 'Won one', business_id: B.agency, stage: 'won', won_client_id: env.client('X', []).clientId });
  env.edit('business', B.consulting, { archived: true });
  env.local('lead', { name: 'Archived business', business_id: B.consulting, stage: 'lead' });

  env.setNow('2026-10-31 07:36');
  const [run] = env.tick('lead-no-next-step');
  assert.equal(run.status, 'ok', JSON.stringify(run));
  assert.match(run.summary, /Made 10 tasks; 2 more waiting/);
  const made = env.tasks('lead_id IS NOT NULL AND title LIKE ?', 'Set the next step%');
  assert.equal(made.length, LEAD_STEP_CAP);
  assert.deepEqual(made.map((x) => x.lead_id), leads.slice(0, LEAD_STEP_CAP), 'oldest first');
  assert.equal(made[0].title, 'Set the next step for Lead 00 (Great White North Design)');
  assert.equal(made[0].owner, 'partner', 'the lead’s owner');
  assert.equal(made[1].owner, env.ctx.services.planner.automatedOwnerFor(B.agency));
  assert.equal(made[0].due_date, '2026-10-31');
  // The next day: the two waiting get theirs; the open ones are not made again.
  env.setNow('2026-11-01 07:36');
  env.tick('lead-no-next-step');
  assert.equal(env.tasks('lead_id IS NOT NULL AND title LIKE ?', 'Set the next step%').length, LEAD_STEP_CAP + 2);
  // Finished without a real next step: the flag comes back and a new task is made.
  env.edit('task', made[0].id, { done_at: '2026-11-01T14:00:00.000Z' });
  env.setNow('2026-11-02 07:36');
  env.tick('lead-no-next-step');
  assert.equal(env.tasks('lead_id = ? AND done_at IS NULL', leads[0]).length, 1);
});
