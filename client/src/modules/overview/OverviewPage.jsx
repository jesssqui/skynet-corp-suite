// The overview (/overview, D11): one screen for how every business is doing and what needs dealing with. At the top,
// each business's sales for today, this week and this month side by side (each store in its own calendar, as Money →
// Sales) with the combined total of all businesses underneath — per currency, never added across currencies. Then
// "To deal with": overdue tasks, wholesale balances over 30 days, renewals and retainers in 30 days, low stock, support
// emails (not connected yet), payments with no order to go against, no next step, clients gone quiet — each line
// linking to where it is dealt with — plus this device's own changes it couldn't save (the sync bar's "need attention").
// Server data (GET /api/overview, not synced): needs a connection to the suite. Built for the Mac; works on a phone.
// Room is left below for D15's cards (stock, clients, goals…).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Notice, EmptyState, Button, Badge, Icon } from '../../ui/index.js';
import { formatDate, formatDateTime, localDate } from '../../ui/format.js';
import { useSyncStatus } from '../../sync/hooks.js';
import { businessColor } from '../crm/logic.js';
import { periodText, ordersText } from '../sales/logic.js';
import { Periods } from '../sales/parts.jsx';
import {
  SECTIONS, UNMATCHED_MISSING, unmatchedLine, itemLine, stateNote, countText, summaryText, shownCount, moreText, restText, attentionTotal,
  totalOnlyNote, storesNote,
} from './logic.js';
import './overview.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];

function BusinessTile({ b }) {
  const notes = [totalOnlyNote(b), storesNote(b.stores)].filter(Boolean);
  return (
    <section className="overview-tile" data-testid="overview-business" data-business={b.businessId} aria-label={b.name}>
      <h3 className="overview-tile-name">
        <span aria-hidden="true" className="overview-dot" style={{ background: businessColor({ id: b.businessId, color: b.color }) }} />
        {b.name}
      </h3>
      <dl className="overview-periods">
        {PERIODS.map(([k, label]) => (
          <div key={k} data-period={k}>
            <dt>{label}</dt>
            <dd>
              <span className="overview-figure">{periodText(b[k])}</span>
              <span style={muted}>{ordersText(b[k])}</span>
            </dd>
          </div>
        ))}
      </dl>
      {notes.length ? <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>{notes.join(' · ')}</span> : null}
    </section>
  );
}

function SalesStrip({ sales }) {
  if (!sales) return <Card title="Sales"><span style={muted}>Sales can’t be read just now.</span></Card>;
  return (
    <Card>
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 650, margin: 0 }}>Sales</h2>
          <Link to="/costs/sales" style={{ fontSize: 'var(--text-sm)' }}>Per store ›</Link>
        </div>
        {sales.businesses.length ? (
          <div className="overview-strip" data-testid="overview-strip">
            {sales.businesses.map((b) => <BusinessTile key={b.businessId ?? 'none'} b={b} />)}
          </div>
        ) : (
          <EmptyState title="No sales to show yet">
            Connect a store, the Order Manager or eBay on <Link to="/system/connections">System → Connections</Link>, or
            {' '}<Link to="/costs/sales/entries">enter a sale by hand</Link> (invoices, anything not connected).
          </EmptyState>
        )}
        <div className="overview-total" data-testid="overview-total">
          <span style={{ ...muted, fontWeight: 600 }}>All businesses together · per currency</span>
          <Periods figures={sales.overall} testId="overview-overall" />
        </div>
        <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>
          Total sales (items, shipping and tax, after discounts and refunds), each store in its own calendar; weeks run
          Monday–Sunday. Sales entered by hand count as typed.
        </span>
      </div>
    </Card>
  );
}

function Unmatched({ u }) {
  const line = unmatchedLine(u, { date: (d) => formatDate(d) });
  if (!line) return <span style={{ ...muted, fontSize: 'var(--text-xs)' }} data-testid="unmatched-missing">{UNMATCHED_MISSING}</span>;
  return (
    <div className="overview-item" data-testid="unmatched">
      <span className="overview-item-text" style={line.tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{line.text}</span>
      {line.detail ? <span style={muted}>{line.detail}</span> : null}
    </div>
  );
}

function AttentionSection({ section }) {
  const meta = SECTIONS[section.id] ?? { title: section.id };
  const [taps, setTaps] = useState(0);
  const shown = shownCount(taps);
  const note = stateNote(section);
  const items = (section.items ?? []).slice(0, shown).map((i) => itemLine(section.id, i, { date: (d) => formatDate(d) }));
  const more = moreText(section, shown);
  const rest = restText(section, shown);
  const summary = summaryText(section);
  const quiet = !section.count && !note && !(section.id === 'payments' && section.unmatched);
  return (
    <section className="overview-section" data-testid="attention-section" data-section={section.id} data-count={section.count ?? ''} aria-labelledby={`att-${section.id}`}>
      <div className="overview-section-head">
        <h3 id={`att-${section.id}`}>{meta.title}</h3>
        <Badge tone={section.count ? (section.id === 'overdue' || section.id === 'balances' ? 'danger' : 'warn') : 'neutral'}>{countText(section)}</Badge>
      </div>
      {section.id === 'payments' && section.state !== 'not_connected' ? <Unmatched u={section.unmatched} /> : null}
      {summary ? <span style={muted}>{summary}</span> : null}
      {note ? <span style={muted} data-testid="section-state">{note}</span> : null}
      {quiet ? <span style={muted}>{meta.empty}</span> : null}
      {items.length ? (
        <ul className="overview-items">
          {items.map((l) => (
            <li key={l.key}>
              {l.link ? (
                <Link to={l.link} className="overview-item">
                  <span className="overview-item-text" style={l.tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{l.text}</span>
                  {l.detail ? <span style={muted}>{l.detail}</span> : null}
                </Link>
              ) : (
                <div className="overview-item">
                  <span className="overview-item-text" style={l.tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{l.text}</span>
                  {l.detail ? <span style={muted}>{l.detail}</span> : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {more || rest || (meta.link && section.count) ? (
        <div className="overview-section-foot">
          {more ? <Button onClick={() => setTaps((n) => n + 1)} style={{ minHeight: 36 }}>{more}</Button> : null}
          {rest ? <span style={muted}>{rest}</span> : null}
          {meta.link && section.count ? <Link to={meta.link} style={{ fontSize: 'var(--text-sm)' }}>{meta.linkText} ›</Link> : null}
        </div>
      ) : null}
    </section>
  );
}

export default function OverviewPage() {
  const today = localDate();
  const { data, error, loading, offline, checking, checkAgain } = useServerData(`/api/overview?today=${today}`, { everyMs: 60_000 });
  const sync = useSyncStatus();
  const syncAttention = sync?.attention ?? 0;
  const total = attentionTotal(data?.attention, syncAttention, data?.urgent);
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={formatDate(today, { weekday: true })}
        actions={<Button onClick={checkAgain} disabled={loading || checking}>{checking ? 'Checking…' : 'Check again'}</Button>}
      />
      {offline ? (
        <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>
          Can’t reach the suite server. The overview is worked out by the server (sales and the Order Manager’s money
          aren’t kept on this device), so it needs a connection{data ? `; what you see is from ${formatDateTime(data.at)}` : ''}.
          Today, Tasks and Clients work offline.
        </Notice>
      ) : null}
      {error && !offline ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{error.message}</Notice> : null}
      {!data && loading ? <EmptyState title="Loading…" /> : null}
      {data ? (
        <div className="overview" data-testid="overview">
          <SalesStrip sales={data.sales} />
          <Card>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="attention">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 650, margin: 0 }}>To deal with</h2>
                <span style={muted} data-testid="attention-total">{total ? `${total.toLocaleString('en-CA')} urgent` : 'Nothing urgent'}</span>
              </div>
              {syncAttention ? (
                <Link to="/sync/attention" className="overview-sync" data-testid="attention-sync">
                  <Icon name="alert" size={18} />
                  {syncAttention} change{syncAttention === 1 ? '' : 's'} on this device couldn’t be saved: fix or discard
                  <Icon name="chevron" size={16} />
                </Link>
              ) : null}
              <div className="overview-sections">
                {data.attention.map((s) => <AttentionSection key={s.id} section={s} />)}
              </div>
            </div>
          </Card>
        </div>
      ) : null}
    </>
  );
}
