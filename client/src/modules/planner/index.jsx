import TodayPage from './TodayPage.jsx';
import InboxPage from './InboxPage.jsx';
import TasksPage from './TasksPage.jsx';
import { useInboxCount } from './data.js';

// The planner's screens (C4a). Its record types (task, inbox_item) are registered on the server
// (planner module) and reach this device through the sync engine; pages read and write them only
// through the offline store, so everything works offline.
//   /         Today: overdue first, due today, today's top 3, Plan my day, capture, no next step
//   /inbox    the capture inbox: each item becomes a task, a note on a client, or is dismissed
//   /tasks    every task, filtered by whose, business, client and due

/** The inbox's count beside its nav entry (nothing when it is empty). */
function InboxBadge() {
  const n = useInboxCount();
  return n ? <span className="shell-nav-count" data-testid="inbox-count" aria-label={`${n} to sort`}>{n > 99 ? '99+' : n}</span> : null;
}

export default {
  id: 'planner',
  nav: [
    { id: 'today', label: 'Today', icon: 'today', order: 10, path: '/' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', order: 12, path: '/inbox', Badge: InboxBadge },
    { id: 'tasks', label: 'Tasks', icon: 'tasks', order: 15, path: '/tasks' },
  ],
  routes: [
    { path: '/', element: <TodayPage /> },
    { path: '/inbox', element: <InboxPage /> },
    { path: '/tasks', element: <TasksPage /> },
  ],
};
