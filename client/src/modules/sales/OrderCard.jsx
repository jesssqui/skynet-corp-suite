// One WooCommerce order as the suite shows it (D12's lookup; D14's ticket page too): status, dates, items, money,
// shipping and tracking, and the customer's first name only. Live from the store, kept only in the page's memory.
import { Card, Badge } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { orderStatus, trackingText, orderMoneyLines } from './logic.js';
import './sales.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

export function OrderCard({ o }) {
  const st = orderStatus(o.status);
  return (
    <li data-testid="sales-order" data-number={o.number}>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>Order #{o.number}</strong>
            <Badge tone={st.tone}>{st.text}</Badge>
            {o.customerFirstName ? <span style={muted}>for {o.customerFirstName}</span> : null}
          </div>
          <span style={muted}>
            Placed {formatDateTime(o.createdAt)}
            {o.paidAt ? ` · paid ${formatDateTime(o.paidAt)}` : ''}
            {o.completedAt ? ` · completed ${formatDateTime(o.completedAt)}` : ''}
          </span>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-4)', fontSize: 'var(--text-sm)' }}>
            {o.items.map((i, n) => <li key={n}>{i.quantity} × {i.name}{i.sku ? ` (${i.sku})` : ''}</li>)}
          </ul>
          <div className="sales-lines">
            {orderMoneyLines(o).map(([k, v]) => [<span key={`${k}k`} style={muted}>{k}</span>, <span key={`${k}v`} style={{ textAlign: 'right' }}>{v}</span>])}
          </div>
          <span style={muted}>Shipping: {o.shippingMethods.length ? o.shippingMethods.join(', ') : '—'}</span>
          {o.tracking.length ? (
            <span style={{ fontSize: 'var(--text-sm)' }} data-testid="sales-tracking">
              Tracking: {o.tracking.map((t, n) => (
                <span key={n}>{n ? ' · ' : ''}{t.url ? <a href={t.url} target="_blank" rel="noreferrer noopener">{trackingText(t)}</a> : trackingText(t)}</span>
              ))}
            </span>
          ) : <span style={muted}>No tracking in the store</span>}
        </div>
      </Card>
    </li>
  );
}
