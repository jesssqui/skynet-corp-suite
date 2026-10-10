// Sales entered by hand (/costs/sales/entries, D11): invoices and anything no connection brings in — a business, a day,
// an amount, a currency (CAD by default), orders and a note; refunds and credit notes count down. They are added up per
// day into the sales totals (a card per business on Money → Sales, and the overview), counted as total only. Server
// data (not synced): adding, changing or deleting one needs a connection to the suite. `?business=` filters the list.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { newId } from '@suite/shared/ids';
import { byHandAllowed, BY_HAND_WARNING } from '@suite/shared/sales';
import { api } from '../../api/client.js';
import { useServerData } from '../../api/useServerData.js';
import { PageHeader, Card, Notice, EmptyState, Button, TextField, SelectField, TextAreaField, Segmented, Sheet, Badge } from '../../ui/index.js';
import { formatDate, localDate } from '../../ui/format.js';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import {
  KIND_LABELS, KIND_OPTIONS, CURRENCY_OPTIONS, newEntryForm, entryToForm, entryProblem, entryBody, entryAmountText, sumsText,
} from './logic.js';
import './sales.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const PAGE = 50;
const LAST_BUSINESS = 'suite.sales.lastEntryBusiness';
const remembered = () => {
  try { return localStorage.getItem(LAST_BUSINESS) ?? ''; } catch { return ''; }
};
const remember = (id) => {
  try { localStorage.setItem(LAST_BUSINESS, id); } catch { /* a convenience only */ }
};

function EntrySheet({ entry, businesses, initialBusiness, offline, onClose, onSaved }) {
  const today = localDate();
  const [form, setForm] = useState(() => (entry ? entryToForm(entry) : newEntryForm({ today, businessId: initialBusiness })));
  // The new entry's id is made once, when the sheet opens: a save sent twice (a double tap, a lost reply) is one entry.
  const id = useRef(entry?.id ?? newId());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [touched, setTouched] = useState(false);
  const wrong = entryProblem(form, { today: null });
  const set = (k) => (v) => { setTouched(true); setForm((f) => ({ ...f, [k]: v })); };
  const errorFor = (field) => (touched && wrong?.field === field ? wrong.text : undefined);
  // Review fix: not Wholesale or Save Point Shop (their sales come from the Order Manager and eBay: they would count
  // twice) nor Personal, not archived — an entry already on one keeps it; Retail stores with a warning (D11 follow-up).
  const options = businesses.filter((b) => byHandAllowed(b) || b.id === entry?.businessId).map((b) => ({ value: b.id, label: b.name }));

  async function save() {
    setTouched(true);
    if (wrong) return;
    setBusy(true);
    setProblem(null);
    try {
      const body = entryBody(form);
      let res;
      if (entry) res = await api.put(`/api/sales/entries/${entry.id}`, body);
      else {
        try {
          res = await api.post('/api/sales/entries', { id: id.current, ...body });
        } catch (err) {
          // Review fix: a save whose reply was lost, then changed and saved again — the server has this entry under
          // the id made when the sheet opened: it is the same entry, so change it.
          if (err.status !== 409 || err.code !== 'exists') throw err;
          res = await api.put(`/api/sales/entries/${id.current}`, body);
        }
      }
      remember(form.businessId);
      onSaved(res.entry);
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server: saving an entry needs a connection.' : err.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setProblem(null);
    try {
      await api.del(`/api/sales/entries/${entry.id}`);
      onSaved(null);
    } catch (err) {
      setProblem(err.status === 0 ? 'Can’t reach the suite server.' : err.message);
    } finally {
      setBusy(false);
    }
  }
  const sign = form.kind === 'sale' ? 'counts up' : 'counts down (a negative)';
  return (
    <Sheet
      title={entry ? 'Change the entry' : 'Enter a sale by hand'}
      onClose={onClose}
      onSubmit={save}
      testId="entry-sheet"
      footer={(
        <>
          {entry ? (confirmDelete ? (
            <Button variant="danger" onClick={remove} disabled={busy || offline} data-testid="entry-delete-confirm">Delete it</Button>
          ) : (
            <Button onClick={() => setConfirmDelete(true)} disabled={busy || offline}>Delete…</Button>
          )) : null}
          <span style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || offline}>{busy ? 'Saving…' : 'Save'}</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {offline ? <Notice tone="warn">Can’t reach the suite server: entries need a connection.</Notice> : null}
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Segmented label="What it is" value={form.kind} onChange={set('kind')} options={KIND_OPTIONS} />
        </div>
        <span style={muted}>A {KIND_LABELS[form.kind].toLowerCase()} {sign}: type the amount as it is on the {form.kind === 'credit_note' ? 'credit note' : form.kind === 'refund' ? 'refund' : 'invoice'}.</span>
        <SelectField id="entry-business" label="Business" value={form.businessId} onChange={set('businessId')}
          options={[{ value: '', label: 'Pick one…' }, ...options]} error={errorFor('businessId')}
          hint="Not Wholesale or Save Point Shop: their sales come from the Order Manager and eBay (they would count twice)." />
        {BY_HAND_WARNING[form.businessId] ? <div data-testid="entry-warning"><Notice tone="warn">{BY_HAND_WARNING[form.businessId]}.</Notice></div> : null}
        <TextField id="entry-day" label="Day" type="date" value={form.day} onChange={(e) => set('day')(e.target.value)} error={errorFor('day')} />
        <div className="sales-entry-money">
          <TextField id="entry-amount" label="Amount" inputMode="decimal" placeholder="1234.56" value={form.amount}
            onChange={(e) => set('amount')(e.target.value)} error={errorFor('amount')} />
          <SelectField id="entry-currency" label="Currency" value={form.currency} onChange={set('currency')}
            options={CURRENCY_OPTIONS.some((o) => o.value === form.currency) ? CURRENCY_OPTIONS : [...CURRENCY_OPTIONS, { value: form.currency, label: form.currency }]} />
        </div>
        {form.kind === 'sale' ? (
          <TextField id="entry-orders" label="Orders (optional)" inputMode="numeric" value={form.orders} onChange={(e) => set('orders')(e.target.value)} error={errorFor('orders')} />
        ) : null}
        <TextAreaField id="entry-note" label="Note (optional)" rows={2} placeholder="Invoice 2026-031, Maple Dental" value={form.note} onChange={(e) => set('note')(e.target.value)} />
        {confirmDelete ? <Notice tone="warn">Delete this entry? Its day’s total goes down by it.</Notice> : null}
        {problem ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{problem}</p> : null}
      </div>
    </Sheet>
  );
}

export default function EntriesPage() {
  const [params, setParams] = useSearchParams();
  const business = params.get('business') ?? '';
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [business]);
  const url = `/api/sales/entries?limit=${limit}${business ? `&business=${encodeURIComponent(business)}` : ''}`;
  const list = useServerData(url, { everyMs: 60_000 });
  const bizData = useServerData('/api/crm/businesses', { everyMs: 0 });
  const businesses = useMemo(() => bizData.data?.businesses ?? [], [bizData.data]);
  const names = new Map(businesses.map((b) => [b.id, b.name]));
  const pickable = businesses.filter(byHandAllowed);
  const [sheet, setSheet] = useState(null); // { entry } | { entry: null }
  const [done, setDone] = useState(null);
  const offline = list.offline || bizData.offline;
  const entries = list.data?.entries ?? [];

  const saved = (entry, wasNew) => {
    setSheet(null);
    setDone(entry ? (wasNew ? 'Saved.' : 'Changed.') : 'Deleted.');
    list.reload();
  };

  return (
    <>
      <MoneyTabs />
      <PageHeader
        title="Sales entered by hand"
        subtitle="Invoices and anything not connected: they count in Sales and the overview"
        actions={<Button variant="primary" onClick={() => { setDone(null); setSheet({ entry: null }); }} disabled={offline || !pickable.length} data-testid="entry-add">Enter a sale</Button>}
      />
      <p style={{ margin: '0 0 var(--space-4)' }}><Link to="/costs/sales">← All sales</Link></p>
      {offline ? (
        <Notice tone="warn" style={{ marginBottom: 'var(--space-4)' }}>
          Can’t reach the suite server. Entries are kept by the server, not on this device: this page needs a connection
          {list.data ? '; what you see is from the last check' : ''}.
        </Notice>
      ) : null}
      {list.error && !offline ? <Notice tone="danger" style={{ marginBottom: 'var(--space-4)' }}>{list.error.message}</Notice> : null}
      {done ? <Notice tone="ok" style={{ marginBottom: 'var(--space-4)' }}>{done}</Notice> : null}
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card>
          <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <SelectField id="entries-business" label="Business" value={business}
              onChange={(v) => setParams(v ? { business: v } : {}, { replace: true })}
              options={[{ value: '', label: 'All businesses' }, ...businesses.map((b) => ({ value: b.id, label: b.name }))]} />
            <span style={muted} data-testid="entries-sum">
              {list.data ? `${list.data.total} entr${list.data.total === 1 ? 'y' : 'ies'} · together ${sumsText(list.data.sums)}` : ' '}
            </span>
          </div>
        </Card>
        {list.data && !entries.length ? (
          <EmptyState title="Nothing entered by hand yet">
            Enter an invoice, a sale no connection brings in, or a refund or credit note (they count down).
          </EmptyState>
        ) : null}
        {entries.length ? (
          <Card padded={false}>
            <ul className="sales-entries" data-testid="entries">
              {entries.map((e) => (
                <li key={e.id}>
                  <button type="button" className="sales-entry" onClick={() => { setDone(null); setSheet({ entry: e }); }} disabled={offline} data-entry={e.id}>
                    <span className="sales-entry-main">
                      <span style={{ fontWeight: 600 }}>{formatDate(e.day, { weekday: false })}</span>
                      <span style={muted}>{names.get(e.businessId) ?? 'Unknown business'}{e.note ? ` · ${e.note}` : ''}</span>
                    </span>
                    <span className="sales-entry-amount">
                      <span style={{ fontWeight: 650, color: e.amount < 0 ? 'var(--danger)' : 'var(--text)' }}>{entryAmountText(e)}</span>
                      <span style={muted}>
                        {e.kind === 'sale' ? (e.orders ? `${e.orders} order${e.orders === 1 ? '' : 's'}` : 'Sale') : <Badge tone="neutral">{KIND_LABELS[e.kind]}</Badge>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {list.data && list.data.total > entries.length ? (
          <div><Button onClick={() => setLimit((n) => Math.min(n + PAGE, 200))} disabled={limit >= 200}>Show more</Button></div>
        ) : null}
        {list.data && list.data.total > 200 && limit >= 200 ? <span style={muted}>The newest 200 are shown: pick a business to see its own.</span> : null}
        <p style={{ ...muted, margin: 0 }}>
          Each business’s entries are added up per day on its card in Sales (“Entered by hand”) and in the overview’s
          sales — total only: tax and shipping aren’t asked for. Refunds and credit notes count down on their own day.
          Never added across currencies.
        </p>
      </div>
      {sheet ? (
        <EntrySheet
          entry={sheet.entry}
          businesses={businesses}
          initialBusiness={[business, remembered()].find((id) => pickable.some((b) => b.id === id)) ?? ''}
          offline={offline}
          onClose={() => setSheet(null)}
          onSaved={(e) => saved(e, !sheet.entry)}
        />
      ) : null}
    </>
  );
}
