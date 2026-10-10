import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Icon } from '../../ui/index.js';

// D8: Clients, Pipeline and Cross-sell share the Clients nav entry (the phone's tab bar already has eight
// tabs, and leads become clients there); this switches between them, like System's tabs.
const TABS = [
  { value: '/crm', label: 'Clients', icon: 'users' },
  { value: '/crm/pipeline', label: 'Pipeline', icon: 'target' },
  { value: '/crm/cross-sell', label: 'Cross-sell', icon: 'repeat' },
];

export default function CrmTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const value = pathname.startsWith('/crm/pipeline') || pathname.startsWith('/crm/leads') ? '/crm/pipeline'
    : pathname.startsWith('/crm/cross-sell') ? '/crm/cross-sell' : '/crm';
  return (
    <div style={{ marginBottom: 'var(--space-4)', maxWidth: '100%', overflowX: 'auto' }}>
      <Segmented
        label="Client pages"
        value={value}
        onChange={(to) => navigate(to)}
        options={TABS.map((t) => ({ value: t.value, label: t.label, icon: <Icon name={t.icon} size={16} /> }))}
      />
    </div>
  );
}
