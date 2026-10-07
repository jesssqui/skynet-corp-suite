import OfflinePage from './OfflinePage.jsx';
import AttentionPage from './AttentionPage.jsx';
import RecordsPage from './RecordsPage.jsx';

// The device's offline copy: sync status, changes that need attention, and a plain view of
// every synced record type. Reached from the sync bar and the System page (not in the nav).
export default {
  id: 'sync',
  routes: [
    { path: '/sync', element: <OfflinePage /> },
    { path: '/sync/attention', element: <AttentionPage /> },
    { path: '/sync/data/:entity', element: <RecordsPage /> },
  ],
};
