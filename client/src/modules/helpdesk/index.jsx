import { lazy, Suspense } from 'react';
import { registerConnectionPanel } from '../connections/panels.js';

// The helpdesk (D14), device side: the Support pages (tickets and their emails are server data: they need a connection;
// saved answers are synced and work offline) and the support mailboxes' cards on System → Connections. Its nav entry is
// in the sidebar only (phone: false) — the phone's tab bar keeps its eight; on a phone a ticket is reached from its task
// ("Open the ticket" on Today) or the overview's support line.
const TicketsPage = lazy(() => import('./TicketsPage.jsx'));
const TicketPage = lazy(() => import('./TicketPage.jsx'));
const AnswersPage = lazy(() => import('./AnswersPage.jsx'));
const HubPanel = lazy(() => import('./HubPanel.jsx'));
const MailboxPanel = lazy(() => import('./MailboxPanel.jsx'));

registerConnectionPanel('helpdesk', (props) => <Suspense fallback={null}><HubPanel {...props} /></Suspense>);
registerConnectionPanel('mail-*', (props) => <Suspense fallback={null}><MailboxPanel {...props} /></Suspense>);

const page = (Page) => <Suspense fallback={null}><Page /></Suspense>;
export default {
  id: 'helpdesk',
  nav: { label: 'Support', icon: 'mail', order: 27, path: '/helpdesk', phone: false },
  routes: [
    { path: '/helpdesk', element: page(TicketsPage) },
    { path: '/helpdesk/answers', element: page(AnswersPage) },
    { path: '/helpdesk/tickets/:id', element: page(TicketPage) },
  ],
};
