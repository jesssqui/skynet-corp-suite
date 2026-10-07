import TodayPage from './TodayPage.jsx';

export default {
  id: 'home',
  nav: { label: 'Today', icon: 'today', order: 10 },
  routes: [{ path: '/', element: <TodayPage /> }],
};
