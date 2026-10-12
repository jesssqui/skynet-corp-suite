// Quotes, invoices and credit notes (D17/D18), server side: the record types and their checks (drafts only change while
// drafts, fields only the server writes, Wholesale / Save Point Shop / Personal refused), gap-free numbers per business
// and kind given only when a person approves a draft (with the fingerprint of what they saw), the stored PDF (valid,
// the same bytes every time, never changed), sending a lead's quote moves the lead to Quoted with its value, the 7-day
// follow-up task (finished when the quote is decided), invoices in sales as money comes in (payments on their day,
// credit notes taking it back), void, overdue invoices on the overview, the business details, and the HTTP routes.
// The server's local time zone is Toronto's.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { createHlc } from '@suite/shared/hlc';
import { BUSINESS_IDS as B } from '@suite/shared/crm';
import { LEAD_STAGE_FIELDS } from '@suite/shared/leads';
import { documentFingerprint } from '@suite/shared/billing';
import { modules } from '../src/modules/index.js';
import { atLocal } from '../src/modules/automations/schedule.js';
import { KEPT_TABLES } from '../src/backup/restore.js';
import { renderDocument } from '../src/modules/billing/document.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor } from './helpers.js';

const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};

async function setup(t, { start = '2026-10-12 10:00' } = {}) {
  const clock = testClock();
  clock.offsetMs = at(start) - Date.now();
  const env = await startApp(t, testConfig(tmpDir(t)), { modules, now: clock.now });
  const users = await ensureTestUsers(env.ctx);
  const { sync, billing } = env.ctx.services;
  const local = (entity, fields, actor = 'owner') => {
    const r = sync.applyLocal({ actor, entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  // A phone: its steps go through the module's checks (server code's own steps don't).
  const phone = (actor = 'owner') => {
    const { deviceId } = sessionFor(env.ctx, users[actor]);
    const clockH = createHlc(deviceId, { wallClock: clock.now });
    const step = (entity, op, recordId, fields) => {
      const s = { key: newId(), entity, recordId, op, hlc: clockH.now(), seen: sync.info().cursor, ...(op === 'delete' ? {} : { fields }) };
      const r = sync.push({ actor, deviceId, steps: [s] }).results[0];
      return r;
    };
    return {
      create: (entity, fields, id = newId()) => ({ id, ...step(entity, 'create', id, fields) }),
      update: (entity, id, fields) => step(entity, 'update', id, fields),
      remove: (entity, id) => step(entity, 'delete', id),
    };
  };
  const row = (table, id) => env.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const tasks = (where = '1', ...args) => env.db.prepare(`SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND ${where} ORDER BY created_at, id`).all(...args);
  const setNow = (s) => { clock.offsetMs = at(s) - Date.now(); };
  const client = (name) => {
    const clientId = local('client', { name, status: 'active' });
    const accountId = local('account', { client_id: clientId, name });
    const relationshipId = local('relationship', { account_id: accountId, business_id: B.agency, kind: 'website', status: 'active' });
    return { clientId, accountId, relationshipId };
  };
  /** A draft with lines, written by a phone; → { id, lines } */
  const draft = (dev, kind, fields, lines = [{ description: 'Website build', unit_cents: 250000 }]) => {
    const doc = dev.create(kind, { status: 'draft', ...fields });
    assert.equal(doc.status, 'applied', JSON.stringify(doc));
    const parent = { quote: 'quote_id', invoice: 'invoice_id', credit_note: 'credit_note_id' }[kind];
    for (const [i, l] of lines.entries()) {
      const r = dev.create(`${kind}_line`, { [parent]: doc.id, position: i, ...l });
      assert.equal(r.status, 'applied', JSON.stringify(r));
    }
    return doc.id;
  };
  const fp = (kind, id) => documentFingerprint(billing.lines ? row({ quote: 'billing_quotes', invoice: 'billing_invoices', credit_note: 'billing_credit_notes' }[kind], id) : null, billing.lines(kind, id));
  const approve = (kind, id, { actor = 'owner', today = '2026-10-12', fingerprint = fp(kind, id) } = {}) => billing.approve(kind, id, { actor, today, fingerprint });
  return { ...env, users, clock, sync, billing, local, phone, row, tasks, setNow, client, draft, fp, approve };
}

const salesRows = (env, business) => env.db.prepare("SELECT * FROM sales_daily WHERE source = 'invoices' AND store = ? ORDER BY day").all(`invoices:${business}`);

test('records: drafts change only while drafts; server-only fields, statuses and blocked businesses are refused', async (t) => {
  const env = await setup(t);
  const dev = env.phone();
  const { clientId } = env.client('Alpha Bakery');
  // Wholesale, Save Point Shop and Personal never bill here.
  for (const b of [B.wholesale, B.save_point, B.personal]) {
    const r = dev.create('quote', { status: 'draft', business_id: b, to_name: 'X' });
    assert.equal(r.status, 'rejected');
    assert.equal(r.code, 'invalid_value');
  }
  assert.equal(dev.create('quote', { status: 'sent', business_id: B.agency }).status, 'rejected', 'a new quote is a draft');
  assert.equal(dev.create('quote', { status: 'draft', business_id: B.agency, number: 'GWND-Q-9999' }).status, 'rejected', 'the number is the server’s');
  assert.equal(dev.create('invoice', { status: 'draft', business_id: B.agency }).status, 'rejected', 'an invoice names its client');
  const q = env.draft(dev, 'quote', { business_id: B.agency, client_id: clientId, to_name: 'Alpha Bakery', title: 'New website' });
  assert.equal(dev.update('quote', q, { title: 'New website and logo' }).status, 'applied');
  assert.equal(dev.update('quote', q, { status: 'sent' }).status, 'rejected', 'sending is approving, on the server');
  assert.equal(dev.update('quote', q, { total_cents: 1 }).status, 'rejected');
  assert.equal(dev.update('quote', q, { decided_on: '2026-10-12' }).status, 'rejected', 'no decision on a draft');
  // Sent: what it says is locked; lines too; it can't be deleted; it can be decided.
  env.approve('quote', q);
  const line = env.db.prepare('SELECT id FROM billing_quote_lines WHERE quote_id = ?').get(q).id;
  assert.equal(dev.update('quote', q, { title: 'Changed' }).code, 'locked');
  assert.equal(dev.update('quote_line', line, { unit_cents: 1 }).code, 'locked');
  assert.equal(dev.create('quote_line', { quote_id: q, description: 'Extra', unit_cents: 100 }).code, 'locked');
  assert.equal(dev.remove('quote_line', line).code, 'locked');
  assert.equal(dev.remove('quote', q).code, 'locked');
  assert.equal(dev.update('quote', q, { status: 'draft' }).status, 'rejected');
  assert.equal(dev.update('quote', q, { account_id: null }).status, 'applied', 'links aren’t printed: they may change');
  assert.equal(dev.update('quote', q, { status: 'accepted', decided_on: '2026-10-13' }).status, 'applied');
  // Invoices: the status is the server's; payments only on an issued invoice; credit notes only for an issued one.
  const inv = env.draft(dev, 'invoice', { business_id: B.agency, client_id: clientId, to_name: 'Alpha Bakery' });
  assert.equal(dev.create('invoice_payment', { invoice_id: inv, amount_cents: 100, paid_on: '2026-10-12' }).status, 'rejected');
  assert.equal(dev.create('credit_note', { status: 'draft', invoice_id: inv, business_id: B.agency }).status, 'rejected');
  assert.equal(dev.update('invoice', inv, { status: 'issued' }).status, 'rejected');
  assert.equal(dev.update('invoice', inv, { due_days: 400 }).status, 'rejected');
  assert.equal(dev.update('invoice', inv, { tax_rate_bp: 9000 }).status, 'rejected');
  env.approve('invoice', inv);
  assert.equal(dev.create('invoice_payment', { invoice_id: inv, amount_cents: 0, paid_on: '2026-10-12' }).status, 'rejected', 'more than 0');
  assert.equal(dev.create('invoice_payment', { invoice_id: inv, amount_cents: 500, paid_on: '2026-10-12' }).status, 'applied');
  assert.equal(dev.create('credit_note', { status: 'draft', invoice_id: inv, business_id: B.consulting }).status, 'rejected', 'the invoice’s own business');
  assert.equal(dev.create('credit_note', { status: 'draft', invoice_id: inv, business_id: B.agency }).status, 'applied');
  // A draft can be deleted (a mistake); an issued one can't.
  const scrap = env.draft(dev, 'invoice', { business_id: B.agency, client_id: clientId, to_name: 'x' });
  assert.equal(dev.remove('invoice', scrap).status, 'applied');
  assert.equal(dev.remove('invoice', inv).code, 'locked');
});

test('numbers: per business and kind, gap-free, given only when a draft is approved; a retry gives the same number', async (t) => {
  const env = await setup(t);
  const dev = env.phone();
  const { clientId } = env.client('Alpha Bakery');
  const q1 = env.draft(dev, 'quote', { business_id: B.agency, to_name: 'Alpha' });
  const q2 = env.draft(dev, 'quote', { business_id: B.agency, to_name: 'Beta' });
  const c1 = env.draft(dev, 'quote', { business_id: B.consulting, to_name: 'Gamma' });
  const empty = env.draft(dev, 'quote', { business_id: B.agency, to_name: 'Delta' }, []);
  // Not ready (no lines), or the fingerprint isn't what is on the server: refused, and no number is used up.
  assert.throws(() => env.approve('quote', empty), (e) => e.status === 400 && e.code === 'not_ready' && /at least one line/.test(e.message));
  assert.throws(() => env.approve('quote', q1, { fingerprint: 'deadbeef' }), (e) => e.status === 409 && e.code === 'changed');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM billing_counters').get().n, 0);
  assert.equal(env.approve('quote', q1).number, 'GWND-Q-0001');
  assert.equal(env.approve('quote', c1).number, 'BC-Q-0001', 'another business counts on its own');
  const again = env.approve('quote', q1, { fingerprint: 'anything' });
  assert.deepEqual([again.number, again.already], ['GWND-Q-0001', true], 'a retried request changes nothing');
  // A prefix of our own from the settings.
  env.billing.putSettings(B.agency, { prefix: 'gw' }, { actor: 'owner' });
  assert.equal(env.billing.settingsFor(B.agency).next.quote, 'GW-Q-0002');
  assert.equal(env.approve('quote', q2).number, 'GW-Q-0002');
  const inv = env.draft(dev, 'invoice', { business_id: B.agency, client_id: clientId, to_name: 'Alpha' });
  assert.equal(env.approve('invoice', inv).number, 'GW-INV-0001', 'invoices count apart from quotes');
  // Numbers never repeat and leave no gap: the PDFs' sequence per business and kind is 1, 2, … with no hole.
  const seqs = env.db.prepare("SELECT seq FROM billing_pdfs WHERE business_id = ? AND kind = 'quote' ORDER BY seq").pluck().all(B.agency);
  assert.deepEqual(seqs, [1, 2]);
  // Kept across restores with the details: never given twice, even when the database goes back.
  for (const table of ['billing_settings', 'billing_counters', 'billing_pdfs']) assert.ok(KEPT_TABLES.includes(table), table);
  // An issued document never changes.
  assert.throws(() => env.db.prepare("UPDATE billing_pdfs SET number = 'X' WHERE doc_id = ?").run(q1), /never changes/);
});

test('the PDF: a valid file with the document on it, the same bytes every time, stored once and served as stored', async (t) => {
  const env = await setup(t);
  const dev = env.phone();
  env.billing.putSettings(B.agency, {
    legal_name: 'Great White North Design', address: '12 Main St\nSimcoe, ON N3Y 1A1', hst_number: '123456789rt0001', email: 'hello@example.ca',
    payment_instructions: 'Interac e-Transfer to pay@example.ca', invoice_due_days: 15,
  }, { actor: 'owner' });
  assert.equal(env.billing.settingsFor(B.agency).hst_number, '123456789 RT0001', 'stored in one shape');
  assert.throws(() => env.billing.putSettings(B.agency, { hst_number: '12345' }, { actor: 'owner' }), (e) => e.code === 'bad_hst');
  assert.throws(() => env.billing.putSettings(B.wholesale, {}, { actor: 'owner' }), (e) => e.code === 'not_by_billing');
  const { clientId } = env.client('Café Déjà Vu');
  const inv = env.draft(dev, 'invoice', { business_id: B.agency, client_id: clientId, to_name: 'Café Déjà Vu', to_lines: '1 Queen St\nSimcoe ON', title: 'Website (phase 1)' }, [
    { description: 'Design — “home” and (about) pages', quantity: 10, unit_cents: 9500 },
    { description: 'Domain (resold)', unit_cents: 2500, tax_exempt: true },
  ]);
  const draftPdf = env.billing.pdfOf('invoice', inv, { today: '2026-10-12' });
  assert.equal(draftPdf.draft, true);
  assert.match(draftPdf.pdf.toString('latin1'), /\(DRAFT\) Tj/);
  const out = env.approve('invoice', inv);
  assert.equal(out.number, 'GWND-INV-0001');
  const record = env.row('billing_invoices', inv);
  assert.deepEqual([record.status, record.issue_date, record.due_date, record.subtotal_cents, record.tax_cents, record.total_cents],
    ['issued', '2026-10-12', '2026-10-27', 97500, 12350, 109850], 'HST on the taxable $950 only; due in the business’s 15 days');
  const stored = env.billing.pdfOf('invoice', inv);
  assert.equal(stored.draft, false);
  assert.equal(stored.filename, 'GWND-INV-0001.pdf');
  const text = stored.pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n') && text.trimEnd().endsWith('%%EOF'));
  for (const s of ['(GWND-INV-0001)', '(HST # 123456789 RT0001)', '(Caf\\351 D\\351j\\340 Vu)', '\\(about\\)', '($1,098.50) Tj', '(Interac e-Transfer to pay@example.ca)', '(* No HST on this line)']) {
    assert.ok(text.includes(s), `the PDF says ${s}`);
  }
  assert.doesNotMatch(text, /DRAFT/);
  // A well-formed file: every xref offset points at its object.
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  const entries = text.slice(xref).split('\n').slice(3).filter((l) => / n $/.test(l));
  entries.forEach((l, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, Number(l.slice(0, 10))), `object ${i + 1}`));
  // The same document gives the same bytes (no dates, no random ids), and what is stored is what was made.
  const input = {
    kind: 'invoice', number: 'GWND-INV-0001', business: { name: 'Great White North Design', color: '#1d6fa5' }, settings: env.billing.settingsFor(B.agency),
    doc: { to_name: 'Café Déjà Vu', title: 'Website (phase 1)', tax_rate_bp: 1300 }, lines: env.billing.lines('invoice', inv), date: '2026-10-12', dueDate: '2026-10-27',
  };
  assert.ok(renderDocument(input).equals(renderDocument(input)));
  const pdfRow = env.db.prepare("SELECT sha256, made_by, made_on, total_cents FROM billing_pdfs WHERE kind = 'invoice' AND doc_id = ?").get(inv);
  assert.deepEqual([pdfRow.made_by, pdfRow.made_on, pdfRow.total_cents], ['owner', '2026-10-12', 109850]);
  // Many lines go onto more pages, each with "Page n of m".
  const long = renderDocument({ ...input, lines: Array.from({ length: 60 }, (_, i) => ({ id: String(i).padStart(3, '0'), position: i, description: `Line ${i}`, unit_cents: 100 })) }).toString('latin1');
  assert.match(long, /\/Count 3 >>/);
  assert.ok(long.includes('(Great White North Design \\267 GWND-INV-0001 \\267 Page 3 of 3) Tj'));
});

test('sending a lead’s quote: the lead moves to Quoted (its whole stage set, a stage row, the value); the follow-up task', async (t) => {
  const env = await setup(t);
  const dev = env.phone();
  const lead = env.local('lead', { name: 'Alpha Bakery', business_id: B.agency, kind: 'website', stage: 'talking', stage_changed_at: '2026-10-01T12:00:00.000Z', owner: 'owner' });
  const q = env.draft(dev, 'quote', { business_id: B.agency, lead_id: lead, to_name: 'Alpha Bakery', title: 'New website' }, [
    { description: 'Website', unit_cents: 200000 }, { description: 'Logo', unit_cents: 50000 },
  ]);
  const out = env.approve('quote', q);
  assert.equal(out.lead, 'quoted');
  const l = env.row('crm_leads', lead);
  assert.deepEqual([l.stage, l.value_cents, l.value_period, l.closed_at, l.lost_reason], ['quoted', 250000, 'once', null, null], 'value before HST');
  // The whole stage set was written in one step (so a move on a device at the same time settles as one).
  const step = env.db.prepare("SELECT fields FROM sync_steps WHERE entity = 'lead' AND record_id = ? ORDER BY seq DESC LIMIT 1").get(lead);
  for (const f of LEAD_STAGE_FIELDS) assert.ok(Object.hasOwn(JSON.parse(step.fields), f), f);
  const rows = env.db.prepare('SELECT * FROM crm_lead_activities WHERE lead_id = ? ORDER BY at').all(lead);
  assert.deepEqual(rows.map((r) => [r.type, r.stage_from, r.stage_to]), [['stage', 'talking', 'quoted']]);
  assert.match(rows[0].body, /^Quote GWND-Q-0001 sent: \$2,825\.00 \(\$2,500\.00 before HST\)$/);
  const quote = env.row('billing_quotes', q);
  assert.deepEqual([quote.status, quote.sent_on, quote.sent_by, quote.valid_until, quote.total_cents], ['sent', '2026-10-12', 'owner', '2026-11-11', 282500]);
  // The follow-up: due a week later, the lead's next step (it names the lead), for the business's default owner.
  const [task] = env.tasks('lead_id = ?', lead);
  assert.equal(task.title, 'Follow up on quote GWND-Q-0001 for Alpha Bakery');
  assert.deepEqual([task.due_date, task.owner, task.business_id, task.done_at], ['2026-10-19', 'owner', B.agency, null]);
  // A second quote for the same (now Quoted) lead: a new value and a note; no second stage move.
  const q2 = env.draft(dev, 'quote', { business_id: B.agency, lead_id: lead, to_name: 'Alpha Bakery' }, [{ description: 'Website, smaller', unit_cents: 150000 }]);
  assert.equal(env.approve('quote', q2).lead, 'value');
  assert.equal(env.row('crm_leads', lead).value_cents, 150000);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM crm_lead_activities WHERE lead_id = ? AND type = 'stage'").get(lead).n, 1);
  // Declining the first on a device finishes its follow-up (the suite's own note says why); the second is still open.
  env.setNow('2026-10-15 09:00');
  assert.equal(dev.update('quote', q, { status: 'declined', decided_on: '2026-10-15', declined_reason: 'price' }).status, 'applied');
  const t1 = env.tasks('title LIKE ?', '%GWND-Q-0001%')[0];
  assert.ok(t1.done_at);
  assert.match(t1.notes, /Quote GWND-Q-0001 was declined on Oct 15, 2026 — finished by the suite/);
  const t2 = env.tasks('title LIKE ?', '%GWND-Q-0002%')[0];
  assert.equal(t2.done_at, null);
  // A person finishes the second themselves; it is never made again, and accepting later leaves it alone.
  env.sync.applyLocal({ actor: 'owner', entity: 'task', op: 'update', recordId: t2.id, fields: { done_at: '2026-10-15T14:00:00.000Z' } });
  env.ctx.services.automations.emit('billing.changed', { key: newId() });
  assert.equal(env.tasks('title LIKE ?', '%GWND-Q-0002%').length, 1);
  assert.equal(dev.update('quote', q2, { status: 'accepted', decided_on: '2026-10-16' }).status, 'applied');
  assert.equal(env.tasks('title LIKE ?', '%GWND-Q-0002%')[0].done_at, '2026-10-15T14:00:00.000Z');
  // A lead already lost (or won) only gets a note.
  const lost = env.local('lead', { name: 'Gone Ltd', business_id: B.agency, stage: 'lost', lost_reason: 'timing', closed_at: '2026-10-01T12:00:00.000Z' });
  const q3 = env.draft(dev, 'quote', { business_id: B.agency, lead_id: lost, to_name: 'Gone Ltd' });
  assert.equal(env.approve('quote', q3, { today: '2026-10-16' }).lead, 'note');
  assert.equal(env.row('crm_leads', lost).stage, 'lost');
});

test('HTTP: settings, approving with the fingerprint, the PDF (inline or to download), void; a phone needs a session', async (t) => {
  const env = await setup(t);
  const dev = env.phone();
  const { cookie } = sessionFor(env.ctx, env.users.partner);
  const headers = { cookie, origin: env.base, 'content-type': 'application/json' };
  const call = async (method, path, body) => {
    const res = await fetch(`${env.base}/api/billing${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, csp: res.headers.get('content-security-policy'), nosniff: res.headers.get('x-content-type-options'), type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), draft: res.headers.get('x-billing-draft'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  assert.equal((await fetch(`${env.base}/api/billing/settings`)).status, 401);
  const list = await call('GET', '/settings');
  assert.deepEqual(list.body.businesses.map((b) => b.name), ['Great White North Design', 'Business consulting', 'Retail stores']);
  const put = await call('PUT', `/settings/${B.consulting}`, { legal_name: 'Rho Consulting', prefix: 'rc', invoice_due_days: 0 });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.business.prefix, put.body.business.invoice_due_days, put.body.business.updatedBy], ['RC', 0, 'partner']);
  assert.equal((await call('PUT', `/settings/${B.consulting}`, { prefix: 'too-long-prefix' })).body.code, 'bad_prefix');
  const { clientId } = env.client('Alpha Bakery');
  const inv = env.draft(dev, 'invoice', { business_id: B.consulting, client_id: clientId, to_name: 'Alpha Bakery' });
  const preview = await call('GET', `/pdf/invoice/${inv}?today=2026-10-12`);
  assert.deepEqual([preview.status, preview.type, preview.draft], [200, 'application/pdf', '1']);
  assert.equal((await call('POST', `/invoices/${inv}/issue`, { today: '2026-10-12', fingerprint: 'nope' })).status, 409);
  const issued = await call('POST', `/invoices/${inv}/issue`, { today: '2026-10-12', fingerprint: env.fp('invoice', inv) });
  assert.deepEqual([issued.status, issued.body.number], [200, 'RC-INV-0001']);
  assert.equal(env.row('billing_invoices', inv).due_date, '2026-10-12', 'due on receipt');
  const pdf = await call('GET', `/pdf/invoice/${inv}?download=1`);
  assert.deepEqual([pdf.status, pdf.draft, pdf.disposition], [200, '0', 'attachment; filename="RC-INV-0001.pdf"']);
  assert.equal(pdf.csp, null, 'no page CSP on a PDF (built-in viewers refuse it); nosniff stays');
  assert.equal(pdf.nosniff, 'nosniff');
  assert.ok(pdf.body.equals(env.billing.pdfOf('invoice', inv).pdf));
  assert.equal((await call('GET', `/pdf/quote/${inv}`)).status, 404);
  assert.equal((await call('POST', `/invoices/${inv}/void`, { reason: 'Sent to the wrong client' })).status, 200);
  assert.equal(env.row('billing_invoices', inv).status, 'void');
  const archive = await call('GET', '/archive');
  assert.deepEqual(archive.body.documents.map((d) => [d.number, d.inDatabase]), [['RC-INV-0001', true]]);
});
