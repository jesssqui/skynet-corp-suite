import AccountPage from './AccountPage.jsx';
import DevicesPage from './DevicesPage.jsx';

// The signed-in person's account and both people's devices. The sign-in screen
// itself lives in src/auth/ (it shows before the shell and its routes exist).
export default {
  id: 'auth',
  nav: { label: 'Account', icon: 'user', order: 950, path: '/account' },
  routes: [
    { path: '/account', element: <AccountPage /> },
    { path: '/account/devices', element: <DevicesPage /> },
  ],
};
