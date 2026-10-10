// A WooCommerce store's page (/costs/sales/woo/:id, D12): its totals, and order lookups by number or email — live
// from the store with its read-only key, shown here only while the page is open: nothing about an order or a
// customer is stored in the suite or on this device (only the customer's first name is shown). The stores sell
// age-restricted products: what is seen here must never feed a marketing list. Needs a connection to the suite.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Badge, Notice, EmptyState, Button, TextField } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import { Periods, StateLine } from './SalesPage.jsx';
import { lookupQuery, orderStatus, trackingText, orderMoneyLines, stateText, updatedText, backfillText } from './logic.js';
import './sales.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function OrderCard({ o }) {
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

function Lookup({ storeId, disabled }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // kept only in this page's memory
  const [problem, setProblem] = useState(null);
  const q = lookupQuery(text);
  async function find() {
    if (q.problem !== undefined) return;
    setBusy(true);
    setProblem(null);
    try {
      const qs = q.number ? `number=${encodeURIComponent(q.number)}` : `email=${encodeURIComponent(q.email)}`;
      setResult({ ...(await api.get(`/api/woocommerce/stores/${storeId}/orders?${qs}`)), asked: text.trim() });
    } catch (err) {
      setResult(null);
      setProblem(err.status === 0 ? 'Can’t reach the suite server: looking orders up needs a connection.' : err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Look up an order">
      <form
        onSubmit={(e) => { e.preventDefault(); find(); }}
        style={{ display: 'grid', gap: 'var(--space-3)' }}
        data-testid="sales-lookup"
      >
        <TextField
          id="sales-lookup-q"
          label="Order number or the customer’s email"
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={q.problem || undefined}
          autoComplete="off"
          inputMode="email"
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button type="submit" variant="primary" disabled={disabled || busy || q.problem !== undefined}>{busy ? 'Asking the store…' : 'Look up'}</Button>
          {result ? <Button onClick={() => { setResult(null); setText(''); }}>Clear</Button> : null}
        </div>
        <span style={muted}>
          Read live from the store and shown only here: nothing about the order or the customer is kept (first name only).
        </span>
      </form>
      {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 'var(--space-3) 0 0' }}>{problem}</p> : null}
      {result ? (
        result.orders.length ? (
          <ul className="sales-orders" style={{ marginTop: 'var(--space-3)' }}>
            {result.orders.map((o) => <OrderCard key={o.id} o={o} />)}
            {result.more ? <li style={muted}>More orders match: the 10 newest are shown.</li> : null}
          </ul>
        ) : <p style={{ ...muted, margin: 'var(--space-3) 0 0' }} data-testid="sales-no-orders">No order matches “{result.asked}”.</p>
      ) : null}
    </Card>
  );
}

export default function StorePage() {
  const { id } = useParams();
  const { data, error, offline } = useServerData(`/api/woocommerce/stores/${id}`, { everyMs: 60_000 });
  const summary = useServerData('/api/sales/summary', { everyMs: 60_000 });
  const store = data?.store;
  const totals = store ? summary.data?.stores.find((s) => s.source === 'woo' && s.store === store.storeKey) : null;
  const st = totals ? stateText(totals) : null;
  return (
    <>
      <MoneyTabs />
      <PageHeader title={store?.name ?? 'Store'} subtitle={store ? `${store.url} · WooCommerce · ${store.currency ?? ''}` : ' '} />
      <p style={{ margin: '0 0 var(--space-4)' }}><Link to="/costs/sales">← All sales</Link></p>
      {offline ? (
        <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>
          Can’t reach the suite server: sales and order lookups need a connection.
        </Notice>
      ) : null}
      {error && !offline ? <Notice tone="danger">{error.status === 404 ? 'This store isn’t connected any more.' : error.message}</Notice> : null}
      {store ? (
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          <Card>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <Periods figures={totals} testId="store-periods" />
              <span style={muted}>
                {totals ? `${updatedText(totals, formatDateTime)} · ` : ''}its day is {store.today}{store.timeZone ? ` (${store.timeZone})` : ''} · {backfillText(store)}
              </span>
              {st ? <StateLine st={st} /> : null}
              <span style={muted}>
                Its key, switch and settings are on <Link to="/system/connections">System → Connections</Link>.
              </span>
            </div>
          </Card>
          <Lookup storeId={store.id} disabled={offline || store.paused || !store.readable} />
          {store.paused ? <Notice tone="warn">This store is paused on Connections: nothing is read from it, lookups included.</Notice> : null}
        </div>
      ) : null}
    </>
  );
}
