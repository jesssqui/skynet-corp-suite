// Quotes, invoices and credit notes (D17/D18) on devices: the forms (a line, the details), a new document filled from a
// client, a lead or a CRM service, the lists and where an invoice stands, the email the person sends (the suite sends
// nothing), an invoice from an accepted quote — then two devices against a real server: a draft written offline,
// approving only what was seen (changed on the other device → refused, no number used), what was sent never changes
// (an offline edit lands in Needs attention), accepting a lead's quote wins the lead once (offline, retried), declining
// loses it, and payments recorded on both devices count in sales. Invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS as B } from '@suite/shared/crm';
import { newId } from '@suite/shared/ids';
import { localDate } from '@suite/shared/time';
import { startServer, makeDevice, row, count } from './helpers.js';
import { valuesFrom, editChanges } from '../src/modules/crm/formFields.js';
import { planWin, applyWin, winIds, stageChange, saveStageChange } from '../src/modules/crm/leads.js';
import {
  lineForm, detailsForm, newDocument, createDocument, docIds, recipientFor, serviceLine, invoiceFromQuote, creditNoteFor, listRows, docStatus,
  emailFor, paymentFields, declineFields, approval, approveDocument, linesOf, docTotal, contactFor,
} from '../src/modules/billing/logic.js';

const map = (list) => new Map(list.map((r) => [r.id, r]));

test('a line: description, quantity (1 by default, decimals), price in dollars (a discount is negative), no HST', () => {
  const blank = valuesFrom(lineForm, null);
  assert.deepEqual(Object.keys(lineForm.toFields(blank).problems).sort(), ['description', 'price']);
  let r = lineForm.toFields({ ...blank, description: ' Design ', quantity: '2,5', price: '1,200.50' });
  assert.deepEqual(r.problems, {});
  assert.deepEqual(r.fields, { description: 'Design', quantity: 2.5, unit_cents: 120050, tax_exempt: false });
  r = lineForm.toFields({ ...blank, description: 'Friends discount', price: '-50', tax_exempt: true });
  assert.deepEqual([r.fields.quantity, r.fields.unit_cents, r.fields.tax_exempt], [null, -5000, true], 'quantity 1 is stored as none');
  assert.ok(lineForm.toFields({ ...blank, description: 'x', quantity: '0', price: '1' }).problems.quantity);
  assert.ok(lineForm.toFields({ ...blank, description: 'x', price: 'lots' }).problems.price);
  // An edit sends only what changed.
  const rec = { id: 'l1', description: 'Design', quantity: null, unit_cents: 10000, tax_exempt: false };
  const start = valuesFrom(lineForm, rec);
  assert.deepEqual(editChanges(lineForm, start, { ...start, price: '120' }).fields, { unit_cents: 12000 });
});

test('the details: who it is for is needed; HST 13 % is stored as none; terms in days', () => {
  const start = valuesFrom(detailsForm, { to_name: 'Alpha', tax_rate_bp: null, due_days: null });
  assert.equal(start.tax_rate_bp, '1300');
  assert.deepEqual(editChanges(detailsForm, start, { ...start, tax_rate_bp: '500', due_days: '15' }).fields, { tax_rate_bp: 500, due_days: 15 });
  assert.ok(detailsForm.toFields({ ...start, to_name: ' ' }).problems.to_name);
  assert.ok(detailsForm.toFields({ ...start, due_days: '400' }).problems.due_days);
});

const crm = () => {
  const businesses = [{ id: B.agency, name: 'Great White North Design' }, { id: B.wholesale, name: 'Wholesale' }];
  const clients = [{ id: 'c1', name: 'Alpha Bakery', status: 'active' }];
  const accounts = [{ id: 'a1', client_id: 'c1', name: 'Alpha Bakery', street: '1 Queen St', city: 'Simcoe', region: 'ON', postal_code: 'N3Y 4K3' }];
  const contacts = [{ id: 'p1', client_id: 'c1', account_id: 'a1', name: 'Pat Baker', email: 'pat@alpha.ca' }, { id: 'p2', client_id: 'c1', account_id: null, name: 'Lou' }];
  const relationships = [{ id: 'r1', account_id: 'a1', business_id: B.agency, kind: 'website', status: 'active' }];
  const services = [
    { id: 's1', relationship_id: 'r1', name: 'Website care', billing: 'flat', amount_cents: 15000, period: 'monthly', status: 'active' },
    { id: 's2', relationship_id: 'r1', name: 'Coaching', billing: 'hourly', rate_cents: 12000, sessions: 4, status: 'active' },
  ];
  const leads = [{ id: 'L1', name: 'Beta Bikes', contact_name: 'Sam', email: 'sam@beta.ca', business_id: B.agency, stage: 'talking' }];
  return {
    businesses, businessesById: map(businesses), clients, clientsById: map(clients), accounts, accountsById: map(accounts), contacts, relationships,
    services, servicesById: map(services), leads, leadsById: map(leads),
  };
};

test('a new document: filled from the client (address, contact, email), a lead, or a service (its first line); who may bill', () => {
  const d = crm();
  assert.deepEqual(recipientFor({ account: d.accounts[0], contact: d.contacts[0] }), { to_name: 'Alpha Bakery', to_lines: '1 Queen St\nSimcoe, ON N3Y 4K3\nPat Baker\npat@alpha.ca' });
  assert.equal(contactFor(d.contacts, { clientId: 'c1', accountId: 'a1' }).id, 'p1', 'one with an email first');
  let n = newDocument({ kind: 'invoice', businessId: B.agency, clientId: 'c1', serviceId: 's1' }, d);
  assert.deepEqual(n.problems, {});
  assert.deepEqual(n.fields, {
    status: 'draft', business_id: B.agency, client_id: 'c1', account_id: 'a1', relationship_id: 'r1', to_name: 'Alpha Bakery',
    to_lines: '1 Queen St\nSimcoe, ON N3Y 4K3\nPat Baker\npat@alpha.ca', title: 'Website care', service_id: 's1',
  });
  assert.deepEqual(n.lines, [{ description: 'Website care (monthly)', quantity: 1, unit_cents: 15000 }]);
  assert.deepEqual(serviceLine(d.services[1]), { description: 'Coaching (hours)', quantity: 4, unit_cents: 12000 });
  n = newDocument({ kind: 'quote', businessId: B.agency, leadId: 'L1', title: 'New site' }, d);
  assert.deepEqual([n.fields.lead_id, n.fields.client_id, n.fields.to_name, n.fields.to_lines, n.fields.title], ['L1', null, 'Beta Bikes', 'Sam\nsam@beta.ca', 'New site']);
  assert.ok(newDocument({ kind: 'invoice', businessId: B.agency }, d).problems.clientId, 'an invoice names its client');
  assert.match(newDocument({ kind: 'quote', businessId: B.wholesale, clientId: 'c1' }, d).problems.businessId, /Order Manager/);
});

test('the lists and where things stand; an invoice from an accepted quote; a credit note; the email the person sends', () => {
  const today = '2026-10-20';
  const data = {
    quotes: [
      { id: 'q1', business_id: B.agency, status: 'sent', number: 'GWND-Q-0001', to_name: 'Alpha', title: 'Site', sent_on: '2026-10-01', total_cents: 113000 },
      { id: 'q2', business_id: B.agency, status: 'draft', to_name: 'Beta', _sync: { createdAt: '2026-10-19T12:00:00.000Z' } },
      { id: 'q3', business_id: B.agency, status: 'declined', number: 'GWND-Q-0002', to_name: 'Gamma', sent_on: '2026-09-01', total_cents: 5 },
    ],
    quoteLines: [{ id: 'x1', quote_id: 'q2', position: 0, description: 'A', unit_cents: 10000 }, { id: 'x2', quote_id: 'q2', position: 1, description: 'B', unit_cents: 5000, tax_exempt: true }],
    invoices: [
      { id: 'i1', business_id: B.agency, status: 'issued', number: 'GWND-INV-0001', to_name: 'Alpha', issue_date: '2026-09-01', due_date: '2026-10-01', total_cents: 113000 },
      { id: 'i2', business_id: B.agency, status: 'issued', number: 'GWND-INV-0002', to_name: 'Beta', issue_date: '2026-10-10', due_date: '2026-11-09', total_cents: 50000 },
    ],
    invoiceLines: [],
    payments: [{ id: 'p1', invoice_id: 'i1', amount_cents: 13000, paid_on: '2026-10-02' }, { id: 'p2', invoice_id: 'i2', amount_cents: 50000, paid_on: '2026-10-11' }],
    creditNotes: [],
  };
  assert.deepEqual(listRows('quote', data, { today }).map((r) => r.id), ['q2', 'q1'], 'open = drafts and sent, drafts first');
  assert.equal(docTotal('quote', data.quotes[1], data.quoteLines), 16300, 'a draft’s total as it stands: HST on the taxable line only');
  assert.deepEqual(listRows('quote', data, { show: 'declined' }).map((r) => r.id), ['q3']);
  assert.deepEqual(listRows('invoice', data, { show: 'overdue', today }).map((r) => [r.id, r.status.label]), [['i1', 'Overdue · $1,000.00 owing']]);
  assert.deepEqual(listRows('invoice', data, { show: 'paid', today }).map((r) => r.id), ['i2']);
  assert.deepEqual(listRows('invoice', data, { q: 'beta', show: 'all' }).map((r) => r.id), ['i2']);
  assert.equal(docStatus('quote', data.quotes[0]).label, 'Sent');
  // An accepted quote's invoice: its client (from the lead's win), lines copied.
  const lines = [{ id: 'l1', quote_id: 'q9', position: 0, description: 'Site', quantity: null, unit_cents: 200000 }];
  assert.match(invoiceFromQuote({ id: 'q9', business_id: B.agency, to_name: 'Beta' }, lines).problem, /no client yet/);
  const inv = invoiceFromQuote({ id: 'q9', business_id: B.agency, lead_id: 'L1', to_name: 'Beta', title: 'Site', tax_rate_bp: null }, lines, { lead: { won_client_id: 'c9', won_relationship_id: 'r9' } });
  assert.deepEqual([inv.fields.client_id, inv.fields.relationship_id, inv.fields.quote_id, inv.fields.status], ['c9', 'r9', 'q9', 'draft']);
  assert.deepEqual(inv.lines, [{ description: 'Site', quantity: null, unit_cents: 200000, tax_exempt: false }]);
  assert.deepEqual(creditNoteFor(data.invoices[0], 'Fewer pages').fields, { status: 'draft', invoice_id: 'i1', business_id: B.agency, to_name: 'Alpha', to_lines: null, tax_rate_bp: null, reason: 'Fewer pages' });
  // The email: the person sends it (mailto with the subject and body); the payment instructions on an invoice.
  const mail = emailFor('invoice', data.invoices[0], { business: { name: 'GWND' }, email: 'pat@alpha.ca', settings: { legal_name: 'Great White North Design', payment_instructions: 'e-Transfer to pay@example.ca' }, dueText: 'Oct 1, 2026' });
  assert.equal(mail.subject, 'Invoice GWND-INV-0001 from Great White North Design');
  assert.match(mail.body, /\$1,130\.00, due Oct 1, 2026\. It is attached as a PDF\.\n\nHow to pay: e-Transfer to pay@example\.ca/);
  assert.ok(mail.mailto.startsWith('mailto:pat%40alpha.ca?subject=Invoice%20GWND-INV-0001'));
  assert.match(emailFor('quote', data.quotes[0], { business: { name: 'GWND' } }).body, /Reply to this email to go ahead/);
  // A payment and a decline.
  assert.ok(paymentFields({ amount: '0', paid_on: '2026-10-20' }, 'i1').problems.amount);
  assert.deepEqual(paymentFields({ amount: '1,000', paid_on: '2026-10-20', method: 'cheque', note: ' ' }, 'i1').fields, { invoice_id: 'i1', amount_cents: 100000, paid_on: '2026-10-20', method: 'cheque', note: null });
  assert.ok(declineFields({ reason: '', day: today }).problem);
  assert.deepEqual(declineFields({ reason: 'price', note: 'Too much', day: today }).fields, { status: 'declined', decided_on: today, declined_reason: 'price', decided_note: 'Too much' });
});

// ---- two devices against a real server -------------------------------------------------------------------------

async function devices(t) {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  return { server, mac, phone };
}
const makeDraft = async (dev, kind, fields, lines) => createDocument(dev.engine, kind, { fields: { status: 'draft', ...fields }, lines }, docIds(newId, lines.length));
const approveOn = async (dev, kind, id, today = localDate()) => {
  const doc = await dev.engine.get(kind, id);
  const lines = await dev.engine.list(`${kind}_line`);
  return approveDocument(dev.engine, dev.transport, kind, id, { fingerprint: approval(kind, doc, lines).fingerprint, today });
};

test('two devices: a quote drafted offline; approving only what was seen; once sent it never changes', async (t) => {
  const { server, mac, phone } = await devices(t);
  phone.online = false;
  const lead = await phone.engine.create('lead', { name: 'Alpha Bakery', business_id: B.agency, kind: 'website', stage: 'talking', stage_changed_at: '2026-10-01T12:00:00.000Z' });
  const id = await makeDraft(phone, 'quote', { business_id: B.agency, lead_id: lead, to_name: 'Alpha Bakery', title: 'New website' }, [
    { description: 'Website', unit_cents: 200000 }, { description: 'Hosting, first year (resold)', unit_cents: 30000, tax_exempt: true },
  ]);
  assert.equal(docTotal('quote', await phone.engine.get('quote', id), await phone.engine.list('quote_line')), 256000, 'offline, its total as typed');
  await assert.rejects(approveOn(phone, 'quote', id), (e) => e.code === 'pending', 'approving needs its changes on the server (a connection)');
  phone.online = true;
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  // The phone opens the approve sheet (it sees two lines) — meanwhile the Mac changes the price.
  const seen = approval('quote', await phone.engine.get('quote', id), await phone.engine.list('quote_line'));
  const [first] = linesOf('quote', id, await mac.engine.list('quote_line'));
  await mac.engine.update('quote_line', first.id, { unit_cents: 180000 });
  await mac.engine.syncNow();
  await assert.rejects(approveDocument(phone.engine, phone.transport, 'quote', id, { fingerprint: seen.fingerprint, today: localDate() }), (e) => e.code === 'changed');
  assert.equal(count(server.db, 'SELECT COUNT(*) AS n FROM billing_counters'), 0, 'no number used up');
  const out = await approveOn(phone, 'quote', id);
  assert.equal(out.number, 'GWND-Q-0001');
  assert.equal((await phone.engine.get('quote', id)).number, 'GWND-Q-0001', 'the number shows on the device that sent it');
  await mac.engine.syncNow();
  const onMac = await mac.engine.get('quote', id);
  assert.deepEqual([onMac.status, onMac.total_cents], ['sent', 233400]);
  assert.equal((await mac.engine.get('lead', lead)).stage, 'quoted', 'the lead moved to Quoted');
  // The Mac, offline, still edits the title it had open: refused once it reaches the server (Needs attention), never printed.
  mac.online = false;
  await mac.engine.update('quote', id, { title: 'Changed later' });
  mac.online = true;
  await mac.engine.syncNow();
  assert.equal(row(server.db, 'billing_quotes', id).title, 'New website');
  const attention = await mac.engine.attentionList();
  assert.ok(attention.some((a) => a.step.recordId === id && a.code === 'locked'), JSON.stringify(attention.map((a) => a.code)));
});

test('two devices: accepting a lead’s quote wins the lead once (offline, retried); the follow-up finishes; declining loses the lead', async (t) => {
  const { server, mac, phone } = await devices(t);
  const lead = await mac.engine.create('lead', { name: 'Beta Bikes', contact_name: 'Sam', email: 'sam@beta.ca', business_id: B.agency, kind: 'website', stage: 'lead', stage_changed_at: '2026-10-01T12:00:00.000Z' });
  const q = await makeDraft(mac, 'quote', { business_id: B.agency, lead_id: lead, to_name: 'Beta Bikes' }, [{ description: 'Website', unit_cents: 300000 }]);
  await mac.engine.syncNow();
  await approveOn(mac, 'quote', q);
  assert.equal(count(server.db, "SELECT COUNT(*) AS n FROM planner_tasks WHERE lead_id = ? AND done_at IS NULL AND title LIKE 'Follow up on quote%'", lead), 1);
  await phone.engine.syncNow();
  // Accepted on the phone with no signal: D8's win (ids kept), then the quote — the first try fails part-way.
  phone.online = false;
  const leadRec = await phone.engine.get('lead', lead);
  const data = { accounts: await phone.engine.list('account'), contacts: await phone.engine.list('contact'), relationships: await phone.engine.list('relationship') };
  const ids = winIds(newId);
  const plan = planWin(leadRec, { clientId: '', kind: 'website', startDate: '2026-10-14', businessName: 'Great White North Design' }, data, ids);
  const flaky = { ...phone.engine, create: phone.engine.create, update: phone.engine.update };
  let n = 0;
  flaky.create = async (...a) => { n += 1; if (n === 3) throw new Error('storage hiccup'); return phone.engine.create(...a); };
  await assert.rejects(applyWin(flaky, plan));
  await applyWin(phone.engine, plan); // the retry: same ids, nothing made twice
  await phone.engine.update('quote', q, { status: 'accepted', decided_on: '2026-10-14', client_id: plan.clientId, account_id: plan.accountId, relationship_id: plan.relationshipId });
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(count(server.db, "SELECT COUNT(*) AS n FROM crm_clients WHERE name = 'Beta Bikes' AND deleted_at IS NULL"), 1, 'one client');
  assert.equal(row(server.db, 'crm_leads', lead).stage, 'won');
  assert.equal(row(server.db, 'billing_quotes', q).client_id, plan.clientId);
  const task = server.db.prepare("SELECT * FROM planner_tasks WHERE lead_id = ? AND title LIKE 'Follow up on quote%'").get(lead);
  assert.ok(task.done_at, 'the follow-up finished itself');
  assert.match(task.notes, /was accepted on Oct 14, 2026/);
  // The invoice from it, on the Mac.
  await mac.engine.syncNow();
  const quote = await mac.engine.get('quote', q);
  const made = invoiceFromQuote(quote, linesOf('quote', q, await mac.engine.list('quote_line')), { lead: await mac.engine.get('lead', lead) });
  const inv = await createDocument(mac.engine, 'invoice', made, docIds(newId, made.lines.length));
  await mac.engine.syncNow();
  assert.deepEqual([row(server.db, 'billing_invoices', inv).quote_id, row(server.db, 'billing_invoices', inv).client_id], [q, plan.clientId]);
  // Another lead's quote declined: the quote, and the lead lost with the reason.
  const lead2 = await mac.engine.create('lead', { name: 'Gamma Gym', business_id: B.agency, stage: 'talking', stage_changed_at: '2026-10-01T12:00:00.000Z' });
  const q2 = await makeDraft(mac, 'quote', { business_id: B.agency, lead_id: lead2, to_name: 'Gamma Gym' }, [{ description: 'Site', unit_cents: 100000 }]);
  await mac.engine.syncNow();
  await approveOn(mac, 'quote', q2);
  const d = declineFields({ reason: 'price', note: 'Went cheaper', day: '2026-10-15' });
  await mac.engine.update('quote', q2, d.fields);
  await saveStageChange(mac.engine, await mac.engine.get('lead', lead2), stageChange(await mac.engine.get('lead', lead2), 'lost', { reason: 'price', note: 'Went cheaper' }));
  await mac.engine.syncNow();
  assert.deepEqual([row(server.db, 'crm_leads', lead2).stage, row(server.db, 'crm_leads', lead2).lost_reason], ['lost', 'price']);
  assert.ok(server.db.prepare("SELECT done_at FROM planner_tasks WHERE lead_id = ? AND title LIKE 'Follow up on quote%'").get(lead2).done_at);
});

test('two devices: an invoice issued, paid in parts on both devices (one offline) — both count in sales on their days; a credit note takes some back', async (t) => {
  const { server, mac, phone } = await devices(t);
  const client = await mac.engine.create('client', { name: 'Alpha Bakery', status: 'active' });
  const inv = await makeDraft(mac, 'invoice', { business_id: B.consulting, client_id: client, to_name: 'Alpha Bakery' }, [{ description: 'Coaching, 10 hours', quantity: 10, unit_cents: 10000 }]);
  await mac.engine.syncNow();
  assert.equal((await approveOn(mac, 'invoice', inv)).number, 'BC-INV-0001');
  await phone.engine.syncNow();
  phone.online = false;
  await phone.engine.create('invoice_payment', { invoice_id: inv, amount_cents: 50000, paid_on: '2026-10-13', method: 'cash' });
  await mac.engine.create('invoice_payment', { invoice_id: inv, amount_cents: 63000, paid_on: '2026-10-14', method: 'etransfer' });
  await mac.engine.syncNow();
  phone.online = true;
  await phone.engine.syncNow();
  const days = server.db.prepare("SELECT day, total FROM sales_daily WHERE source = 'invoices' AND store = ? ORDER BY day").all(`invoices:${B.consulting}`);
  assert.deepEqual(days.map((r) => [r.day, r.total]), [['2026-10-13', 50000], ['2026-10-14', 63000]]);
  await mac.engine.syncNow();
  const status = docStatus('invoice', await mac.engine.get('invoice', inv), { payments: await mac.engine.list('invoice_payment'), today: '2026-10-14' });
  assert.equal(status.key, 'paid');
  const cn = await createDocument(mac.engine, 'credit_note', { ...creditNoteFor(await mac.engine.get('invoice', inv), 'One hour less'), lines: [{ description: 'One hour', unit_cents: 10000 }] }, docIds(newId, 1));
  await mac.engine.syncNow();
  assert.equal((await approveOn(mac, 'credit_note', cn)).number, 'BC-CN-0001');
  const total = server.db.prepare("SELECT SUM(total) AS t FROM sales_daily WHERE source = 'invoices' AND store = ?").get(`invoices:${B.consulting}`).t;
  assert.equal(total, 113000 - 11300, 'the credit note took $113 back on its day');
});
