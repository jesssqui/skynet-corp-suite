// Money → Billing (/costs/billing, D17/D18): quotes, invoices and credit notes on this device (offline too), by tab, with
// the business, what to show and words in the URL; "New quote" / "New invoice" (also opened with ?new=quote&lead=…,
// ?new=invoice&client=…&relationship=…&service=… from a lead or a client page), the business details, and — when a
// restore rolled the database back — the documents whose PDF was kept but whose record isn't here.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { billingAllowed } from '@suite/shared/billing';
import { PageHeader, Card, Button, Badge, EmptyState, Icon, Segmented, SelectField, TextField } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { useServerData } from '../../api/useServerData.js';
import { BusinessChip, Badges } from '../crm/parts.jsx';
import { useToday } from '../planner/parts.jsx';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import { useBillingData } from './data.js';
import { listRows, docPath, moneyText, QUOTE_FILTERS, INVOICE_FILTERS, KIND_LABELS } from './logic.js';
import { NewDocumentSheet } from './forms.jsx';
import './billing.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const TABS = [{ value: 'quote', label: 'Quotes' }, { value: 'invoice', label: 'Invoices' }, { value: 'credit_note', label: 'Credit notes' }];
const PAGE = 50;

function Row({ row, business }) {
  return (
    <li>
      <Link className="billing-row" to={docPath(row.kind, row.id)} data-doc-id={row.id}>
        <span className="billing-row-main">
          <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{row.toName || '—'}{row.title ? <span style={{ ...muted, fontWeight: 400 }}> · {row.title}</span> : null}</span>
          <span style={{ ...muted, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>{row.number}</span>
            {row.day ? <span>{formatDate(row.day)}</span> : null}
            <BusinessChip business={business} short />
          </span>
          <Badges record={row.doc}><Badge tone={row.status.tone}>{row.status.label}</Badge></Badges>
        </span>
        <span className="billing-row-amount">{moneyText(row.total)}</span>
      </Link>
    </li>
  );
}

export default function BillingPage() {
  const { data, loading } = useBillingData();
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'quote';
  const business = params.get('business') ?? '';
  const show = params.get('show') ?? 'open';
  const q = params.get('q') ?? '';
  const [shown, setShown] = useState(PAGE);
  const [sheet, setSheet] = useState(null);
  const archive = useServerData('/api/billing/archive', { everyMs: 0 });
  const setParam = (key, value, fallback = '') => {
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    if (key === 'tab') next.delete('show');
    setParams(next, { replace: true });
    setShown(PAGE);
  };
  // ?new=quote|invoice (+ lead, client, account, relationship, service, business): the new-document sheet, once.
  const wantNew = params.get('new');
  useEffect(() => {
    if (!data || !['quote', 'invoice'].includes(wantNew)) return;
    const get = (k) => params.get(k) ?? '';
    setSheet({ kind: wantNew, initial: { leadId: get('lead'), clientId: get('client'), accountId: get('account'), relationshipId: get('relationship'), serviceId: get('service'), businessId: get('business') || undefined } });
    const next = new URLSearchParams(window.location.search);
    for (const k of ['new', 'lead', 'client', 'account', 'relationship', 'service']) next.delete(k);
    setParams(next, { replace: true });
  }, [data, wantNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (data ? listRows(tab, data, { business, show: tab === 'credit_note' ? 'all' : show, q, today }) : []), [data, tab, business, show, q, today]);
  const lost = (archive.data?.documents ?? []).filter((d) => !d.inDatabase);
  const businesses = (data?.businesses ?? []).filter((b) => billingAllowed(b, b.id));
  const filters = tab === 'quote' ? QUOTE_FILTERS : INVOICE_FILTERS;

  return (
    <>
      <MoneyTabs />
      <PageHeader
        title="Quotes and invoices"
        subtitle="Working documents: write a draft (offline too), approve it to give it its number and PDF, then send the PDF yourself. The accountant keeps the books."
        actions={(
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={() => setSheet({ kind: 'quote', initial: {} })}><Icon name="plus" size={16} />New quote</Button>
            <Button onClick={() => setSheet({ kind: 'invoice', initial: {} })}><Icon name="plus" size={16} />New invoice</Button>
          </div>
        )}
      />
      <div className="billing-filters">
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Segmented label="Kind" value={tab} onChange={(x) => setParam('tab', x, 'quote')} options={TABS} />
        </div>
        {tab !== 'credit_note' ? <SelectField id="billing-show" label="Show" value={show} onChange={(x) => setParam('show', x, 'open')} options={filters} /> : null}
        <SelectField id="billing-business" label="Business" value={business} onChange={(x) => setParam('business', x)} options={[{ value: '', label: 'All' }, ...businesses.map((b) => ({ value: b.id, label: b.name }))]} />
        <TextField id="billing-q" label="Find" type="search" value={q} onChange={(e) => setParam('q', e.target.value)} placeholder="Number, who, title" />
      </div>
      <Card>
        {!data ? <p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p> : rows.length ? (
          <>
            <ul className="billing-list" data-testid="billing-list">
              {rows.slice(0, shown).map((r) => <Row key={r.id} row={r} business={data.businessesById.get(r.doc.business_id)} />)}
            </ul>
            {rows.length > shown ? <Button variant="ghost" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button> : null}
          </>
        ) : (
          <EmptyState title={`No ${KIND_LABELS[tab].toLowerCase()}s here`}>
            {tab === 'credit_note' ? 'A credit note is made from an issued invoice (its page: Credit note…).' : 'Change what to show, or make a new one.'}
          </EmptyState>
        )}
      </Card>
      <p style={{ ...muted, margin: 'var(--space-3) 0 0' }}>
        <Link to="/costs/billing/settings">Business details on documents (name, address, HST number, numbers) ›</Link>
        {' '}· Paid invoices count in <Link to="/costs/sales">Sales</Link> on the day they were paid.
      </p>
      {lost.length ? (
        <Card>
          <h2 style={{ fontSize: 'var(--text-sm)', margin: '0 0 var(--space-2)' }}>Issued, but not in the database any more</h2>
          <p style={{ ...muted, margin: '0 0 var(--space-2)' }}>The database was restored from an earlier backup: these were sent or issued after it. Their PDFs were kept (and their numbers are never given again): enter them again if they still count.</p>
          <ul style={{ margin: 0, paddingLeft: '1.2em' }} data-testid="billing-lost">
            {lost.map((d) => <li key={`${d.kind}:${d.doc_id}`}>{d.number} · {d.to_name ?? '—'} · {moneyText(d.total_cents ?? 0)} · {formatDate(d.made_on)} — <a href={`/api/billing/pdf-archive/${d.kind}/${d.doc_id}`}>PDF</a></li>)}
          </ul>
        </Card>
      ) : null}
      {sheet && data ? <NewDocumentSheet kind={sheet.kind} initial={sheet.initial} data={data} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
