import { lazy, Suspense } from 'react';

// Quotes, invoices and credit notes (D17/D18), device side: the Billing tab under Money (/costs/billing: the lists,
// New quote / New invoice), one document's page (draft lines offline; approve, PDF and email online), and the business
// details printed on them (/costs/billing/settings, online). The records are synced (registered by the server's billing
// module), so drafts, decisions and payments work offline. No nav entry of its own: Money → Billing; a lead's page and a
// client's page show theirs (cards.jsx).
const BillingPage = lazy(() => import('./BillingPage.jsx'));
const DocumentPage = lazy(() => import('./DocumentPage.jsx'));
const SettingsPage = lazy(() => import('./SettingsPage.jsx'));
const wrap = (el) => <Suspense fallback={null}>{el}</Suspense>;

export default {
  id: 'billing',
  routes: [
    { path: '/costs/billing', element: wrap(<BillingPage />) },
    { path: '/costs/billing/settings', element: wrap(<SettingsPage />) },
    { path: '/costs/billing/quotes/:id', element: wrap(<DocumentPage kind="quote" />) },
    { path: '/costs/billing/invoices/:id', element: wrap(<DocumentPage kind="invoice" />) },
    { path: '/costs/billing/credit-notes/:id', element: wrap(<DocumentPage kind="credit_note" />) },
  ],
};
