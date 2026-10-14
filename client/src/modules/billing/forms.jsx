// The billing sheets (D17/D18): a new quote or invoice (for a client or a lead, from a CRM service), a line, a
// document's details, approving a draft (online: number + PDF), emailing it (the person sends it — the suite never
// does), accepting a quote (a lead's: D8's Won… sheet, so the client is made once), declining one (the lead lost
// with the reason), recording a payment, voiding an invoice. Writes go through the offline store, except approving
// and voiding (the server's).
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { newId } from '@suite/shared/ids';
import { LOST_REASONS, isOpenLead } from '@suite/shared/leads';
import { PAYMENT_METHODS, billingAllowed, BILLING_BLOCKED, KIND_LABELS, moneyText, rateText } from '@suite/shared/billing';
import { TextField, SelectField, TextAreaField, CheckboxField, Notice, Button, Sheet } from '../../ui/index.js';
import { formatDate, localDate } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { api } from '../../api/client.js';
import { FormSheet, useAction } from '../crm/parts.jsx';
import { useForm } from '../crm/forms.jsx';
import { fold, centsToInput } from '../crm/logic.js';
import { WinSheet } from '../crm/leadForms.jsx';
import { stageChange, saveStageChange, LOST_LABELS, STAGE_LABELS } from '../crm/leads.js';
import {
  lineForm, detailsForm, DETAIL_FIELDS, TAX_RATES, PAYMENT_METHOD_LABELS, newDocument, createDocument, docIds, docPath, nextPosition,
  paymentFields, approveDocument, approval, pdfUrl, emailFor, declineFields,
} from './logic.js';
import { LINE_ENTITY, LINE_PARENT, DOC_ENTITY } from '@suite/shared/billing';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };

// ---- a new quote or invoice ----------------------------------------------------------------------------------

/** Find a client by typing (thousands of clients: never one long select). */
function ClientPicker({ clients, value, onChange, error }) {
  const [q, setQ] = useState('');
  const chosen = clients.find((c) => c.id === value) ?? null;
  const words = fold(q).split(/\s+/).filter(Boolean);
  const found = words.length ? clients.filter((c) => c.status !== 'closed' && words.every((w) => fold(c.name).includes(w))).slice(0, 8) : [];
  if (chosen) {
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Client</span>
        <span data-testid="doc-client"><strong>{chosen.name}</strong> <button type="button" className="crm-link-button" onClick={() => onChange('')}>Change</button></span>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <TextField id="doc-client-find" label="Client" placeholder="Type a name" value={q} onChange={(e) => setQ(e.target.value)} error={error} autoComplete="off" />
      {found.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }} data-testid="doc-client-results">
          {found.map((c) => (
            <li key={c.id}><button type="button" className="crm-link-button" style={{ minHeight: 'var(--tap)', textAlign: 'left' }} onClick={() => onChange(c.id)}>{c.name}</button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A new quote or invoice. `initial`: { kind, businessId, clientId, accountId, relationshipId, serviceId, leadId } (from a
 * lead, a client's relationship or service). Saves the draft and its first line (from the service), then opens it.
 */
export function NewDocumentSheet({ kind, initial = {}, data, onClose }) {
  const navigate = useNavigate();
  const businesses = data.businesses.filter((b) => billingAllowed(b));
  const [v, setV] = useState(() => ({
    businessId: initial.businessId ?? (businesses.length === 1 ? businesses[0].id : ''), clientId: initial.clientId ?? '', accountId: initial.accountId ?? '',
    relationshipId: initial.relationshipId ?? '', serviceId: initial.serviceId ?? '', leadId: initial.leadId ?? '', title: '',
  }));
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  const ids = useRef(null);
  const lead = v.leadId ? data.leadsById.get(v.leadId) : null;
  const accounts = data.accounts.filter((a) => a.client_id === v.clientId);
  const rels = data.relationships.filter((r) => r.account_id === v.accountId && (!v.businessId || r.business_id === v.businessId));
  const services = data.services.filter((s) => s.relationship_id === v.relationshipId && !['done', 'cancelled'].includes(s.status));
  const set = (k) => (x) => setV((cur) => ({ ...cur, [k]: x?.target ? x.target.value : x }));
  const blocked = initial.businessId && BILLING_BLOCKED[initial.businessId];
  return (
    <FormSheet
      title={kind === 'quote' ? 'New quote' : 'New invoice'}
      testId="new-doc-form"
      saveLabel="Make the draft"
      onClose={onClose}
      busy={busy}
      error={error}
      dirty
      onSave={async () => {
        const plan = newDocument({ ...v, kind }, data);
        setProblems(plan.problems);
        if (Object.keys(plan.problems).length) return;
        ids.current ??= docIds(newId, plan.lines.length);
        let id = null;
        if (await run(async () => { id = await createDocument(store, kind, plan, ids.current); })) {
          onClose();
          navigate(docPath(kind, id));
        }
      }}
    >
      {blocked ? <Notice tone="warn">{blocked}</Notice> : null}
      <SelectField
        id="doc-business"
        label="From (our business)"
        value={v.businessId}
        onChange={set('businessId')}
        error={problems.businessId}
        options={[{ value: '', label: 'Pick one' }, ...businesses.map((b) => ({ value: b.id, label: b.name }))]}
      />
      {lead && !v.clientId ? (
        <p style={{ margin: 0 }} data-testid="doc-lead">For the lead <strong>{lead.name}</strong> ({STAGE_LABELS[lead.stage]}). Sending it moves the lead to Quoted.</p>
      ) : (
        <ClientPicker clients={data.clients} value={v.clientId} onChange={(id) => setV((cur) => ({ ...cur, clientId: id, accountId: '', relationshipId: '', serviceId: '' }))} error={problems.clientId} />
      )}
      {v.clientId && accounts.length ? (
        <SelectField id="doc-account" label="Their business (account)" value={v.accountId} onChange={(x) => setV((cur) => ({ ...cur, accountId: x, relationshipId: '', serviceId: '' }))}
          options={[{ value: '', label: accounts.length === 1 ? accounts[0].name : 'Pick one (optional)' }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]} />
      ) : null}
      {v.accountId && rels.length ? (
        <SelectField id="doc-relationship" label="For the work" value={v.relationshipId} onChange={(x) => setV((cur) => ({ ...cur, relationshipId: x, serviceId: '' }))}
          options={[{ value: '', label: '—' }, ...rels.map((r) => ({ value: r.id, label: `${data.businessesById.get(r.business_id)?.name ?? ''} · ${r.kind}` }))]} />
      ) : null}
      {kind === 'invoice' && services.length ? (
        <SelectField id="doc-service" label="Bill a service" hint="Its price becomes the first line" value={v.serviceId} onChange={set('serviceId')}
          options={[{ value: '', label: '—' }, ...services.map((s) => ({ value: s.id, label: s.name }))]} />
      ) : null}
      <TextField id="doc-title" label="What it’s for (title)" value={v.title} onChange={set('title')} maxLength={300} placeholder={kind === 'quote' ? 'New website' : 'Website, October'} />
      <p style={{ ...muted, margin: 0 }}>It starts as a draft: write it here (offline too); it gets its number when you approve it.</p>
    </FormSheet>
  );
}

// ---- a line, the details ---------------------------------------------------------------------------------------

export function LineSheet({ kind, docId, record = null, lines = [], onClose }) {
  const [parent] = useState(() => ({ [LINE_PARENT[kind]]: docId, position: nextPosition(lines) }));
  const f = useForm(lineForm, record, { entity: LINE_ENTITY[kind], parent, onDone: onClose });
  const { v, set, setV, problems } = f;
  return (
    <FormSheet
      title={record ? 'Edit line' : 'Add a line'}
      testId="line-form"
      onClose={onClose}
      onSave={f.save}
      busy={f.busy}
      error={f.error}
      dirty={f.dirty}
      onDelete={record ? async () => { if (await f.run(() => store.remove(LINE_ENTITY[kind], record.id))) onClose(); } : null}
      deleteWarning="Take this line off?"
    >
      <TextAreaField id="line-description" label="What it is" value={v.description} onChange={set('description')} rows={2} maxLength={2000} error={problems.description} autoFocus={!record} />
      <div style={row}>
        <TextField id="line-quantity" label="Quantity" inputMode="decimal" value={v.quantity} onChange={set('quantity')} error={problems.quantity} />
        <TextField id="line-price" label="Price of one ($)" inputMode="decimal" value={v.price} onChange={set('price')} error={problems.price} hint="A discount: -50" />
      </div>
      <CheckboxField id="line-exempt" label="No HST on this line" hint="For something HST doesn’t apply to (a resold domain billed at cost…)" checked={v.tax_exempt} onChange={(on) => setV((cur) => ({ ...cur, tax_exempt: on }))} />
    </FormSheet>
  );
}

export function DetailsSheet({ kind, record, settings, onClose }) {
  const fields = DETAIL_FIELDS[kind];
  const form = useMemo(() => ({ ...detailsForm, toFields: (x) => { const r = detailsForm.toFields(x); return { problems: r.problems, fields: Object.fromEntries(fields.map((k) => [k, r.fields[k]])) }; } }), [fields]);
  const f = useForm(form, record, { entity: DOC_ENTITY[kind], onDone: onClose });
  const { v, set, problems } = f;
  const has = (k) => fields.includes(k);
  const rates = TAX_RATES.some((r) => String(r.value) === v.tax_rate_bp) ? TAX_RATES : [...TAX_RATES, { value: Number(v.tax_rate_bp), label: rateText(Number(v.tax_rate_bp)) }];
  return (
    <FormSheet title="Details" testId="details-form" onClose={onClose} onSave={f.save} busy={f.busy} error={f.error} dirty={f.dirty}>
      <TextField id="doc-to-name" label="To (their business or name)" value={v.to_name} onChange={set('to_name')} maxLength={200} error={problems.to_name} />
      <TextAreaField id="doc-to-lines" label="Their address, contact, email" value={v.to_lines} onChange={set('to_lines')} rows={3} maxLength={1000} />
      {has('reason') ? <TextField id="doc-reason" label="Why this credit" value={v.reason} onChange={set('reason')} maxLength={500} /> : null}
      {has('title') ? <TextField id="doc-title-edit" label="Title" value={v.title} onChange={set('title')} maxLength={300} /> : null}
      <div style={row}>
        {has('valid_until') ? <TextField id="doc-valid" label="Valid until" type="date" value={v.valid_until} onChange={set('valid_until')} hint={`Empty: ${settings?.quote_valid_days ?? 30} days after sending`} /> : null}
        {has('due_days') ? <TextField id="doc-due-days" label="Due in (days)" inputMode="numeric" value={v.due_days} onChange={set('due_days')} error={problems.due_days} hint={`Empty: ${settings?.invoice_due_days ?? 30}; 0 = on receipt`} /> : null}
        <SelectField id="doc-tax" label="Tax" value={v.tax_rate_bp} onChange={set('tax_rate_bp')} options={rates.map((r) => ({ value: String(r.value), label: r.label }))} />
      </div>
      <TextAreaField id="doc-notes" label="Notes (printed)" value={v.notes} onChange={set('notes')} rows={3} maxLength={5000} />
      {has('terms') ? <TextAreaField id="doc-terms" label="Terms (printed)" value={v.terms} onChange={set('terms')} rows={3} maxLength={5000} hint={(kind === 'quote' ? settings?.quote_terms : settings?.invoice_terms) ? 'Empty: the business’s usual terms' : undefined} /> : null}
    </FormSheet>
  );
}

// ---- approving a draft (online) ----------------------------------------------------------------------------------

export function ApproveSheet({ kind, doc, lines, settings, today, offline, onClose, onApproved }) {
  const seen = useMemo(() => approval(kind, doc, lines), [kind, doc, lines]);
  const { busy, error, run } = useAction();
  const label = KIND_LABELS[kind].toLowerCase();
  const verb = kind === 'quote' ? 'send' : 'issue';
  const next = settings?.next?.[kind];
  return (
    <Sheet
      title={`Approve and ${verb} this ${label}`}
      testId="approve-form"
      onClose={onClose}
      footer={(
        <>
          <Button
            variant="primary"
            disabled={busy || offline || seen.problems.length > 0}
            onClick={() => run(async () => {
              const out = await approveDocument(store, api, kind, doc.id, { fingerprint: seen.fingerprint, today });
              onApproved?.(out);
            })}
          >
            {kind === 'quote' ? 'Approve and send' : 'Approve and issue'}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </>
      )}
    >
      {seen.problems.length ? <Notice tone="warn"><span data-testid="approve-problems">Not ready: {seen.problems.join('. ')}.</span></Notice> : null}
      <p style={{ margin: 0 }}>
        To <strong>{doc.to_name || '—'}</strong> · {seen.lines.length} line{seen.lines.length === 1 ? '' : 's'} · total <strong data-testid="approve-total">{moneyText(seen.totals.total)}</strong>
        {' '}({moneyText(seen.totals.subtotal)} + {moneyText(seen.totals.tax)} tax)
      </p>
      <p style={{ margin: 0 }}>
        <a href={pdfUrl(kind, doc.id, { today })} target="_blank" rel="noreferrer">Look at the PDF first</a> (a draft copy).
      </p>
      <p style={{ ...muted, margin: 0 }}>
        Approving gives it its number{next ? ` (${next})` : ''} and keeps its PDF for good: after that what it says can’t change.
        {kind === 'quote' ? ' It is marked sent' : ' It is issued'} — the suite doesn’t email it: you send the PDF yourself next.
        {kind === 'quote' && doc.lead_id ? ' Its lead moves to Quoted.' : ''}
      </p>
      {offline ? <Notice tone="warn">Needs a connection to the suite (it gives the number).</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Sheet>
  );
}

// ---- emailing it (the person does) -------------------------------------------------------------------------------

/**
 * Send the PDF yourself: share it (a phone's share sheet, with the file — straight into Mail), or download it and open
 * a drafted email. The suite never sends anything. A quote or invoice is a business message they expect, so it needs no
 * email consent (CASL covers marketing).
 */
export function EmailSheet({ kind, doc, email, business, settings, onClose }) {
  const mail = emailFor(kind, doc, { business, email, settings, dueText: doc.due_date ? formatDate(doc.due_date) : null });
  const [note, setNote] = useState(null);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  const share = async () => {
    setNote(null);
    try {
      const res = await fetch(pdfUrl(kind, doc.id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('The PDF couldn’t be fetched: is the suite reachable?');
      const file = new File([await res.blob()], `${doc.number}.pdf`, { type: 'application/pdf' });
      if (!navigator.canShare({ files: [file] })) throw new Error('This device can’t share a file: download it instead');
      await navigator.share({ files: [file], title: mail.subject, text: mail.body });
    } catch (err) {
      if (err?.name !== 'AbortError') setNote(err.message);
    }
  };
  return (
    <Sheet title={`Email ${doc.number}`} testId="email-sheet" onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Done</Button>}>
      <p style={{ margin: 0 }}>The suite doesn’t send email: send it from your own mail, with the PDF attached.</p>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {canShare ? <Button variant="primary" onClick={share}>Share the PDF…</Button> : null}
        <a className="billing-link-button" href={pdfUrl(kind, doc.id, { download: true })} download={`${doc.number}.pdf`} data-testid="email-download">Download the PDF</a>
        <a className="billing-link-button" href={mail.mailto} data-testid="email-mailto">Open a drafted email</a>
      </div>
      <p style={{ ...muted, margin: 0 }}>To: {mail.to || 'no email on file — add one to their contact'} · Subject: {mail.subject}</p>
      <TextAreaField id="email-body" label="The email (copy it if you like)" value={mail.body} readOnly rows={8} />
      <p style={{ ...muted, margin: 0 }}>A {mail.label} is a business message they expect, not marketing: it needs no email consent.</p>
      {note ? <Notice tone="warn">{note}</Notice> : null}
    </Sheet>
  );
}

// ---- accepting and declining a quote -----------------------------------------------------------------------------

/**
 * Accepted: a quote for an open (or lost) lead wins the lead — D8's Won… sheet, so its client, account, contact and
 * relationship are made once (ids kept until saved), and the quote is marked accepted with them in the same save. A
 * lead already won (on the other device), or a quote for a client: just marked accepted.
 */
export function AcceptSheet({ quote, data, onClose }) {
  const lead = quote.lead_id ? data.leadsById.get(quote.lead_id) : null;
  const [day, setDay] = useState(localDate());
  const { busy, error, run } = useAction();
  const mark = (extra = {}) => store.update('quote', quote.id, { status: 'accepted', decided_on: day, ...extra });
  if (lead && lead.stage !== 'won') {
    const leadData = { ...data, businessesById: data.businessesById };
    return (
      <WinSheet
        lead={{ ...lead, kind: lead.kind ?? null }}
        data={leadData}
        title={`Accepted: ${quote.number}`}
        saveLabel="Mark accepted"
        intro={<p style={{ margin: 0 }} data-testid="accept-wins">Accepting wins the lead <strong>{lead.name}</strong>{isOpenLead(lead) ? '' : ' (it was lost)'}:</p>}
        afterWin={(plan) => mark({ client_id: plan.clientId, account_id: plan.accountId, relationship_id: plan.relationshipId })}
        onClose={onClose}
        onDone={onClose}
      />
    );
  }
  const won = lead?.stage === 'won' ? lead : null;
  return (
    <FormSheet
      title={`Accepted: ${quote.number}`}
      testId="accept-form"
      saveLabel="Mark accepted"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={async () => {
        if (await run(() => mark(won ? { client_id: won.won_client_id, relationship_id: won.won_relationship_id ?? quote.relationship_id ?? null } : {}))) onClose();
      }}
    >
      {won ? <p style={{ margin: 0 }}>The lead {won.name} is already won.</p> : null}
      <TextField id="accept-day" label="Accepted on" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      <p style={{ ...muted, margin: 0 }}>Its follow-up task finishes itself. Then make the invoice from it.</p>
    </FormSheet>
  );
}

export function DeclineSheet({ quote, data, onClose }) {
  const lead = quote.lead_id ? data.leadsById.get(quote.lead_id) : null;
  const open = isOpenLead(lead);
  const [v, setV] = useState({ reason: '', note: '', day: localDate(), lose: true });
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useAction();
  return (
    <FormSheet
      title={`Declined: ${quote.number}`}
      testId="decline-form"
      saveLabel="Mark declined"
      onClose={onClose}
      busy={busy}
      error={error}
      dirty={Boolean(v.reason || v.note)}
      onSave={async () => {
        const d = declineFields(v);
        setProblem(d.problem ?? null);
        if (d.problem) return;
        if (await run(async () => {
          await store.update('quote', quote.id, d.fields);
          if (open && v.lose) {
            const change = stageChange(lead, 'lost', { reason: v.reason, note: v.note });
            if (!change.problem) await saveStageChange(store, lead, change);
          }
        })) onClose();
      }}
    >
      <SelectField id="decline-reason" label="Why" value={v.reason} error={problem} onChange={(x) => setV({ ...v, reason: x })}
        options={[{ value: '', label: 'Pick one' }, ...LOST_REASONS.map((r) => ({ value: r, label: LOST_LABELS[r] }))]} />
      <TextField id="decline-note" label="A few words (optional)" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={2000} />
      <TextField id="decline-day" label="Declined on" type="date" value={v.day} onChange={(e) => setV({ ...v, day: e.target.value })} />
      {open ? <CheckboxField id="decline-lose" label={`The lead ${lead.name} is lost too`} checked={v.lose} onChange={(on) => setV({ ...v, lose: on })} /> : null}
    </FormSheet>
  );
}

// ---- payments and void ---------------------------------------------------------------------------------------------

export function PaymentSheet({ invoice, owing, onClose }) {
  const [v, setV] = useState({ amount: owing > 0 ? centsToInput(owing) : '', paid_on: localDate(), method: 'etransfer', note: '' });
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  const saved = useRef(null);
  return (
    <FormSheet
      title={`Payment on ${invoice.number}`}
      testId="payment-form"
      onClose={onClose}
      busy={busy}
      error={error}
      dirty
      onSave={async () => {
        const p = paymentFields(v, invoice.id, { today: localDate(), issueDate: invoice.issue_date });
        setProblems(p.problems);
        if (Object.keys(p.problems).length) return;
        if (await run(async () => { saved.current ??= await store.create('invoice_payment', p.fields); })) onClose();
      }}
    >
      <div style={row}>
        <TextField id="pay-amount" label="Amount ($)" inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} error={problems.amount} autoFocus />
        <TextField id="pay-day" label="Paid on" type="date" value={v.paid_on} onChange={(e) => setV({ ...v, paid_on: e.target.value })} error={problems.paid_on} />
      </div>
      <SelectField id="pay-method" label="How" value={v.method} onChange={(x) => setV({ ...v, method: x })} options={PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))} />
      <TextField id="pay-note" label="Note (optional)" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={500} />
      {paymentFields(v, invoice.id, { issueDate: invoice.issue_date }).warning ? <Notice tone="warn"><span data-testid="pay-warning">{paymentFields(v, invoice.id, { issueDate: invoice.issue_date }).warning}</span></Notice> : null}
      <p style={{ ...muted, margin: 0 }}>It counts in sales on the day it was paid (Money → Sales and the overview).</p>
    </FormSheet>
  );
}

export function VoidSheet({ invoice, offline, onClose }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <FormSheet
      title={`Void ${invoice.number}`}
      testId="void-form"
      saveLabel="Void it"
      onClose={onClose}
      busy={busy || offline}
      error={error}
      onSave={async () => {
        if (await run(async () => {
          await api.post(`/api/billing/invoices/${invoice.id}/void`, { reason, today: localDate() });
          await store.syncNow();
        })) onClose();
      }}
    >
      <p style={{ margin: 0 }}>For a mistake (sent twice, the wrong client). It keeps its number and its PDF; it no longer counts as owed. If they paid, issue a credit note instead.</p>
      <TextField id="void-reason" label="Why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      {offline ? <Notice tone="warn">Needs a connection to the suite.</Notice> : null}
    </FormSheet>
  );
}
