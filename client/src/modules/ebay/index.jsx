import { lazy, Suspense } from 'react';
import { registerConnectionPanel } from '../connections/panels.js';

// eBay (D13), device side: the eBay card's settings on System → Connections (the keyset, Sign in to eBay, the pasted
// address, the zone, Pull now, Forget) and the page eBay sends the browser back to after "I agree" (/ebay/accepted).
// Its totals and months are the sales module's pages (Money → Sales → Save Point Shop on eBay).
const ConnectionPanel = lazy(() => import('./ConnectionPanel.jsx'));
const AcceptedPage = lazy(() => import('./AcceptedPage.jsx'));

registerConnectionPanel('ebay', (props) => <Suspense fallback={null}><ConnectionPanel {...props} /></Suspense>);

export default {
  id: 'ebay',
  routes: [
    { path: '/ebay/accepted', element: <Suspense fallback={null}><AcceptedPage /></Suspense> },
    { path: '/ebay/declined', element: <Suspense fallback={null}><AcceptedPage declined /></Suspense> },
  ],
};
