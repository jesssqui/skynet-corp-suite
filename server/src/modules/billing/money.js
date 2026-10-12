// Invoices and money (D18): how the suite's own invoices count in sales, and which are past due.
//
//   sales     source 'invoices' in the sales module, one store per business ('invoices:<business id>', CAD), its days
//             worked out by invoiceSalesDays (@suite/shared/billing): the money invoices brought in and kept, on the day it
//             came in — payments on their day, a credit note on a paid invoice taking it back on its own day. Every
//             figure is known (net, HST, total), so these days are never "total only". Worked out again after every
//             change that reaches the server (a device's push, an issue, a void) and at start; only days that differ are
//             written (zeros for days that now have nothing).
//   past due  issued invoices still owing after their due date (the overview's "To deal with").
import { nowIso, localDate } from '@suite/shared/time';
import { SALES_FIGURES, zeroFigures } from '@suite/shared/sales';
import { invoiceState, invoiceSalesDays, invoiceStoreKey } from '@suite/shared/billing';

export function createInvoiceMoney({ db, crm, sales, log, now }) {
  const q = {
    salesInvoices: db.prepare("SELECT id, business_id, status, subtotal_cents, tax_cents, total_cents FROM billing_invoices WHERE deleted_at IS NULL AND status IN ('issued', 'void')"),
    salesPayments: db.prepare(`SELECT p.invoice_id, p.amount_cents, p.paid_on FROM billing_payments p
      JOIN billing_invoices i ON i.id = p.invoice_id AND i.deleted_at IS NULL WHERE p.deleted_at IS NULL`),
    salesCreditNotes: db.prepare("SELECT invoice_id, status, issue_date, total_cents FROM billing_credit_notes WHERE deleted_at IS NULL AND status = 'issued'"),
    billedBusinesses: db.prepare("SELECT DISTINCT business_id FROM billing_invoices WHERE deleted_at IS NULL AND status IN ('issued', 'void')"),
    issuedInvoices: db.prepare("SELECT * FROM billing_invoices WHERE deleted_at IS NULL AND status = 'issued' ORDER BY due_date, number"),
    payments: db.prepare('SELECT * FROM billing_payments WHERE invoice_id = ? AND deleted_at IS NULL'),
    creditNotesOf: db.prepare('SELECT * FROM billing_credit_notes WHERE invoice_id = ? AND deleted_at IS NULL'),
  };

  const storeName = (businessId) => `Invoices · ${crm.getBusiness(businessId)?.name ?? 'Unknown business'}`;
  /**
   * Work out every business's invoice days again and write the ones that differ from what sales holds (plus zeros for
   * days that now have nothing). Cheap at two people's volumes. → the number of days written
   */
  function rebuildSales() {
    if (!sales?.putDays) return 0;
    const days = invoiceSalesDays(q.salesInvoices.all(), q.salesPayments.all(), q.salesCreditNotes.all());
    let written = 0;
    for (const { business_id: b } of q.billedBusinesses.all()) {
      const store = invoiceStoreKey(b);
      const stored = new Map(sales.storeRows({ source: 'invoices', store }).map((r) => [r.day, r]));
      const want = days.get(b) ?? new Map();
      const changed = [];
      for (const [day, r] of want) {
        const s = stored.get(day);
        if (!s || SALES_FIGURES.some((k) => (s[k] ?? 0) !== (r[k] ?? 0))) changed.push({ day, ...r });
      }
      for (const [day, s] of stored) if (!want.has(day) && SALES_FIGURES.some((k) => s[k])) changed.push({ day, ...zeroFigures() });
      if (changed.length || !stored.size) {
        sales.putDays({ source: 'invoices', store, name: storeName(b), businessId: b, currency: 'CAD', timeZone: null, days: changed, fetchedAt: nowIso(now()) });
        written += changed.length;
      }
    }
    return written;
  }
  function rebuildSalesSafe() {
    try {
      rebuildSales();
    } catch (err) {
      log?.error?.('billing: writing the invoice sales days failed (written again after the next change):', err);
    }
  }
  if (sales?.registerSource) {
    sales.registerSource({
      source: 'invoices',
      label: 'Invoices',
      stores: () => q.billedBusinesses.all().map(({ business_id: b }) => ({
        store: invoiceStoreKey(b), name: storeName(b), businessId: b, currency: 'CAD', timeZone: null, state: 'invoices',
        lastSuccessAt: null, lastError: null, link: `/costs/billing?business=${b}`,
      })),
    });
  }

  /** Issued invoices still owing after their due date, on `today`: oldest due first. */
  function overdueInvoices(today = localDate(now())) {
    const out = [];
    for (const inv of q.issuedInvoices.all()) {
      if (!inv.due_date || inv.due_date >= today) continue;
      const st = invoiceState(inv, q.payments.all(inv.id), q.creditNotesOf.all(inv.id), today);
      if (!st.overdue) continue;
      out.push({
        id: inv.id, number: inv.number, toName: inv.to_name, clientId: inv.client_id, businessId: inv.business_id,
        business: crm.getBusiness(inv.business_id)?.name ?? null, owingCents: st.owing, totalCents: st.total, dueDate: inv.due_date, daysOverdue: st.daysOverdue,
      });
    }
    return out;
  }

  return { rebuildSales, rebuildSalesSafe, overdueInvoices };
}
