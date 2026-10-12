// Quotes, invoices and credit notes (D17, D18), signed in (/api/billing). Drafts, decisions and payments are synced
// records written on devices (offline too); these routes are the server's part — what needs the server's numbers,
// PDFs and settings:
//   GET  /settings                       every business that may bill: what prints on its documents, its defaults
//   PUT  /settings/:businessId { legal_name, address, hst_number, email, phone, website, payment_instructions, prefix,
//                                quote_valid_days, invoice_due_days, quote_terms, invoice_terms }
//   GET  /pdf/:kind/:id?today=&download=1   the stored PDF once sent / issued; a DRAFT preview before (kind: quote |
//                                        invoice | credit_note)
//   POST /quotes/:id/send { today, fingerprint }        approve a quote's draft: number + PDF + sent (+ its lead → Quoted)
//   POST /invoices/:id/issue { today, fingerprint }     approve an invoice's draft: number + PDF + issued (+ due date)
//   POST /invoices/:id/void { today, reason }           a mistake: only with no payment and no credit note
//   POST /credit-notes/:id/issue { today, fingerprint } approve a credit note
//   GET  /archive                        every document as sent / issued (newest first), marked when not in the database
//   GET  /pdf-archive/:kind/:id          a kept PDF, also when its record isn't in the database (after a restore)
// `fingerprint` = documentFingerprint (@suite/shared/billing) of what the person saw; a different one → 409 changed.
// Nothing here emails anyone: the person downloads or shares the PDF and sends it themselves.
import { Router } from 'express';
import { HttpError } from '../../lib/httpError.js';

const KINDS = { quote: 'quote', invoice: 'invoice', credit_note: 'credit_note', 'credit-note': 'credit_note' };

/**
 * A PDF answer. The app's CSP (helmet: object-src 'none', …) is for HTML pages; browsers' built-in PDF viewers can refuse to
 * show a PDF that carries it, so a PDF answer goes without it — these PDFs are the suite's own (pdf.js writes text and
 * boxes only: no scripts, links or forms). nosniff stays (it is only ever application/pdf).
 */
function sendPdf(res, pdf, filename, { download = false, draft = null } = {}) {
  res.removeHeader('Content-Security-Policy');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
  if (draft !== null) res.set('X-Billing-Draft', draft ? '1' : '0');
  res.send(pdf);
}

export function createBillingRouter(_ctx, service) {
  const router = Router();
  if (!service?.available) return router;
  const who = (req) => ({ actor: req.auth.user.actor });
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/settings', (_req, res) => res.json({ businesses: service.listSettings() }));
  router.put('/settings/:businessId', (req, res) => res.json({ business: service.putSettings(req.params.businessId, req.body ?? {}, who(req)) }));
  router.get('/archive', (_req, res) => res.json({ documents: service.archive() }));
  router.get('/pdf/:kind/:id', (req, res) => {
    const kind = KINDS[req.params.kind];
    if (!kind) throw new HttpError(404, 'No such kind of document');
    const { pdf, filename, draft } = service.pdfOf(kind, req.params.id, { today: typeof req.query.today === 'string' ? req.query.today : null });
    sendPdf(res, pdf, filename, { download: Boolean(req.query.download), draft });
  });
  router.get('/pdf-archive/:kind/:id', (req, res) => {
    const kind = KINDS[req.params.kind];
    if (!kind) throw new HttpError(404, 'No such kind of document');
    const { pdf, filename } = service.archivedPdf(kind, req.params.id);
    sendPdf(res, pdf, filename);
  });
  const approve = (kind) => (req, res) => {
    const { today = null, fingerprint = null } = req.body ?? {};
    res.json(service.approve(kind, req.params.id, { ...who(req), today, fingerprint }));
  };
  router.post('/quotes/:id/send', approve('quote'));
  router.post('/invoices/:id/issue', approve('invoice'));
  router.post('/credit-notes/:id/issue', approve('credit_note'));
  router.post('/invoices/:id/void', (req, res) => {
    const { today = null, reason = null } = req.body ?? {};
    res.json(service.voidInvoice(req.params.id, { ...who(req), today, reason }));
  });
  return router;
}
