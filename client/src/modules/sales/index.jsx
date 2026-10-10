import { lazy, Suspense } from 'react';

// Sales totals (D12), device side: the Sales tab under Money (/costs/sales) — each store's and each business's today,
// this week and this month, the combined total per currency — and a store's page (/costs/sales/woo/:id) with its
// order lookup; D13: Save Point Shop's eBay page (/costs/sales/ebay: its months, and entering one by hand). Server data
// (not synced): the pages need a connection to the suite. No nav entry of its own.
const SalesPage = lazy(() => import('./SalesPage.jsx'));
const StorePage = lazy(() => import('./StorePage.jsx'));
const EbayPage = lazy(() => import('./EbayPage.jsx'));
const wrap = (el) => <Suspense fallback={null}>{el}</Suspense>;

export default {
  id: 'sales',
  routes: [
    { path: '/costs/sales', element: wrap(<SalesPage />) },
    { path: '/costs/sales/woo/:id', element: wrap(<StorePage />) },
    { path: '/costs/sales/ebay', element: wrap(<EbayPage />) },
  ],
};
