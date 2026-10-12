// Quotes, invoices and credit notes (D17/D18) without React: labels, the lists' filters and rows, a new document's
// fields (who it is for, filled from the client, account, contact or lead — a first line from a CRM service), the line
// and details forms, what a document shows (lines in order, totals, where an invoice stands), approving a draft (sync
// first, then the server with the fingerprint of what was seen), the email to send it with, an invoice made from an
// accepted quote, a credit note from an invoice. Tested in client/test/billing.test.js (+ two devices).
import {
  DOC_ENTITY, LINE_ENTITY, LINE_PARENT, KIND_LABELS, HST_RATE_BP, PAYMENT_METHOD_LABELS, INVOICE_STATE_LABELS,
  documentTotals, documentFingerprint, documentProblems, invoiceState, sortLines, moneyText, billingAllowed, BILLING_BLOCKED,
} from '@suite/shared/billing';
import { addDays } from '@suite/shared/planner';
import { addressLines, parseDollars, centsToInput, textOrNull, fold } from '../crm/logic.js';

export { KIND_LABELS, PAYMENT_METHOD_LABELS, INVOICE_STATE_LABELS, moneyText, documentTotals, invoiceState, billingAllowed, BILLING_BLOCKED };

/** Where each kind lives in the app, and its API path. */
export const KIND_PATHS = Object.freeze({ quote: 'quotes', invoice: 'invoices', credit_note: 'credit-notes' });
export const docPath = (kind, id) => `/costs/billing/${KIND_PATHS[kind]}/${id}`;
export const pdfUrl = (kind, id, { today = null, download = false } = {}) => {
  const qs = new URLSearchParams();
  if (today) qs.set('today', today);
  if (download) qs.set('download', '1');
  const s = qs.toString();
  return `/api/billing/pdf/${kind}/${id}${s ? `?${s}` : ''}`;
};
export const approvePath = (kind, id) => (kind === 'quote' ? `/api/billing/quotes/${id}/send` : `/api/billing/${KIND_PATHS[kind]}/${id}/issue`);

export const QUOTE_STATUS_LABELS = Object.freeze({ draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' });
export const CREDIT_STATUS_LABELS = Object.freeze({ draft: 'Draft', issued: 'Issued' });
export const STATE_TONES = Object.freeze({
  draft: 'neutral', sent: 'accent', accepted: 'ok', declined: 'danger', unpaid: 'accent', partly_paid: 'warn', paid: 'ok', credited: 'neutral',
  void: 'neutral', overdue: 'danger', issued: 'ok',
});
/** The HST rates offered on a document: Ontario HST, GST only (a client outside the HST provinces), none. */
export const TAX_RATES = Object.freeze([
  { value: HST_RATE_BP, label: 'HST 13 % (Ontario)' },
  { value: 500, label: 'GST 5 % (outside the HST provinces)' },
  { value: 0, label: 'No tax (outside Canada)' },
]);

/** A document's state for its badge and the lists: { key, label, tone, detail }. */
export function docStatus(kind, doc, { payments = [], creditNotes = [], today = null } = {}) {
  if (kind === 'invoice') {
    const st = invoiceState(doc, payments, creditNotes, today);
    if (st.overdue) return { key: 'overdue', label: `Overdue · ${moneyText(st.owing)} owing`, tone: 'danger', state: st };
    const detail = st.state === 'partly_paid' ? ` · ${moneyText(st.owing)} owing` : '';
    return { key: st.state, label: `${INVOICE_STATE_LABELS[st.state]}${detail}`, tone: STATE_TONES[st.state], state: st };
  }
  const labels = kind === 'quote' ? QUOTE_STATUS_LABELS : CREDIT_STATUS_LABELS;
  return { key: doc.status, label: labels[doc.status] ?? doc.status, tone: STATE_TONES[doc.status] ?? 'neutral' };
}

/** A document's day to show: sent / issued, else when the draft was made. */
export const docDay = (doc) => doc.sent_on ?? doc.issue_date ?? (doc._sync?.createdAt ? doc._sync.createdAt.slice(0, 10) : null);
/** "GWND-Q-0007" or "Draft". */
export const docNumber = (doc) => doc.number ?? 'Draft';

/** Lines of one document (in their order), from a list of every line of that kind. */
export function linesOf(kind, docId, lines) {
  const f = LINE_PARENT[kind];
  return sortLines((lines ?? []).filter((l) => l[f] === docId));
}
/** A draft's total as it stands (live, from its lines); a sent / issued one's as stored. */
export function docTotal(kind, doc, lines) {
  if (doc.status !== 'draft' && Number.isSafeInteger(doc.total_cents)) return doc.total_cents;
  return documentTotals(linesOf(kind, doc.id, lines), doc.tax_rate_bp ?? HST_RATE_BP).total;
}

// ---- the lists ---------------------------------------------------------------------------------------------------

export const QUOTE_FILTERS = Object.freeze([
  { value: 'open', label: 'Open' }, { value: 'accepted', label: 'Accepted' }, { value: 'declined', label: 'Declined' }, { value: 'all', label: 'All' },
]);
export const INVOICE_FILTERS = Object.freeze([
  { value: 'open', label: 'Open' }, { value: 'overdue', label: 'Overdue' }, { value: 'paid', label: 'Paid' }, { value: 'all', label: 'All' },
]);

/**
 * One tab of the Billing page: rows { kind, doc, number, toName, title, total, day, status } filtered and sorted (newest
 * first; drafts first). `show`: quotes open = draft + sent; invoices open = drafts + owing; overdue; paid (or credited);
 * all. `business`, words (`q`: number, who, title).
 */
export function listRows(kind, data, { business = '', show = 'open', q = '', today = null } = {}) {
  const docs = kind === 'quote' ? data.quotes : kind === 'invoice' ? data.invoices : data.creditNotes;
  const lines = kind === 'quote' ? data.quoteLines : kind === 'invoice' ? data.invoiceLines : data.creditNoteLines;
  const payBy = groupBy(data.payments ?? [], 'invoice_id');
  const cnBy = groupBy(data.creditNotes ?? [], 'invoice_id');
  const words = fold(q).split(/\s+/).filter(Boolean);
  const rows = (docs ?? []).map((doc) => {
    const status = docStatus(kind, doc, { payments: payBy.get(doc.id) ?? [], creditNotes: cnBy.get(doc.id) ?? [], today });
    return { kind, doc, id: doc.id, number: docNumber(doc), toName: doc.to_name ?? '', title: doc.title ?? doc.reason ?? '', total: docTotal(kind, doc, lines), day: docDay(doc), status };
  }).filter((r) => {
    if (business && r.doc.business_id !== business) return false;
    if (words.length && !words.every((w) => fold(`${r.number} ${r.toName} ${r.title}`).includes(w))) return false;
    if (show === 'all') return true;
    if (kind === 'quote') return show === 'open' ? ['draft', 'sent'].includes(r.doc.status) : r.doc.status === show;
    if (kind === 'invoice') {
      if (show === 'open') return r.doc.status === 'draft' || ['unpaid', 'partly_paid', 'overdue'].includes(r.status.key);
      if (show === 'overdue') return r.status.key === 'overdue';
      if (show === 'paid') return ['paid', 'credited'].includes(r.status.key);
    }
    return true;
  });
  return rows.sort((a, b) => (b.doc.status === 'draft') - (a.doc.status === 'draft')
    || String(b.day ?? '').localeCompare(String(a.day ?? '')) || String(b.number).localeCompare(String(a.number)));
}
function groupBy(list, key) {
  const m = new Map();
  for (const r of list) m.set(r[key], [...(m.get(r[key]) ?? []), r]);
  return m;
}

// ---- a new document ----------------------------------------------------------------------------------------------

/**
 * Who a document is for, as printed: the account (or the lead) name, then the address and the contact's name and
 * email. → { to_name, to_lines }
 */
export function recipientFor({ account = null, client = null, contact = null, lead = null } = {}) {
  const name = account?.name ?? client?.name ?? lead?.name ?? '';
  const lines = [];
  if (account) lines.push(...addressLines(account));
  const person = contact ?? (lead ? { name: lead.contact_name, email: lead.email } : null);
  if (person?.name && person.name !== name) lines.push(person.name);
  if (person?.email) lines.push(person.email);
  return { to_name: name, to_lines: lines.join('\n') || null };
}

/** The contact to write to for an account (its own first, then the client's with no account; one with an email first). */
export function contactFor(contacts, { clientId = null, accountId = null } = {}) {
  const mine = (contacts ?? []).filter((p) => p.client_id === clientId && (!accountId || p.account_id === accountId || !p.account_id));
  return mine.sort((a, b) => (Boolean(b.email) - Boolean(a.email)) || ((b.account_id === accountId) - (a.account_id === accountId)))[0] ?? null;
}

/** What a service bills, as a first line: its name, and a flat amount, or hours × the rate. null when it has no price. */
export function serviceLine(service) {
  if (!service) return null;
  const period = { monthly: ' (monthly)', quarterly: ' (quarterly)', yearly: ' (yearly)' }[service.period] ?? '';
  if (service.billing === 'hourly' && Number.isSafeInteger(service.rate_cents)) {
    return { description: `${service.name} (hours)`, quantity: service.sessions ?? 1, unit_cents: service.rate_cents };
  }
  if (Number.isSafeInteger(service.amount_cents)) return { description: `${service.name}${period}`, quantity: 1, unit_cents: service.amount_cents };
  return { description: service.name, quantity: 1, unit_cents: 0 };
}

/**
 * The new-document sheet's choice → the document's fields (status draft) and its first lines. choice: { kind,
 * businessId, clientId, accountId, relationshipId, serviceId, leadId, title }. → { fields, lines, problems }
 */
export function newDocument(choice, data) {
  const problems = {};
  const business = data.businessesById?.get(choice.businessId);
  if (!business) problems.businessId = 'Pick which of our businesses it is from';
  else if (BILLING_BLOCKED[business.id]) problems.businessId = BILLING_BLOCKED[business.id];
  const lead = choice.leadId ? data.leadsById?.get(choice.leadId) : null;
  const clientId = choice.clientId || lead?.won_client_id || lead?.client_id || '';
  if (choice.kind === 'invoice' && !clientId) problems.clientId = 'Pick the client to bill';
  if (choice.kind === 'quote' && !clientId && !lead) problems.clientId = 'Pick a client or a lead';
  const client = clientId ? data.clientsById?.get(clientId) : null;
  const accountId = choice.accountId || (lead && !choice.clientId ? lead.account_id : '') || '';
  const account = accountId ? data.accountsById?.get(accountId) : (client ? (data.accounts ?? []).filter((a) => a.client_id === client.id).length === 1 ? data.accounts.find((a) => a.client_id === client.id) : null : null);
  const contact = client ? contactFor(data.contacts, { clientId: client.id, accountId: account?.id ?? null }) : null;
  const to = client || account ? recipientFor({ account, client, contact }) : recipientFor({ lead });
  const service = choice.serviceId ? data.servicesById?.get(choice.serviceId) : null;
  const first = serviceLine(service);
  const fields = {
    status: 'draft', business_id: choice.businessId || null, client_id: clientId || null, account_id: account?.id ?? null,
    relationship_id: choice.relationshipId || service?.relationship_id || null, ...to, title: textOrNull(choice.title) ?? (service ? service.name : null),
  };
  if (choice.kind === 'quote') fields.lead_id = lead?.id ?? null;
  if (choice.kind === 'invoice') fields.service_id = service?.id ?? null;
  return { fields, lines: first ? [first] : [], problems };
}

/**
 * Save a new document and its first lines, with ids made once (a retry after a failure part-way, or a double tap,
 * makes nothing twice: `already_exists` counts as done). → the document's id
 */
export async function createDocument(store, kind, { fields, lines }, ids) {
  const create = async (entity, f, id) => {
    try {
      await store.create(entity, f, { id });
    } catch (err) {
      if (err?.code !== 'already_exists') throw err;
    }
  };
  await create(DOC_ENTITY[kind], fields, ids.doc);
  for (const [i, l] of lines.entries()) await create(LINE_ENTITY[kind], { [LINE_PARENT[kind]]: ids.doc, position: i, ...l }, ids.lines[i]);
  return ids.doc;
}
/** Ids for a new document and up to `n` lines. */
export const docIds = (newId, n = 0) => ({ doc: newId(), lines: Array.from({ length: n }, () => newId()) });

/** An invoice from an accepted quote: its client, account, relationship, what it says and its lines. */
export function invoiceFromQuote(quote, quoteLines, { lead = null } = {}) {
  const clientId = quote.client_id ?? lead?.won_client_id ?? lead?.client_id ?? null;
  if (!clientId) return { problem: 'This quote has no client yet: mark it accepted (which makes the client) first' };
  return {
    fields: {
      status: 'draft', business_id: quote.business_id, client_id: clientId, account_id: quote.account_id ?? null,
      relationship_id: quote.relationship_id ?? lead?.won_relationship_id ?? null, quote_id: quote.id, to_name: quote.to_name,
      to_lines: quote.to_lines ?? null, title: quote.title ?? null, tax_rate_bp: quote.tax_rate_bp ?? null,
    },
    lines: sortLines(quoteLines).map((l) => ({ description: l.description, quantity: l.quantity ?? null, unit_cents: l.unit_cents, tax_exempt: Boolean(l.tax_exempt) })),
  };
}
/** A credit note's draft for an invoice (lines added after: all of the invoice's, or some). */
export function creditNoteFor(invoice, reason = null) {
  return {
    fields: {
      status: 'draft', invoice_id: invoice.id, business_id: invoice.business_id, to_name: invoice.to_name, to_lines: invoice.to_lines ?? null,
      tax_rate_bp: invoice.tax_rate_bp ?? null, reason: textOrNull(reason),
    },
    lines: [],
  };
}

// ---- the forms ---------------------------------------------------------------------------------------------------

/** A line's sheet: { description, quantity, price, tax_exempt } (typed) → { fields, problems }. */
export const lineForm = {
  defaults: { description: '', quantity: '1', price: '', tax_exempt: false },
  fromRecord: (v, r) => ({
    ...v, description: r?.description ?? '', quantity: r ? String(r.quantity ?? 1) : '1', price: r ? centsToInput(r.unit_cents) : '', tax_exempt: Boolean(r?.tax_exempt),
  }),
  toFields(v) {
    const problems = {};
    const description = textOrNull(v.description);
    if (!description) problems.description = 'What is it?';
    const qtyText = String(v.quantity ?? '').trim().replace(',', '.');
    const quantity = qtyText === '' ? 1 : Number(qtyText);
    if (!(Number.isFinite(quantity) && quantity > 0 && quantity <= 1_000_000)) problems.quantity = 'More than 0, like 1, 2.5 or 10';
    const negative = String(v.price ?? '').trim().startsWith('-');
    const cents = parseDollars(String(v.price ?? '').trim().replace(/^-/, ''));
    if (cents === null) problems.price = 'Enter the price of one';
    else if (Number.isNaN(cents)) problems.price = 'Enter dollars, like 120 or 99.50 (a discount: -50)';
    return {
      problems,
      fields: { description, quantity: quantity === 1 ? null : Math.round(quantity * 1000) / 1000, unit_cents: Number.isNaN(cents) || cents === null ? null : (negative ? -cents : cents), tax_exempt: Boolean(v.tax_exempt) },
    };
  },
};

/** The document's details sheet (who it is for, title, notes, terms, the quote's date / the invoice's terms, tax). */
export const detailsForm = {
  defaults: { to_name: '', to_lines: '', title: '', notes: '', terms: '', valid_until: '', due_days: '', tax_rate_bp: String(HST_RATE_BP), reason: '' },
  fromRecord: (v, r) => ({
    ...v, due_days: r?.due_days === null || r?.due_days === undefined ? '' : String(r.due_days), tax_rate_bp: String(r?.tax_rate_bp ?? HST_RATE_BP),
  }),
  toFields(v) {
    const problems = {};
    if (!textOrNull(v.to_name)) problems.to_name = 'Who is it for?';
    const days = String(v.due_days ?? '').trim();
    const dueDays = days === '' ? null : Number(days);
    if (dueDays !== null && !(Number.isInteger(dueDays) && dueDays >= 0 && dueDays <= 365)) problems.due_days = '0 (on receipt) to 365 days';
    const rate = Number(v.tax_rate_bp);
    return {
      problems,
      fields: {
        to_name: textOrNull(v.to_name), to_lines: textOrNull(v.to_lines), title: textOrNull(v.title), notes: textOrNull(v.notes), terms: textOrNull(v.terms),
        valid_until: v.valid_until || null, due_days: dueDays, tax_rate_bp: rate === HST_RATE_BP ? null : rate, reason: textOrNull(v.reason),
      },
    };
  },
};
/** Only the details fields a kind has. */
export const DETAIL_FIELDS = Object.freeze({
  quote: ['to_name', 'to_lines', 'title', 'notes', 'terms', 'valid_until', 'tax_rate_bp'],
  invoice: ['to_name', 'to_lines', 'title', 'notes', 'terms', 'due_days', 'tax_rate_bp'],
  credit_note: ['to_name', 'to_lines', 'reason', 'notes', 'tax_rate_bp'],
});

/** The next line's position on a document. */
export const nextPosition = (lines) => (lines?.length ? Math.max(...lines.map((l) => l.position ?? 0)) + 1 : 0);

/**
 * A payment's sheet: amount ($, more than 0), day (not after tomorrow: the server refuses it — review fix), method, note.
 * → { fields, problems, warning } — `warning` when it was paid before the invoice's issue date (allowed: a deposit).
 */
export function paymentFields(v, invoiceId, { today = null, issueDate = null } = {}) {
  const problems = {};
  const cents = parseDollars(v.amount);
  if (!cents || Number.isNaN(cents)) problems.amount = 'Enter the amount received, like 1130 or 565.50';
  if (!v.paid_on) problems.paid_on = 'Pick the day it was paid';
  else if (today && v.paid_on > addDays(today, 1)) problems.paid_on = 'That day hasn’t come yet';
  const warning = v.paid_on && issueDate && v.paid_on < issueDate ? `Before the invoice was issued (${issueDate}): fine for a deposit — check the day otherwise` : null;
  return { problems, warning, fields: { invoice_id: invoiceId, amount_cents: Number.isNaN(cents) ? null : cents, paid_on: v.paid_on || null, method: v.method || null, note: textOrNull(v.note) } };
}

// ---- approving a draft -------------------------------------------------------------------------------------------

/** What the person is about to approve (shown in the sheet): { fingerprint, totals, problems, lines }. */
export function approval(kind, doc, lines) {
  const mine = linesOf(kind, doc.id, lines);
  return { fingerprint: documentFingerprint(doc, mine), totals: documentTotals(mine, doc.tax_rate_bp ?? HST_RATE_BP), problems: documentProblems(doc, mine), lines: mine };
}

/**
 * Send a quote / issue an invoice or a credit note: sync first (the server must have this device's latest), check that
 * what the device holds now is what the person approved (the fingerprint), then ask the server (number + PDF), then
 * sync again so the number shows. Throws an Error with `code` ('pending', 'changed', or the server's). Needs a connection.
 * @param {{ syncNow, get, list }} store   @param {{ post }} api
 */
export async function approveDocument(store, api, kind, id, { fingerprint, today }) {
  await store.syncNow();
  const doc = await store.get(DOC_ENTITY[kind], id);
  if (!doc) throw Object.assign(new Error('It isn’t on this device any more'), { code: 'not_found' });
  const lines = (await store.list(LINE_ENTITY[kind], { where: { [LINE_PARENT[kind]]: id } }));
  if (doc._sync?.pending || lines.some((l) => l._sync?.pending)) {
    throw Object.assign(new Error('Some changes haven’t reached the suite yet: try again when the sync bar says they are saved'), { code: 'pending' });
  }
  if (documentFingerprint(doc, lines) !== fingerprint) {
    throw Object.assign(new Error('It changed while you were looking at it: check it again, then approve'), { code: 'changed' });
  }
  const out = await api.post(approvePath(kind, id), { today, fingerprint });
  await store.syncNow();
  return out;
}

// ---- sending it (the person does) --------------------------------------------------------------------------------

/**
 * The email the person sends the PDF with (the suite sends nothing): { to, subject, body, mailto }. A quote or an
 * invoice is a transactional message the client expects, not marketing, so it needs no CASL consent.
 */
export function emailFor(kind, doc, { business = null, email = null, settings = null, dueText = null, totalCents = null } = {}) {
  const ours = settings?.legal_name ?? business?.name ?? '';
  const total = moneyText(totalCents ?? doc.total_cents ?? 0);
  const label = KIND_LABELS[kind].toLowerCase();
  const subject = `${KIND_LABELS[kind]} ${doc.number ?? ''} from ${ours}`.replace(/\s+/g, ' ').trim();
  const lines = [`Hello${doc.to_name ? ` ${doc.to_name}` : ''},`, ''];
  if (kind === 'quote') lines.push(`Here is our quote ${doc.number}${doc.title ? ` for ${doc.title}` : ''}: ${total} (HST included). It is attached as a PDF.`, '', 'Reply to this email to go ahead, or with any questions.');
  if (kind === 'invoice') lines.push(`Here is invoice ${doc.number}${doc.title ? ` for ${doc.title}` : ''}: ${total}${dueText ? `, due ${dueText}` : ''}. It is attached as a PDF.`, ...(settings?.payment_instructions ? ['', `How to pay: ${settings.payment_instructions}`] : []));
  if (kind === 'credit_note') lines.push(`Here is credit note ${doc.number}: ${total}. It is attached as a PDF.`);
  lines.push('', 'Thank you,', ours);
  const body = lines.join('\n');
  const to = email ?? '';
  return { to, subject, body, label, mailto: `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` };
}

/** The decision on a sent quote: { status, decided_on, declined_reason?, decided_note? } and whether its lead is lost too. */
export function declineFields({ reason, note, day }) {
  if (!reason) return { problem: 'Say why (it goes on the lead too)' };
  return { fields: { status: 'declined', decided_on: day, declined_reason: reason, decided_note: textOrNull(note) } };
}
