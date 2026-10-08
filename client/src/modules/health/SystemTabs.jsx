import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Icon } from '../../ui/index.js';

// System, Connections and Automations share the System nav entry; this switches between them.
const TABS = [
  { value: '/system', label: 'System', icon: 'pulse' },
  { value: '/system/connections', label: 'Connections', icon: 'plug' },
  { value: '/system/automations', label: 'Automations', icon: 'bolt' },
];

export default function SystemTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const value = [...TABS].reverse().find((t) => pathname.startsWith(t.value))?.value ?? '/system';
  return (
    <div style={{ marginBottom: 'var(--space-4)', maxWidth: '100%', overflowX: 'auto' }}>
      <Segmented
        label="System pages"
        value={value}
        onChange={(to) => navigate(to)}
        options={TABS.map((t) => ({ value: t.value, label: t.label, icon: <Icon name={t.icon} size={16} /> }))}
      />
    </div>
  );
}
