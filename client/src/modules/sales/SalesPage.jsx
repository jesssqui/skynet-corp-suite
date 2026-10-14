// Sales by channel (/sales): Save Point Shop's sales from Whatnot, Poshmark and Facebook
// Marketplace. One total per channel per day, typed here (works offline) and added for any past
// day. The page shows each channel's total for a period, and the entries to fix or delete. eBay's
// totals are automatic and will show here once its connection exists. Days are the Toronto
// calendar days as typed; "today" is this device's calendar day.
import { useMemo, useState } from 'react';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { SALES_CHANNELS, channelLabel, totalsByChannel } from '@suite/shared/sales';
import { PageHeader, Card, Button, EmptyState, Notice, Segmented, TextField, SelectField } from '../../ui/index.js';
import { formatDate, localDate } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { SyncBadges } from '../../sync/components.jsx';
import { useAction } from '../crm/parts.jsx';
import { useSales } from './data.js';
import { PERIODS, periodRange, parseAmount, money, listEntries, sameDayTotal } from './logic.js';
import './sales.css';

const BUSINESS = BUSINESS_IDS.save_point;
const PAGE = 40;
const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const CHANNEL_OPTIONS = SALES_CHANNELS.map((c) => ({ value: c.id, label: c.label }));

const emptyForm = (today, channel = SALES_CHANNELS[0].id) => ({ date: today, channel, amount: '', notes: '' });

function Totals({ sales, range }) {
  const { byChannel, total } = useMemo(
    () => totalsByChannel(sales.filter((r) => r.business_id === BUSINESS), range),
    [sales, range],
  );
  return (
    <ul className="sales-totals" data-testid="sales-totals">
      <li className="sales-tile" data-channel="ebay">
        <span className="sales-tile-label">eBay</span>
        <span className="sales-tile-amount">—</span>
        <span className="sales-tile-note">Automatic · not connected yet</span>
      </li>
      {SALES_CHANNELS.map((c) => (
        <li key={c.id} className="sales-tile" data-channel={c.id}>
          <span className="sales-tile-label">{c.label}</span>
          <span className="sales-tile-amount" data-testid={`total-${c.id}`}>{money(byChannel[c.id].total)}</span>
          <span className="sales-tile-note">{byChannel[c.id].days === 1 ? '1 day' : `${byChannel[c.id].days} days`} entered</span>
        </li>
      ))}
      <li className="sales-tile" data-channel="total" style={{ background: 'var(--surface-2)', outline: '1px solid var(--border)' }}>
        <span className="sales-tile-label">Total, not counting eBay</span>
        <span className="sales-tile-amount" data-testid="total-all">{money(total)}</span>
        <span className="sales-tile-note">Whatnot, Poshmark, Facebook Marketplace</span>
      </li>
    </ul>
  );
}

export default function SalesPage() {
  const { sales, loading } = useSales();
  const today = localDate();
  const [period, setPeriod] = useState('month');
  const [form, setForm] = useState(() => emptyForm(today));
  const [editing, setEditing] = useState(null); // the record being edited
  const [amountError, setAmountError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [shown, setShown] = useState(PAGE);
  const { error, setError, run } = useAction();
  const range = useMemo(() => periodRange(period, today), [period, today]);
  const entries = useMemo(() => (sales ? listEntries(sales, { businessId: BUSINESS, ...range }) : []), [sales, range]);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(null); if (k === 'amount') setAmountError(null); };
  const already = sales && form.date
    ? sameDayTotal(sales, { businessId: BUSINESS, date: form.date, channel: form.channel, excludeId: editing?.id ?? null })
    : null;

  const startEdit = (r) => {
    setEditing(r);
    setForm({ date: r.sale_date, channel: r.channel, amount: String(r.amount), notes: r.notes ?? '' });
    setAmountError(null);
    setSaved(null);
    setError(null);
  };
  const cancelEdit = () => { setEditing(null); setForm(emptyForm(today, form.channel)); setAmountError(null); };

  const submit = (ev) => {
    ev.preventDefault();
    const a = parseAmount(form.amount);
    if (a.error) { setAmountError(a.error); return; }
    if (!form.date) { setError('Pick the day the sales happened'); return; }
    const notes = form.notes.trim();
    return run(async () => {
      if (editing) {
        const changed = {};
        if (editing.sale_date !== form.date) changed.sale_date = form.date;
        if (editing.channel !== form.channel) changed.channel = form.channel;
        if (editing.amount !== a.value) changed.amount = a.value;
        if ((editing.notes ?? '') !== notes) changed.notes = notes || null;
        if (Object.keys(changed).length) await store.update('sale_day', editing.id, changed);
        setSaved(`Saved the change to ${channelLabel(form.channel)} on ${formatDate(form.date)}.`);
        setEditing(null);
        setForm(emptyForm(today, form.channel));
      } else {
        await store.create('sale_day', {
          business_id: BUSINESS, channel: form.channel, sale_date: form.date, amount: a.value, ...(notes ? { notes } : {}),
        });
        setSaved(`Added ${money(a.value)} for ${channelLabel(form.channel)} on ${formatDate(form.date)}.`);
        // Keep the day and channel: the next entry is usually the next channel or the day before.
        setForm((f) => ({ ...f, amount: '', notes: '' }));
      }
    });
  };

  const remove = (r) => run(async () => {
    await store.remove('sale_day', r.id);
    setConfirmDelete(null);
    if (editing?.id === r.id) cancelEdit();
  });

  return (
    <>
      <PageHeader title="Sales" subtitle="Save Point Shop · Whatnot, Poshmark and Facebook Marketplace" />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card title="Totals">
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <div><Segmented label="Period" value={period} onChange={(p) => { setPeriod(p); setShown(PAGE); }} options={PERIODS} /></div>
            {range.from ? <p style={{ ...muted, margin: 0 }}>{formatDate(range.from)} to {formatDate(range.to)}</p> : null}
            {sales ? <Totals sales={sales} range={range} /> : <p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p>}
          </div>
        </Card>

        <Card title={editing ? 'Change an entry' : 'Add a day’s sales'}>
          <form onSubmit={submit} noValidate data-testid="sales-form" className="sales-form">
            <TextField label="Day" type="date" value={form.date} max={today} onChange={(e) => set('date')(e.target.value)} required />
            <SelectField label="Channel" value={form.channel} onChange={set('channel')} options={CHANNEL_OPTIONS} />
            <TextField
              label="Amount sold ($)"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={form.amount}
              onChange={(e) => set('amount')(e.target.value)}
              error={amountError ?? undefined}
              hint={!amountError && already != null && !editing ? `${channelLabel(form.channel)} already has ${money(already)} for this day — this adds to it.` : undefined}
            />
            <TextField label="Note (optional)" value={form.notes} maxLength={500} onChange={(e) => set('notes')(e.target.value)} />
            <div className="sales-form-wide" style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Button variant="primary" type="submit">{editing ? 'Save change' : 'Add'}</Button>
              {editing ? <Button onClick={cancelEdit}>Cancel</Button> : null}
              <span style={muted}>Works offline. Past days are fine: pick the day it happened.</span>
            </div>
          </form>
          {error ? <div style={{ marginTop: 'var(--space-3)' }}><Notice tone="danger">{error}</Notice></div> : null}
          {saved ? <div style={{ marginTop: 'var(--space-3)' }}><Notice tone="info"><span data-testid="sales-saved">{saved}</span></Notice></div> : null}
        </Card>

        <Card title="Entries">
          {!sales ? (
            <p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p>
          ) : entries.length ? (
            <>
              <ul className="sales-entries" data-testid="sales-list">
                {entries.slice(0, shown).map((r) => (
                  <li key={r.id} className="sales-entry" data-entry-id={r.id}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 550 }}>{formatDate(r.sale_date, { weekday: true })} · {channelLabel(r.channel)}</div>
                      <div style={{ ...muted, overflowWrap: 'anywhere' }}>{r.notes ? r.notes : ' '} <SyncBadges record={r} /></div>
                    </div>
                    <div className="sales-entry-amount">{money(r.amount)}</div>
                    <div className="sales-entry-actions">
                      {confirmDelete === r.id ? (
                        <>
                          <span style={muted}>Delete this entry?</span>
                          <Button variant="danger" onClick={() => remove(r)}>Yes, delete</Button>
                          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Keep</Button>
                        </>
                      ) : (
                        <>
                          <Button onClick={() => startEdit(r)} aria-label={`Change ${channelLabel(r.channel)} on ${r.sale_date}`}>Change</Button>
                          <Button variant="ghost" onClick={() => setConfirmDelete(r.id)} aria-label={`Delete ${channelLabel(r.channel)} on ${r.sale_date}`}>Delete</Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {entries.length > shown ? (
                <div style={{ marginTop: 'var(--space-3)' }}><Button onClick={() => setShown((n) => n + PAGE)}>Show more ({entries.length - shown} left)</Button></div>
              ) : null}
            </>
          ) : (
            <EmptyState title="No entries in this period">Add a day’s sales above. Totals start from zero.</EmptyState>
          )}
        </Card>
      </div>
    </>
  );
}
