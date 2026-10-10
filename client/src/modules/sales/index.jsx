import { lazy, Suspense } from 'react';

// Sales totals (D12), device side: the Sales tab under Money (/costs/sales) — each store's and each business's today,
// this week and this month, the combined total per currency — and a store's page (/costs/sales/woo/:id) with its
// order lookup. Server data (not synced): both pages need a connection to the suite. No nav entry of its own.
const SalesPage = lazy(() => import('./SalesPage.jsx'));
const StorePage = lazy(() => import('./StorePage.jsx'));
const wrap = (el) => <Suspense fallback={null}>{el}</Suspense>;

export default {
  id: 'sales',
  routes: [
    { path: '/costs/sales', element: wrap(<SalesPage />) },
    { path: '/costs/sales/woo/:id', element: wrap(<StorePage />) },
  ],
};
