import CalendarPage from './CalendarPage.jsx';

// The task calendar feed (C6a): each person's secret link for Apple Calendar, on Account → Calendar
// (no nav entry of its own: the Account page's tabs lead here).
export default {
  id: 'calendar',
  routes: [{ path: '/account/calendar', element: <CalendarPage /> }],
};
