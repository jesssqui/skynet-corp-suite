// What a quote, an invoice or a credit note looks like on paper (D17/D18): our business at the top in its colour
// (`business.color`, else the CRM's fixed colour for it) with its details from the billing settings (name, address,
// HST number, email, phone, website), the kind, number and dates, who it is for, the lines (description, quantity,
// unit price, amount; HST-exempt lines marked), subtotal, HST and total in Canadian dollars, then notes, terms and —
// on an invoice — how to pay. A draft preview says DRAFT across every page and has no number.
// Pure: the same input always gives the same bytes (pdf.js writes no dates or ids).
import { parseLocalDate } from '@suite/shared/time';
import { documentTotals, sortLines, lineAmount, moneyText, rateText, KIND_LABELS } from '@suite/shared/billing';
import { Page, PAGE, writePdf, wrapText, textWidth, tint } from './pdf.js';

const M = 48; // margin
const RIGHT = PAGE.width - M;
const BOTTOM = PAGE.height - 64; // where a page's content stops (the footer sits below)
const GREY = '#666666';
const DARK = '#1f2328';
const RULE = '#d0d4d9';

/** "October 12, 2026" for a calendar day ('' for none). */
export const longDate = (ymd) => (ymd ? parseLocalDate(ymd).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric' }) : '');

/** "1", "2.5", "0.25": a quantity as written on the document. */
const qtyText = (q) => {
  const n = q === null || q === undefined ? 1 : Number(q);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
};

/**
 * The PDF of one document (a Buffer).
 * input: { kind: 'quote'|'invoice'|'credit_note', number (null on a draft), draft, business: { name, color },
 *   settings: { legal_name, address, hst_number, email, phone, website, payment_instructions },
 *   doc: { to_name, to_lines, title, notes, terms, tax_rate_bp, reason }, lines,
 *   date (sent / issued day), validUntil (quote), dueDate (invoice), forInvoice (credit note: the invoice's number),
 *   forQuote (invoice: the quote's number) }
 */
export function renderDocument(input) {
  const { kind, number = null, draft = false, business = {}, settings = {}, doc = {}, lines = [] } = input;
  const color = business.color || '#1d6fa5';
  const label = KIND_LABELS[kind] ?? 'Document';
  const ours = settings.legal_name || business.name || '';
  const sorted = sortLines(lines);
  const totals = documentTotals(sorted, doc.tax_rate_bp ?? undefined);
  const pages = [];
  let page;
  let y;

  const newPage = (first) => {
    page = new Page();
    pages.push(page);
    page.rect(0, 0, PAGE.width, 10, color);
    if (draft) page.watermark('DRAFT');
    if (first) {
      y = 56;
      return;
    }
    page.text(M, 40, ours, { size: 9, bold: true, color: GREY });
    page.text(RIGHT, 40, `${label}${number ? ` ${number}` : ''} (continued)`, { size: 9, color: GREY, align: 'right' });
    y = 64;
  };
  const room = (h) => {
    if (y + h > BOTTOM) newPage(false);
  };

  // ---- the header: us on the left, the document on the right -------------------------------------------------
  newPage(true);
  const leftW = 300;
  let ly = y;
  for (const l of wrapText(ours, leftW, 17, true)) {
    page.text(M, ly + 14, l, { size: 17, bold: true, color: DARK });
    ly += 20;
  }
  const ourLines = [
    ...String(settings.address ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    settings.hst_number ? `HST # ${settings.hst_number}` : null,
    settings.email || null, settings.phone || null, settings.website || null,
  ].filter(Boolean);
  for (const l of ourLines.flatMap((s) => wrapText(s, leftW, 9))) {
    page.text(M, ly + 9, l, { size: 9, color: GREY });
    ly += 12;
  }
  let ry = y;
  page.text(RIGHT, ry + 20, label.toUpperCase(), { size: 22, bold: true, color, align: 'right' });
  ry += 30;
  const facts = [
    [draft ? 'Draft' : 'Number', draft ? 'not sent — no number yet' : (number ?? '')],
    [kind === 'quote' ? 'Date' : 'Issued', longDate(input.date)],
    kind === 'quote' && input.validUntil ? ['Valid until', longDate(input.validUntil)] : null,
    kind === 'invoice' && input.dueDate ? ['Due', input.dueDate === input.date ? `${longDate(input.dueDate)} (on receipt)` : longDate(input.dueDate)] : null,
    kind === 'invoice' && input.forQuote ? ['For quote', input.forQuote] : null,
    kind === 'credit_note' && input.forInvoice ? ['For invoice', input.forInvoice] : null,
  ].filter((f) => f && f[1]);
  for (const [k, v] of facts) {
    page.text(RIGHT - 130, ry + 9, k, { size: 9, color: GREY, align: 'right' });
    page.text(RIGHT, ry + 9, v, { size: 9, bold: true, color: DARK, align: 'right' });
    ry += 13;
  }
  y = Math.max(ly, ry) + 22;

  // ---- who it is for ---------------------------------------------------------------------------------------
  page.text(M, y, kind === 'quote' ? 'PREPARED FOR' : 'BILL TO', { size: 8, bold: true, color: GREY });
  y += 14;
  for (const l of wrapText(doc.to_name ?? '', 330, 11, true)) {
    page.text(M, y, l, { size: 11, bold: true, color: DARK });
    y += 14;
  }
  for (const l of String(doc.to_lines ?? '').split(/\r?\n/).filter((s) => s.trim()).flatMap((s) => wrapText(s.trim(), 330, 10))) {
    page.text(M, y, l, { size: 10, color: DARK });
    y += 13;
  }
  y += 10;
  if (kind === 'credit_note' && doc.reason) {
    room(30);
    for (const l of wrapText(`Reason: ${doc.reason}`, RIGHT - M, 10)) {
      page.text(M, y, l, { size: 10, color: DARK });
      y += 13;
    }
    y += 6;
  }
  if (doc.title) {
    for (const l of wrapText(doc.title, RIGHT - M, 13, true)) {
      room(18);
      page.text(M, y + 4, l, { size: 13, bold: true, color: DARK });
      y += 18;
    }
    y += 4;
  }

  // ---- the lines -------------------------------------------------------------------------------------------
  const COL_QTY = 390;
  const COL_UNIT = 478;
  const descW = COL_QTY - 40 - M - 8;
  const header = () => {
    page.rect(M, y, RIGHT - M, 20, tint(color, 0.88));
    page.text(M + 8, y + 13.5, 'Description', { size: 8.5, bold: true, color: DARK });
    page.text(COL_QTY, y + 13.5, 'Qty', { size: 8.5, bold: true, color: DARK, align: 'right' });
    page.text(COL_UNIT, y + 13.5, 'Unit price', { size: 8.5, bold: true, color: DARK, align: 'right' });
    page.text(RIGHT - 8, y + 13.5, 'Amount', { size: 8.5, bold: true, color: DARK, align: 'right' });
    y += 26;
  };
  room(60);
  header();
  const anyExempt = sorted.some((l) => l.tax_exempt);
  for (const l of sorted) {
    const parts = wrapText(l.description ?? '', descW, 10);
    const h = parts.length * 13 + 8;
    if (y + h > BOTTOM) {
      newPage(false);
      header();
    }
    page.text(COL_QTY, y + 9, qtyText(l.quantity), { size: 10, color: DARK, align: 'right' });
    page.text(COL_UNIT, y + 9, moneyText(l.unit_cents ?? 0), { size: 10, color: DARK, align: 'right' });
    page.text(RIGHT - 8, y + 9, `${moneyText(lineAmount(l))}${l.tax_exempt ? ' *' : ''}`, { size: 10, color: DARK, align: 'right' });
    for (const [i, p] of parts.entries()) page.text(M + 8, y + 9 + i * 13, p, { size: 10, color: DARK });
    y += h;
    page.line(M, y - 3, RIGHT, y - 3, RULE, 0.5);
  }

  // ---- totals ----------------------------------------------------------------------------------------------
  room(90);
  y += 8;
  const label2 = RIGHT - 120;
  const sum = (name, value, { bold = false, size = 10 } = {}) => {
    page.text(label2, y, name, { size, bold, color: DARK, align: 'right' });
    page.text(RIGHT - 8, y, value, { size, bold, color: DARK, align: 'right' });
    y += size + 6;
  };
  sum('Subtotal', moneyText(totals.subtotal));
  sum(totals.exempt ? `HST ${rateText(totals.rateBp)} on ${moneyText(totals.taxable)}` : `HST ${rateText(totals.rateBp)}`, moneyText(totals.tax));
  page.line(label2 - 110, y - 4, RIGHT, y - 4, DARK, 1);
  y += 12;
  sum(kind === 'credit_note' ? 'Total credit (CAD)' : 'Total (CAD)', moneyText(totals.total), { bold: true, size: 12 });
  if (anyExempt) {
    page.text(M, y, '* No HST on this line', { size: 8, color: GREY });
    y += 12;
  }
  y += 14;

  // ---- notes, terms, how to pay ----------------------------------------------------------------------------
  const block = (title, text) => {
    if (!String(text ?? '').trim()) return;
    room(34);
    page.text(M, y, title.toUpperCase(), { size: 8, bold: true, color: GREY });
    y += 13;
    for (const l of wrapText(text, RIGHT - M, 9.5)) {
      room(13);
      page.text(M, y, l, { size: 9.5, color: DARK });
      y += 12.5;
    }
    y += 10;
  };
  block('Notes', doc.notes);
  block('Terms', doc.terms);
  if (kind === 'invoice') block('How to pay', settings.payment_instructions);
  if (kind === 'quote' && input.validUntil) block('Acceptance', `This quote is valid until ${longDate(input.validUntil)}. Reply to accept it.`);

  // ---- footers: "Great White North Design · GWND-INV-0012 · Page 1 of 2" ----------------------------------------
  pages.forEach((p, i) => {
    const text = [ours, draft ? 'Draft' : number, `Page ${i + 1} of ${pages.length}`].filter(Boolean).join(' · ');
    p.line(M, PAGE.height - 44, RIGHT, PAGE.height - 44, RULE, 0.5);
    p.text(PAGE.width / 2, PAGE.height - 30, text, { size: 8, color: GREY, align: 'center' });
  });
  return writePdf(pages, { title: `${label}${number ? ` ${number}` : ' (draft)'}`, author: ours });
}

export { textWidth };
