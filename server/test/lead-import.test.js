// D8b: importing leads from a research / outreach CSV — preview flags (nothing written), the lead,
// its timeline and next-step task made through sync.applyLocal (in the sync log), excluded rows as
// lost, bounced / bad values kept in the notes, idempotent re-imports (and a newer export adding only
// new rows), skipping what is already a lead or a client, the guards, and a big file in chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { leadsWithoutNextStep } from '@suite/shared/leads';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;
const COLUMNS = [
  'schema_version', 'lead_id', 'company_name', 'industry', 'city', 'province', 'business_phone', 'website_url', 'website_status',
  'contact_email', 'email_consent_status', 'estimated_value', 'currency', 'priority', 'pipeline_stage', 'first_contacted_on',
  'last_contacted_on', 'next_action_on', 'next_action', 'reply_status', 'last_outreach_subject', 'subject_verified', 'sales_angle',
  'outreach_bucket', 'do_not_email', 'suppressed_email', 'research_status', 'import_notes', 'offer_code', 'qualification_notes',
];
const quote = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Rows as objects -> a CSV with the export's header (BOM, CRLF — what the research export has). */
const csv = (rows, columns = COLUMNS) => `﻿${[columns.join(','), ...rows.map((r) => columns.map((c) => quote(String(r[c] ?? ''))).join(','))].join('\r\n')}`;

const SENT = {
  lead_id: 'lead_a1', company_name: 'North Shore Reno', industry: 'Home renovations', city: 'Simcoe', province: 'ON',
  business_phone: '+15195550111', website_status: 'facebook_only', contact_email: 'NSReno@Example.test', email_consent_status: 'not_recorded',
  estimated_value: '595', currency: 'CAD', priority: 'high', pipeline_stage: 'contacted', first_contacted_on: '2026-10-11',
  last_contacted_on: '2026-10-11', next_action_on: '2026-10-21', next_action: 'review_inbox_then_qualify_follow_up',
  reply_status: 'awaiting_reply', last_outreach_subject: 'North Shore Reno — an idea for showcasing your work', subject_verified: 'false',
  sales_angle: 'Portfolio page with an estimate form.', outreach_bucket: 'contacted', do_not_email: 'YES - already contacted',
  research_status: 'legacy_unverified', import_notes: 'Legacy directory research.', offer_code: 'starter_website_intro_595',
  qualification_notes: 'Google listing points to Facebook.',
};
const FRESH = {
  lead_id: 'lead_b2', company_name: 'Delhi Heating', industry: 'HVAC', city: 'Delhi', province: 'ON', business_phone: '(519) 555-0122',
  contact_email: 'hvac@example.test', email_consent_status: 'unassessed', estimated_value: '595', currency: 'CAD', priority: 'Medium',
  pipeline_stage: 'researched', reply_status: 'not_contacted', outreach_bucket: 'research_pending', research_status: 'legacy_unverified',
  offer_code: 'starter_595', sales_angle: 'Heating-season lead generation.',
};
const EXCLUDED = {
  lead_id: 'lead_c3', company_name: 'Hush Plumbing', city: 'Simcoe', province: 'ON', contact_email: 'hush@example.test', pipeline_stage: 'on_hold',
  reply_status: 'on_hold', outreach_bucket: 'excluded', do_not_email: 'YES - excluded', import_notes: 'Owner asked not to be contacted.',
  estimated_value: '595', currency: 'CAD',
};
const BOUNCED = {
  lead_id: 'lead_d4', company_name: 'Bounce Bakery', city: 'Delhi', province: 'ON', contact_email: '', suppressed_email: 'bounced@example.test',
  pipeline_stage: 'on_hold', reply_status: 'bounced_undeliverable', outreach_bucket: 'bounced_suppressed', do_not_email: 'YES - bounce',
  estimated_value: '595', currency: 'CAD',
};
const MESSY = {
  lead_id: 'lead_e5', company_name: 'Odd Details Ltd', city: 'Waterford', province: 'ON', business_phone: '555-0199', contact_email: 'not an email',
  pipeline_stage: 'researched', reply_status: 'not_contacted', estimated_value: 'a lot', currency: 'CAD', next_action_on: 'soonish', outreach_bucket: 'research_pending',
};

async function setup(t) {
  const app = await startApp(t, testConfig(tmpDir(t)));
  const users = await ensureTestUsers(app.ctx);
  const owner = sessionFor(app.ctx, users.owner);
  const partner = sessionFor(app.ctx, users.partner);
  const call = async (method, path, body, who = owner) => {
    const res = await fetch(`${app.base}${path}`, {
      method,
      headers: { cookie: who.cookie, origin: app.base, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const preview = async (text, extra = {}) => {
    const r = await call('POST', '/api/crm/leads/import/preview', { text, fileName: 'research.csv', ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const commit = async (text, who = owner, extra = {}) => {
    const r = await call('POST', '/api/crm/leads/import/commit', { batchId: newId(), text, fileName: 'research.csv', ...extra }, who);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.batch;
  };
  const count = (table, where = 'deleted_at IS NULL') => app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
  const lead = (name) => app.db.prepare('SELECT * FROM crm_leads WHERE name = ? AND deleted_at IS NULL').get(name);
  const apply = (entity, fields, actor = 'owner') => {
    const r = app.ctx.services.sync.applyLocal({ actor, entity, op: 'create', recordId: newId(), fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  return { ...app, users, owner, partner, call, preview, commit, count, lead, apply };
}

test('preview: rows flagged and cleaned, nothing written', async (t) => {
  const s = await setup(t);
  const steps = s.count('sync_steps', '1 = 1');
  const p = await s.preview(csv([SENT, FRESH, EXCLUDED, BOUNCED, MESSY]));
  assert.equal(s.count('sync_steps', '1 = 1'), steps, 'a preview writes nothing');
  assert.equal(s.count('crm_leads'), 0);
  assert.equal(p.total, 5);
  assert.deepEqual(p.counts, { new: 5, imported: 0, exists: 0, client: 0, duplicate: 0, invalid: 0 });
  assert.equal(p.willBeLost, 1, 'the excluded row');
  assert.equal(p.willMakeTasks, 1, 'only the row with a next-step date');
  assert.equal(p.alreadyEmailed, 1);
  assert.equal(p.rowsWithWarnings, 1, 'the row with bad values');
  const [sent, , excluded, bounced, messy] = p.rows;
  assert.deepEqual([sent.row, sent.name, sent.stage, sent.email, sent.phone, sent.nextStep, sent.emailed],
    [2, 'North Shore Reno', 'lead', 'nsreno@example.test', '5195550111', '2026-10-21', true]);
  assert.equal(excluded.stage, 'lost');
  assert.equal(bounced.email, null, 'a bounced address is not kept as the contact address');
  assert.equal(messy.phone, null);
  assert.equal(messy.email, null);
  assert.ok(messy.warnings.length >= 3, messy.warnings.join(' | '));
});

test('commit: the lead, its timeline and its next-step task, through sync, as the person who imported', async (t) => {
  const s = await setup(t);
  const steps = s.count('sync_steps', '1 = 1');
  const batch = await s.commit(csv([SENT, FRESH]), s.partner);
  assert.deepEqual([batch.imported, batch.skipped, batch.failed, batch.tasks, batch.lost], [2, 0, 0, 1, 0]);
  assert.equal(batch.actor, 'partner');
  assert.ok(batch.finishedAt);
  assert.equal(s.count('sync_steps', '1 = 1') - steps, batch.records, 'every record is a sync step devices will pull');

  const l = s.lead('North Shore Reno');
  assert.deepEqual(
    [l.business_id, l.kind, l.source, l.stage, l.owner, l.email, l.phone, l.value_cents, l.value_period, l.currency, l.created_by],
    [AGENCY, 'website', 'scraped', 'lead', 'partner', 'nsreno@example.test', '5195550111', 59500, 'once', null, 'partner'],
  );
  assert.equal(l.stage_changed_at, new Date(2026, 9, 11, 12).toISOString(), 'dated from the file, not from the import');
  assert.match(l.notes, /Imported from “research.csv” \(row 2\)\./);
  assert.match(l.notes, /Home renovations · Simcoe, ON/);
  assert.match(l.notes, /Email consent \(CASL\): not cleared/);
  assert.match(l.notes, /Do not email \(from the export\): already contacted/);
  assert.match(l.notes, /Angle: Portfolio page/);

  const timeline = s.db;
  const acts = timeline.prepare('SELECT * FROM crm_lead_activities WHERE lead_id = ? AND deleted_at IS NULL').all(l.id);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].type, 'email');
  assert.equal(acts[0].at, new Date(2026, 9, 11, 12).toISOString());
  assert.match(acts[0].body, /Intro email sent on 2026-10-11\. Subject: “North Shore Reno — an idea for showcasing your work” \(taken from the research export, not checked against the sent email\)\. Reply status: awaiting reply\./);

  const task = s.db.prepare('SELECT * FROM planner_tasks WHERE lead_id = ? AND deleted_at IS NULL').get(l.id);
  assert.deepEqual([task.title, task.due_date, task.owner, task.business_id], ['Follow up: North Shore Reno', '2026-10-21', 'partner', AGENCY]);
  assert.match(task.notes, /Review inbox then qualify follow up — from the research export \(reply status: awaiting reply\)\./);

  const fresh = s.lead('Delhi Heating');
  assert.equal(fresh.stage_changed_at.slice(0, 10), new Date().toISOString().slice(0, 10), 'no contact date: the import moment');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM crm_lead_activities WHERE lead_id = ?').get(fresh.id).n, 0);

  // The suite's own "No next step" rule: the dated lead is covered, the other is flagged (it is truthful).
  const flagged = leadsWithoutNextStep({
    leads: s.ctx.services.crm.liveLeads(),
    tasks: s.db.prepare('SELECT * FROM planner_tasks WHERE deleted_at IS NULL').all(),
  });
  assert.deepEqual(flagged.map((x) => x.name), ['Delhi Heating']);
});

test('excluded rows come in as lost (not a fit), bounced and bad values go to the notes', async (t) => {
  const s = await setup(t);
  const batch = await s.commit(csv([EXCLUDED, BOUNCED, MESSY]));
  assert.deepEqual([batch.imported, batch.lost, batch.failed, batch.tasks], [3, 1, 0, 0]);

  const hush = s.lead('Hush Plumbing');
  assert.deepEqual([hush.stage, hush.lost_reason, hush.owner], ['lost', 'not_a_fit', 'owner']);
  assert.equal(hush.lost_note, 'Excluded in the research export: Owner asked not to be contacted.');
  assert.ok(hush.closed_at, 'closed when imported');
  const stage = s.db.prepare("SELECT * FROM crm_lead_activities WHERE lead_id = ? AND type = 'stage'").get(hush.id);
  assert.deepEqual([stage.stage_from, stage.stage_to], ['lead', 'lost']);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE lead_id = ?').get(hush.id).n, 0, 'no task for a lost lead');

  const bounce = s.lead('Bounce Bakery');
  assert.equal(bounce.email, null);
  assert.match(bounce.notes, /Email bounced — not kept as the contact address: bounced@example\.test/);
  assert.match(bounce.notes, /Do not email \(from the export\): bounce/);

  const odd = s.lead('Odd Details Ltd');
  assert.equal(odd.phone, null);
  assert.equal(odd.email, null);
  assert.equal(odd.value_cents, null);
  assert.match(odd.notes, /Phone as given: 555-0199/);
  assert.match(odd.notes, /Email as given: not an email/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE lead_id = ?').get(odd.id).n, 0, 'a next-step "date" that is not a date makes no task');
});

test('importing the same file again makes nothing; a newer export adds only its new rows', async (t) => {
  const s = await setup(t);
  const first = await s.commit(csv([SENT, FRESH]));
  assert.equal(first.imported, 2);
  const steps = s.count('sync_steps', '1 = 1');

  const p = await s.preview(csv([SENT, FRESH]));
  assert.deepEqual(p.counts, { new: 0, imported: 2, exists: 0, client: 0, duplicate: 0, invalid: 0 });
  const again = await s.commit(csv([SENT, FRESH]));
  assert.deepEqual([again.imported, again.skipped], [0, 2]);
  assert.equal(s.count('sync_steps', '1 = 1'), steps, 'nothing was written');

  // A later export: the same leads, one changed (never applied), one new.
  const changed = { ...SENT, sales_angle: 'A different angle now.', next_action_on: '2026-11-30' };
  const newer = await s.commit(csv([changed, FRESH, EXCLUDED]));
  assert.deepEqual([newer.imported, newer.lost, newer.skipped], [1, 1, 2]);
  assert.match(s.lead('North Shore Reno').notes, /Portfolio page/, 'an existing lead is never overwritten');
  assert.equal(s.count('crm_leads'), 3);
  assert.equal(s.count('planner_tasks'), 1);
});

test('a row already in the pipeline, already a client, or repeated in the file is skipped', async (t) => {
  const s = await setup(t);
  // A lead already here (by email), a client with a contact (by email), a client with a similar name.
  s.apply('lead', { name: 'Someone Else', email: 'hvac@example.test', business_id: AGENCY, stage: 'lead' });
  const clientId = s.apply('client', { name: 'Maple Leaf Dental', status: 'active' });
  s.apply('contact', { client_id: clientId, name: 'Pat', email: 'front@mapledental.test' });
  const dup = { ...FRESH, lead_id: 'lead_dup', company_name: 'Delhi Heating (again)', contact_email: 'nsreno@example.test' };
  const rows = [
    FRESH,
    { ...SENT, lead_id: 'lead_x1', company_name: 'Some Dental Office', contact_email: 'front@mapledental.test', pipeline_stage: 'researched', first_contacted_on: '', last_contacted_on: '', next_action_on: '' },
    { ...FRESH, lead_id: 'lead_x2', company_name: 'Maple Leaf Dental Ltd', contact_email: 'other@example.test' },
    SENT,
    dup,
  ];
  const p = await s.preview(csv(rows));
  assert.deepEqual(p.rows.map((r) => r.status), ['exists', 'client', 'client', 'new', 'duplicate']);
  assert.match(p.rows[1].reason, /Already a client: Maple Leaf Dental \(same email\)/);
  assert.match(p.rows[2].reason, /Maybe already a client: Maple Leaf Dental/);
  assert.equal(p.rows[0].reason, 'Already in the pipeline');
  const batch = await s.commit(csv(rows));
  assert.deepEqual([batch.imported, batch.skipped], [1, 4]);
  assert.equal(s.count('crm_leads'), 2, 'the one it already had, and the one new');
});

test('guards: a column is required, a retried commit answers with its batch, another file under that id is refused', async (t) => {
  const s = await setup(t);
  const noName = await s.call('POST', '/api/crm/leads/import/preview', { text: 'a,b\n1,2\n', fileName: 'x.csv' });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.code, 'no_name_column');
  const empty = await s.call('POST', '/api/crm/leads/import/preview', { text: '   ' });
  assert.equal(empty.status, 400);
  const noRows = await s.call('POST', '/api/crm/leads/import/preview', { text: 'company_name,city\n' });
  assert.equal(noRows.status, 400);
  assert.equal((await s.call('POST', '/api/crm/leads/import/commit', { batchId: 'nope', text: csv([FRESH]) })).status, 400);

  const text = csv([FRESH]);
  const batchId = newId();
  const a = await s.call('POST', '/api/crm/leads/import/commit', { batchId, text, fileName: 'research.csv' });
  assert.equal(a.status, 201);
  const b = await s.call('POST', '/api/crm/leads/import/commit', { batchId, text, fileName: 'research.csv' });
  assert.equal(b.status, 200, 'the same request again (its answer was lost)');
  assert.deepEqual(b.body.batch, a.body.batch);
  const other = await s.call('POST', '/api/crm/leads/import/commit', { batchId, text: csv([MESSY]), fileName: 'research.csv' });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'batch_mismatch');
  assert.equal(s.count('crm_leads'), 1);

  const anon = await fetch(`${s.base}/api/crm/leads/import/preview`, { method: 'POST', headers: { origin: s.base, 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  assert.equal(anon.status, 401, 'signed in only');
});

test('limits and a big file: too many rows are refused; 1,500 rows import in chunks, once', async (t) => {
  const s = await setup(t);
  const many = (n, start = 0) => Array.from({ length: n }, (_, i) => ({
    ...FRESH, lead_id: `lead_n${start + i}`, company_name: `Bulk Business ${start + i} ${'abcdefghij'[(start + i) % 10]}${(start + i) * 7}`,
    contact_email: `bulk${start + i}@example.test`, business_phone: '', next_action_on: '',
  }));
  const tooMany = await s.call('POST', '/api/crm/leads/import/preview', { text: csv(many(2001)), fileName: 'big.csv' });
  assert.equal(tooMany.status, 413);
  assert.equal(tooMany.body.code, 'too_many_rows');

  const text = csv(many(1500));
  const t0 = Date.now();
  const batch = await s.commit(text);
  assert.equal(batch.imported, 1500);
  assert.ok(Date.now() - t0 < 30_000);
  assert.equal(s.count('crm_leads'), 1500);
  const again = await s.commit(text);
  assert.deepEqual([again.imported, again.skipped], [0, 1500]);
});

test('a lead imported is a normal lead: the pipeline moves it like any other', async (t) => {
  const s = await setup(t);
  await s.commit(csv([FRESH]));
  const l = s.lead('Delhi Heating');
  const r = s.ctx.services.sync.applyLocal({
    actor: 'owner', entity: 'lead', op: 'update', recordId: l.id,
    fields: { stage: 'talking', stage_changed_at: new Date().toISOString(), closed_at: null, lost_reason: null, lost_note: null, won_client_id: null, won_relationship_id: null },
  });
  assert.equal(r.status, 'applied', JSON.stringify(r));
  assert.equal(s.lead('Delhi Heating').stage, 'talking');
});

test('D8d: leads imported as "outreach" become "scraped" once; other leads are left alone', async (t) => {
  const s = await setup(t);
  await s.commit(csv([FRESH]));
  const { sync, crm } = s.ctx.services;
  const imported = s.lead('Delhi Heating');
  assert.equal(imported.source, 'scraped');
  // As an older build left it: outreach; plus a lead made by hand with outreach.
  sync.applyLocal({ actor: 'owner', entity: 'lead', op: 'update', recordId: imported.id, fields: { source: 'outreach' } });
  const byHand = sync.applyLocal({ actor: 'owner', entity: 'lead', op: 'create', fields: { name: 'Hand Made', business_id: AGENCY, stage: 'lead', source: 'outreach' } });
  assert.equal(byHand.status, 'applied', JSON.stringify(byHand));
  s.ctx.db.prepare('DELETE FROM crm_backfills').run();
  assert.equal(crm.backfillScrapedSource(), 1);
  assert.equal(s.lead('Delhi Heating').source, 'scraped');
  assert.equal(s.lead('Hand Made').source, 'outreach');
  // Once: a person setting it back is not undone.
  sync.applyLocal({ actor: 'owner', entity: 'lead', op: 'update', recordId: imported.id, fields: { source: 'outreach' } });
  assert.equal(crm.backfillScrapedSource(), 0);
  assert.equal(s.lead('Delhi Heating').source, 'outreach');
});

test('D8e: imported leads that are in no campaign join Email Outreach once', async (t) => {
  const s = await setup(t);
  await s.commit(csv([FRESH, SENT]));
  const { crm } = s.ctx.services;
  const inEmail = () => s.ctx.db.prepare('SELECT lead_id FROM crm_lead_campaigns WHERE deleted_at IS NULL').all().map((r) => r.lead_id);
  // As before campaigns: forget the memberships (raw SQL is fine on a test copy only after removing the guard — use sync deletes).
  for (const m of s.ctx.db.prepare('SELECT id FROM crm_lead_campaigns WHERE deleted_at IS NULL').all()) {
    s.ctx.services.sync.applyLocal({ actor: 'owner', entity: 'lead_campaign', op: 'delete', recordId: m.id });
  }
  assert.equal(inEmail().length, 0);
  const byHand = s.ctx.services.sync.applyLocal({ actor: 'owner', entity: 'lead', op: 'create', fields: { name: 'Hand Made', business_id: AGENCY, stage: 'lead' } });
  assert.equal(byHand.status, 'applied');
  s.ctx.db.prepare('DELETE FROM crm_backfills').run();
  assert.equal(crm.backfillEmailOutreach(), 2);
  assert.equal(inEmail().length, 2);
  assert.ok(!inEmail().includes(s.lead('Hand Made').id));
  assert.equal(crm.backfillEmailOutreach(), 0);
});
