import { lazy, Suspense } from 'react';
import { registerConnectionPanel } from '../connections/panels.js';

// WooCommerce stores (D12), device side: the "WooCommerce stores" card's Add a store form and each store's card
// settings on System → Connections. Their totals and order lookups are the sales module's pages (Money → Sales).
const HubPanel = lazy(() => import('./HubPanel.jsx'));
const StorePanel = lazy(() => import('./StorePanel.jsx'));

registerConnectionPanel('woocommerce', (props) => <Suspense fallback={null}><HubPanel {...props} /></Suspense>);
registerConnectionPanel('woo-*', (props) => <Suspense fallback={null}><StorePanel {...props} /></Suspense>);

export default { id: 'woocommerce', routes: [] };
