// Sales figures shared by the Sales pages and the overview (D11): today / this week / this month side by side, and a
// store's state in words.
import { periodText, ordersText } from './logic.js';
import './sales.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];

export function Periods({ figures, testId }) {
  return (
    <div className="sales-periods" data-testid={testId}>
      {PERIODS.map(([k, label]) => (
        <div key={k} style={{ display: 'grid', gap: 2, minWidth: 0 }} data-period={k}>
          <span style={{ ...muted, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</span>
          <span className="sales-figure">{periodText(figures?.[k])}</span>
          <span style={muted}>{ordersText(figures?.[k])}</span>
        </div>
      ))}
    </div>
  );
}

/** A store's state in words (wraps on phones; a Badge doesn't). */
export function StateLine({ st }) {
  const color = st.tone === 'danger' ? 'var(--danger)' : st.tone === 'warn' ? 'var(--warn, var(--text))' : 'var(--text-muted)';
  return <span style={{ fontSize: 'var(--text-sm)', color, overflowWrap: 'anywhere' }} data-testid="store-state">{st.text}</span>;
}

