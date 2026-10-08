import { Navigate } from 'react-router-dom';
import ConnectionsPage from './ConnectionsPage.jsx';

// Connections (C8): every connection with its last success, queue, last error and off switch.
// Under System (no nav entry of its own): System → Connections.
export default {
  id: 'connections',
  routes: [
    { path: '/system/connections', element: <ConnectionsPage /> },
    { path: '/connections', element: <Navigate to="/system/connections" replace /> },
  ],
};
