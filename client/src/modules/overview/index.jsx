import { lazy, Suspense } from 'react';

// The overview (D11): sales per business and what needs dealing with, on one screen (/overview). Built for the Mac:
// its nav entry is in the sidebar only (phone: false) — the phone's tab bar already has eight; on a phone it is reached
// from Today and Money → Sales. Server data: needs a connection to the suite (lazy, so the app shell stays small).
const OverviewPage = lazy(() => import('./OverviewPage.jsx'));

export default {
  id: 'overview',
  nav: { label: 'Overview', icon: 'overview', order: 5, path: '/overview', phone: false },
  routes: [{ path: '/overview', element: <Suspense fallback={null}><OverviewPage /></Suspense> }],
};
