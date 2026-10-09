import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Icon } from '../../ui/index.js';

/** Account, Devices and Calendar (C6a: the task calendar link) share one nav entry; this switches between them. */
export default function AccountTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <Segmented
      label="Account pages"
      value={pathname.startsWith('/account/devices') ? '/account/devices' : pathname.startsWith('/account/calendar') ? '/account/calendar' : '/account'}
      onChange={(to) => navigate(to)}
      options={[
        { value: '/account', label: 'Account', icon: <Icon name="user" size={16} /> },
        { value: '/account/devices', label: 'Devices', icon: <Icon name="phone" size={16} /> },
        { value: '/account/calendar', label: 'Calendar', icon: <Icon name="today" size={16} /> },
      ]}
    />
  );
}
