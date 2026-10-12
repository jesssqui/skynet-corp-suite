// One quote, invoice or credit note (/costs/billing/quotes/:id, /invoices/:id, /credit-notes/:id; D17/D18).
//   draft   who it is for, its lines (add, change, take off) and its totals as you type — offline too; "Look at the PDF"
//           (a draft copy) and "Approve and send / issue…" need a connection: the server gives the number and keeps the PDF.
//   quote   sent → Email it… (you send it), Accepted… (a lead's quote wins the lead: D8's Won…), Declined… (the lead lost
//           too); accepted → Make the invoice.
//   invoice issued → where it stands (unpaid, partly paid, paid, overdue), its payments (Record a payment — offline too;
//           take one off), Credit note…, Void… (a mistake, no payment), Email it…
//   credit  draft lines (Copy the invoice's lines), then issued like an invoice; it takes money off its invoice.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { newId } from '@suite/shared/ids';
import { DOC_ENTITY, LINE_ENTITY, LINE_PARENT, KIND_LABELS, HST_RATE_BP, documentTotals, lineAmount, moneyText, rateText } from '@suite/shared/billing';
import { Card, Button, Badge, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { store, useSyncStatus } from '../../sync/index.js';
import { useServerData } from '../../api/useServerData.js';
import { BusinessChip, Badges, RecordSync, TextButton, useAction } from '../crm/parts.jsx';
import { useToday } from '../planner/parts.jsx';
import MoneyTabs from '../costs/MoneyTabs.jsx';
import { useBillingData } from './data.js';
import {
  docStatus, docPath, linesOf, pdfUrl, invoiceFromQuote, creditNoteFor, createDocument, docIds, contactFor, PAYMENT_METHOD_LABELS, QUOTE_STATUS_LABELS,
} from './logic.js';
import { LineSheet, DetailsSheet, ApproveSheet, EmailSheet, AcceptSheet, DeclineSheet, PaymentSheet, VoidSheet } from './forms.jsx';
import { LOST_LABELS } from '../crm/leads.js';
import './billing.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };
const sectionHead = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' };
const qty = (q) => (q === null || q === undefined ? '1' : String(q));

function Lines({ kind, doc, lines, editable, onEdit }) {
  const totals = documentTotals(lines, doc.tax_rate_bp ?? HST_RATE_BP);
  return (
    <>
      {lines.length ? (
        <ul className="billing-lines" data-testid="doc-lines">
          {lines.map((l) => {
            const body = (
              <>
                <span className="billing-line-text">{l.description}{l.tax_exempt ? <span style={muted}> · no HST</span> : null}</span>
                <span className="billing-line-qty">{qty(l.quantity)} × {moneyText(l.unit_cents)}</span>
                <span className="billing-line-amount">{moneyText(lineAmount(l))}</span>
              </>
            );
            return (
              <li key={l.id} data-line-id={l.id}>
                {editable ? <button type="button" className="billing-line" onClick={() => onEdit(l)} aria-label={`Edit ${l.description}`}>{body}</button> : <div className="billing-line">{body}</div>}
                <Badges record={l} />
              </li>
            );
          })}
        </ul>
      ) : <p style={{ ...muted, margin: 0 }}>No lines yet.</p>}
      <dl className="billing-totals" data-testid="doc-totals">
        <dt>Subtotal</dt><dd>{moneyText(totals.subtotal)}</dd>
        <dt>{`${(doc.tax_rate_bp ?? HST_RATE_BP) === 500 ? 'GST' : 'HST'} ${rateText(totals.rateBp)}${totals.exempt ? ` on ${moneyText(totals.taxable)}` : ''}`}</dt><dd>{moneyText(totals.tax)}</dd>
        <dt className="billing-total">{kind === 'credit_note' ? 'Total credit' : 'Total'}</dt><dd className="billing-total" data-testid="doc-total">{moneyText(totals.total)}</dd>
      </dl>
    </>
  );
}

function DocumentScreen({ kind, id }) {
  const { data, loading } = useBillingData();
  const today = useToday();
  const navigate = useNavigate();
  const sync = useSyncStatus();
  const settingsData = useServerData('/api/billing/settings', { everyMs: 0 });
  const offline = settingsData.offline || sync?.phase === 'offline';
  const [sheet, setSheet] = useState(null);
  const { busy, error, run } = useAction();
  const made = useRef(null);

  const doc = data?.[{ quote: 'quotesById', invoice: 'invoicesById', credit_note: 'creditNotesById' }[kind]]?.get(id) ?? null;
  const lines = useMemo(() => (doc ? linesOf(kind, id, kind === 'quote' ? data.quoteLines : kind === 'invoice' ? data.invoiceLines : data.creditNoteLines) : []), [data, doc, kind, id]);
  if (!data) return <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>;
  if (!doc) {
    return (
      <Card>
        <EmptyState title={`This ${KIND_LABELS[kind].toLowerCase()} isn’t on this device`}>
          It may have been deleted, or this device hasn’t downloaded it yet. <Link to="/costs/billing">Back to billing</Link>
        </EmptyState>
      </Card>
    );
  }
  const business = data.businessesById.get(doc.business_id);
  const settings = settingsData.data?.businesses?.find((b) => b.businessId === doc.business_id) ?? null;
  const payments = kind === 'invoice' ? data.payments.filter((p) => p.invoice_id === id).sort((a, b) => String(a.paid_on).localeCompare(String(b.paid_on))) : [];
  const credits = kind === 'invoice' ? data.creditNotes.filter((c) => c.invoice_id === id) : [];
  const status = docStatus(kind, doc, { payments, creditNotes: credits, today });
  const draft = doc.status === 'draft';
  const client = doc.client_id ? data.clientsById.get(doc.client_id) : null;
  const lead = doc.lead_id ? data.leadsById.get(doc.lead_id) : null;
  const invoice = kind === 'credit_note' ? data.invoicesById.get(doc.invoice_id) : null;
  const quote = kind === 'invoice' && doc.quote_id ? data.quotesById.get(doc.quote_id) : null;
  const madeInvoice = kind === 'quote' ? data.invoices.find((i) => i.quote_id === id) : null;
  const email = contactFor(data.contacts, { clientId: doc.client_id ?? invoice?.client_id, accountId: doc.account_id ?? invoice?.account_id })?.email ?? lead?.email ?? null;
  const close = () => setSheet(null);
  const label = KIND_LABELS[kind];

  const makeFrom = (target, plan) => run(async () => {
    made.current ??= docIds(newId, plan.lines.length);
    const newIdOf = await createDocument(store, target, plan, made.current);
    navigate(docPath(target, newIdOf));
  });
  const copyInvoiceLines = () => run(async () => {
    const src = linesOf('invoice', doc.invoice_id, data.invoiceLines);
    for (const [i, l] of src.entries()) {
      await store.create(LINE_ENTITY.credit_note, { [LINE_PARENT.credit_note]: id, position: i, description: l.description, quantity: l.quantity ?? null, unit_cents: l.unit_cents, tax_exempt: Boolean(l.tax_exempt) });
    }
  });

  return (
    <div className="billing-doc" data-testid="doc-page" data-kind={kind} data-status={doc.status}>
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'grid', gap: 'var(--space-2)', minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', overflowWrap: 'anywhere' }} data-testid="doc-number">{label} {doc.number ?? '(draft)'}</h1>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                <span data-testid="doc-status"><Badge tone={status.tone}>{status.label}</Badge></span>
                <BusinessChip business={business} />
                <Badges record={doc} />
              </div>
            </div>
            {draft ? <Button onClick={() => setSheet({ kind: 'details' })}><Icon name="edit" size={16} />Details</Button> : null}
          </div>
          <div style={{ display: 'grid', gap: 2 }}>
            <span style={muted}>{kind === 'quote' ? 'For' : 'To'}</span>
            <strong data-testid="doc-to">{doc.to_name || '— (add who it’s for in Details)'}</strong>
            {doc.to_lines ? <span style={{ ...muted, whiteSpace: 'pre-line' }}>{doc.to_lines}</span> : null}
          </div>
          {doc.title || doc.reason ? <p style={{ margin: 0, fontWeight: 600 }}>{doc.title ?? `Reason: ${doc.reason}`}</p> : null}
          <p style={{ ...muted, margin: 0 }}>
            {client ? <>Client: <Link to={`/crm/clients/${client.id}`}>{client.name}</Link>. </> : null}
            {lead ? <>Lead: <Link to={`/crm/leads/${lead.id}`}>{lead.name}</Link>. </> : null}
            {quote ? <>From quote <Link to={docPath('quote', quote.id)}>{quote.number}</Link>. </> : null}
            {invoice ? <>For invoice <Link to={docPath('invoice', invoice.id)}>{invoice.number ?? 'draft'}</Link>. </> : null}
            {doc.sent_on ? `Sent ${formatDate(doc.sent_on)}. ` : null}
            {doc.valid_until ? `Valid until ${formatDate(doc.valid_until)}. ` : null}
            {doc.issue_date ? `Issued ${formatDate(doc.issue_date)}. ` : null}
            {doc.due_date && doc.status === 'issued' && kind === 'invoice' ? `Due ${formatDate(doc.due_date)}. ` : null}
            {doc.decided_on ? `${QUOTE_STATUS_LABELS[doc.status]} ${formatDate(doc.decided_on)}${doc.declined_reason ? ` (${LOST_LABELS[doc.declined_reason]}${doc.decided_note ? `: ${doc.decided_note}` : ''})` : ''}. ` : null}
            {doc.void_on ? `Void since ${formatDate(doc.void_on)}: ${doc.void_reason}. ` : null}
          </p>
          <div className="billing-actions" role="group" aria-label={`What to do with this ${label.toLowerCase()}`}>
            {draft ? (
              <>
                <Button variant="primary" disabled={offline} onClick={() => setSheet({ kind: 'approve' })}>
                  <Icon name="check" size={16} />{kind === 'quote' ? 'Approve and send…' : 'Approve and issue…'}
                </Button>
                {offline ? null : <a className="billing-link-button" href={pdfUrl(kind, id, { today })} target="_blank" rel="noreferrer">Look at the PDF</a>}
              </>
            ) : (
              <>
                <Button variant={kind === 'quote' && doc.status !== 'sent' ? 'secondary' : 'primary'} disabled={offline} onClick={() => setSheet({ kind: 'email' })}><Icon name="mail" size={16} />Email it…</Button>
                {offline ? null : <a className="billing-link-button" href={pdfUrl(kind, id)} target="_blank" rel="noreferrer" data-testid="doc-pdf">PDF</a>}
              </>
            )}
            {kind === 'quote' && doc.status === 'sent' ? (
              <>
                <Button variant="primary" onClick={() => setSheet({ kind: 'accept' })}>Accepted…</Button>
                <Button onClick={() => setSheet({ kind: 'decline' })}>Declined…</Button>
              </>
            ) : null}
            {kind === 'quote' && doc.status === 'accepted' ? (
              madeInvoice
                ? <Link to={docPath('invoice', madeInvoice.id)} data-testid="quote-invoice">Invoice {madeInvoice.number ?? '(draft)'} ›</Link>
                : <Button variant="primary" disabled={busy} onClick={() => { const p = invoiceFromQuote(doc, lines, { lead }); return p.problem ? null : makeFrom('invoice', p); }}>Make the invoice</Button>
            ) : null}
            {kind === 'invoice' && doc.status === 'issued' ? (
              <>
                {status.state.owing > 0 ? <Button variant="primary" onClick={() => setSheet({ kind: 'payment' })}>Record a payment…</Button> : null}
                <Button disabled={busy} onClick={() => makeFrom('credit_note', creditNoteFor(doc))}>Credit note…</Button>
                {!payments.length && !credits.some((c) => c.status === 'issued') ? <Button variant="ghost" disabled={offline} onClick={() => setSheet({ kind: 'void' })}>Void…</Button> : null}
              </>
            ) : null}
          </div>
          {offline ? <p style={{ ...muted, margin: 0 }}>Offline: the draft saves on this device; approving and the PDF need a connection to the suite.</p> : null}
          {kind === 'quote' && doc.status === 'accepted' && !madeInvoice && invoiceFromQuote(doc, lines, { lead }).problem ? <Notice tone="warn">{invoiceFromQuote(doc, lines, { lead }).problem}</Notice> : null}
          {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
          <RecordSync record={doc} what={label.toLowerCase()} />
        </div>
      </Card>

      <div className="billing-grid">
        <Card>
          <div style={sectionHead}>
            <h2 style={h2}>Lines</h2>
            {draft ? <TextButton onClick={() => setSheet({ kind: 'line' })}><Icon name="plus" size={14} />Add a line</TextButton> : null}
          </div>
          {kind === 'credit_note' && draft && !lines.length && invoice ? (
            <p style={{ margin: '0 0 var(--space-2)' }}><TextButton style={{ padding: 0 }} onClick={copyInvoiceLines}>Copy the invoice’s lines</TextButton> <span style={muted}>then change or take off what isn’t credited.</span></p>
          ) : null}
          <Lines kind={kind} doc={doc} lines={lines} editable={draft} onEdit={(l) => setSheet({ kind: 'line', record: l })} />
          {doc.notes ? <p style={{ whiteSpace: 'pre-wrap', margin: 'var(--space-3) 0 0' }}><span style={muted}>Notes: </span>{doc.notes}</p> : null}
          {doc.terms ? <p style={{ whiteSpace: 'pre-wrap', margin: 'var(--space-2) 0 0' }}><span style={muted}>Terms: </span>{doc.terms}</p> : null}
        </Card>
        {kind === 'invoice' && !draft ? (
          <Card>
            <div style={sectionHead}><h2 style={h2}>Payments</h2><span style={muted}>{moneyText(status.state.paid)} of {moneyText(status.state.total)}</span></div>
            {payments.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="payments">
                {payments.map((p) => (
                  <li key={p.id} className="billing-payment">
                    <span><strong>{moneyText(p.amount_cents)}</strong> · {formatDate(p.paid_on)}{p.method ? ` · ${PAYMENT_METHOD_LABELS[p.method]}` : ''}{p.note ? ` · ${p.note}` : ''} <Badges record={p} /></span>
                    <TextButton onClick={() => setSheet({ kind: 'unpay', payment: p })} aria-label={`Take off the payment of ${moneyText(p.amount_cents)}`}>Take off</TextButton>
                  </li>
                ))}
              </ul>
            ) : <p style={{ ...muted, margin: 0 }}>No payment yet.</p>}
            {credits.length ? (
              <p style={{ margin: 'var(--space-3) 0 0' }}>
                Credit notes: {credits.map((c, i) => <span key={c.id}>{i ? ', ' : ''}<Link to={docPath('credit_note', c.id)}>{c.number ?? 'draft'}</Link>{c.status === 'issued' ? ` (${moneyText(c.total_cents)})` : ''}</span>)}
              </p>
            ) : null}
            {status.state.overpaid > 0 ? <Notice tone="warn">Paid {moneyText(status.state.overpaid)} more than it owes: give it back, or keep it as credit (the accountant decides).</Notice> : null}
            {sheet?.kind === 'unpay' ? (
              <Notice tone="warn">
                <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
                  <span>Take off the payment of {moneyText(sheet.payment.amount_cents)} ({formatDate(sheet.payment.paid_on)})? Only for a mistake: it stops counting in sales.</span>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <Button variant="danger" disabled={busy} onClick={() => run(() => store.remove('invoice_payment', sheet.payment.id)).then(close)}>Take it off</Button>
                    <Button variant="ghost" onClick={close}>Keep it</Button>
                  </div>
                </div>
              </Notice>
            ) : null}
          </Card>
        ) : null}
      </div>

      {draft ? (
        <p style={{ margin: 0 }}>
          <TextButton style={{ color: 'var(--danger)', padding: 0 }} onClick={() => setSheet({ kind: 'delete' })}>Delete this draft…</TextButton>
        </p>
      ) : null}
      {sheet?.kind === 'delete' ? (
        <Notice tone="warn">
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <span>Delete this draft? It has no number yet, so nothing is lost but what it says.</span>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <Button variant="danger" disabled={busy} onClick={() => run(() => store.remove(DOC_ENTITY[kind], id)).then((ok) => ok && navigate('/costs/billing', { replace: true }))}>Delete</Button>
              <Button variant="ghost" onClick={close}>Keep it</Button>
            </div>
          </div>
        </Notice>
      ) : null}

      {sheet?.kind === 'line' ? <LineSheet kind={kind} docId={id} record={sheet.record ?? null} lines={lines} onClose={close} /> : null}
      {sheet?.kind === 'details' ? <DetailsSheet kind={kind} record={doc} settings={settings} onClose={close} /> : null}
      {sheet?.kind === 'approve' ? (
        <ApproveSheet kind={kind} doc={doc} lines={lines} settings={settings} today={today} offline={offline} onClose={close} onApproved={() => setSheet({ kind: 'email' })} />
      ) : null}
      {sheet?.kind === 'email' && doc.number ? <EmailSheet kind={kind} doc={doc} email={email} business={business} settings={settings} onClose={close} /> : null}
      {sheet?.kind === 'accept' ? <AcceptSheet quote={doc} data={data} onClose={close} /> : null}
      {sheet?.kind === 'decline' ? <DeclineSheet quote={doc} data={data} onClose={close} /> : null}
      {sheet?.kind === 'payment' ? <PaymentSheet invoice={doc} owing={status.state.owing} onClose={close} /> : null}
      {sheet?.kind === 'void' ? <VoidSheet invoice={doc} offline={offline} onClose={close} /> : null}
    </div>
  );
}

export default function DocumentPage({ kind }) {
  const { id } = useParams();
  return (
    <>
      <MoneyTabs />
      <p style={{ margin: '0 0 var(--space-3)' }}><Link to={`/costs/billing?tab=${kind}`}>← Billing</Link></p>
      <DocumentScreen key={id} kind={kind} id={id} />
    </>
  );
}
