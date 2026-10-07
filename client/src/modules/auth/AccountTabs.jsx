import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Icon } from '../../ui/index.js';

/** Account and Devices share one nav entry; this switches between them. */
export default function AccountTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <Segmented
      label="Account pages"
      value={pathname.startsWith('/account/devices') ? '/account/devices' : '/account'}
      onChange={(to) => navigate(to)}
      options={[
        { value: '/account', label: 'Account', icon: <Icon name="user" size={16} /> },
        { value: '/account/devices', label: 'Devices', icon: <Icon name="phone" size={16} /> },
      ]}
    />
  );
}
