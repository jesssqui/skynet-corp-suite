// Add/edit sheets for the client screens. Every write goes through the offline store (works with
// no connection); errors from the store show inline in plain English. Delete is behind a confirm
// and removes only that record — what belongs to it is hidden with it, never deleted.
import { useState } from 'react';
import {
  CLIENT_STATUSES, RELATIONSHIP_KINDS, RELATIONSHIP_STATUSES, SERVICE_STATUSES, SERVICE_BILLING, SERVICE_PERIODS,
  CONTACT_CHANNELS, CONSENT_KINDS, consentExpiresOn,
} from '@suite/shared/crm';
import { TextField, SelectField, TextAreaField, CheckboxField, Segmented } from '../../ui/index.js';
import { localDate, toDateTimeInput, fromDateTimeInput } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { FormSheet, useAction } from './parts.jsx';
import {
  KIND_LABELS, ACTIVITY_LABELS, MANUAL_ACTIVITY_TYPES, CHANNEL_LABELS, PERIOD_LABELS, BILLING_LABELS, CONSENT_KIND_LABELS,
  titleCase, pickableBusinesses, defaultKindFor, parseDollars, centsToInput, textOrNull,
} from './logic.js';

const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };
const opts = (values, labels = {}) => values.map((v) => ({ value: v, label: labels[v] ?? titleCase(v) }));
const none = (label = '—') => [{ value: '', label }];

/** Field values from a record (or defaults), as form strings. */
function useValues(record, defaults) {
  return useState(() => {
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) if (record && record[k] !== null && record[k] !== undefined) out[k] = record[k];
    return out;
  });
}

/** Save: create or update (only changed fields go out), then close. */
async function save(run, entity, record, fields, onDone) {
  let id = record?.id ?? null;
  const ok = await run(async () => {
    if (record) await store.update(entity, record.id, fields);
    else id = await store.create(entity, fields);
  });
  if (ok) onDone(id);
}

function deleter(run, entity, record, onDeleted) {
  if (!record) return null;
  return async () => {
    if (await run(() => store.remove(entity, record.id))) onDeleted();
  };
}

// ---- client ---------------------------------------------------------------------------------

export function ClientForm({ record, onClose, onDone, onDeleted }) {
  const [v, setV] = useValues(record, { name: '', status: 'active', tags: '', notes: '' });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  return (
    <FormSheet
      title={record ? 'Edit client' : 'New client'}
      testId="client-form"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={() => save(run, 'client', record, {
        name: textOrNull(v.name), status: v.status, tags: textOrNull(v.tags), notes: textOrNull(v.notes),
      }, onDone)}
      onDelete={deleter(run, 'client', record, onDeleted)}
      deleteWarning="Delete this client? Only for a mistake: to stop working with them, close the client instead. Their accounts, contacts and timeline are hidden with it (not deleted) and come back if the delete is undone."
    >
      <TextField id="client-name" label="Name" value={v.name} onChange={set('name')} autoFocus={!record} maxLength={200} hint="The owner or group" />
      <SelectField id="client-status" label="Status" value={v.status} onChange={set('status')} options={opts(CLIENT_STATUSES)} />
      <TextField id="client-tags" label="Tags (optional)" value={v.tags} onChange={set('tags')} hint="Separate with commas" />
      <TextAreaField id="client-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} rows={4} />
    </FormSheet>
  );
}

// ---- account --------------------------------------------------------------------------------

export function AccountForm({ record, clientId, onClose, onDone, onDeleted }) {
  const [v, setV] = useValues(record, {
    name: '', street: '', city: '', region: '', postal_code: '', country: '', website: '', tags: '', notes: '', age_restricted: false,
  });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  return (
    <FormSheet
      title={record ? 'Edit account' : 'New account'}
      testId="account-form"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={() => save(run, 'account', record, {
        ...(record ? {} : { client_id: clientId }),
        name: textOrNull(v.name), street: textOrNull(v.street), city: textOrNull(v.city), region: textOrNull(v.region),
        postal_code: textOrNull(v.postal_code), country: textOrNull(v.country), website: textOrNull(v.website),
        tags: textOrNull(v.tags), notes: textOrNull(v.notes), age_restricted: Boolean(v.age_restricted),
      }, onDone)}
      onDelete={deleter(run, 'account', record, onDeleted)}
      deleteWarning="Delete this account? Only for a mistake. Its relationships and services are hidden with it (not deleted); notes logged on it stay on the client’s timeline."
    >
      <TextField id="account-name" label="Business name" value={v.name} onChange={set('name')} autoFocus={!record} maxLength={200} hint="One of the client’s businesses" />
      <TextField id="account-street" label="Street (optional)" value={v.street} onChange={set('street')} autoComplete="street-address" />
      <div style={row}>
        <TextField id="account-city" label="City (optional)" value={v.city} onChange={set('city')} />
        <TextField id="account-region" label="Province (optional)" value={v.region} onChange={set('region')} />
        <TextField id="account-postal" label="Postal code (optional)" value={v.postal_code} onChange={set('postal_code')} autoCapitalize="characters" />
      </div>
      <TextField id="account-country" label="Country (optional)" value={v.country} onChange={set('country')} />
      <TextField id="account-website" label="Website (optional)" value={v.website} onChange={set('website')} inputMode="url" autoCapitalize="none" />
      <TextField id="account-tags" label="Tags (optional)" value={v.tags} onChange={set('tags')} hint="Separate with commas" />
      <TextAreaField id="account-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} />
      <CheckboxField
        id="account-age"
        label="Age-restricted"
        checked={v.age_restricted}
        onChange={set('age_restricted')}
        hint="Sells nicotine or cannabis: its contacts and orders are never used for another brand’s marketing."
      />
    </FormSheet>
  );
}

// ---- contact --------------------------------------------------------------------------------

export function ContactForm({ record, clientId, accounts, onClose, onDone, onDeleted }) {
  const [v, setV] = useValues(record, { name: '', role: '', account_id: '', email: '', phone: '', preferred_channel: '', notes: '' });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  return (
    <FormSheet
      title={record ? 'Edit contact' : 'New contact'}
      testId="contact-form"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={() => save(run, 'contact', record, {
        ...(record ? {} : { client_id: clientId }),
        name: textOrNull(v.name), role: textOrNull(v.role), account_id: v.account_id || null,
        email: textOrNull(v.email), phone: textOrNull(v.phone), preferred_channel: v.preferred_channel || null, notes: textOrNull(v.notes),
      }, onDone)}
      onDelete={deleter(run, 'contact', record, onDeleted)}
      deleteWarning="Delete this contact? Only for a mistake. Their consent records are hidden with them (not deleted)."
    >
      <TextField id="contact-name" label="Name" value={v.name} onChange={set('name')} autoFocus={!record} maxLength={200} autoComplete="off" />
      <TextField id="contact-role" label="Role (optional)" value={v.role} onChange={set('role')} hint="e.g. Owner, Store manager" />
      <SelectField
        id="contact-account"
        label="Works at (optional)"
        value={v.account_id}
        onChange={set('account_id')}
        options={[...none('— Any of their businesses —'), ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
      />
      <TextField id="contact-email" label="Email (optional)" type="email" inputMode="email" autoCapitalize="none" value={v.email} onChange={set('email')} />
      <TextField id="contact-phone" label="Phone (optional)" type="tel" inputMode="tel" value={v.phone} onChange={set('phone')} hint="Any format; an extension goes in the notes" />
      <SelectField id="contact-channel" label="Prefers (optional)" value={v.preferred_channel} onChange={set('preferred_channel')} options={[...none(), ...opts(CONTACT_CHANNELS, CHANNEL_LABELS)]} />
      <TextAreaField id="contact-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} />
    </FormSheet>
  );
}

// ---- relationship -----------------------------------------------------------------------------

export function RelationshipForm({ record, accountId, accounts, businesses, onClose, onDone, onDeleted }) {
  const [v, setV] = useValues(record, {
    account_id: accountId ?? '', business_id: '', kind: '', status: 'active', start_date: '', notes: '',
  });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  const pickBusiness = (id) => setV({ ...v, business_id: id, kind: v.kind || defaultKindFor(id) });
  return (
    <FormSheet
      title={record ? 'Edit relationship' : 'New relationship'}
      testId="relationship-form"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={() => save(run, 'relationship', record, {
        account_id: v.account_id || null, business_id: v.business_id || null, kind: v.kind || null, status: v.status,
        start_date: v.start_date || null, notes: textOrNull(v.notes),
      }, onDone)}
      onDelete={deleter(run, 'relationship', record, onDeleted)}
      deleteWarning="Delete this relationship? Only for a mistake: when the work stops, set its status to Ended. Its services are hidden with it (not deleted)."
    >
      <SelectField
        id="rel-account"
        label="Their business"
        value={v.account_id}
        onChange={set('account_id')}
        options={[...none('Choose…'), ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
      />
      <SelectField
        id="rel-business"
        label="Our business"
        value={v.business_id}
        onChange={pickBusiness}
        options={[...none('Choose…'), ...pickableBusinesses(businesses, record?.business_id).map((b) => ({ value: b.id, label: b.archived ? `${b.name} (archived)` : b.name }))]}
      />
      <div style={row}>
        <SelectField id="rel-kind" label="Kind" value={v.kind} onChange={set('kind')} options={[...none('Choose…'), ...opts(RELATIONSHIP_KINDS, KIND_LABELS)]} />
        <SelectField id="rel-status" label="Status" value={v.status} onChange={set('status')} options={opts(RELATIONSHIP_STATUSES)} />
      </div>
      <TextField id="rel-start" label="Started (optional)" type="date" value={v.start_date} onChange={set('start_date')} />
      <TextAreaField id="rel-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} />
    </FormSheet>
  );
}

// ---- service ----------------------------------------------------------------------------------

export function ServiceForm({ record, relationshipId, onClose, onDone, onDeleted }) {
  const [v, setV] = useValues(record, {
    name: '', status: 'active', stage: '', billing: '', period: '', sessions: '', start_date: '', renewal_date: '', scope: '', notes: '',
  });
  const [amount, setAmount] = useState(centsToInput(record?.amount_cents));
  const [rate, setRate] = useState(centsToInput(record?.rate_cents));
  const [moneyError, setMoneyError] = useState({});
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  const onSave = () => {
    const amountCents = parseDollars(amount);
    const rateCents = v.billing === 'hourly' ? parseDollars(rate) : (record?.rate_cents ?? null);
    const sessions = String(v.sessions).trim() === '' ? null : Number(v.sessions);
    const problems = {};
    if (Number.isNaN(amountCents)) problems.amount = 'Enter dollars, like 1500 or 1,500.00';
    if (Number.isNaN(rateCents)) problems.rate = 'Enter dollars, like 95 or 95.50';
    if (sessions !== null && !(Number.isSafeInteger(sessions) && sessions >= 0)) problems.sessions = 'Enter a whole number';
    setMoneyError(problems);
    if (Object.keys(problems).length) return;
    save(run, 'service', record, {
      ...(record ? {} : { relationship_id: relationshipId }),
      name: textOrNull(v.name), status: v.status, stage: textOrNull(v.stage), billing: v.billing || null,
      amount_cents: amountCents, rate_cents: rateCents, period: v.period || null, sessions,
      start_date: v.start_date || null, renewal_date: v.renewal_date || null, scope: textOrNull(v.scope), notes: textOrNull(v.notes),
    }, onDone);
  };
  return (
    <FormSheet
      title={record ? 'Edit service' : 'New service'}
      testId="service-form"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={onSave}
      onDelete={deleter(run, 'service', record, onDeleted)}
      deleteWarning="Delete this service? Only for a mistake: when it’s finished, set its status to Done (or Cancelled)."
    >
      <TextField id="svc-name" label="Name" value={v.name} onChange={set('name')} autoFocus={!record} maxLength={200} hint="e.g. Website build, Social retainer" />
      <div style={row}>
        <SelectField id="svc-status" label="Status" value={v.status} onChange={set('status')} options={opts(SERVICE_STATUSES)} />
        <TextField id="svc-stage" label="Stage (optional)" value={v.stage} onChange={set('stage')} maxLength={60} hint="e.g. Design, Build, Live" />
      </div>
      <div style={row}>
        <SelectField id="svc-billing" label="Billing (optional)" value={v.billing} onChange={set('billing')} options={[...none(), ...opts(SERVICE_BILLING, BILLING_LABELS)]} />
        <SelectField id="svc-period" label="How often (optional)" value={v.period} onChange={set('period')} options={[...none(), ...opts(SERVICE_PERIODS, PERIOD_LABELS)]} />
      </div>
      <div style={row}>
        <TextField
          id="svc-amount"
          label={v.billing === 'hourly' ? 'Retainer $ (optional)' : 'Amount $ (optional)'}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={moneyError.amount}
          hint="Fee, or per period for a retainer"
        />
        {v.billing === 'hourly' ? (
          <TextField id="svc-rate" label="Hourly rate $" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} error={moneyError.rate} />
        ) : null}
        <TextField id="svc-sessions" label="Sessions (optional)" inputMode="numeric" value={v.sessions} onChange={set('sessions')} error={moneyError.sessions} />
      </div>
      <div style={row}>
        <TextField id="svc-start" label="Started (optional)" type="date" value={v.start_date} onChange={set('start_date')} />
        <TextField id="svc-renewal" label="Renews (optional)" type="date" value={v.renewal_date} onChange={set('renewal_date')} />
      </div>
      <TextAreaField id="svc-scope" label="Scope (optional)" value={v.scope} onChange={set('scope')} />
      <TextAreaField id="svc-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} />
    </FormSheet>
  );
}

// ---- consent (append-only: each change is a new row) ---------------------------------------------

export function ConsentForm({ contact, businesses, businessId, onClose, onDone }) {
  const today = localDate();
  const [v, setV] = useState({ business_id: businessId ?? '', withdrawn: false, kind: 'express', date: today, source: '' });
  const [expires, setExpires] = useState(null); // null = follow the kind and date
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  const implied = !v.withdrawn && v.kind !== 'express';
  const suggested = implied ? consentExpiresOn({ kind: v.kind, date: v.date || null }) : null;
  const expiresOn = expires ?? suggested ?? '';
  return (
    <FormSheet
      title={`Consent · ${contact.name}`}
      testId="consent-form"
      onClose={onClose}
      busy={busy}
      error={error}
      saveLabel="Record"
      onSave={async () => {
        const ok = await run(() => store.create('consent', {
          contact_id: contact.id, business_id: v.business_id || null, withdrawn: v.withdrawn, date: v.date || null,
          kind: v.withdrawn ? null : v.kind, expires_on: implied ? (expiresOn || null) : null, source: textOrNull(v.source),
        }));
        if (ok) onDone();
      }}
    >
      <SelectField
        id="consent-business"
        label="Our business"
        value={v.business_id}
        onChange={set('business_id')}
        options={[...none('Choose…'), ...pickableBusinesses(businesses).map((b) => ({ value: b.id, label: b.name }))]}
        hint="Consent is per business: a yes to one isn’t a yes to the others."
      />
      <Segmented
        label="Given or withdrawn"
        value={v.withdrawn ? 'withdrawn' : 'given'}
        onChange={(x) => setV({ ...v, withdrawn: x === 'withdrawn' })}
        options={[{ value: 'given', label: 'Gave consent' }, { value: 'withdrawn', label: 'Withdrew' }]}
      />
      {!v.withdrawn ? (
        <SelectField
          id="consent-kind"
          label="Kind"
          value={v.kind}
          onChange={(kind) => { setV({ ...v, kind }); setExpires(null); }}
          options={opts(CONSENT_KINDS, {
            express: 'Express — they said yes', implied_purchase: 'Implied — they bought (2 years)', implied_inquiry: 'Implied — they asked (6 months)',
          })}
        />
      ) : null}
      <TextField id="consent-date" label={v.withdrawn ? 'Withdrawn on' : 'Given on'} type="date" value={v.date} onChange={(e) => { setV({ ...v, date: e.target.value }); setExpires(null); }} />
      {implied ? (
        <TextField
          id="consent-expires"
          label="Lapses on"
          type="date"
          value={expiresOn}
          onChange={(e) => setExpires(e.target.value)}
          hint={`${CONSENT_KIND_LABELS[v.kind]} consent lapses on this day (CASL). Change it for other grounds.`}
        />
      ) : null}
      <TextField id="consent-source" label="How (optional)" value={v.source} onChange={set('source')} hint={v.withdrawn ? 'e.g. replied STOP, asked by phone' : 'e.g. signed up at the counter, replied to an email'} />
    </FormSheet>
  );
}

// ---- activity (quick capture; append-only: a correction is a new activity) ---------------------------

export function activityTitle(type) {
  return type === 'note' ? 'Add note' : `Log ${ACTIVITY_LABELS[type].toLowerCase()}`;
}

export function ActivityForm({ clientId, type: initialType = 'note', accountId = '', businessId = '', accounts, businesses, onClose, onDone }) {
  const [v, setV] = useState({ type: initialType, body: '', account_id: accountId, business_id: businessId, at: toDateTimeInput() });
  const [whenError, setWhenError] = useState(null);
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  return (
    <FormSheet
      title={activityTitle(v.type)}
      testId="activity-form"
      onClose={onClose}
      busy={busy}
      error={error}
      onSave={async () => {
        const at = fromDateTimeInput(v.at);
        setWhenError(at ? null : 'Pick a date and time');
        if (!at) return;
        const ok = await run(() => store.create('activity', {
          client_id: clientId, type: v.type, body: textOrNull(v.body), account_id: v.account_id || null, business_id: v.business_id || null, at,
        }));
        if (ok) onDone();
      }}
    >
      <SelectField id="act-type" label="Type" value={v.type} onChange={set('type')} options={opts(MANUAL_ACTIVITY_TYPES, ACTIVITY_LABELS)} />
      <TextAreaField
        id="act-body"
        label={v.type === 'call' ? 'What was said' : 'Text'}
        value={v.body}
        onChange={set('body')}
        rows={4}
        autoFocus
        maxLength={20000}
      />
      <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <SelectField
          id="act-account"
          label="Their business (optional)"
          value={v.account_id}
          onChange={set('account_id')}
          options={[...none('None in particular'), ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
        />
        <SelectField
          id="act-business"
          label="Our business (optional)"
          value={v.business_id}
          onChange={set('business_id')}
          options={[...none('None in particular'), ...pickableBusinesses(businesses, businessId || null).map((b) => ({ value: b.id, label: b.name }))]}
        />
      </div>
      <TextField id="act-at" label="When" type="datetime-local" value={v.at} onChange={set('at')} error={whenError} hint="Now, or earlier for a call you’re logging late" />
    </FormSheet>
  );
}
