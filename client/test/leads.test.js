// Leads and the pipeline (D8) without React: the lead form (only what changed is sent on an edit),
// stage changes, the pipeline's columns and totals, the duplicate check before a win, the win as store
// writes with ids made once, a call's next step, the client page's view, and against a real server with
// two devices: edits from both survive, a win made offline and retried after a failure part-way never
// makes a second client, a win for a current client adds only the relationship, and a next step clears
// the "No next step" flag on both devices. Invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS as B } from '@suite/shared/crm';
import { leadsWithoutNextStep } from '@suite/shared/leads';
import { newId } from '@suite/shared/ids';
import { startServer, makeDevice, row, count } from './helpers.js';
import { valuesFrom, editChanges } from '../src/modules/crm/formFields.js';
import {
  leadForm, newLeadFields, stageChange, saveStageChange, filterLeads, pipelineView, valueText, leadValueText, daysInStage, leadDuplicate,
  winIds, planWin, applyWin, leadNextStepFields, nextStepOf, clientLeads, leadTimelineItems, crossSellLeadFields,
} from '../src/modules/crm/leads.js';
import { clearedFields } from '../src/modules/planner/logic.js';

const TODAY = '2026-10-09';
const NOW = '2026-10-09T15:00:00.000Z';
const ids = () => winIds(newId);

test('the lead form: required name and business, dollars to cents, CAD stored as none; an edit sends only what changed', () => {
  const blank = valuesFrom(leadForm, null);
  assert.deepEqual(Object.keys(leadForm.toFields(blank).problems).sort(), ['business_id', 'name']);
  const v = { ...blank, name: ' Brantford Auto Body ', business_id: B.agency, value: '2,500', value_period: 'once', currency: 'cad', email: 'sam@bab.ca' };
  const { fields, problems } = leadForm.toFields(v);
  assert.deepEqual(problems, {});
  assert.equal(fields.name, 'Brantford Auto Body');
  assert.equal(fields.value_cents, 250000);
  assert.equal(fields.currency, null, 'CAD is the default');
  assert.equal(fields.account_id, null, 'no account without a client');
  assert.equal(leadForm.toFields({ ...v, currency: 'usd' }).fields.currency, 'USD');
  assert.ok(leadForm.toFields({ ...v, currency: 'dollars' }).problems.currency);
  assert.ok(leadForm.toFields({ ...v, value: 'lots' }).problems.value);
  assert.equal(leadForm.toFields({ ...v, value: '' }).fields.value_period, null, 'no value, no period');
  assert.deepEqual(newLeadFields({ name: 'X' }, { now: NOW }), { name: 'X', stage: 'lead', stage_changed_at: NOW });

  const record = { id: 'l1', name: 'BAB', business_id: B.agency, stage: 'talking', value_cents: 30000, value_period: 'monthly', currency: null, notes: 'Hi' };
  const start = valuesFrom(leadForm, record);
  assert.equal(start.value, '300');
  assert.deepEqual(editChanges(leadForm, start, start).fields, {});
  assert.deepEqual(editChanges(leadForm, start, { ...start, value: '350' }).fields, { value_cents: 35000 });
  assert.deepEqual(editChanges(leadForm, start, { ...start, notes: 'Hello' }).fields, { notes: 'Hello' });
  assert.ok(!('stage' in leadForm.toFields(start).fields), 'the stage moves with its own buttons');
});

test('stage changes: won only through a win; lost needs a reason; reopening clears the close', () => {
  const lead = { id: 'l1', stage: 'talking', name: 'BAB' };
  assert.ok(stageChange(lead, 'won').problem);
  assert.ok(stageChange(lead, 'talking').problem);
  assert.ok(stageChange(lead, 'lost').problem);
  const q = stageChange(lead, 'quoted', { now: NOW });
  assert.deepEqual(q.fields, { stage: 'quoted', stage_changed_at: NOW });
  assert.deepEqual(q.activity, { lead_id: 'l1', type: 'stage', stage_from: 'talking', stage_to: 'quoted', body: null, at: NOW });
  const lost = stageChange(lead, 'lost', { now: NOW, reason: 'price', note: ' Too dear ' });
  assert.deepEqual(lost.fields, { stage: 'lost', stage_changed_at: NOW, lost_reason: 'price', lost_note: 'Too dear', closed_at: NOW });
  assert.equal(lost.activity.body, 'Price: Too dear');
  assert.deepEqual(stageChange({ ...lead, stage: 'lost' }, 'talking', { now: NOW }).fields, { stage: 'talking', stage_changed_at: NOW, closed_at: null });
});

test('the pipeline: columns by stage, this month’s won and lost, totals per currency; filters', () => {
  const leads = [
    { id: 'a', name: 'Alpha Bakery', stage: 'lead', business_id: B.agency, value_cents: 100000, stage_changed_at: '2026-10-01T12:00:00.000Z', email: 'pat@alpha.ca' },
    { id: 'b', name: 'Beta Barbers', stage: 'lead', business_id: B.consulting, value_cents: 5000, value_period: 'monthly', currency: 'USD', stage_changed_at: '2026-10-05T12:00:00.000Z', phone: '5195550100' },
    { id: 'c', name: 'Gamma Gym', stage: 'quoted', business_id: B.agency, owner: 'partner' },
    { id: 'd', name: 'Delta Deli', stage: 'won', business_id: B.agency, value_cents: 200000, closed_at: '2026-10-03T12:00:00.000Z' },
    { id: 'e', name: 'Echo Eats', stage: 'won', business_id: B.agency, closed_at: '2026-09-03T12:00:00.000Z' },
    { id: 'f', name: 'Fox Fitness', stage: 'lost', business_id: B.agency, lost_reason: 'price', closed_at: '2026-10-08T12:00:00.000Z' },
  ];
  const v = pipelineView(leads, { today: TODAY });
  assert.deepEqual(v.columns.lead.map((l) => l.id), ['b', 'a'], 'most recently moved first');
  assert.deepEqual(v.columns.quoted.map((l) => l.id), ['c']);
  assert.deepEqual(v.won.map((l) => l.id), ['d'], 'won this month only');
  assert.deepEqual(v.lost.map((l) => l.id), ['f']);
  assert.equal(valueText(v.totals.stages.lead.value), '$1,000 · US$600');
  assert.equal(v.totals.wonThisMonth, 1);
  assert.deepEqual(filterLeads(leads, { business: B.consulting }).map((l) => l.id), ['b']);
  assert.deepEqual(filterLeads(leads, { q: 'gamma' }).map((l) => l.id), ['c']);
  assert.deepEqual(filterLeads(leads, { q: 'alpha.ca' }).map((l) => l.id), ['a']);
  assert.deepEqual(filterLeads(leads, { q: '555-01' }).map((l) => l.id), ['b']);
  assert.deepEqual(filterLeads(leads, { owner: 'partner' }).map((l) => l.id), ['c']);
  assert.equal(leadValueText(leads[1]), 'US$50/mo (US$600 in a year)');
  assert.equal(leadValueText(leads[0]), '$1,000 one-off');
  assert.equal(daysInStage(leads[0], TODAY), 8);
  assert.equal(nextStepOf([
    { id: 't1', due_date: '2026-10-20' }, { id: 't2', due_date: '2026-10-12' }, { id: 't3', due_date: null }, { id: 't4', due_date: '2026-10-01', done_at: NOW },
  ]).id, 't2');
  assert.equal(nextStepOf([]), null);
});

test('before a win: a likely client already here (same email or phone, similar name)', () => {
  const data = {
    clients: [{ id: 'c1', name: 'Brantford Auto Body', status: 'active' }],
    accounts: [{ id: 'a1', client_id: 'c1', name: 'Brantford Auto Body' }],
    contacts: [{ id: 'p1', client_id: 'c1', name: 'Sam', email: 'sam@bab.ca', phone: null }],
  };
  assert.equal(leadDuplicate({ name: 'BAB Collision', email: 'sam@bab.ca' }, data).state, 'same');
  assert.equal(leadDuplicate({ name: 'Brantford Auto Body Inc.' }, data).state, 'similar');
  assert.equal(leadDuplicate({ name: 'Somebody Else' }, data), null);
  assert.equal(leadDuplicate({ name: 'Brantford Auto Body', client_id: 'c1' }, data), null, 'a cross-sell lead already names its client');
});

test('planWin: a new client makes client, account, contact, relationship, a milestone, then the lead and its stage row', () => {
  const lead = { id: 'l1', name: 'Alpha Bakery', stage: 'quoted', business_id: B.agency, kind: 'website', contact_name: 'Pat', email: 'pat@alpha.ca', value_cents: 250000 };
  const i = ids();
  const plan = planWin(lead, { clientId: '', kind: '', startDate: '2026-10-12', businessName: 'GWND' }, {}, i, { now: NOW, today: TODAY });
  assert.deepEqual(plan.steps.map((s) => `${s.op} ${s.entity}`), [
    'create client', 'create account', 'create contact', 'create relationship', 'create activity', 'update lead', 'create lead_activity',
  ]);
  assert.deepEqual(plan.steps[0].fields, { name: 'Alpha Bakery', status: 'active' });
  assert.deepEqual(plan.steps[2].fields, { client_id: i.client, account_id: i.account, name: 'Pat', email: 'pat@alpha.ca', phone: null });
  assert.deepEqual(plan.steps[3].fields, { account_id: i.account, business_id: B.agency, kind: 'website', status: 'active', start_date: '2026-10-12' });
  assert.equal(plan.steps[4].fields.type, 'milestone');
  assert.match(plan.steps[4].fields.body, /Won the lead “Alpha Bakery”: Website with GWND \(\$2,500 one-off\)/);
  assert.deepEqual(plan.steps[5].fields, { stage: 'won', won_client_id: i.client, won_relationship_id: i.relationship, kind: 'website', closed_at: NOW, stage_changed_at: NOW });
  assert.deepEqual([plan.clientId, plan.accountId, plan.relationshipId], [i.client, i.account, i.relationship]);
  assert.ok(planWin({ ...lead, kind: null }, { clientId: '' }, {}, i).problem, 'what we do for them is needed');
  assert.equal(planWin({ ...lead, contact_name: null, email: null }, { clientId: '' }, {}, i).steps.filter((s) => s.entity === 'contact').length, 0, 'no person, no contact');
});

test('planWin: a current client gets only what it lacks — the relationship on its account; a known contact isn’t repeated; an ended one is made active again', () => {
  const lead = { id: 'l2', name: 'Lefty’s', stage: 'talking', business_id: B.agency, kind: 'social', email: 'pat@leftys.ca', client_id: 'c1', account_id: 'a1' };
  const data = {
    accounts: [{ id: 'a1', client_id: 'c1', name: 'Lefty’s' }],
    contacts: [{ id: 'p1', client_id: 'c1', name: 'Pat', email: 'pat@leftys.ca' }],
    relationships: [{ id: 'r1', account_id: 'a1', business_id: B.agency, kind: 'website', status: 'active' }],
  };
  const i = ids();
  const plan = planWin(lead, { clientId: 'c1', accountId: 'a1', kind: 'social' }, data, i, { now: NOW, today: TODAY });
  assert.deepEqual(plan.steps.map((s) => `${s.op} ${s.entity}`), ['create relationship', 'create activity', 'update lead', 'create lead_activity']);
  assert.equal(plan.steps[0].fields.start_date, TODAY);
  const ended = { ...data, relationships: [...data.relationships, { id: 'r2', account_id: 'a1', business_id: B.agency, kind: 'social', status: 'ended' }] };
  const again = planWin(lead, { clientId: 'c1', accountId: 'a1', kind: 'social' }, ended, i, { now: NOW });
  assert.deepEqual(again.steps[0], { op: 'update', entity: 'relationship', id: 'r2', fields: { status: 'active' } });
  assert.equal(again.relationshipId, 'r2');
  assert.ok(planWin(lead, { clientId: 'c1', accountId: 'nope', kind: 'social' }, data, i).problem);
  const newAccount = planWin(lead, { clientId: 'c1', accountId: '', kind: 'social' }, data, i, { now: NOW });
  assert.deepEqual(newAccount.steps.slice(0, 2).map((s) => s.entity), ['account', 'relationship'], 'a new account under the same client');
});

test('a call’s next step, the client page’s leads and timeline items, a cross-sell line as a lead', () => {
  const lead = { id: 'l1', name: 'Alpha', business_id: B.agency, client_id: 'c1', account_id: 'a1' };
  assert.deepEqual(leadNextStepFields({ title: '', date: '' }, { lead, me: 'owner' }), { fields: null, problems: {} });
  assert.deepEqual(Object.keys(leadNextStepFields({ title: 'Call back', date: '' }, { lead, me: 'owner' }).problems), ['date']);
  assert.deepEqual(leadNextStepFields({ title: 'Call back', date: '2026-10-12' }, { lead, me: 'partner' }).fields, {
    title: 'Call back', owner: 'partner', business_id: B.agency, lead_id: 'l1', client_id: 'c1', account_id: 'a1', due_date: '2026-10-12',
  });
  const leads = [
    { id: 'x', client_id: 'c1', stage: 'won', stage_changed_at: '2026-10-08T00:00:00.000Z' },
    { id: 'y', client_id: null, won_client_id: 'c1', stage: 'won', stage_changed_at: '2026-10-01T00:00:00.000Z' },
    { id: 'z', client_id: 'c1', stage: 'talking', stage_changed_at: '2026-09-01T00:00:00.000Z' },
    { id: 'w', client_id: 'c2', stage: 'lead' },
  ];
  assert.deepEqual(clientLeads(leads, 'c1').map((l) => l.id), ['z', 'x', 'y'], 'open first');
  const items = leadTimelineItems([
    { id: 'la1', lead_id: 'y', type: 'call', body: 'Talked', at: NOW },
    { id: 'la2', lead_id: 'y', type: 'stage', stage_from: 'quoted', stage_to: 'won', at: NOW },
  ], new Map([['y', { id: 'y', name: 'Alpha', business_id: B.agency, won_relationship_id: 'r9' }]]), new Map([['r9', { id: 'r9', account_id: 'a9' }]]));
  assert.deepEqual(items.map((x) => [x.source, x.type, x.account_id, x.business_id]), [['lead_activity', 'call', 'a9', B.agency], ['lead_activity', 'milestone', 'a9', B.agency]]);
  assert.equal(items[1].body, 'Lead “Alpha”: Quoted → Won');
  const entry = {
    pair: { why: 'Website with us, no social media', to: { business: B.agency, kind: 'social' } },
    client: { id: 'c1', name: 'Lefty’s' }, account: { id: 'a1', client_id: 'c1', name: 'Lefty’s Garage' },
    contacts: [{ contact: { id: 'p0', name: 'Owner', account_id: null } }, { contact: { id: 'p1', name: 'Gary', account_id: 'a1' } }],
  };
  assert.deepEqual(crossSellLeadFields(entry, { me: 'owner', now: NOW }), {
    name: 'Lefty’s Garage', client_id: 'c1', account_id: 'a1', business_id: B.agency, kind: 'social', source: 'cross_sell', stage: 'lead',
    stage_changed_at: NOW, owner: 'owner', contact_name: 'Gary', notes: 'From the cross-sell list: Website with us, no social media.',
  });
});

// ---- two devices against a real server ------------------------------------------------------------

async function devices(t) {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  return { server, mac, phone };
}

test('two devices: a lead added offline syncs; an open edit sheet keeps the other person’s change; stage moves', async (t) => {
  const { server, mac, phone } = await devices(t);
  phone.online = false;
  const id = await phone.engine.create('lead', newLeadFields(leadForm.toFields({
    ...valuesFrom(leadForm, null), name: 'Alpha Bakery', business_id: B.agency, kind: 'website', value: '2500', email: ' Pat@Alpha.ca ', owner: 'partner',
  }).fields));
  assert.equal((await phone.engine.get('lead', id)).email, 'pat@alpha.ca', 'shown at once, cleaned');
  phone.online = true;
  await phone.engine.syncNow();
  assert.deepEqual([row(server.db, 'crm_leads', id).stage, row(server.db, 'crm_leads', id).created_by], ['lead', 'partner']);

  await mac.engine.syncNow();
  const start = valuesFrom(leadForm, await mac.engine.get('lead', id));
  await phone.engine.update('lead', id, { value_cents: 300000 });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const edit = editChanges(leadForm, start, { ...start, notes: 'Wants a shop too' });
  assert.deepEqual(edit.fields, { notes: 'Wants a shop too' });
  await mac.engine.update('lead', id, edit.fields);
  await mac.engine.syncNow();
  const r = row(server.db, 'crm_leads', id);
  assert.deepEqual([r.value_cents, r.notes], [300000, 'Wants a shop too'], 'both changes survive');
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_clashes'), 0);

  // Moves: talking, then lost needs a reason (refused by the server too, landing in Needs attention).
  const lead = await mac.engine.get('lead', id);
  await saveStageChange(mac.engine, lead, stageChange(lead, 'talking'));
  await mac.engine.syncNow();
  assert.equal(row(server.db, 'crm_leads', id).stage, 'talking');
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM crm_lead_activities WHERE lead_id = ?', id), 1);
  await phone.engine.syncNow();
  await phone.engine.update('lead', id, { stage: 'lost' }); // no reason: the store lets it by, the server refuses it
  await phone.engine.syncNow();
  assert.equal(row(server.db, 'crm_leads', id).stage, 'talking');
  assert.ok((await phone.engine.attentionList()).some((a) => a.step.recordId === id && a.code === 'invalid_value'));
});

test('two devices: a win made offline, failing part-way and retried, makes one client; the lead names it', async (t) => {
  const { server, mac, phone } = await devices(t);
  const leadId = await phone.engine.create('lead', newLeadFields({ name: 'Gamma Gym', business_id: B.agency, kind: 'website', contact_name: 'Gia', phone: '519 555 0199' }));
  await phone.engine.syncNow();
  phone.online = false;
  const lead = await phone.engine.get('lead', leadId);
  const kept = ids(); // made once per lead (the sheet keeps them until the win is saved)
  const data = async () => ({ accounts: await phone.engine.list('account'), contacts: await phone.engine.list('contact'), relationships: await phone.engine.list('relationship') });
  const plan1 = planWin(lead, { clientId: '', kind: 'website', startDate: TODAY, businessName: 'GWND' }, await data(), kept, { now: NOW, today: TODAY });
  // The first try fails after three writes (say, the phone ran out of space).
  let writes = 0;
  const flaky = {
    create: (...a) => { writes += 1; if (writes > 3) throw Object.assign(new Error('full'), { code: 'storage_full' }); return phone.engine.create(...a); },
    update: (...a) => phone.engine.update(...a),
  };
  await assert.rejects(applyWin(flaky, plan1));
  // Retry (the same ids; the data now holds what the first try made): nothing is made twice.
  const plan2 = planWin(await phone.engine.get('lead', leadId), { clientId: '', kind: 'website', startDate: TODAY, businessName: 'GWND' }, await data(), kept, { now: NOW, today: TODAY });
  await applyWin(phone.engine, plan2);
  await applyWin(phone.engine, plan2); // a double tap
  const offline = await phone.engine.get('lead', leadId);
  assert.deepEqual([offline.stage, offline.won_client_id], ['won', kept.client], 'won at once, offline');
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(count(server.db, "SELECT count(*) AS n FROM crm_clients WHERE name = 'Gamma Gym'"), 1);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM crm_accounts WHERE client_id = ?', kept.client), 1);
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM crm_contacts WHERE client_id = ?', kept.client), 1);
  const rel = server.db.prepare('SELECT * FROM crm_relationships WHERE account_id = ?').all(kept.account);
  assert.deepEqual(rel.map((x) => [x.business_id, x.kind, x.status, x.start_date]), [[B.agency, 'website', 'active', TODAY]]);
  const won = row(server.db, 'crm_leads', leadId);
  assert.deepEqual([won.stage, won.won_client_id, won.won_relationship_id], ['won', kept.client, rel[0].id]);
  assert.equal(count(server.db, "SELECT count(*) AS n FROM crm_activities WHERE client_id = ? AND type = 'milestone'", kept.client), 1);
  assert.equal(row(server.db, 'crm_contacts', kept.contact).phone, '5195550199');
  assert.equal((await phone.engine.attentionList()).length, 0);
  // The Mac sees the client with the lead won into it.
  await mac.engine.syncNow();
  assert.equal(clientLeads(await mac.engine.list('lead'), kept.client)[0].id, leadId);
});

test('two devices: a win for a current client adds only the relationship; a next step clears "No next step" on both', async (t) => {
  const { server, mac, phone } = await devices(t);
  const clientId = await mac.engine.create('client', { name: 'Lefty’s', status: 'active' });
  const accountId = await mac.engine.create('account', { client_id: clientId, name: 'Lefty’s' });
  await mac.engine.create('relationship', { account_id: accountId, business_id: B.agency, kind: 'website', status: 'active' });
  const leadId = await mac.engine.create('lead', newLeadFields({ name: 'Lefty’s', business_id: B.agency, kind: 'social', client_id: clientId, account_id: accountId, source: 'cross_sell' }));
  await mac.engine.syncNow();
  await phone.engine.syncNow();

  // Flagged on both devices until a dated task names it.
  const flagged = async (dev) => leadsWithoutNextStep({ leads: await dev.engine.list('lead'), tasks: await dev.engine.list('task') }).map((l) => l.id);
  assert.deepEqual(await flagged(mac), [leadId]);
  assert.deepEqual(await flagged(phone), [leadId]);
  phone.online = false;
  const lead = await phone.engine.get('lead', leadId);
  await phone.engine.create('lead_activity', { lead_id: leadId, type: 'call', body: 'Interested in Instagram', at: NOW });
  const next = leadNextStepFields({ title: 'Send the social proposal', date: '2026-10-14' }, { lead, me: 'partner' });
  await phone.engine.create('task', next.fields);
  assert.deepEqual(await flagged(phone), [], 'cleared at once, offline');
  phone.online = true;
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  assert.deepEqual(await flagged(mac), [], 'and on the other device');

  // Win: only a relationship (+ the milestone and the lead's update) — no new client or account.
  const before = [count(server.db, 'SELECT count(*) AS n FROM crm_clients'), count(server.db, 'SELECT count(*) AS n FROM crm_accounts')];
  const plan = planWin(await mac.engine.get('lead', leadId), { clientId, accountId, kind: 'social', businessName: 'GWND' }, {
    accounts: await mac.engine.list('account'), contacts: await mac.engine.list('contact'), relationships: await mac.engine.list('relationship'),
  }, ids(), { now: NOW, today: TODAY });
  await applyWin(mac.engine, plan);
  await mac.engine.syncNow();
  assert.deepEqual([count(server.db, 'SELECT count(*) AS n FROM crm_clients'), count(server.db, 'SELECT count(*) AS n FROM crm_accounts')], before);
  assert.deepEqual(server.db.prepare('SELECT kind FROM crm_relationships WHERE account_id = ? ORDER BY kind').all(accountId).map((r) => r.kind), ['social', 'website']);
  assert.equal(row(server.db, 'crm_leads', leadId).won_client_id, clientId);
  assert.deepEqual(await flagged(mac), [], 'a won lead is never flagged');
});

test('two devices: an inbox item becomes a lead', async (t) => {
  const { server, mac, phone } = await devices(t);
  const item = await phone.engine.create('inbox_item', { text: 'Coach Pat wants a website\nmet at the market', source: 'phone', captured_at: NOW });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const leadId = await mac.engine.create('lead', newLeadFields({ name: 'Coach Pat wants a website', notes: 'met at the market', business_id: B.agency, source: 'inbox' }));
  await mac.engine.update('inbox_item', item, clearedFields({ entity: 'lead', id: leadId, now: NOW }));
  await mac.engine.syncNow();
  const r = row(server.db, 'planner_inbox_items', item);
  assert.deepEqual([r.became_entity, r.became_id], ['lead', leadId]);
});
