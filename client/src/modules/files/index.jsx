import { lazy, Suspense } from 'react';

// Files (D10). The `file` record type is registered on the server (files module) and reaches this
// device through the sync engine, so the lists work offline; uploads and downloads go to
// /api/files (online). No nav entry: a client's Files tab is reached from the client page (its Files
// card and each account's "Files (N)"); a task's files are in its sheet.
//   /crm/clients/:id/files   the Files tab: everything for the client, a tab per account
const FilesPage = lazy(() => import('./FilesPage.jsx'));

export default {
  id: 'files',
  routes: [{ path: '/crm/clients/:id/files', element: <Suspense fallback={null}><FilesPage /></Suspense> }],
};
