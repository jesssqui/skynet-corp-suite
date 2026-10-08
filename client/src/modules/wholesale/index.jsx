import { lazy, Suspense } from 'react';
import { registerConnectionPanel } from '../connections/panels.js';

// The wholesale connection (D1), device side. The Order Manager's records (orders, payments,
// returns, refunds, each customer's figures) are synced and shown on the client page (crm's
// ClientPage, through ./parts.jsx and ./logic.js); this module adds:
//   /wholesale    Order Manager customers waiting for a client (link one, or make a client from it)
//                 and those linked (unlink) — server lists, so it needs a connection
//   the 'wom' card's settings on System → Connections (address, shared secret)
// No nav entry of its own: linked from the client list, the client page and the Connections card.
// Both load when first opened (like C7's pages); the service worker caches their files too.
const WholesalePage = lazy(() => import('./WholesalePage.jsx'));
const ConnectionPanel = lazy(() => import('./ConnectionPanel.jsx'));
const loading = <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

registerConnectionPanel('wom', (props) => <Suspense fallback={null}><ConnectionPanel {...props} /></Suspense>);

export default {
  id: 'wholesale',
  routes: [{ path: '/wholesale', element: <Suspense fallback={loading}><WholesalePage /></Suspense> }],
};
