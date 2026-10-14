import { lazy, Suspense } from 'react';

// Projects and playbooks (D9). The record types (playbook, playbook_step, playbook_run, run_step) are
// registered on the server (playbooks module) and reach this device through the sync engine; the pages
// read and write them only through the offline store, so running a playbook works offline.
//   /playbooks            what is under way, every playbook by business (Run…), examples to start from
//   /playbooks/:id        one playbook: its steps by stage (edit, reorder, add), Run…, its runs
//   /playbooks/runs/:id   one run: progress, its checklist by stage with ticks, done / stop / reopen
// Nav: a sidebar entry (phone: false — the phone's tab bar keeps its eight); on a phone it is reached
// from Tasks ("Playbooks and projects") and the client page's Projects card. Lazy: the pages' chunks are
// cached by the service worker like the rest of the app, so they open offline.
const PlaybooksPage = lazy(() => import('./PlaybooksPage.jsx'));
const PlaybookPage = lazy(() => import('./PlaybookPage.jsx'));
const RunPage = lazy(() => import('./RunPage.jsx'));
const wrap = (el) => <Suspense fallback={null}>{el}</Suspense>;

export default {
  id: 'playbooks',
  nav: { label: 'Playbooks', icon: 'list', order: 17, path: '/playbooks', phone: false },
  routes: [
    { path: '/playbooks', element: wrap(<PlaybooksPage />) },
    { path: '/playbooks/runs/:id', element: wrap(<RunPage />) },
    { path: '/playbooks/:id', element: wrap(<PlaybookPage />) },
  ],
};
