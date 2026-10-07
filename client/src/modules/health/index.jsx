import SystemPage from './SystemPage.jsx';

export default {
  id: 'health',
  nav: { label: 'System', icon: 'pulse', order: 900 },
  routes: [{ path: '/system', element: <SystemPage /> }],
};
