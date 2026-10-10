// Sales (/costs/sales, D12): what each store sold today, this week and this month — each store in its own calendar
// (its WooCommerce time zone) — per business, and everything together per currency (never added across currencies).
// The figure is each store's own **Total sales** (D13: WooCommerce Analytics → Revenue's "Total sales", eBay Seller
// Hub's "Total sales": items, shipping and tax, after refunds) and orders, read by the server about once an hour; eBay's
// month can be entered by hand while it isn't connected (it fills the same card, shown as such). Server data, not synced: the page needs a connection to the suite.
// Plain on purpose: the overview (D15) is where sales meet everything else.
import { Link } from 'react-router-dom';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Notice, EmptyState, Button } from '../../ui/index.js';
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

/** A store's state in words (wraps on phones; a Badge doesn't). */
export function StateLine({ st }) {
  const color = st.tone === 'danger' ? 'var(--danger)' : st.tone === 'warn' ? 'var(--warn, var(--text))' : 'var(--text-muted)';
  return <span style={{ fontSize: 'var(--text-sm)', color, overflowWrap: 'anywhere' }} data-testid="store-state">{st.text}</span>;
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
          {store.monthFromManual ? `This month entered by hand${store.manualEntry?.enteredAt ? ` (${formatDateTime(store.manualEntry.enteredAt)})` : ''} · ` : ''}
          {updatedText(store, formatDateTime)} · its day is {store.date}{store.timeZone ? ` (${store.timeZone})` : ''}
        </span>
        {store.manualStore ? <Link to={store.link ?? '/costs/sales'} style={{ fontSize: 'var(--text-sm)' }}>Months, and entering one by hand</Link> : null}
        {st ? <StateLine st={st} /> : null}
      </div>
    </Card>
  );
}

export default function SalesPage() {
  const { data, error, loading, offline, reload } = useServerData('/api/sales/summary', { everyMs: 60_000 });
  const stores = data?.stores ?? [];
  const names = new Map((data?.businesses ?? []).map((b) => [b.businessId, b.name]));
  const connected = stores.filter((s) => s.connected && s.state !== 'not_set_up');
  return (
    <>
      <MoneyTabs />
      <PageHeader
        title="Sales"
        subtitle="Total sales and orders per store, as each store’s own report shows them"
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
            Weeks run Monday–Sunday, each store in its own calendar (a store’s own report may start weeks on another day:
            compare with a custom Monday–Sunday range there).
            Total sales = items, shipping and tax, after discounts and refunds — as WooCommerce Analytics and eBay’s
            Seller Hub show it; a refund counts on the day it was made. Which orders count is each store’s own setting
            (eBay: cancelled and unpaid orders don’t). Read about once an hour, recent weeks again each time, so late
            refunds land. No customer details are kept.
          </p>
        </div>
      ) : null}
    </>
  );
}
