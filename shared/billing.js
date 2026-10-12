// Quotes, invoices and credit notes (D17, D18): the facts the server and devices share — statuses, which of our
// businesses may bill, numbers, money on a document (lines, HST, totals), where an invoice stands (paid, partly paid,
// overdue…), and how invoices count in sales (the money they brought in and kept, on the day it came in). The record
// types are registered by the server's billing module (server/src/modules/billing/entities.js). Working documents:
// the accountant keeps the books. See CLAUDE.md, "Quotes, invoices and credit notes (D17, D18)".
import { BUSINESS_IDS } from './crm.js';
import { addDays } from './planner.js';

export const BILLING_KINDS = Object.freeze(['quote', 'invoice', 'credit_note']);
/** The synced record type of each kind and of its lines. */
export const DOC_ENTITY = Object.freeze({ quote: 'quote', invoice: 'invoice', credit_note: 'credit_note' });
export const LINE_ENTITY = Object.freeze({ quote: 'quote_line', invoice: 'invoice_line', credit_note: 'credit_note_line' });
/** A line's field naming its document. */
export const LINE_PARENT = Object.freeze({ quote: 'quote_id', invoice: 'invoice_id', credit_note: 'credit_note_id' });

/**
 * A quote: a draft (written on any device, offline too) → sent (the server gives it its number and its PDF when a
 * person approves the draft) → accepted or declined (on a device: accepting a lead's quote wins the lead).
 */
export const QUOTE_STATUSES = Object.freeze(['draft', 'sent', 'accepted', 'declined']);
/** An invoice: draft → issued (number + PDF, by the server) → void (by the server; only with no payment). Paid is worked out. */
export const INVOICE_STATUSES = Object.freeze(['draft', 'issued', 'void']);
/** A credit note: draft → issued (number + PDF). It takes money off one issued invoice. */
export const CREDIT_NOTE_STATUSES = Object.freeze(['draft', 'issued']);
export const PAYMENT_METHODS = Object.freeze(['etransfer', 'cheque', 'cash', 'card', 'bank_transfer', 'other']);
export const PAYMENT_METHOD_LABELS = Object.freeze({
  etransfer: 'Interac e-Transfer', cheque: 'Cheque', cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other',
});

/** Ontario HST, in basis points (13 % = 1300). A document's rate; a line can be HST-exempt. */
export const HST_RATE_BP = 1300;
/** Days a quote stays valid, and an invoice's payment terms, unless a business's settings say otherwise. */
export const DEFAULT_QUOTE_VALID_DAYS = 30;
export const DEFAULT_INVOICE_DUE_DAYS = 30;
/** The follow-up task for a sent quote is due this many days after it was sent. */
export const QUOTE_FOLLOW_UP_DAYS = 7;
/** Limits: lines per document, a line's text, a quantity's and an amount's size. */
export const LINE_MAX = 200;
export const LINE_TEXT_MAX = 2000;
export const AMOUNT_MAX_CENTS = 100_000_000_00; // $100 million: anything bigger is a typo

/**
 * Our businesses that never bill through the suite, and why (the words shown): wholesale invoices stay in the Order
 * Manager, Save Point Shop sells on eBay (its sales are counted from there — an invoice here would count them twice),
 * Personal isn't a business that sells. Everything else may (Great White North Design, Business consulting, the retail
 * stores — for sales outside WooCommerce —, and any business added later).
 */
export const BILLING_BLOCKED = Object.freeze({
  [BUSINESS_IDS.wholesale]: 'Wholesale invoices stay in the Order Manager',
  [BUSINESS_IDS.save_point]: 'Save Point Shop sells on eBay: its sales are counted from there',
  [BUSINESS_IDS.personal]: 'Personal isn’t a business that bills',
});
/**
 * D17/D18 review: on D11's "Sales entered by hand" sheet, for a business that invoices here — its invoices made on
 * Money → Billing count in sales by themselves when paid, so entering them by hand too would count them twice.
 */
export const INVOICED_HERE_NOTE = 'Invoices made on Money → Billing count in sales by themselves when they’re paid: enter only sales that weren’t invoiced there';
export const invoicedHereNote = (businessId) => (businessId && !BILLING_BLOCKED[businessId] && businessId !== BUSINESS_IDS.retail ? INVOICED_HERE_NOTE : null);

/** May this business make quotes and invoices? (not blocked; not archived — unless `keep`, the document's own) */
export const billingAllowed = (business, keep = null) => Boolean(business) && !BILLING_BLOCKED[business.id]
  && (!business.archived || business.id === keep);

/** The short code of each kind in its number: GWND-Q-0007, GWND-INV-0012, GWND-CN-0002. */
export const KIND_CODES = Object.freeze({ quote: 'Q', invoice: 'INV', credit_note: 'CN' });
export const KIND_LABELS = Object.freeze({ quote: 'Quote', invoice: 'Invoice', credit_note: 'Credit note' });
const DEFAULT_PREFIXES = Object.freeze({ [BUSINESS_IDS.agency]: 'GWND', [BUSINESS_IDS.consulting]: 'BC', [BUSINESS_IDS.retail]: 'RS' });
export const PREFIX_RE = /^[A-Z0-9]{0,8}$/;

/** A business's number prefix when its settings give none: GWND for Great White North Design, else its initials. */
export function defaultPrefix(business) {
  if (!business) return '';
  if (DEFAULT_PREFIXES[business.id]) return DEFAULT_PREFIXES[business.id];
  const words = String(business.name ?? '').normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
}

/** A document's number: "GWND-INV-0012" (prefix may be empty: "INV-0012"). Numbers count per business and kind. */
export function formatNumber(prefix, kind, seq) {
  const code = `${KIND_CODES[kind]}-${String(seq).padStart(4, '0')}`;
  return prefix ? `${prefix}-${code}` : code;
}

// ---- money on a document ---------------------------------------------------------------------------

/** Round to whole cents, halves away from zero (−2.5 → −3, like 2.5 → 3: a discount line mirrors its price). */
export const roundCents = (x) => Math.sign(x) * Math.round(Math.abs(x));

/** A line's amount in cents: quantity (null = 1) × unit price, rounded once. */
export function lineAmount(line) {
  const qty = line?.quantity === null || line?.quantity === undefined ? 1 : Number(line.quantity);
  const unit = Number(line?.unit_cents ?? 0);
  if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0;
  return roundCents(qty * unit);
}

/** A document's lines in their order (position, then id: made first comes first). */
export function sortLines(lines) {
  return [...(lines ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id)));
}

/**
 * A document's totals: subtotal (every line), the part HST applies to (lines not exempt), HST at the document's rate on
 * that part — rounded once, on the document (not per line) — and the total. All integer cents.
 * → { subtotal, taxable, exempt, tax, total, rateBp }
 */
export function documentTotals(lines, rateBp = HST_RATE_BP) {
  const rate = Number.isSafeInteger(rateBp) && rateBp >= 0 ? rateBp : HST_RATE_BP;
  let taxable = 0;
  let exempt = 0;
  for (const l of lines ?? []) {
    const a = lineAmount(l);
    if (l.tax_exempt) exempt += a;
    else taxable += a;
  }
  const tax = Math.round((taxable * rate) / 10_000);
  return { subtotal: taxable + exempt, taxable, exempt, tax, total: taxable + exempt + tax, rateBp: rate };
}

/**
 * The tax's name for a rate (review fix: one label on the PDF and the screen): 13 % HST (Ontario), 5 % GST (outside the
 * HST provinces), 0 % zero-rated (outside Canada), anything else "Tax".
 */
export function taxLabel(rateBp) {
  const r = rateBp ?? HST_RATE_BP;
  return r === HST_RATE_BP ? 'HST' : r === 500 ? 'GST' : r === 0 ? 'Zero-rated' : 'Tax';
}
/** "HST 13 %", "GST 5 %", "Zero-rated (0 %)", "Tax 7 %"; with `on` (the taxable part when some lines are exempt): "HST 13 % on $X". */
export function taxLineText(rateBp, { on = null } = {}) {
  const r = rateBp ?? HST_RATE_BP;
  const name = taxLabel(r);
  const base = r === 0 ? `${name} (0 %)` : `${name} ${rateText(r)}`;
  return on === null ? base : `${base} on ${moneyText(on)}`;
}

/** "13 %", "5 %", "14.975 %" for a rate in basis points. */
export function rateText(rateBp) {
  const r = (rateBp ?? HST_RATE_BP) / 100;
  return `${Number.isInteger(r) ? r : r.toFixed(3).replace(/0+$/, '')} %`;
}

/** "$1,234.50" (always two decimals: documents show cents). Negative: "−$5.00". */
export function moneyText(cents, currency = 'CAD') {
  const n = Number(cents) || 0;
  const s = new Intl.NumberFormat('en-CA', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n) / 100);
  return n < 0 ? `−${s}` : s;
}

/**
 * What a person approves when sending or issuing: every printed value of the document and its lines, as one short text
 * hash (FNV-1a, the same in Node and the browser). The server refuses to send or issue a document whose fingerprint
 * differs from the one the person saw (changed on the other device meanwhile, or not synced yet).
 */
export function documentFingerprint(doc, lines) {
  const printed = {
    business_id: doc?.business_id ?? null, to_name: doc?.to_name ?? null, to_lines: doc?.to_lines ?? null, title: doc?.title ?? null,
    notes: doc?.notes ?? null, terms: doc?.terms ?? null, valid_until: doc?.valid_until ?? null, due_days: doc?.due_days ?? null,
    reason: doc?.reason ?? null, tax_rate_bp: doc?.tax_rate_bp ?? null,
    lines: sortLines(lines).map((l) => [l.id, l.description ?? null, l.quantity ?? null, l.unit_cents ?? null, Boolean(l.tax_exempt)]),
  };
  const text = JSON.stringify(printed);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A line's problems before sending/issuing (null when fine): text, a quantity above 0, a whole-cent price. */
export function lineProblem(line) {
  if (!String(line?.description ?? '').trim()) return 'A line has no description';
  const qty = line.quantity === null || line.quantity === undefined ? 1 : Number(line.quantity);
  if (!(Number.isFinite(qty) && qty > 0 && qty <= 1_000_000)) return 'A quantity is more than 0';
  if (!Number.isSafeInteger(line.unit_cents) || Math.abs(line.unit_cents) > AMOUNT_MAX_CENTS) return 'A price is a whole number of cents';
  return null;
}

/**
 * Why a document can't be sent or issued yet (a list of plain sentences; [] = it can): something to bill (a name), at
 * least one line, every line complete, a total of $0 or more, at most LINE_MAX lines.
 */
export function documentProblems(doc, lines) {
  const out = [];
  if (!String(doc?.to_name ?? '').trim()) out.push('Say who it’s for (the “To” name)');
  if (!lines?.length) out.push('Add at least one line');
  if ((lines?.length ?? 0) > LINE_MAX) out.push(`At most ${LINE_MAX} lines`);
  for (const l of lines ?? []) {
    const p = lineProblem(l);
    if (p) {
      out.push(p);
      break;
    }
  }
  if (lines?.length && documentTotals(lines, doc?.tax_rate_bp ?? HST_RATE_BP).total < 0) out.push('The total can’t be below $0');
  return out;
}

// ---- where an invoice stands -----------------------------------------------------------------------

const live = (r) => r && !r.deleted_at;

/**
 * An invoice's state on `today` from its payments and issued credit notes (pass those of this invoice, live):
 * { state: draft | void | unpaid | partly_paid | paid | credited, total, paid, credited, owing, overpaid, overdue,
 *   daysOverdue }. owing = total − credit notes − payments (never below 0); overpaid = what was paid beyond that (money
 * to give back or keep as credit). credited = cancelled in full by credit notes with nothing paid.
 */
export function invoiceState(invoice, payments = [], creditNotes = [], today = null) {
  const status = invoice?.status ?? 'draft';
  const total = invoice?.total_cents ?? 0;
  const paid = payments.filter(live).reduce((a, p) => a + (p.amount_cents ?? 0), 0);
  const credited = creditNotes.filter((c) => live(c) && c.status === 'issued').reduce((a, c) => a + (c.total_cents ?? 0), 0);
  const due = Math.max(0, total - credited);
  const owing = Math.max(0, due - paid);
  const overpaid = Math.max(0, paid - due);
  let state;
  if (status === 'draft') state = 'draft';
  else if (status === 'void') state = 'void';
  else if (owing === 0 && paid === 0 && credited > 0) state = 'credited';
  else if (owing === 0) state = 'paid';
  else if (paid > 0) state = 'partly_paid';
  else state = 'unpaid';
  const overdue = (state === 'unpaid' || state === 'partly_paid') && Boolean(today && invoice?.due_date && invoice.due_date < today);
  const daysOverdue = overdue ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${invoice.due_date}T00:00:00Z`)) / 86_400_000) : 0;
  return { state, total, paid, credited, owing: status === 'issued' ? owing : 0, overpaid, overdue, daysOverdue };
}
export const INVOICE_STATE_LABELS = Object.freeze({
  draft: 'Draft', void: 'Void', unpaid: 'Unpaid', partly_paid: 'Partly paid', paid: 'Paid', credited: 'Credited in full',
});

/** An invoice's due date: its issue date + its terms in days (0 = due on receipt). */
export const dueDateOf = (issueDate, dueDays = DEFAULT_INVOICE_DUE_DAYS) => addDays(issueDate, Math.max(0, Number(dueDays) || 0));

// ---- invoices in sales -----------------------------------------------------------------------------

/**
 * Sales from invoices (D18 decision — counted as money comes in, as every other source counts a sale only once it is
 * paid): per business and day, the money invoices brought in **and kept**. For each issued invoice, on every day a
 * payment arrived or a credit note was issued, kept = min(paid so far, total − credited so far) (never below 0), and the
 * day counts the change in `kept`. So a payment counts on the day it was paid; a credit note on a paid invoice takes its
 * amount off on its own day (money given back); a credit note before payment only lowers what is still owed (nothing
 * counted twice); a void invoice (never paid: voiding is refused with payments) counts nothing. Each change is split into
 * before-tax and HST in the invoice's own proportion (worked out on the running total, so the parts always add up).
 *
 * invoices: issued/void ones { id, business_id, status, subtotal_cents, tax_cents, total_cents };
 * payments: live { invoice_id, amount_cents, paid_on }; creditNotes: issued { invoice_id, issue_date, total_cents }.
 * → Map<business_id, Map<day, { orders, items, gross, discounts, refunds, net, tax, shipping, total }>>
 *   orders = invoices that brought money in that day; refunds = before-tax money given back (credit notes on what was paid).
 */
export function invoiceSalesDays(invoices, payments, creditNotes) {
  const payBy = new Map();
  for (const p of payments ?? []) {
    if (!live(p)) continue;
    payBy.set(p.invoice_id, [...(payBy.get(p.invoice_id) ?? []), p]);
  }
  const cnBy = new Map();
  for (const c of creditNotes ?? []) {
    if (!live(c) || c.status !== 'issued') continue;
    cnBy.set(c.invoice_id, [...(cnBy.get(c.invoice_id) ?? []), c]);
  }
  const out = new Map();
  const row = (business, day) => {
    let days = out.get(business);
    if (!days) out.set(business, (days = new Map()));
    let r = days.get(day);
    if (!r) days.set(day, (r = { orders: 0, items: 0, gross: 0, discounts: 0, refunds: 0, net: 0, tax: 0, shipping: 0, total: 0 }));
    return r;
  };
  for (const inv of invoices ?? []) {
    if (!live(inv) || inv.status !== 'issued') continue;
    const total = inv.total_cents ?? 0;
    if (total <= 0) continue;
    const sub = inv.subtotal_cents ?? total;
    const ps = payBy.get(inv.id) ?? [];
    const cs = cnBy.get(inv.id) ?? [];
    const days = [...new Set([...ps.map((p) => p.paid_on), ...cs.map((c) => c.issue_date)])].filter(Boolean).sort();
    let keptNet = 0;
    let keptTax = 0;
    for (const day of days) {
      const paid = ps.filter((p) => p.paid_on <= day).reduce((a, p) => a + (p.amount_cents ?? 0), 0);
      const credited = cs.filter((c) => c.issue_date <= day).reduce((a, c) => a + (c.total_cents ?? 0), 0);
      const kept = Math.max(0, Math.min(paid, total - credited));
      const net = Math.round((kept * sub) / total);
      const tax = kept - net;
      const dn = net - keptNet;
      const dt = tax - keptTax;
      keptNet = net;
      keptTax = tax;
      if (!dn && !dt) continue;
      const r = row(inv.business_id, day);
      if (dn > 0) r.gross += dn;
      else r.refunds += -dn;
      if (dn + dt > 0) r.orders += 1;
      r.net += dn;
      r.tax += dt;
      r.total += dn + dt;
    }
  }
  return out;
}

/** The sales module's store key for one business's invoices (CAD only: documents are in Canadian dollars). */
export const invoiceStoreKey = (businessId) => `invoices:${businessId}`;
