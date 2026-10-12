// What the billing pages read: the device's offline copy through the CRM screens' cached lists (../crm/data.js: each
// record type listed once and kept until it changes) — quotes, invoices and credit notes with their lines and payments,
// and the CRM records they point at. Everything here works offline; only approving a draft and the PDFs need the server.
import { useSyncData } from '../../sync/index.js';
import { cachedLists } from '../crm/data.js';

export const BILLING_ENTITIES = ['business', 'client', 'account', 'contact', 'relationship', 'service', 'lead',
  'quote', 'quote_line', 'invoice', 'invoice_line', 'invoice_payment', 'credit_note', 'credit_note_line'];

/** Every billing record on this device and the CRM records around them (with lookups by id). */
export function useBillingData() {
  const { data, loading, error } = useSyncData(async (e) => {
    const [businesses, clients, accounts, contacts, relationships, services, leads, quotes, quoteLines, invoices, invoiceLines, payments, creditNotes, creditNoteLines] = await cachedLists(e, BILLING_ENTITIES);
    return {
      businesses: [...businesses.records].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)),
      businessesById: businesses.byId(),
      clients: clients.records, clientsById: clients.byId(),
      accounts: accounts.records, accountsById: accounts.byId(),
      contacts: contacts.records,
      relationships: relationships.records, relationshipsById: relationships.byId(),
      services: services.records, servicesById: services.byId(),
      leads: leads.records, leadsById: leads.byId(),
      quotes: quotes.records, quotesById: quotes.byId(), quoteLines: quoteLines.records,
      invoices: invoices.records, invoicesById: invoices.byId(), invoiceLines: invoiceLines.records,
      payments: payments.records,
      creditNotes: creditNotes.records, creditNotesById: creditNotes.byId(), creditNoteLines: creditNoteLines.records,
    };
  }, [], { entities: BILLING_ENTITIES });
  return { data: data ?? null, loading, error };
}
