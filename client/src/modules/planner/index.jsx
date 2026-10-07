import { Navigate } from 'react-router-dom';
import TodayPage from './TodayPage.jsx';
import InboxPage from './InboxPage.jsx';
import TasksPage from './TasksPage.jsx';
import WeekPlanPage from './WeekPlanPage.jsx';
import MonthPlanPage from './MonthPlanPage.jsx';
import ReviewPage from './ReviewPage.jsx';
import FocusPage from './FocusPage.jsx';
import { useInboxCount } from './data.js';

// The planner's screens (C4a, C4b). Its record types (task, inbox_item, goal, workday) are
// registered on the server (planner module) and reach this device through the sync engine; pages
// read and write them only through the offline store, so everything works offline.
//   /             Today: overdue first, due today, today's top 3, Plan my day, capture, no next step,
//                 the overbooked warning, "N to sort", Focus
//   /inbox        the capture inbox: each item becomes a task, a note on a client, or is dismissed
//   /tasks        every task, filtered by whose, business, client, due (incl. to sort) and goal
//   /plan/week    the Monday plan: week goals, carry-over, To sort, the week's load
//   /plan/month   the monthly plan: priorities per business, the month's week goals, carry-over
//   /plan/review  the Friday review checklist
//   /focus        one task at a time with the client's details

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
    { id: 'plan', label: 'Plan', icon: 'target', order: 16, path: '/plan' },
  ],
  routes: [
    { path: '/', element: <TodayPage /> },
    { path: '/inbox', element: <InboxPage /> },
    { path: '/tasks', element: <TasksPage /> },
    { path: '/plan', element: <Navigate to="/plan/week" replace /> },
    { path: '/plan/week', element: <WeekPlanPage /> },
    { path: '/plan/month', element: <MonthPlanPage /> },
    { path: '/plan/review', element: <ReviewPage /> },
    { path: '/focus', element: <FocusPage /> },
  ],
};
