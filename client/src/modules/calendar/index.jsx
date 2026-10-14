import { Link } from 'react-router-dom';
import CalendarPage from './CalendarPage.jsx';
import { registerConnectionPanel } from '../connections/panels.js';

// C6b: the Apple Calendar row on System → Connections points to where each person connects their own.
registerConnectionPanel('calendar', () => (
  <Link to="/account/calendar" className="planner-link-row" data-testid="calendar-connect-link">
    Connect your own calendars on Account → Calendar ›
  </Link>
));

// The task calendar feed (C6a): each person's secret link for Apple Calendar, on Account → Calendar
// (no nav entry of its own: the Account page's tabs lead here).
export default {
  id: 'calendar',
  routes: [{ path: '/account/calendar', element: <CalendarPage /> }],
};
