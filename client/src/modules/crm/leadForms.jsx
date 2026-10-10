// D8: the lead sheets — add/edit a lead (only what changed is sent), lose one (with its reason), win one
// (the client, account, contact and relationship made in one go, offline, with ids made once so a retry
// never makes a second client; a likely duplicate client is offered first), and a note or call on a lead
// with its optional next step. Every write goes through the offline store.
import { useMemo, useRef, useState } from 'react';
import { RELATIONSHIP_KINDS } from '@suite/shared/crm';
import { LEAD_SOURCES, LOST_REASONS, LEAD_VALUE_PERIODS } from '@suite/shared/leads';
import { newId } from '@suite/shared/ids';
import { TextField, SelectField, TextAreaField, Notice } from '../../ui/index.js';
import { localDate, toDateTimeInput } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { FormSheet, useAction } from './parts.jsx';
import { useForm } from './forms.jsx';
import { Blocked } from '../planner/forms.jsx';
import { activityAt } from './formFields.js';
import { KIND_LABELS, PERIOD_LABELS, pickableBusinesses, defaultKindFor, textOrNull } from './logic.js';
import {
  leadForm, newLeadFields, stageChange, saveStageChange, SOURCE_LABELS, LOST_LABELS, LEAD_ACTIVITY_LABELS,
  leadDuplicate, winIds, planWin, applyWin, leadNextStepFields,
} from './leads.js';

const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };
const opts = (values, labels) => values.map((v) => ({ value: v, label: labels[v] ?? v }));
const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

// ---- add / edit ---------------------------------------------------------------------------------

/**
 * A lead's details. `initial` pre-fills a new one (from the inbox, the cross-sell list: name, notes,
 * source, client and account). New leads start at stage `lead`.
 */
export function LeadForm({ record = null, initial = null, businesses, clientsById = new Map(), accountsById = new Map(), onClose, onDone, onDeleted, guard = null, onSaved = null }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const start = record ? null : { owner: me, ...initial };
  const [parent] = useState(() => newLeadFields({}));
  const f = useForm(leadForm, record, { entity: 'lead', parent, onDone, initial: start, guard, onSaved });
  const { v, set, setV, problems } = f;
  const client = v.client_id ? clientsById.get(v.client_id) : null;
  const account = v.account_id ? accountsById.get(v.account_id) : null;
  const pickBusiness = (id) => setV((cur) => ({ ...cur, business_id: id, kind: cur.kind || defaultKindFor(id) || '' }));
  return (
    <FormSheet
      title={record ? 'Edit lead' : 'New lead'}
      testId="lead-form"
      onClose={onClose}
      onSave={f.save}
      busy={f.busy}
      error={f.error}
      dirty={f.dirty}
      onDelete={record ? async () => { if (await f.run(() => store.remove('lead', record.id))) onDeleted?.(); } : null}
      deleteWarning="Delete this lead? Only for a mistake: a lead that went nowhere is Lost (with why)."
    >
      <Blocked blocked={f.blocked} />
      <TextField id="lead-name" label="Who (their business, or the person)" value={v.name} onChange={set('name')} error={problems.name} maxLength={200} autoFocus={!record} />
      {client ? (
        <Notice tone="info">
          <span data-testid="lead-form-client">A current client: <strong>{client.name}</strong>{account ? ` · ${account.name}` : ''}. Winning adds the service there.</span>{' '}
          <button type="button" className="crm-link-button" onClick={() => setV((cur) => ({ ...cur, client_id: '', account_id: '' }))}>Not a current client</button>
        </Notice>
      ) : null}
      <div style={row}>
        <TextField id="lead-contact" label="Contact person" value={v.contact_name} onChange={set('contact_name')} maxLength={200} />
        <TextField id="lead-email" label="Email" type="email" inputMode="email" value={v.email} onChange={set('email')} autoComplete="off" />
        <TextField id="lead-phone" label="Phone" type="tel" inputMode="tel" value={v.phone} onChange={set('phone')} autoComplete="off" />
      </div>
      <div style={row}>
        <SelectField
          id="lead-business"
          label="For our business"
          value={v.business_id}
          onChange={pickBusiness}
          error={problems.business_id}
          options={[{ value: '', label: 'Pick one' }, ...pickableBusinesses(businesses, record?.business_id ?? null).map((b) => ({ value: b.id, label: b.name }))]}
        />
        <SelectField id="lead-kind" label="What we’d do" value={v.kind} onChange={set('kind')} options={[{ value: '', label: 'Not sure yet' }, ...opts(RELATIONSHIP_KINDS, KIND_LABELS)]} />
        <SelectField id="lead-source" label="Came from" value={v.source} onChange={set('source')} options={[{ value: '', label: '—' }, ...opts(LEAD_SOURCES, SOURCE_LABELS)]} />
      </div>
      <div style={row}>
        <TextField id="lead-value" label="Estimated value ($)" inputMode="decimal" value={v.value} onChange={set('value')} error={problems.value} />
        <SelectField id="lead-period" label="Per" value={v.value_period} onChange={set('value_period')} options={opts(LEAD_VALUE_PERIODS, PERIOD_LABELS)} />
        <TextField id="lead-currency" label="Currency" value={v.currency} onChange={set('currency')} error={problems.currency} maxLength={3} />
      </div>
      <SelectField
        id="lead-owner"
        label="Whose lead"
        value={v.owner}
        onChange={set('owner')}
        options={[{ value: 'owner', label: me === 'owner' ? 'Mine' : 'My partner’s' }, { value: 'partner', label: me === 'partner' ? 'Mine' : 'My partner’s' }, { value: 'shared', label: 'Shared' }]}
      />
      <TextAreaField id="lead-notes" label="Notes" value={v.notes} onChange={set('notes')} rows={3} maxLength={20000} />
    </FormSheet>
  );
}

// ---- lost --------------------------------------------------------------------------------------------

export function LostSheet({ lead, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useAction();
  return (
    <FormSheet
      title={`Lost: ${lead.name}`}
      testId="lost-form"
      saveLabel="Mark lost"
      onClose={onClose}
      dirty={Boolean(reason || note)}
      busy={busy}
      error={error}
      onSave={async () => {
        const change = stageChange(lead, 'lost', { reason: reason || null, note });
        setProblem(change.problem ?? null);
        if (change.problem) return;
        if (await run(() => saveStageChange(store, lead, change))) onDone?.();
      }}
    >
      <SelectField id="lost-reason" label="Why" value={reason} onChange={setReason} error={problem} options={[{ value: '', label: 'Pick a reason' }, ...opts(LOST_REASONS, LOST_LABELS)]} />
      <TextField id="lost-note" label={reason === 'other' ? 'What happened' : 'A few words (optional)'} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
    </FormSheet>
  );
}

// ---- won ---------------------------------------------------------------------------------------------

// A win's ids are made once per lead and kept (this device) until it is saved: a retry after a failure
// part-way — even after a reload — uses the same ones, so it never makes a second client.
const WIN_KEY = (leadId) => `suite.crm.winIds.${leadId}`;
function storedWinIds(leadId) {
  try {
    const kept = JSON.parse(localStorage.getItem(WIN_KEY(leadId)) ?? 'null');
    if (kept?.client) return kept;
  } catch { /* none kept */ }
  const ids = winIds(newId);
  try { localStorage.setItem(WIN_KEY(leadId), JSON.stringify(ids)); } catch { /* best effort: this session still reuses them */ }
  return ids;
}
const forgetWinIds = (leadId) => { try { localStorage.removeItem(WIN_KEY(leadId)); } catch { /* fine */ } };

/**
 * Win a lead. A lead for a current client adds the service there (pick the account, or a new one); a
 * new lead first looks for a likely client already here (same email or phone, similar name) and offers
 * "Add to <client>" instead of a new one. One save: client (if new) → account → contact → relationship
 * → a milestone on the client's timeline → the lead won (with the client and relationship it became).
 */
export function WinSheet({ lead, data, onClose, onDone }) {
  const businessName = data.businessesById.get(lead.business_id)?.name ?? '';
  const dup = useMemo(() => leadDuplicate(lead, data), [lead, data]);
  const ids = useRef(null);
  const [clientId, setClientId] = useState(lead.client_id ?? (dup?.state === 'same' ? dup.clientId : ''));
  const accounts = useMemo(() => data.accounts.filter((a) => a.client_id === clientId), [data.accounts, clientId]);
  const [accountId, setAccountId] = useState(lead.account_id ?? '');
  const [kind, setKind] = useState(lead.kind ?? defaultKindFor(lead.business_id) ?? '');
  const [startDate, setStartDate] = useState(localDate());
  const [problem, setProblem] = useState(null);
  const { busy, error, run } = useAction();
  const chosenAccount = accountId && accounts.some((a) => a.id === accountId) ? accountId : (clientId && !lead.client_id && accounts.length === 1 ? accounts[0].id : accountId);
  const client = clientId ? data.clientsById.get(clientId) : null;
  return (
    <FormSheet
      title={`Won: ${lead.name}`}
      testId="win-form"
      saveLabel="Mark won"
      onClose={onClose}
      dirty
      busy={busy}
      error={error}
      onSave={async () => {
        ids.current ??= storedWinIds(lead.id);
        const plan = planWin(lead, { clientId, accountId: clientId ? chosenAccount : '', kind, startDate, businessName }, data, ids.current);
        setProblem(plan.problem ?? null);
        if (plan.problem) return;
        if (await run(() => applyWin(store, plan))) {
          forgetWinIds(lead.id);
          onDone?.(plan.clientId);
        }
      }}
    >
      {lead.client_id ? (
        <p style={{ margin: 0 }}>Adds {KIND_LABELS[kind] ?? 'the service'} with {businessName} to <strong>{client?.name ?? 'this client'}</strong>.</p>
      ) : dup ? (
        <Notice tone="warn">
          <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="win-duplicate">
            <span>{dup.state === 'same' ? `Already here: ${dup.clientName} has the same ${dup.by}.` : `Maybe the same as ${dup.clientName} (a similar name).`}</span>
            <SelectField
              id="win-client"
              label="Win it as"
              value={clientId}
              onChange={(x) => { setClientId(x); setAccountId(''); }}
              options={[{ value: dup.clientId, label: `Add to ${dup.clientName}` }, { value: '', label: `A new client “${lead.name}”` }]}
            />
          </div>
        </Notice>
      ) : (
        <p style={{ margin: 0 }}>Makes the client <strong>{lead.name}</strong>{lead.contact_name || lead.email || lead.phone ? ' with its contact' : ''}, and {KIND_LABELS[kind] ?? 'the service'} with {businessName}.</p>
      )}
      {clientId ? (
        <SelectField
          id="win-account"
          label="Their business (account)"
          value={chosenAccount}
          onChange={setAccountId}
          options={[...accounts.map((a) => ({ value: a.id, label: a.name })), { value: '', label: `A new account “${lead.name}”` }]}
        />
      ) : null}
      <div style={row}>
        <SelectField id="win-kind" label="What we’ll do" value={kind} onChange={setKind} error={problem} options={[{ value: '', label: 'Pick one' }, ...opts(RELATIONSHIP_KINDS, KIND_LABELS)]} />
        <TextField id="win-start" label="Starting" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </div>
      <p style={{ ...muted, margin: 0 }}>The lead’s notes and calls stay with it and show on the client’s timeline.</p>
    </FormSheet>
  );
}

// ---- a note or call on a lead (with its next step) ---------------------------------------------

export function LeadActivityForm({ lead, type: initialType = 'note', onClose, onDone }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const [start] = useState(() => ({ type: initialType, body: '', at: toDateTimeInput(), next_title: '', next_date: '' }));
  const [v, setV] = useState(start);
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  const saved = useRef({ activity: null, task: null }); // a retry after a failure doesn't save twice
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  return (
    <FormSheet
      title={v.type === 'note' ? 'Add note' : `Log ${LEAD_ACTIVITY_LABELS[v.type].toLowerCase()}`}
      testId="lead-activity-form"
      onClose={onClose}
      dirty={Boolean(textOrNull(v.body) || v.next_title || v.next_date)}
      busy={busy}
      error={error}
      onSave={async () => {
        const at = activityAt(start.at, v.at);
        const next = leadNextStepFields({ title: v.next_title, date: v.next_date }, { lead, me });
        const p = { ...next.problems, ...(at ? {} : { at: 'Pick a date and time' }), ...(textOrNull(v.body) || next.fields ? {} : { body: 'Write something, or set a next step' }) };
        setProblems(p);
        if (Object.keys(p).length) return;
        const ok = await run(async () => {
          if (textOrNull(v.body)) saved.current.activity ??= await store.create('lead_activity', { lead_id: lead.id, type: v.type, body: textOrNull(v.body), at });
          if (next.fields && !saved.current.task) saved.current.task = await store.create('task', next.fields);
        });
        if (ok) onDone?.();
      }}
    >
      <SelectField id="lead-act-type" label="Type" value={v.type} onChange={set('type')} options={['note', 'call', 'email', 'meeting'].map((t) => ({ value: t, label: LEAD_ACTIVITY_LABELS[t] }))} />
      <TextAreaField id="lead-act-body" label={v.type === 'call' ? 'What was said' : 'Text'} value={v.body} onChange={set('body')} rows={4} autoFocus maxLength={20000} error={problems.body} />
      <TextField id="lead-act-at" label="When" type="datetime-local" value={v.at} onChange={set('at')} error={problems.at} />
      <fieldset style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0, padding: 'var(--space-3) 0 0', display: 'grid', gap: 'var(--space-3)', minWidth: 0 }}>
        <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 650, padding: '0 var(--space-2) 0 0' }}>Next step (optional) <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· becomes a task for you</span></legend>
        <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <TextField id="lead-next-title" label="What’s next" value={v.next_title} onChange={set('next_title')} maxLength={300} error={problems.title} />
          <TextField id="lead-next-date" label="By" type="date" value={v.next_date} onChange={set('next_date')} error={problems.date} />
        </div>
      </fieldset>
    </FormSheet>
  );
}
