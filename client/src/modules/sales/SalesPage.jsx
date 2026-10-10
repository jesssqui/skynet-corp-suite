// Sales (/costs/sales, D12): what each store sold today, this week and this month — each store in its own calendar
// (its WooCommerce time zone) — per business, and everything together per currency (never added across currencies).
// The figures are WooCommerce Analytics → Revenue's "Net sales" (gross − coupons − returns; before tax and shipping)
// and orders, read by the server about once an hour. Server data, not synced: the page needs a connection to the suite.
// Plain on purpose: the overview (D15) is where sales meet everything else.
import { Link } from 'react-router-dom';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Badge, Notice, EmptyState, Button } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import { periodText, ordersText, stateText, updatedText } from './logic.js';
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

function StoreCard({ store, businessName }) {
  const st = stateText(store);
  const title = store.link ? <Link to={store.link}>{store.name}</Link> : store.name;
  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-store={store.store} data-testid="sales-store">
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 650, margin: 0, overflowWrap: 'anywhere' }}>{title}</h2>
          <span style={muted}>{store.sourceLabel} · {businessName}</span>
        </div>
        <Periods figures={store} />
        <span style={muted}>
          {updatedText(store, formatDateTime)} · its day is {store.date}{store.timeZone ? ` (${store.timeZone})` : ''}
        </span>
        {st ? <Badge tone={st.tone}>{st.text}</Badge> : null}
      </div>
    </Card>
  );
}

export default function SalesPage() {
  const { data, error, loading, offline, reload } = useServerData('/api/sales/summary', { everyMs: 60_000 });
  const stores = data?.stores ?? [];
  const names = new Map((data?.businesses ?? []).map((b) => [b.businessId, b.name]));
  const connected = stores.filter((s) => s.connected);
  return (
    <>
      <MoneyTabs />
      <PageHeader
        title="Sales"
        subtitle="Net sales and orders per store, as WooCommerce Analytics shows them"
        actions={<Button onClick={reload} disabled={loading}>Check again</Button>}
      />
      {offline ? (
        <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>
          Can’t reach the suite server. Sales are read by the server and aren’t kept on this device, so this page needs a
          connection{data ? '; what you see is from the last check' : ''}.
        </Notice>
      ) : null}
      {error && !offline ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error.message}</Notice> : null}
      {!data && loading ? <EmptyState title="Loading…" /> : null}
      {data ? (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <Card>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <span style={{ ...muted, fontWeight: 600 }}>All stores together · each in its own calendar · per currency</span>
              <Periods figures={data.overall} testId="sales-overall" />
            </div>
          </Card>
          {!connected.length ? (
            <EmptyState title="No store connected">
              Add each WooCommerce store with its own read-only key on <Link to="/system/connections">System → Connections</Link>.
            </EmptyState>
          ) : null}
          {data.businesses.length > 1 ? (
            <Card title="Per business">
              <div style={{ display: 'grid', gap: 'var(--space-4)' }} data-testid="sales-businesses">
                {data.businesses.map((b) => (
                  <div key={b.businessId ?? 'none'} style={{ display: 'grid', gap: 'var(--space-2)' }}>
                    <span style={{ fontWeight: 600 }}>{b.name}</span>
                    <Periods figures={b} />
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
          <div className="sales-stores">
            {stores.map((s) => <StoreCard key={`${s.source}|${s.store}`} store={s} businessName={names.get(s.businessId ?? null) ?? '—'} />)}
          </div>
          <p style={{ ...muted, margin: 0 }}>
            Net sales = gross sales − coupons − returns, before tax and shipping; a refund counts on the day it was made.
            Which orders count (statuses) is each store’s own Analytics setting. Read about once an hour; the last 60
            days are read again each time, so late refunds land. No customer details are kept.
          </p>
        </div>
      ) : null}
    </>
  );
}
