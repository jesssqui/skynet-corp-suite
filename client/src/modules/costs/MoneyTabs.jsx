import { useLocation, useNavigate } from 'react-router-dom';
import { Segmented, Icon } from '../../ui/index.js';

// D12: the "Money" nav entry holds Costs (D6) and Sales (D12) — no ninth tab on phones; this switches between them.
// D17/D18: and Billing (quotes, invoices, credit notes).
const TABS = [
  { value: '/costs', label: 'Costs', icon: 'card' },
  { value: '/costs/sales', label: 'Sales', icon: 'chart' },
  { value: '/costs/billing', label: 'Billing', icon: 'list' },
];

export default function MoneyTabs() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const value = pathname.startsWith('/costs/sales') ? '/costs/sales' : pathname.startsWith('/costs/billing') ? '/costs/billing' : '/costs';
  return (
    <div style={{ marginBottom: 'var(--space-4)', maxWidth: '100%', overflowX: 'auto' }} data-testid="money-tabs">
      <Segmented
        label="Money pages"
        value={value}
        onChange={(to) => navigate(to)}
        options={TABS.map((t) => ({ value: t.value, label: t.label, icon: <Icon name={t.icon} size={16} /> }))}
      />
    </div>
  );
}
