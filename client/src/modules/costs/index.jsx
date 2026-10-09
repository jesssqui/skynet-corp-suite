import CostsPage from './CostsPage.jsx';

// Renewals and recurring costs (D6). The `recurring_cost` record type is registered on the server
// (costs module) and reaches this device through the sync engine; the page reads and writes it
// only through the offline store, so it all works offline.
//   /costs   what our businesses and the home pay for: by business, soonest renewal first, monthly
//            and yearly totals, add / edit / cancel
// Client services' renewals (30 days ahead) and these costs' (14 days) become tasks through the
// server's automations; the Friday review lists both, and the client page shows resold costs.
export default {
  id: 'costs',
  nav: { label: 'Costs', icon: 'card', order: 25, path: '/costs' },
  routes: [{ path: '/costs', element: <CostsPage /> }],
};
