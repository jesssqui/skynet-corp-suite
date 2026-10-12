// Quotes, invoices and credit notes (D17, D18) — the server side. See CLAUDE.md, "Quotes, invoices and credit notes".
//
//   records    quote, invoice, credit_note (+ their lines) and invoice_payment: synced (entities.js), so drafts and
//              payments are written on any device, offline too. This module's checks keep what was sent or issued
//              from changing, refuse fields only the server writes, and refuse Wholesale / Save Point Shop / Personal.
//   approving  a draft becomes a document only here, when a person approves it (POST …/send or …/issue, with the
//              fingerprint of what they saw): in ONE transaction the business's next number (gap-free: the counter
//              moves only here), the PDF (stored for good in billing_pdfs), and the record's number, dates and totals
//              (through sync.applyLocal, so devices pull them). Sending a quote for a lead moves the lead to Quoted
//              (D8's whole stage set + a stage row) with the quote's value. The suite never emails anything: the
//              person downloads or shares the PDF and sends it themselves.
//   sales      invoices count in sales (source 'invoices', one store per business) as money comes in and is kept:
//              payments on their day, credit notes on paid invoices taking it back (invoiceSalesDays). Re-worked out
//              after every change that reaches the server (a device's push, an issue, a void) and at start.
//   follow-up  a task 7 days after a quote is sent, finished when it is accepted or declined (automations.js).
// It reads and writes only its own tables; the CRM, planner, sales and automations through their services.
import crypto from 'node:crypto';
import { nowIso, localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';
import { isId, newId } from '@suite/shared/ids';
import {
  BILLING_BLOCKED, LINE_PARENT, KIND_LABELS, HST_RATE_BP, DEFAULT_QUOTE_VALID_DAYS, DEFAULT_INVOICE_DUE_DAYS, AMOUNT_MAX_CENTS,
  PREFIX_RE, defaultPrefix, formatNumber, documentTotals, documentFingerprint, documentProblems, moneyText, dueDateOf, sortLines,
} from '@suite/shared/billing';
import { HttpError } from '../../lib/httpError.js';
import { BILLING_ENTITIES, BILLING_ENTITY_NAMES, SERVER_FIELDS, CONTENT_FIELDS } from './entities.js';
import { renderDocument } from './document.js';
import { registerBillingAutomations } from './automations.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (d) => typeof d === 'string' && DAY_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const TABLE = Object.freeze({ quote: 'billing_quotes', invoice: 'billing_invoices', credit_note: 'billing_credit_notes' });
const LINE_TABLE = Object.freeze({ quote: 'billing_quote_lines', invoice: 'billing_invoice_lines', credit_note: 'billing_credit_note_lines' });
const LINE_KIND = Object.freeze({ quote_line: 'quote', invoice_line: 'invoice', credit_note_line: 'credit_note' });
const refuse = (code, reason) => ({ code, reason });
const bad = (code, message, status = 400) => new HttpError(status, message, undefined, { code });
const SETTING_FIELDS = Object.freeze({
  legal_name: 200, address: 500, hst_number: 40, email: 200, phone: 40, website: 200, payment_instructions: 1000,
  quote_terms: 5000, invoice_terms: 5000,
});
export const HST_NUMBER_RE = /^\d{9} ?RT ?\d{4}$/i;
const SALES_KINDS = new Set(['invoice', 'invoice_payment', 'credit_note']);

/** Rules for a document's step from a device (the server's own steps pass). Right in any arrival order. */
export function documentCheck(kind, rows) {
  return ({ op, fields, current, server }) => {
    if (server) return null;
    const label = KIND_LABELS[kind].toLowerCase();
    if (op === 'delete') {
      if (current && current.status !== 'draft') return refuse('locked', `A ${label} that was sent or issued is kept: it can’t be deleted`);
      return null;
    }
    if (!fields) return null;
    const has = (k) => Object.hasOwn(fields, k);
    for (const k of SERVER_FIELDS[kind]) {
      if (has(k) && (op === 'update' || fields[k] !== null)) return refuse('op_not_allowed', `${k}: set by the suite when a draft is approved`);
    }
    if (has('business_id') && BILLING_BLOCKED[fields.business_id]) return refuse('invalid_value', BILLING_BLOCKED[fields.business_id]);
    if (has('tax_rate_bp') && fields.tax_rate_bp !== null && !(Number.isSafeInteger(fields.tax_rate_bp) && fields.tax_rate_bp >= 0 && fields.tax_rate_bp <= 5000)) {
      return refuse('invalid_value', 'tax_rate_bp: a rate from 0 to 50 %, in basis points (13 % = 1300)');
    }
    if (has('due_days') && fields.due_days !== null && !(Number.isSafeInteger(fields.due_days) && fields.due_days >= 0 && fields.due_days <= 365)) {
      return refuse('invalid_value', 'due_days: 0 (on receipt) to 365 days');
    }
    if (op === 'create') {
      if (fields.status !== 'draft') return refuse('invalid_value', `A new ${label} starts as a draft`);
    } else {
      const st = current?.status;
      if (has('status') && fields.status !== st) {
        const decision = kind === 'quote' && st === 'sent' && ['accepted', 'declined'].includes(fields.status);
        if (!decision) return refuse('invalid_value', kind === 'quote' ? 'A quote is sent by approving its draft; then it is accepted or declined' : `A ${label} is issued (or voided) by the suite`);
      }
      if (st !== 'draft' && CONTENT_FIELDS[kind].some(has)) return refuse('locked', `This ${label} was ${kind === 'quote' ? 'sent' : 'issued'}: what it says can no longer change`);
    }
    if (kind === 'quote' && ['decided_on', 'declined_reason', 'decided_note'].some((k) => has(k) && fields[k] !== null)) {
      const st = fields.status ?? current?.status;
      if (!['accepted', 'declined'].includes(st)) return refuse('invalid_value', 'Only an accepted or declined quote has a decision');
    }
    if (kind === 'credit_note' && op === 'create') {
      const inv = rows.invoice(fields.invoice_id);
      if (inv && inv.status !== 'issued') return refuse('invalid_value', 'A credit note is for an issued invoice (not a draft or a void one)');
      if (inv && fields.business_id !== inv.business_id) return refuse('invalid_value', 'A credit note is from the invoice’s own business');
    }
    return null;
  };
}

/** Rules for a line's step from a device: only while its document is a draft; it stays on its document. */
export function lineCheck(kind, rows) {
  const parentField = LINE_PARENT[kind];
  return ({ op, fields, current, server }) => {
    if (server) return null;
    if (op === 'update' && fields && Object.hasOwn(fields, parentField) && fields[parentField] !== current?.[parentField]) {
      return refuse('invalid_value', 'A line stays on its document');
    }
    const parentId = op === 'create' ? fields?.[parentField] : current?.[parentField];
    const parent = parentId ? rows[kind](parentId) : null;
    if (parent && parent.status !== 'draft') return refuse('locked', `This ${KIND_LABELS[kind].toLowerCase()} was ${kind === 'quote' ? 'sent' : 'issued'}: its lines can no longer change`);
    if (op === 'delete' || !fields) return null;
    if (Object.hasOwn(fields, 'quantity') && fields.quantity !== null && !(fields.quantity > 0 && fields.quantity <= 1_000_000)) return refuse('invalid_value', 'quantity: more than 0');
    if (Object.hasOwn(fields, 'unit_cents') && !(Math.abs(fields.unit_cents) <= AMOUNT_MAX_CENTS)) return refuse('invalid_value', 'unit_cents: too big');
    return null;
  };
}

/** Rules for a payment from a device: on an issued invoice, an amount above 0. Deleting one (a mistake) is fine. */
export function paymentCheck(rows) {
  return ({ op, fields, server }) => {
    if (server || op !== 'create') return null;
    const inv = rows.invoice(fields.invoice_id);
    if (inv && inv.status !== 'issued') return refuse('invalid_value', inv.status === 'void' ? 'This invoice is void: it takes no payments' : 'Issue the invoice before recording a payment');
    if (!(Number.isSafeInteger(fields.amount_cents) && fields.amount_cents > 0 && fields.amount_cents <= AMOUNT_MAX_CENTS)) return refuse('invalid_value', 'amount_cents: more than 0');
    return null;
  };
}

export function createBillingService(ctx) {
  const { db, services, log } = ctx;
  const clock = ctx.now ?? Date.now;
  const { sync, crm, planner, sales, automations } = services;
  if (!sync || !crm) {
    // Tests that leave the CRM out (the sync engine's): nothing to bill without our businesses.
    return { available: false };
  }

  // ---- statements ----------------------------------------------------------------------------------------------
  const any = Object.fromEntries(Object.entries(TABLE).map(([k, t]) => [k, db.prepare(`SELECT * FROM ${t} WHERE id = ?`)]));
  const liveDoc = Object.fromEntries(Object.entries(TABLE).map(([k, t]) => [k, db.prepare(`SELECT * FROM ${t} WHERE id = ? AND deleted_at IS NULL`)]));
  const linesOf = Object.fromEntries(Object.entries(LINE_TABLE).map(([k, t]) => [k,
    db.prepare(`SELECT * FROM ${t} WHERE ${LINE_PARENT[k]} = ? AND deleted_at IS NULL ORDER BY position, id`)]));
  const q = {
    settings: db.prepare('SELECT * FROM billing_settings WHERE business_id = ?'),
    allSettings: db.prepare('SELECT * FROM billing_settings'),
    putSettings: db.prepare(`INSERT INTO billing_settings (business_id, legal_name, address, hst_number, email, phone, website,
        payment_instructions, prefix, quote_valid_days, invoice_due_days, quote_terms, invoice_terms, updated_at, updated_by)
      VALUES (@business_id, @legal_name, @address, @hst_number, @email, @phone, @website, @payment_instructions, @prefix,
        @quote_valid_days, @invoice_due_days, @quote_terms, @invoice_terms, @updated_at, @updated_by)
      ON CONFLICT (business_id) DO UPDATE SET legal_name = excluded.legal_name, address = excluded.address,
        hst_number = excluded.hst_number, email = excluded.email, phone = excluded.phone, website = excluded.website,
        payment_instructions = excluded.payment_instructions, prefix = excluded.prefix, quote_valid_days = excluded.quote_valid_days,
        invoice_due_days = excluded.invoice_due_days, quote_terms = excluded.quote_terms, invoice_terms = excluded.invoice_terms,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    counter: db.prepare('SELECT last_seq FROM billing_counters WHERE business_id = ? AND kind = ?'),
    putCounter: db.prepare(`INSERT INTO billing_counters (business_id, kind, last_seq) VALUES (?, ?, ?)
      ON CONFLICT (business_id, kind) DO UPDATE SET last_seq = excluded.last_seq`),
    putPdf: db.prepare(`INSERT INTO billing_pdfs (kind, doc_id, business_id, seq, number, to_name, total_cents, made_on, made_at, made_by, sha256, pdf)
      VALUES (@kind, @doc_id, @business_id, @seq, @number, @to_name, @total_cents, @made_on, @made_at, @made_by, @sha256, @pdf)`),
    pdf: db.prepare('SELECT * FROM billing_pdfs WHERE kind = ? AND doc_id = ?'),
    archive: db.prepare(`SELECT kind, doc_id, business_id, seq, number, to_name, total_cents, made_on, made_at, made_by, sha256, length(pdf) AS bytes
      FROM billing_pdfs ORDER BY made_at DESC, number DESC LIMIT ?`),
    payments: db.prepare('SELECT * FROM billing_payments WHERE invoice_id = ? AND deleted_at IS NULL ORDER BY paid_on, id'),
    creditNotesOf: db.prepare('SELECT * FROM billing_credit_notes WHERE invoice_id = ? AND deleted_at IS NULL'),
    quotesForFollowUp: db.prepare("SELECT * FROM billing_quotes WHERE deleted_at IS NULL AND status = 'sent' ORDER BY sent_on, id"),
  };
  const rows = { quote: (id) => any.quote.get(id), invoice: (id) => any.invoice.get(id), credit_note: (id) => any.credit_note.get(id) };

  for (const def of BILLING_ENTITIES) {
    let check = null;
    if (TABLE[def.entity]) check = documentCheck(def.entity, rows);
    else if (LINE_KIND[def.entity]) check = lineCheck(LINE_KIND[def.entity], rows);
    else if (def.entity === 'invoice_payment') check = paymentCheck(rows);
    sync.registerEntity({ module: 'billing', ...def, check });
  }

  const now = () => new Date(clock());
  // Invoices in sales and invoices past due come with D18.
  const money = { rebuildSales: () => 0, rebuildSalesSafe: () => {}, overdueInvoices: () => [] };
  const todayHere = () => localDate(now());
  const must = (r, what) => {
    if (r.status !== 'applied' && r.status !== 'clash') throw new Error(`could not write the ${what}: ${r.code ?? r.status} ${r.reason ?? ''}`.trim());
    return r;
  };

  // ---- business details ----------------------------------------------------------------------------------------
  /** A business's details and defaults as printed: its row (if any) with the defaults filled in. */
  function settingsFor(businessId) {
    const b = crm.getBusiness(businessId);
    const s = q.settings.get(businessId) ?? {};
    return {
      businessId, name: b?.name ?? null, color: b?.color ?? null, archived: Boolean(b?.archived),
      legal_name: s.legal_name ?? null, address: s.address ?? null, hst_number: s.hst_number ?? null, email: s.email ?? null,
      phone: s.phone ?? null, website: s.website ?? null, payment_instructions: s.payment_instructions ?? null,
      prefixSet: s.prefix ?? null, prefix: s.prefix ?? defaultPrefix(b),
      quote_valid_days: s.quote_valid_days ?? DEFAULT_QUOTE_VALID_DAYS, invoice_due_days: s.invoice_due_days ?? DEFAULT_INVOICE_DUE_DAYS,
      quote_terms: s.quote_terms ?? null, invoice_terms: s.invoice_terms ?? null,
      updatedAt: s.updated_at ?? null, updatedBy: s.updated_by ?? null,
      next: Object.fromEntries(['quote', 'invoice', 'credit_note'].map((k) => [k, formatNumber(s.prefix ?? defaultPrefix(b), k, (q.counter.get(businessId, k)?.last_seq ?? 0) + 1)])),
    };
  }
  /** Every business that may bill (not blocked), in our order — archived ones too (their documents stay). */
  function listSettings() {
    return crm.listBusinesses().filter((b) => !BILLING_BLOCKED[b.id]).map((b) => settingsFor(b.id));
  }
  function putSettings(businessId, body = {}, { actor }) {
    const b = isId(businessId) ? crm.getBusiness(businessId) : null;
    if (!b) throw bad('not_found', 'No such business', 404);
    if (BILLING_BLOCKED[b.id]) throw bad('not_by_billing', BILLING_BLOCKED[b.id]);
    const row = { business_id: b.id, updated_at: nowIso(now()), updated_by: actor };
    for (const [k, max] of Object.entries(SETTING_FIELDS)) {
      const v = body[k] === undefined || body[k] === null ? null : String(body[k]).trim();
      if (v && v.length > max) throw bad('too_long', `${k.replace(/_/g, ' ')}: at most ${max} characters`);
      row[k] = v || null;
    }
    if (row.hst_number) {
      if (!HST_NUMBER_RE.test(row.hst_number)) throw bad('bad_hst', 'An HST number looks like 123456789 RT0001');
      const digits = row.hst_number.replace(/\s/g, '').toUpperCase();
      row.hst_number = `${digits.slice(0, 9)} ${digits.slice(9)}`;
    }
    const prefix = body.prefix === undefined || body.prefix === null || body.prefix === '' ? null : String(body.prefix).trim().toUpperCase();
    if (prefix !== null && !PREFIX_RE.test(prefix)) throw bad('bad_prefix', 'A number prefix is up to 8 capital letters or digits (like GWND)');
    row.prefix = prefix;
    const days = (k, min, max, label) => {
      const v = body[k];
      if (v === undefined || v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < min || n > max) throw bad('bad_days', `${label}: ${min} to ${max} days`);
      return n;
    };
    row.quote_valid_days = days('quote_valid_days', 1, 365, 'Quotes valid for');
    row.invoice_due_days = days('invoice_due_days', 0, 365, 'Invoices due in');
    q.putSettings.run(row);
    return settingsFor(b.id);
  }

  // ---- reading documents ---------------------------------------------------------------------------------------
  const kindOf = (kind) => {
    if (!TABLE[kind]) throw bad('not_found', 'No such kind of document', 404);
    return kind;
  };
  function needDoc(kind, id) {
    const doc = isId(id) ? liveDoc[kindOf(kind)].get(id) : null;
    if (!doc) throw bad('not_found', `That ${KIND_LABELS[kind].toLowerCase()} isn’t on the server (yet): sync, then try again`, 404);
    return doc;
  }
  const docLines = (kind, id) => linesOf[kind].all(id).map((l) => ({ ...l, tax_exempt: l.tax_exempt === 1 }));

  /** What renderDocument needs for a document as it stands (draft) or as it will be issued (`issue`). */
  function renderInput(kind, doc, lines, { draft, number = null, date, settings }) {
    const b = crm.getBusiness(doc.business_id);
    const input = {
      kind, number, draft, business: { name: b?.name ?? '', color: colorOf(b) }, settings, lines, date,
      doc: {
        to_name: doc.to_name, to_lines: doc.to_lines, title: doc.title, notes: doc.notes, reason: doc.reason, tax_rate_bp: doc.tax_rate_bp ?? HST_RATE_BP,
        terms: doc.terms ?? (kind === 'quote' ? settings.quote_terms : kind === 'invoice' ? settings.invoice_terms : null),
      },
    };
    if (kind === 'quote') input.validUntil = doc.valid_until ?? addDays(date, settings.quote_valid_days);
    if (kind === 'invoice') {
      input.dueDate = doc.due_date ?? dueDateOf(date, doc.due_days ?? settings.invoice_due_days);
      if (doc.quote_id) input.forQuote = any.quote.get(doc.quote_id)?.number ?? null;
    }
    if (kind === 'credit_note') input.forInvoice = any.invoice.get(doc.invoice_id)?.number ?? null;
    return input;
  }

  /**
   * The PDF to show for a document: the stored one once it was sent or issued (never made again), else a draft
   * preview (DRAFT across it, no number) of what it would be if approved today. → { pdf, filename, draft }
   */
  function pdfOf(kind, id, { today = null } = {}) {
    const doc = needDoc(kind, id);
    if (doc.status !== 'draft') {
      const stored = q.pdf.get(kind, id);
      if (!stored) throw bad('not_found', 'Its PDF isn’t here', 404);
      return { pdf: stored.pdf, filename: `${stored.number}.pdf`, draft: false, sha256: stored.sha256 };
    }
    const day = realDay(today) ? today : todayHere();
    const settings = settingsFor(doc.business_id);
    const pdf = renderDocument(renderInput(kind, doc, docLines(kind, id), { draft: true, date: day, settings }));
    return { pdf, filename: `draft-${kind.replace('_', '-')}.pdf`, draft: true };
  }

  // ---- approving a draft: number + PDF + record, in one transaction ---------------------------------------------
  /**
   * Send a quote / issue an invoice or a credit note. `fingerprint` = documentFingerprint of what the person approved
   * (409 `changed` when the server's copy differs: synced from elsewhere meanwhile, or this device's changes not here
   * yet). Already sent/issued → nothing changes (a retried request), `already: true`. → { kind, id, number, already }
   */
  function approve(kind, id, { actor, today, fingerprint }) {
    kindOf(kind);
    const day = realDay(today) ? today : todayHere();
    if (day > addDays(todayHere(), 1) || day < addDays(todayHere(), -1)) throw bad('bad_day', 'The device’s date is off by more than a day: check it, then try again');
    const at = nowIso(now());
    const out = db.transaction(() => {
      const doc = needDoc(kind, id);
      if (doc.status !== 'draft') return { kind, id, number: doc.number, already: true };
      const lines = docLines(kind, id);
      const problems = documentProblems(doc, lines);
      if (problems.length) throw new HttpError(400, problems.join('. '), { problems }, { code: 'not_ready' });
      if (fingerprint !== documentFingerprint(doc, lines)) {
        throw bad('changed', 'It changed since you looked at it (on the other device, or not synced yet): check it again, then approve', 409);
      }
      if (BILLING_BLOCKED[doc.business_id]) throw bad('not_by_billing', BILLING_BLOCKED[doc.business_id]);
      const totals = documentTotals(lines, doc.tax_rate_bp ?? HST_RATE_BP);
      if (kind === 'credit_note') {
        const inv = liveDoc.invoice.get(doc.invoice_id);
        if (!inv || inv.status !== 'issued') throw bad('invoice_not_issued', 'A credit note is for an issued invoice (not a draft or a void one)', 409);
        const credited = q.creditNotesOf.all(inv.id).filter((c) => c.status === 'issued').reduce((a, c) => a + (c.total_cents ?? 0), 0);
        if (totals.total > (inv.total_cents ?? 0) - credited) {
          throw bad('too_much', `It credits ${moneyText(totals.total)}, more than is left on ${inv.number} (${moneyText((inv.total_cents ?? 0) - credited)})`, 409);
        }
        if (totals.total <= 0) throw bad('not_ready', 'A credit note credits more than $0');
      }
      const settings = settingsFor(doc.business_id);
      const seq = (q.counter.get(doc.business_id, kind)?.last_seq ?? 0) + 1;
      const number = formatNumber(settings.prefix, kind, seq);
      const input = renderInput(kind, doc, lines, { draft: false, number, date: day, settings });
      const pdf = renderDocument(input);
      q.putPdf.run({
        kind, doc_id: id, business_id: doc.business_id, seq, number, to_name: doc.to_name, total_cents: totals.total, made_on: day,
        made_at: at, made_by: actor, sha256: crypto.createHash('sha256').update(pdf).digest('hex'), pdf,
      });
      q.putCounter.run(doc.business_id, kind, seq);
      const sums = { subtotal_cents: totals.subtotal, tax_cents: totals.tax, total_cents: totals.total };
      const fields = kind === 'quote'
        ? { status: 'sent', number, sent_on: day, sent_at: at, sent_by: actor, ...sums, ...(doc.valid_until ? {} : { valid_until: input.validUntil }) }
        : { status: 'issued', number, issue_date: day, issued_at: at, issued_by: actor, ...sums, ...(kind === 'invoice' ? { due_date: input.dueDate } : {}) };
      if (!doc.terms && input.doc.terms) fields.terms = input.doc.terms; // the record says what the PDF says
      must(sync.applyLocal({ actor, entity: kind, op: 'update', recordId: id, fields }), kind);
      const lead = kind === 'quote' && doc.lead_id ? leadQuoted(doc, { number, totals, actor, at }) : null;
      return { kind, id, number, already: false, lead };
    }).immediate();
    if (!out.already) {
      if (kind === 'quote') emitSoon('billing.quote_sent', { key: `sent:${id}`, quoteId: id });
      else money.rebuildSalesSafe();
    }
    return out;
  }

  /**
   * A quote for a lead was sent: an open lead (Lead or Talking) moves to Quoted — D8's whole stage set, so a move on a
   * device at the same time settles as one — with a stage row, and the quote's value before tax becomes the lead's
   * value (one-off). A lead already Quoted gets the new value and a note; a won or lost lead only the note.
   */
  function leadQuoted(quote, { number, totals, actor, at }) {
    const lead = crm.liveRecord('lead', quote.lead_id);
    if (!lead) return null;
    const text = `Quote ${number} sent: ${moneyText(totals.total)} (${moneyText(totals.subtotal)} before HST)`;
    const value = { value_cents: totals.subtotal, value_period: 'once', currency: null };
    if (lead.stage === 'lead' || lead.stage === 'talking') {
      must(sync.applyLocal({
        actor, entity: 'lead', op: 'update', recordId: lead.id,
        fields: { stage: 'quoted', stage_changed_at: at, closed_at: null, lost_reason: null, lost_note: null, won_client_id: null, won_relationship_id: null, ...value },
      }), 'lead');
      must(sync.applyLocal({ actor, entity: 'lead_activity', op: 'create', fields: { lead_id: lead.id, type: 'stage', stage_from: lead.stage, stage_to: 'quoted', body: text, at } }), 'lead’s stage row');
      return 'quoted';
    }
    if (lead.stage === 'quoted') must(sync.applyLocal({ actor, entity: 'lead', op: 'update', recordId: lead.id, fields: value }), 'lead');
    must(sync.applyLocal({ actor, entity: 'lead_activity', op: 'create', fields: { lead_id: lead.id, type: 'note', body: text, at } }), 'lead’s note');
    return lead.stage === 'quoted' ? 'value' : 'note';
  }

  /** Void an issued invoice (a mistake): only with no payment and no issued credit note. Its PDF stays in the archive. */
  function voidInvoice(id, { actor, today, reason }) {
    const day = realDay(today) ? today : todayHere();
    const why = String(reason ?? '').trim().slice(0, 500);
    if (!why) throw bad('no_reason', 'Say why it is void');
    const out = db.transaction(() => {
      const doc = needDoc('invoice', id);
      if (doc.status === 'void') return { id, already: true };
      if (doc.status !== 'issued') throw bad('draft', 'A draft isn’t voided: delete it instead', 409);
      if (q.payments.all(id).length) throw bad('has_payments', 'It has payments: take them off first, or issue a credit note instead', 409);
      if (q.creditNotesOf.all(id).some((c) => c.status === 'issued')) throw bad('has_credit_notes', 'It has a credit note: it stays issued', 409);
      must(sync.applyLocal({ actor, entity: 'invoice', op: 'update', recordId: id, fields: { status: 'void', void_on: day, void_reason: why } }), 'invoice');
      return { id, already: false };
    }).immediate();
    money.rebuildSalesSafe();
    return out;
  }

  // Events after the request's transaction (an automation's run is its own transaction).
  function emitSoon(event, data) {
    try {
      automations?.emit?.(event, data);
    } catch (err) {
      log?.error?.(`billing: ${event} failed:`, err);
    }
  }
  // A device's push (or a settled clash) changed billing records: sales again when money moved, and the follow-up
  // automation looks at quotes (accepted or declined on a device).
  sync.onChange?.(({ entities }) => {
    if (!BILLING_ENTITY_NAMES.some((e) => entities.has(e))) return;
    if ([...entities].some((e) => SALES_KINDS.has(e))) money.rebuildSalesSafe();
    if (entities.has('quote')) emitSoon('billing.changed', { key: newId() });
  });

  /** A kept PDF by kind and id, even when its record isn't in the database (after a restore). */
  function archivedPdf(kind, id) {
    const stored = TABLE[kind] && isId(id) ? q.pdf.get(kind, id) : null;
    if (!stored) throw bad('not_found', 'No such document', 404);
    return { pdf: stored.pdf, filename: `${stored.number}.pdf`, draft: false };
  }

  /** Issued documents kept (newest first), each marked when its record isn't in the database (a restore). */
  function archive({ limit = 200 } = {}) {
    return q.archive.all(limit).map((r) => ({ ...r, inDatabase: Boolean(liveDoc[r.kind]?.get(r.doc_id)) }));
  }

  const service = {
    available: true,
    settingsFor, listSettings, putSettings, pdfOf, archivedPdf, approve, voidInvoice, archive,
    // D18: invoices in sales, and past due on the overview (money.js).
    rebuildSales: money.rebuildSales, overdueInvoices: money.overdueInvoices,
    /** For the follow-up automation: sent quotes, and any quote by id (deleted too). */
    sentQuotes: () => q.quotesForFollowUp.all(),
    quoteRow: (id) => any.quote.get(id) ?? null,
    lines: (kind, id) => sortLines(docLines(kind, id)),
  };
  if (automations && planner) registerBillingAutomations({ automations, planner, crm, billing: service });
  return service;
}

/** A business's colour on its documents: its own, else the CRM's fixed colour for it (the client's businessColor). */
const DEFAULT_COLORS = {
  '01a1163c-1a01-7593-b888-119295f1fc8b': '#1d6fa5', // Great White North Design
  '01a1163c-1a02-7027-8a57-0f455a626426': '#7a4fb5', // Business consulting
  '01a1163c-1a04-7005-9cd7-b9f83f986c43': '#a8790a', // Retail stores
};
function colorOf(business) {
  if (/^#[0-9a-f]{6}$/i.test(business?.color ?? '')) return business.color;
  return DEFAULT_COLORS[business?.id] ?? '#3b55c2';
}
