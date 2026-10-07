import ClientListPage from './ClientListPage.jsx';
import ClientPage from './ClientPage.jsx';
import BusinessesPage from './BusinessesPage.jsx';
import QuickAddPage from './QuickAddPage.jsx';
import ImportPage from './ImportPage.jsx';

// The CRM's screens (C3b). Its record types are registered on the server (crm module, C3a) and
// reach this device through the sync engine — pages read and write them only through the
// offline store (`store` / useSyncData from ../../sync/index.js), so everything works offline.
//   /crm                 the client list: search (names, emails, phones typed any way), filters
//   /crm/clients/:id     one client on one screen: accounts, relationships, services, contacts,
//                        consent, links, the timeline with quick notes and call logs
//   /crm/businesses      our businesses (colour, archived) and the plain record views
//   /crm/quick-add       C7: the brain dump — one client per line, preview, save (offline)
//   /crm/import          C7: the accounting customer list as a CSV (on the server: needs a connection)
export default {
  id: 'crm',
  nav: { label: 'Clients', icon: 'users', order: 20, path: '/crm' },
  routes: [
    { path: '/crm', element: <ClientListPage /> },
    { path: '/crm/clients/:id', element: <ClientPage /> },
    { path: '/crm/businesses', element: <BusinessesPage /> },
    { path: '/crm/quick-add', element: <QuickAddPage /> },
    { path: '/crm/import', element: <ImportPage /> },
  ],
};
