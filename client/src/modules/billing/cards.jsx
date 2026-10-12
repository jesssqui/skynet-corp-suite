// Quotes and invoices where they belong (D17/D18): a lead's quotes on its page ("New quote" — sending it moves the lead
// to Quoted), and a client's quotes, invoices and what they owe on the client page ("New quote" / "New invoice").
// Read from the device's offline copy; the new document opens on Money → Billing.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, Badge, Icon } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { useToday } from '../planner/parts.jsx';
import { useBillingData } from './data.js';
import { listRows, docPath, moneyText } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };
const head = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)', flexWrap: 'wrap' };
const linkButton = { color: 'var(--accent)', fontWeight: 600, fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 'var(--tap)', textDecoration: 'none' };

function DocList({ rows, testId }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid={testId}>
      {rows.map((r) => (
        <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ minWidth: 0 }}>
            <Link to={docPath(r.kind, r.id)}>{r.kind === 'quote' ? 'Quote' : 'Invoice'} {r.number}</Link>
            {r.title ? <span style={muted}> · {r.title}</span> : null}
            {r.day ? <span style={muted}> · {formatDate(r.day)}</span> : null}
          </span>
          <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <Badge tone={r.status.tone}>{r.status.label}</Badge>
            <strong>{moneyText(r.total)}</strong>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A lead's quotes (D17), with "New quote" for it. */
export function LeadQuotesCard({ lead }) {
  const { data } = useBillingData();
  const today = useToday();
  const rows = useMemo(() => (data ? listRows('quote', { ...data, quotes: data.quotes.filter((q) => q.lead_id === lead.id) }, { show: 'all', today }) : []), [data, lead.id, today]);
  return (
    <Card>
      <div style={head}>
        <h2 style={h2}>Quotes</h2>
        <Link style={linkButton} to={`/costs/billing?new=quote&lead=${lead.id}&business=${lead.business_id}`}><Icon name="plus" size={14} />New quote</Link>
      </div>
      {rows.length ? <DocList rows={rows} testId="lead-quotes" /> : <p style={{ ...muted, margin: 0 }}>No quote yet. Sending one moves the lead to Quoted, with its value; accepting it wins the lead.</p>}
    </Card>
  );
}

/** A client's quotes and invoices (D17/D18): open ones first, what is owed, and New quote / New invoice. */
export function ClientBillingCard({ clientId }) {
  const { data } = useBillingData();
  const today = useToday();
  const view = useMemo(() => {
    if (!data) return null;
    const mine = { ...data, quotes: data.quotes.filter((q) => q.client_id === clientId), invoices: data.invoices.filter((i) => i.client_id === clientId) };
    const quotes = listRows('quote', mine, { show: 'all', today });
    const invoices = listRows('invoice', mine, { show: 'all', today });
    const owing = invoices.reduce((a, r) => a + (r.status.state?.owing ?? 0), 0);
    return { rows: [...quotes, ...invoices].slice(0, 8), more: Math.max(0, quotes.length + invoices.length - 8), owing, overdue: invoices.some((r) => r.status.key === 'overdue') };
  }, [data, clientId, today]);
  if (!view) return null;
  return (
    <Card>
      <div style={head}>
        <h2 style={h2}>Quotes and invoices</h2>
        <span style={{ display: 'inline-flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Link style={linkButton} to={`/costs/billing?new=quote&client=${clientId}`}><Icon name="plus" size={14} />New quote</Link>
          <Link style={linkButton} to={`/costs/billing?new=invoice&client=${clientId}`}><Icon name="plus" size={14} />New invoice</Link>
        </span>
      </div>
      {view.owing ? <p style={{ margin: '0 0 var(--space-2)', color: view.overdue ? 'var(--danger)' : 'var(--text)' }} data-testid="client-owing">{moneyText(view.owing)} owing{view.overdue ? ' (past due)' : ''}</p> : null}
      {view.rows.length ? <DocList rows={view.rows} testId="client-docs" /> : <p style={{ ...muted, margin: 0 }}>None yet.</p>}
      {view.more ? <p style={{ ...muted, margin: 'var(--space-2) 0 0' }}><Link to="/costs/billing">and {view.more} more on Money → Billing</Link></p> : null}
    </Card>
  );
}
