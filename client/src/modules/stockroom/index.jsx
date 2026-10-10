import { lazy, Suspense } from 'react';
import { registerConnectionPanel } from '../connections/panels.js';

// Stock tasks from Stockroom (D16), device side: only the Stockroom card's settings on System →
// Connections (paste the connection code, what was read, Pull now, Forget). The tasks themselves
// are ordinary planner tasks (Today, Tasks), made on the server. No nav entry, no routes of its own.
const ConnectionPanel = lazy(() => import('./ConnectionPanel.jsx'));

registerConnectionPanel('stockroom', (props) => <Suspense fallback={null}><ConnectionPanel {...props} /></Suspense>);

export default { id: 'stockroom', routes: [] };
