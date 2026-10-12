// Campaigns (D8c) without React, then against a real server with two devices: the starter campaigns
// arrive on both, a lead joins several, a pipeline filter on a main campaign includes its sub-campaigns,
// two devices adding the same campaign leave one chip, leaving removes every copy, and the two-level rule
// shows up as a refused step. Invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS as B } from '@suite/shared/crm';
import { CAMPAIGN_IDS as C } from '@suite/shared/campaigns';
import { startServer, makeDevice, row, count } from './helpers.js';
import { valuesFrom, editChanges } from '../src/modules/crm/formFields.js';
import {
  campaignForm, campaignTree, campaignScope, campaignsByLead, inCampaign, campaignOptions, leadCampaignList, campaignCounts,
  joinCampaign, leaveCampaign, pickableCampaigns,
} from '../src/modules/crm/campaigns.js';
import { filterLeads } from '../src/modules/crm/leads.js';

const camp = (id, name, parent_id = null, extra = {}) => ({ id, name, parent_id, position: null, ...extra });
const CAMPAIGNS = [
  camp('a', 'Email Outreach'), camp('a1', '$595 One Off Website Package', 'a'), camp('a2', 'In Person Visit', 'a'),
  camp('b', 'Referrals'), camp('gone-kid', 'Orphan', 'deleted'),
];

test('the form needs a name; an edit sends only what changed', () => {
  const blank = valuesFrom(campaignForm, null);
  assert.deepEqual(Object.keys(campaignForm.toFields(blank).problems), ['name']);
  const { fields } = campaignForm.toFields({ ...blank, name: ' Door hangers ', parent_id: 'a' });
  assert.deepEqual([fields.name, fields.parent_id, fields.archived], ['Door hangers', 'a', false]);
  const record = { id: 'x', name: 'Door hangers', parent_id: 'a', notes: null, archived: false };
  const start = valuesFrom(campaignForm, record);
  assert.deepEqual(editChanges(campaignForm, start, start).fields, {});
  assert.deepEqual(editChanges(campaignForm, start, { ...start, archived: true }).fields, { archived: true });
  assert.deepEqual(editChanges(campaignForm, start, { ...start, parent_id: '' }).fields, { parent_id: null });
});

test('the tree: main campaigns with their sub-campaigns; one under a deleted campaign is hidden', () => {
  const tree = campaignTree(CAMPAIGNS);
  assert.deepEqual(tree.map((c) => [c.name, c.children.map((k) => k.name)]), [
    ['Email Outreach', ['$595 One Off Website Package', 'In Person Visit']],
    ['Referrals', []],
  ]);
  assert.deepEqual([...campaignScope(CAMPAIGNS, 'a')].sort(), ['a', 'a1', 'a2']);
  assert.deepEqual([...campaignScope(CAMPAIGNS, 'a1')], ['a1']);
});

test('pickers: tree order with “Main › Sub” labels, archived hidden unless kept, mains only for a parent', () => {
  const list = [...CAMPAIGNS.slice(0, 4), camp('c', 'Old', null, { archived: true })];
  assert.deepEqual(campaignOptions(list).map((o) => o.label), ['Email Outreach', 'Email Outreach › $595 One Off Website Package', 'Email Outreach › In Person Visit', 'Referrals']);
  assert.ok(campaignOptions(list, { keep: 'c' }).some((o) => o.value === 'c'));
  assert.deepEqual(campaignOptions(list, { mainOnly: true }).map((o) => o.value), ['a', 'b']);
  assert.equal(pickableCampaigns(list, { excludeId: 'a' }).some((c) => c.id === 'a'), false);
  assert.deepEqual(leadCampaignList(list, new Set(['a2', 'b'])).map((c) => c.label), ['Email Outreach › In Person Visit', 'Referrals']);
});

test('filters and counts: a main campaign counts its sub-campaigns’ leads; “none” is in no campaign', () => {
  const leads = [
    { id: 'l1', name: 'One', stage: 'lead' }, { id: 'l2', name: 'Two', stage: 'won' },
    { id: 'l3', name: 'Three', stage: 'lost' }, { id: 'l4', name: 'Four', stage: 'talking' },
  ];
  const members = [
    { lead_id: 'l1', campaign_id: 'a' }, { lead_id: 'l1', campaign_id: 'a' }, { lead_id: 'l2', campaign_id: 'a1' },
    { lead_id: 'l3', campaign_id: 'a2' }, { lead_id: 'l3', campaign_id: 'a1' }, { lead_id: 'l4', campaign_id: 'deleted' },
  ];
  const byLead = campaignsByLead(members, new Set(CAMPAIGNS.map((c) => c.id)));
  assert.deepEqual([...byLead.get('l1')], ['a'], 'a double add reads once');
  assert.equal(byLead.has('l4'), false, 'a deleted campaign stops counting');
  const pick = (scope) => leads.filter((l) => inCampaign(byLead.get(l.id), scope)).map((l) => l.id);
  assert.deepEqual(pick(campaignScope(CAMPAIGNS, 'a')), ['l1', 'l2', 'l3']);
  assert.deepEqual(pick(campaignScope(CAMPAIGNS, 'a1')), ['l2', 'l3']);
  assert.deepEqual(pick('none'), ['l4']);
  const counts = campaignCounts(CAMPAIGNS, leads, byLead);
  assert.deepEqual(counts.get('a'), { total: 3, open: 1, won: 1, lost: 1 });
  assert.deepEqual(counts.get('a2'), { total: 1, open: 0, won: 0, lost: 1 });
  assert.equal(filterLeads(leads, { q: 'two' }).length, 1, 'the other filters are untouched');
});

async function devices(t) {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  return { server, mac, phone };
}

test('two devices: the starter campaigns arrive, a lead joins several offline, leaving removes every copy', async (t) => {
  const { server, mac, phone } = await devices(t);
  assert.deepEqual((await mac.engine.list('campaign')).map((c) => c.name).sort(), ['$595 One Off Website Package', 'Email Outreach', 'In Person Visit']);
  const leadId = await phone.engine.create('lead', { name: 'Alpha Bakery', business_id: B.agency, stage: 'lead' });
  await phone.engine.syncNow();
  await mac.engine.syncNow();

  // Both add it to In Person Visit while apart; the phone also adds Email Outreach.
  mac.online = false;
  phone.online = false;
  const members = async (dev) => dev.engine.list('lead_campaign');
  assert.equal(await joinCampaign(dev(mac), await members(mac), leadId, C.in_person), true);
  assert.equal(await joinCampaign(dev(phone), await members(phone), leadId, C.in_person), true);
  assert.equal(await joinCampaign(dev(phone), await members(phone), leadId, C.email_outreach), true);
  assert.equal(await joinCampaign(dev(phone), await members(phone), leadId, C.in_person), false, 'already in it on this device');
  mac.online = true;
  phone.online = true;
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  await phone.engine.syncNow();

  const rows = await mac.engine.list('lead_campaign');
  const byLead = campaignsByLead(rows, new Set((await mac.engine.list('campaign')).map((c) => c.id)));
  assert.deepEqual([...byLead.get(leadId)].sort(), [C.email_outreach, C.in_person].sort(), 'in two campaigns, shown once each');
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_clashes'), 0);

  assert.equal(await leaveCampaign(dev(mac), rows, leadId, C.in_person), 2, 'both copies go');
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  const after = campaignsByLead(await phone.engine.list('lead_campaign'), null).get(leadId);
  assert.deepEqual([...after], [C.email_outreach]);
});

test('two devices: a campaign deleted on one hides its sub-campaigns on the other; the two-level rule is a refused step', async (t) => {
  const { server, mac, phone } = await devices(t);
  const sub = await mac.engine.create('campaign', { name: 'Postcards', parent_id: C.in_person });
  await mac.engine.syncNow();
  assert.equal(row(server.db, 'crm_campaigns', sub), undefined, 'a sub-campaign under a sub-campaign never lands');
  await phone.engine.remove('campaign', C.email_outreach);
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const names = (await mac.engine.list('campaign')).map((c) => c.name);
  assert.deepEqual(names, [], 'the main campaign and, with it, its sub-campaigns are gone from view');
});

// A device's store, shaped like the screens' `store`: create / remove through the engine.
function dev(d) {
  return { create: (entity, fields) => d.engine.create(entity, fields), remove: (entity, id) => d.engine.remove(entity, id) };
}
