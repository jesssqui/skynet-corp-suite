// The Order Manager on the client page (D1): its orders, payments, returns and refunds as timeline
// rows, and the figures (spend, last order, store credit) for an account and for the whole client.
// The records are synced and read-only (the server writes them), so all of this works offline.
import { Link } from 'react-router-dom';
import { Badge, Icon } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { formatMoney } from '../crm/logic.js';
import { isQuietRegular, quietRegularText, nextFollowUp } from './logic.js';
import { BusinessChip } from '../crm/parts.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const ENTRY_ICONS = { payment: 'check', refund: 'back', store_credit: 'star', credit_applied: 'star', return: 'back', credit_note: 'note' };
const NOTE_ICONS = { note: 'note', call: 'call', email: 'mail', meeting: 'meeting', follow_up: 'check' };
const money = (c) => formatMoney(c) || '$0';

/** D5: one Order Manager note on the timeline: its type, when and who wrote it there, the text. */
function WholesaleNoteItem({ item, account, business }) {
  const r = item.record;
  return (
    <li className="crm-activity" data-wholesale={item.source} data-record-id={item.id} data-type={r.type}>
      <span className="crm-activity-icon" aria-hidden="true"><Icon name={NOTE_ICONS[r.type] ?? 'note'} size={16} /></span>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ ...muted, display: 'flex', gap: '0 var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ color: 'var(--text)' }}>{item.title}</strong>
          <time dateTime={item.at}>{formatDateTime(item.at)}</time>
          {item.by ? <span>by {item.by}</span> : null}
        </div>
        {item.body ? <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.body}</p> : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          {business ? <BusinessChip business={business} /> : null}
          {account ? <span style={muted}>{account.name}</span> : null}
          <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>from the Order Manager</span>
        </div>
      </div>
    </li>
  );
}

/** One Order Manager record on the timeline (an item from wholesaleItems()). */
export function WholesaleTimelineItem({ item, account, business }) {
  if (item.source === 'wholesale_note') return <WholesaleNoteItem item={item} account={account} business={business} />;
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

/** D3: the "Quiet regular" chip for a regular past their usual gap (title: their rhythm). */
export function QuietRegularBadge({ card, today, cards }) {
  const quiet = card ? (isQuietRegular(card, today) ? card : null) : (cards ?? []).find((c) => isQuietRegular(c, today));
  if (!quiet) return null;
  const text = quietRegularText(quiet, today);
  return (
    <span title={text} data-testid="quiet-regular" style={{ display: 'inline-flex' }}>
      <Badge tone="warn">Quiet regular</Badge>
    </span>
  );
}

/** An account's Order Manager customer(s) and figures, under the account on the client page. */
export function AccountWholesale({ cards, figures, today, hideQuiet = false }) {
  if (!cards?.length) return null;
  // Never for a closed client's account (closing a client means "no next steps", as the check-ins do).
  const quiet = hideQuiet ? [] : cards.filter((c) => isQuietRegular(c, today));
  return (
    <div
      data-testid="account-wholesale"
      style={{ display: 'grid', gap: 2, padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm, 8px)', background: 'var(--surface-2)' }}
    >
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Icon name="order" size={14} />
        {cards.map((c) => `${c.name}${c.number ? ` (#${c.number})` : ''}`).join(', ')}
        {figures.gone ? <Badge tone="warn">Deleted in the Order Manager</Badge> : null}
        {quiet.length ? <QuietRegularBadge cards={quiet} today={today} /> : null}
      </span>
      <span style={{ ...muted, fontVariantNumeric: 'tabular-nums' }} data-testid="account-wholesale-figures">{figuresText(figures)}</span>
      {nextFollowUp(cards) ? (
        <span style={muted} data-testid="account-wholesale-follow-up">
          Next follow-up in the Order Manager: {formatDate(nextFollowUp(cards))}
        </span>
      ) : null}
      {quiet.map((c) => (
        <span key={c.id} style={{ ...muted, fontSize: 'var(--text-xs)' }} data-testid="quiet-regular-text">
          {cards.length > 1 ? `${c.name}: ` : ''}{quietRegularText(c, today)}
        </span>
      ))}
    </div>
  );
}

/** The client's wholesale line in its header: all its accounts' Order Manager customers added up. */
export function ClientWholesale({ figures }) {
  if (!figures) return null;
  return (
    <p style={{ ...muted, margin: 0, display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start' }} data-testid="client-wholesale">
      <Icon name="order" size={16} style={{ marginTop: 2 }} />
      <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 0 }}>
        Wholesale: {figuresText(figures)}
        {' · '}<Link to="/wholesale?tab=linked">Order Manager links</Link>
      </span>
    </p>
  );
}
