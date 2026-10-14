import SystemPage from './SystemPage.jsx';
import AdminPage from './AdminPage.jsx';

export default {
  id: 'health',
  nav: { label: 'System', icon: 'pulse', order: 900 },
  routes: [
    { path: '/system', element: <SystemPage /> },
    { path: '/system/admin', element: <AdminPage /> },
  ],
};
