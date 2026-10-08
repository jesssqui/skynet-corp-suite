// The Order Manager on the client page (D1): its orders, payments, returns and refunds as timeline
// rows, and the figures (spend, last order, store credit) for an account and for the whole client.
// The records are synced and read-only (the server writes them), so all of this works offline.
import { Link } from 'react-router-dom';
import { Badge, Icon } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { formatMoney } from '../crm/logic.js';
import { BusinessChip } from '../crm/parts.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const ENTRY_ICONS = { payment: 'check', refund: 'back', store_credit: 'star', credit_applied: 'star', return: 'back', credit_note: 'note' };
const money = (c) => formatMoney(c) || '$0';

/** One Order Manager record on the timeline (an item from wholesaleItems()). */
export function WholesaleTimelineItem({ item, account, business }) {
  const r = item.record;
  const icon = item.source === 'wholesale_order' ? 'order' : ENTRY_ICONS[r.kind] ?? 'order';
  return (
    <li className="crm-activity" data-wholesale={item.source} data-record-id={item.id} data-status={r.status}>
      <span className="crm-activity-icon" aria-hidden="true" style={item.struck ? undefined : { color: 'var(--accent)' }}><Icon name={icon} size={16} /></span>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ ...muted, display: 'flex', gap: '0 var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ color: 'var(--text)', textDecoration: item.struck ? 'line-through' : undefined }}>{item.title}</strong>
          <time dateTime={item.at}>{item.date ? formatDate(item.date) : formatDateTime(item.at)}</time>
          {item.status ? <Badge tone={r.status === 'cancelled' || r.status === 'deleted' || r.status === 'removed' ? 'warn' : 'neutral'}>{item.status}</Badge> : null}
          {item.packing ? <Badge>{item.packing}</Badge> : null}
        </div>
        <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{item.facts}</span>
        {item.body ? <p style={{ ...muted, margin: 0, overflowWrap: 'anywhere' }}>{item.body}</p> : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          {business ? <BusinessChip business={business} /> : null}
          {account ? <span style={muted}>{account.name}</span> : null}
          <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>from the Order Manager</span>
        </div>
      </div>
    </li>
  );
}

/** "Spend $1,245.80 · 12 orders · last order Oct 5 · $11.30 store credit" for figures from sumCards(). */
export function figuresText(f) {
  if (!f) return '';
  const parts = [`Spend ${money(f.spendCents)}`, `${f.orders} order${f.orders === 1 ? '' : 's'}`];
  parts.push(f.lastOrderDate ? `last order ${formatDate(f.lastOrderDate)}` : 'no orders yet');
  if (f.creditCents > 0) parts.push(`${money(f.creditCents)} store credit`);
  return parts.join(' · ');
}

/** An account's Order Manager customer(s) and figures, under the account on the client page. */
export function AccountWholesale({ cards, figures }) {
  if (!cards?.length) return null;
  return (
    <div
      data-testid="account-wholesale"
      style={{ display: 'grid', gap: 2, padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm, 8px)', background: 'var(--surface-2)' }}
    >
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Icon name="order" size={14} />
        {cards.map((c) => `${c.name}${c.number ? ` (#${c.number})` : ''}`).join(', ')}
        {figures.gone ? <Badge tone="warn">Deleted in the Order Manager</Badge> : null}
      </span>
      <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }} data-testid="account-wholesale-figures">{figuresText(figures)}</span>
    </div>
  );
}

/** The client's wholesale line in its header: all its accounts' Order Manager customers added up. */
export function ClientWholesale({ figures }) {
  if (!figures) return null;
  return (
    <p style={{ ...muted, margin: 0, display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }} data-testid="client-wholesale">
      <Icon name="order" size={16} />
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>Wholesale: {figuresText(figures)}</span>
      <Link to="/wholesale?tab=linked" style={{ fontSize: 'var(--text-xs)' }}>Order Manager links</Link>
    </p>
  );
}
