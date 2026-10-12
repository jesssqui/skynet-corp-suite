// D8c: campaigns — the starter three made once, two levels, a lead in several campaigns (no double
// membership), the import putting new leads in Email Outreach, and a deleted starter staying deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { CAMPAIGN_IDS } from '@suite/shared/campaigns';
import { tmpDir, testConfig, startApp } from './helpers.js';

async function setup(t) {
  const app = await startApp(t, testConfig(tmpDir(t)));
  const sync = app.ctx.services.sync;
  const apply = (entity, op, fields, recordId = newId(), actor = 'owner') => sync.applyLocal({ actor, entity, op, recordId, fields });
  const campaigns = () => app.db.prepare('SELECT * FROM crm_campaigns WHERE deleted_at IS NULL ORDER BY position').all();
  const lead = () => {
    const r = apply('lead', 'create', { name: 'Test Lead', business_id: BUSINESS_IDS.agency, stage: 'lead' });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  return { ...app, sync, apply, campaigns, lead };
}

test('the starter campaigns: Email Outreach with two sub-campaigns, made once', async (t) => {
  const s = await setup(t);
  const rows = s.campaigns();
  assert.deepEqual(rows.map((c) => c.name), ['Email Outreach', '$595 One Off Website Package', 'In Person Visit']);
  assert.equal(rows[0].parent_id, null);
  assert.deepEqual([rows[1].parent_id, rows[2].parent_id], [CAMPAIGN_IDS.email_outreach, CAMPAIGN_IDS.email_outreach]);
  assert.deepEqual(s.ctx.services.crm.seedCampaigns(), [], 'a second start makes nothing');
  assert.equal(s.campaigns().length, 3);
});

test('a starter campaign deleted in the app stays deleted; one renamed keeps its name', async (t) => {
  const s = await setup(t);
  assert.equal(s.apply('campaign', 'update', { name: 'Cold Email' }, CAMPAIGN_IDS.email_outreach).status, 'applied');
  assert.equal(s.apply('campaign', 'delete', null, CAMPAIGN_IDS.in_person).status, 'applied');
  s.ctx.services.crm.seedCampaigns();
  assert.deepEqual(s.campaigns().map((c) => c.name), ['Cold Email', '$595 One Off Website Package']);
});

test('two levels only: a sub-campaign can’t have sub-campaigns, a campaign with some can’t move under another', async (t) => {
  const s = await setup(t);
  const deeper = s.apply('campaign', 'create', { name: 'Too deep', parent_id: CAMPAIGN_IDS.in_person });
  assert.equal(deeper.status, 'rejected');
  assert.match(deeper.reason, /two levels/);
  const other = s.apply('campaign', 'create', { name: 'Referrals' });
  assert.equal(other.status, 'applied');
  const move = s.apply('campaign', 'update', { parent_id: other.recordId }, CAMPAIGN_IDS.email_outreach);
  assert.equal(move.status, 'rejected');
  assert.match(move.reason, /sub-campaigns/);
  const self = s.apply('campaign', 'update', { parent_id: other.recordId }, other.recordId);
  assert.equal(self.status, 'rejected');
  assert.equal(s.apply('campaign', 'update', { parent_id: other.recordId }, CAMPAIGN_IDS.in_person).status, 'applied', 'a sub-campaign can move to another main one');
});

test('a lead can be in several campaigns; leaving deletes the membership; a campaign that isn’t there is refused', async (t) => {
  const s = await setup(t);
  const leadId = s.lead();
  const join = (campaign_id) => s.apply('lead_campaign', 'create', { lead_id: leadId, campaign_id });
  const a = join(CAMPAIGN_IDS.email_outreach);
  const b = join(CAMPAIGN_IDS.in_person);
  assert.equal(a.status, 'applied');
  assert.equal(b.status, 'applied');
  assert.equal(s.apply('lead_campaign', 'delete', null, b.recordId).status, 'applied');
  assert.equal(join(CAMPAIGN_IDS.in_person).status, 'applied', 'can join again after leaving');
  assert.equal(join(CAMPAIGN_IDS.in_person).status, 'applied', 'a double add (two devices) is harmless, not a refused step');
  assert.equal(s.apply('lead_campaign', 'create', { lead_id: leadId, campaign_id: newId() }).status, 'rejected');
});

test('the leads import puts every new lead in Email Outreach — unless that campaign is gone', async (t) => {
  const s = await setup(t);
  const header = 'company_name,contact_email';
  const { ensureTestUsers, sessionFor } = await import('./helpers.js');
  const users = await ensureTestUsers(s.ctx);
  const who = sessionFor(s.ctx, users.owner);
  const commit = async (text) => {
    const res = await fetch(`${s.base}/api/crm/leads/import/commit`, {
      method: 'POST', headers: { cookie: who.cookie, origin: s.base, 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: newId(), text, fileName: 'x.csv' }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).batch;
  };
  const batch = await commit(`${header}\nAlpha Co,alpha@example.test\nBeta Co,beta@example.test\n`);
  assert.equal(batch.imported, 2);
  const inCampaign = (name) => s.db.prepare(`SELECT m.campaign_id FROM crm_lead_campaigns m JOIN crm_leads l ON l.id = m.lead_id
    WHERE l.name = ? AND m.deleted_at IS NULL`).all(name).map((r) => r.campaign_id);
  assert.deepEqual(inCampaign('Alpha Co'), [CAMPAIGN_IDS.email_outreach]);
  assert.deepEqual(inCampaign('Beta Co'), [CAMPAIGN_IDS.email_outreach]);

  s.apply('campaign', 'delete', null, CAMPAIGN_IDS.email_outreach);
  const later = await commit(`${header}\nGamma Co,gamma@example.test\n`);
  assert.equal(later.imported, 1);
  assert.deepEqual(inCampaign('Gamma Co'), [], 'no campaign to put it in');
});
