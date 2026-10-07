import CrmPage from './CrmPage.jsx';

// The CRM (C3a: records only). Its record types are registered on the server (crm module) and
// reach this device through the sync engine (GET /api/sync/info) — nothing to register here:
// pages read and write them with `store` / useRecords from ../../sync/index.js. The client
// screens (list, client page, timeline) are C3b.
export default {
  id: 'crm',
  nav: { label: 'Clients', icon: 'users', order: 20 },
  routes: [{ path: '/crm', element: <CrmPage /> }],
};
