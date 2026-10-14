// Quotes, invoices and credit notes (D17, D18): synced drafts (quotes, invoices, credit notes with their lines, and
// payments), approved on the server (a gap-free number per business and kind, the PDF stored for good), the 7-day
// follow-up task for sent quotes, lead stages moving with them (D8), and invoices counted in sales as money comes in.
// Working documents: the accountant keeps the books. See CLAUDE.md, "Quotes, invoices and credit notes (D17, D18)".
// Registered after crm, planner, automations and sales (its records point at the CRM, its follow-ups are tasks, its
// sales go to the sales module), before the overview (which reads overdueInvoices).
import { fileURLToPath } from 'node:url';
import { createBillingService } from './service.js';
import { createBillingRouter } from './routes.js';

export default {
  name: 'billing',
  migrationsDir: fileURLToPath(new URL('./migrations', import.meta.url)),
  createService: createBillingService,
  createRouter: createBillingRouter,
  // At start: the invoice sales days as the records say (after a restore sales_daily is rolled back, or a change
  // whose rebuild failed), and the follow-up tasks as the quotes say.
  start(ctx, service) {
    if (!service?.available) return;
    try {
      service.rebuildSales();
    } catch (err) {
      ctx.log.error('writing the invoice sales days failed (written again after the next change):', err);
    }
    try {
      ctx.services.automations?.emit?.('billing.changed', { key: `start:${Date.now()}` });
    } catch (err) {
      ctx.log.error('checking the quote follow-ups failed:', err);
    }
  },
  // Kept across a restore (not rolled back with the data):
  //  - the business details and defaults (settings, like the switches);
  //  - the number counters and the issued PDFs: a client has the document, so a number must never be given twice and
  //    what was sent must stay findable even when the database goes back to before it (Money → Billing lists the PDFs
  //    whose record isn't in the database any more).
  keepOnRestore: ['billing_settings', 'billing_counters', 'billing_pdfs'],
};
