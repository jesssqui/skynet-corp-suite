// Save Point Shop on eBay (/costs/sales/ebay, D13): its totals (today / this week / this month), the last 13 months —
// eBay's own figure, or a month entered by hand while eBay isn't connected (Seller Hub → Performance → Sales, "Total
// sales") — and the form to enter or correct one. Once eBay has days for a month, those count and the month entered by
// hand is kept, shown as replaced. D13b: what each figure is made of — Items, Shipping, Before tax, Tax and the Total
// after tax — for today, this week, this month and each month, always from the same source as the figure shown (a
// month entered by hand has only its total). Server data (not synced): needs a connection to the suite.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Notice, Button, TextField, SelectField } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import { Periods, StateLine } from './SalesPage.jsx';
import { stateText, updatedText, monthText, monthLine, monthBreakdown, periodBreakdown, parseAmount } from './logic.js';
import './sales.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];

/** D13b: each period's breakdown (Items, Shipping, Before tax, Tax, Total after tax), side by side on wide screens. */
function Breakdown({ card }) {
  return (
    <div className="sales-breakdown" data-testid="ebay-breakdown">
      {PERIODS.map(([k, label]) => {
        const parts = periodBreakdown(card[k]);
        return (
          <div key={k} data-breakdown={k} style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
            <span style={{ ...muted, fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</span>
            {parts === null ? <span style={muted} data-testid="breakdown-total-only">Entered by hand: total only</span> : parts.map((part) => (
              <div key={part.currency} className="sales-lines">
                {parts.length > 1 ? <span style={{ ...muted, gridColumn: '1 / -1', fontWeight: 600 }}>{part.currency}</span> : null}
                {part.lines.map(([name, value], i) => {
                  const last = i === part.lines.length - 1;
                  const strong = last ? { fontWeight: 650, borderTop: '1px solid var(--border)', paddingTop: 2 } : null;
                  return [
                    <span key={`${name}k`} style={{ ...muted, ...strong, color: last ? 'var(--text)' : muted.color }}>{name}</span>,
                    <span key={`${name}v`} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', ...strong }}>{value}</span>,
                  ];
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function EbayPage() {
  const months = useServerData('/api/sales/manual/ebay', { everyMs: 60_000 });
  const summary = useServerData('/api/sales/summary', { everyMs: 60_000 });
  const card = summary.data?.stores.find((s) => s.source === 'ebay' && s.manualStore === 'ebay') ?? null;
  const open = (months.data?.months ?? []).filter((m) => m.canEnter ?? m.shown !== 'real');
  const [form, setForm] = useState({ month: '', total: '', orders: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const offline = months.offline || summary.offline;
  const month = form.month || open[0]?.month || '';
  const cents = parseAmount(form.total);
  const orders = form.orders.trim() === '' ? null : (/^\d+$/.test(form.orders.trim()) ? Number(form.orders.trim()) : NaN);
  const typed = !month ? 'Every month shown has eBay’s own figure' : cents === null ? (form.total ? 'Type the total like 1234.56' : '') : Number.isNaN(orders) ? 'Orders is a whole number' : null;

  async function save() {
    setBusy(true);
    setProblem(null);
    try {
      const next = await api.put(`/api/sales/manual/ebay/${month}`, { total: cents, currency: 'CAD', orders, note: form.note.trim() || null });
      months.replace(() => next);
      summary.reload();
      setForm({ month: '', total: '', orders: '', note: '' });
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: entering a month needs a connection.' : err.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(m) {
    setBusy(true);
    setProblem(null);
    try {
      const next = await api.del(`/api/sales/manual/ebay/${m}`);
      months.replace(() => next);
      summary.reload();
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
      months.reload();
    } finally {
      setBusy(false);
    }
  }

  const st = card ? stateText(card) : null;
  return (
    <>
      <MoneyTabs />
      <PageHeader title="Save Point Shop on eBay" subtitle="Total sales as eBay’s Seller Hub shows them, or entered by hand" />
      <p style={{ margin: '0 0 var(--space-4)' }}><Link to="/costs/sales">← All sales</Link></p>
      {offline ? <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>Can’t reach the suite server: sales and months entered by hand need a connection.</Notice> : null}
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        {card ? (
          <Card>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="ebay-card">
              <Periods figures={card} />
              <Breakdown card={card} />
              <span style={muted} data-testid="ebay-breakdown-note">
                Items are item prices after discounts and refunds. eBay doesn’t say what part of a refund was shipping, so
                refunds come off Items, and the tax refunded with a refund is worked out in proportion. Tax is the tax
                eBay collected. Before tax = Items + Shipping.
              </span>
              <span style={muted}>
                {card.monthFromManual ? 'This month entered by hand · ' : ''}{updatedText(card, formatDateTime)} · its day is {card.date}{card.timeZone ? ` (${card.timeZone})` : ''}
              </span>
              {st ? <StateLine st={st} /> : null}
              <span style={muted}>The eBay sign-in, its switch and the time zone are on <Link to="/system/connections">System → Connections</Link>.</span>
            </div>
          </Card>
        ) : null}
        <Card title="Months">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="ebay-months">
            {(months.data?.months ?? []).map((m) => {
              const line = monthLine(m);
              const parts = monthBreakdown(m);
              return (
                <li key={m.month} data-month={m.month} data-shown={m.shown ?? 'none'} style={{ display: 'flex', gap: 'var(--space-1) var(--space-3)', justifyContent: 'space-between', flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 'var(--space-2)' }}>
                  <span style={{ minWidth: 130 }}>{monthText(m.month)}</span>
                  <span style={{ fontWeight: 600 }}>{line.figure}</span>
                  <span style={{ ...muted, flex: '1 1 180px', textAlign: 'right' }}>
                    {line.from}
                    {m.replaced ? ` · by hand: ${periodLike(m.manual)}` : ''}
                    {m.manual && !m.replaced ? <> · <button type="button" onClick={() => remove(m.month)} disabled={busy || offline} style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, font: 'inherit' }}>Remove</button></> : null}
                  </span>
                  {parts ? <span style={{ ...muted, flexBasis: '100%', fontVariantNumeric: 'tabular-nums' }} data-testid="month-breakdown">{parts}</span> : null}
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Enter a month by hand">
          <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="ebay-manual">
            <span style={muted}>
              For months eBay isn’t connected for — or read only in part before it stopped reading (signed out by eBay,
              switched off or forgotten; failing for a while still counts as reading): in Seller Hub, Performance → Sales,
              pick the month and copy its <strong>Total sales</strong>. Once eBay has that month’s figure, it counts and this
              entry is kept, shown as replaced — for good, unless you save the month again.
            </span>
            {!open.length ? <span style={muted} data-testid="ebay-all-real">Every month shown has eBay’s own figure: nothing to enter by hand.</span> : <>
            <SelectField id="ebay-month" label="Month" value={month} onChange={(v) => setForm({ ...form, month: v })}
              options={open.map((m) => ({ value: m.month, label: `${monthText(m.month)}${m.manual ? ' (correct it)' : ''}` }))} />
            <TextField id="ebay-total" label="Total sales (CAD)" inputMode="decimal" placeholder="1234.56" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} error={typed || undefined} />
            <TextField id="ebay-orders" label="Orders (optional)" inputMode="numeric" value={form.orders} onChange={(e) => setForm({ ...form, orders: e.target.value })} />
            <TextField id="ebay-note" label="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <div><Button variant="primary" onClick={save} disabled={busy || offline || typed !== null}>{busy ? 'Saving…' : 'Save the month'}</Button></div>
            </>}
            {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
          </div>
        </Card>
      </div>
    </>
  );
}

const periodLike = (m) => (m ? `${(m.total / 100).toLocaleString('en-CA', { style: 'currency', currency: m.currency || 'CAD', currencyDisplay: 'narrowSymbol' })}` : '');
