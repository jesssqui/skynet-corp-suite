import { Navigate } from 'react-router-dom';
import AutomationsPage from './AutomationsPage.jsx';
import AlertsPage from './AlertsPage.jsx';

// Automations (C8): the Automations page (under System) and the in-app alerts. The bell and the
// phone strip are in the shell (AlertsBell.jsx). No nav entry of its own: System → Automations.
//   /system/automations  every automation: when, on/off, silent/alert, last and next run, Run now
//   /automations         -> /system/automations
//   /alerts              the alerts both people get from automations set to alert
export default {
  id: 'automations',
  routes: [
    { path: '/system/automations', element: <AutomationsPage /> },
    { path: '/automations', element: <Navigate to="/system/automations" replace /> },
    { path: '/alerts', element: <AlertsPage /> },
  ],
};
