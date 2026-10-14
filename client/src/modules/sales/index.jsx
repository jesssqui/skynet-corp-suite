import SalesPage from './SalesPage.jsx';

// Sales by channel (/sales): Save Point Shop's Whatnot, Poshmark and Facebook Marketplace sales,
// one total per channel per day, typed on any device (offline too) and added for past days.
// Its record type (sale_day) is registered on the server (sales module) and reaches this device
// through the sync engine; the page reads and writes it only through the offline store.
export default {
  id: 'sales',
  nav: { label: 'Sales', icon: 'order', order: 22, path: '/sales' },
  routes: [{ path: '/sales', element: <SalesPage /> }],
};
