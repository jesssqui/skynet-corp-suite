import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Icon } from '../../ui/index.js';

// Support: Tickets · Saved answers.
const TABS = [
  { value: '/helpdesk', label: 'Tickets', icon: 'mail' },
  { value: '/helpdesk/answers', label: 'Saved answers', icon: 'note' },
];

export default function HelpdeskTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const value = pathname.startsWith('/helpdesk/answers') ? '/helpdesk/answers' : '/helpdesk';
  return (
    <div style={{ marginBottom: 'var(--space-4)', maxWidth: '100%', overflowX: 'auto' }} data-testid="helpdesk-tabs">
      <Segmented
        label="Support pages"
        value={value}
        onChange={(to) => navigate(to)}
        options={TABS.map((t) => ({ value: t.value, label: t.label, icon: <Icon name={t.icon} size={16} /> }))}
      />
    </div>
  );
}
