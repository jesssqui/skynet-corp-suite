// Add/edit sheets for the client screens. Every write goes through the offline store (works with
// no connection); errors from the store show inline in plain English. Delete is behind a confirm
// and removes only that record — what belongs to it is hidden with it, never deleted.
import { useMemo, useRef, useState } from 'react';
import {
  CLIENT_STATUSES, RELATIONSHIP_KINDS, RELATIONSHIP_STATUSES, SERVICE_STATUSES, SERVICE_BILLING, SERVICE_PERIODS,
  CONTACT_CHANNELS, CONSENT_KINDS, consentExpiresOn,
} from '@suite/shared/crm';
import { TextField, SelectField, TextAreaField, CheckboxField, Segmented, Notice } from '../../ui/index.js';
import { localDate, toDateTimeInput } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { nextStepFields, nextStepWarning, guessRelationship, relationshipLabel, defaultBusinessId } from '../planner/logic.js';
import { getLastBusiness, setLastBusiness } from '../planner/prefs.js';
import { FormSheet, useAction } from './parts.jsx';
import {
  KIND_LABELS, ACTIVITY_LABELS, MANUAL_ACTIVITY_TYPES, CHANNEL_LABELS, PERIOD_LABELS, BILLING_LABELS, CONSENT_KIND_LABELS,
  titleCase, pickableBusinesses, defaultKindFor, textOrNull,
} from './logic.js';
import {
  valuesFrom, editChanges, isDirty, activityAt, clientForm, accountForm, contactForm, relationshipForm, serviceForm,
} from './formFields.js';

const row = { display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' };
const opts = (values, labels = {}) => values.map((v) => ({ value: v, label: labels[v] ?? titleCase(v) }));
const none = (label = '—') => [{ value: '', label }];

/**
 * One add/edit form: its values (from the record when the sheet opened — that snapshot is
 * `start`), whether anything was changed (`dirty`), input problems, and save(): a new record is
 * created with every field (+ `parent`, e.g. its client_id); an edit sends only the fields changed
 * since the sheet opened (formFields.js), so the other person's changes that arrive meanwhile stay.
 */
export function useForm(form, record, { entity, parent = {}, onDone, initial = null, guard = null, onSaved = null }) {
  const [start] = useState(() => ({ ...valuesFrom(form, record), ...initial }));
  const [v, setV] = useState(start);
  const [problems, setProblems] = useState({});
  const [blocked, setBlocked] = useState(null);
  const action = useAction();
  // D8: a new record saved once stays that record: if what runs after it (onSaved — e.g. clearing the
  // inbox item it came from) fails, Save again retries that part instead of making a second one.
  const created = useRef(null);
  const set = (k) => (e) => setV((cur) => ({ ...cur, [k]: e?.target ? e.target.value : e }));
  const save = async () => {
    let id = record?.id ?? null;
    let fields;
    if (record) {
      const r = editChanges(form, start, v);
      setProblems(r.problems);
      if (Object.keys(r.problems).length) return;
      fields = r.fields;
    } else {
      const r = form.toFields(v);
      setProblems(r.problems ?? {});
      if (Object.keys(r.problems ?? {}).length) return;
      fields = { ...parent, ...r.fields };
    }
    let stop = null;
    const ok = await action.run(async () => {
      if (!record && !created.current && guard) {
        stop = await guard(); // e.g. the inbox item was sorted meanwhile: save nothing
        if (stop) return;
      }
      if (!record) {
        id = created.current ?? await store.create(entity, fields);
        created.current = id;
        await onSaved?.(id);
      } else if (Object.keys(fields).length) await store.update(entity, record.id, fields);
    });
    setBlocked(stop);
    if (ok && !stop) onDone(id);
  };
  return { v, setV, set, save, problems, blocked, dirty: isDirty(start, v), ...action };
}

export function deleter(run, entity, record, onDeleted) {
  if (!record) return null;
  return async () => {
    if (await run(() => store.remove(entity, record.id))) onDeleted();
  };
}

// ---- client ---------------------------------------------------------------------------------

export function ClientForm({ record, onClose, onDone, onDeleted }) {
  const { v, set, save, dirty, busy, error, run } = useForm(clientForm, record, { entity: 'client', onDone });
  return (
    <FormSheet
      title={record ? 'Edit client' : 'New client'}
      testId="client-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
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
  const { v, set, save, dirty, busy, error, run } = useForm(accountForm, record, { entity: 'account', parent: { client_id: clientId }, onDone });
  return (
    <FormSheet
      title={record ? 'Edit account' : 'New account'}
      testId="account-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
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
  const { v, set, save, dirty, busy, error, run } = useForm(contactForm, record, { entity: 'contact', parent: { client_id: clientId }, onDone });
  return (
    <FormSheet
      title={record ? 'Edit contact' : 'New contact'}
      testId="contact-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
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
  const { v, setV, set, save, dirty, busy, error, run } = useForm(relationshipForm, record, {
    entity: 'relationship', onDone, initial: record ? null : { account_id: accountId ?? '' },
  });
  const pickBusiness = (id) => setV((cur) => ({ ...cur, business_id: id, kind: cur.kind || defaultKindFor(id) }));
  return (
    <FormSheet
      title={record ? 'Edit relationship' : 'New relationship'}
      testId="relationship-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
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
  const { v, set, save, dirty, problems, busy, error, run } = useForm(serviceForm, record, {
    entity: 'service', parent: { relationship_id: relationshipId }, onDone,
  });
  return (
    <FormSheet
      title={record ? 'Edit service' : 'New service'}
      testId="service-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
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
          value={v.amount}
          onChange={set('amount')}
          error={problems.amount}
          hint="Fee, or per period for a retainer"
        />
        {v.billing === 'hourly' ? (
          <TextField id="svc-rate" label="Hourly rate $" inputMode="decimal" value={v.rate} onChange={set('rate')} error={problems.rate} />
        ) : null}
        <TextField id="svc-sessions" label="Sessions (optional)" inputMode="numeric" value={v.sessions} onChange={set('sessions')} error={problems.sessions} />
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
      dirty={v.business_id !== (businessId ?? '') || Boolean(textOrNull(v.source)) || v.withdrawn || v.kind !== 'express' || v.date !== today || expires !== null}
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
        options={[...none('Choose…'), ...pickableBusinesses(businesses, businessId ?? null).map((b) => ({ value: b.id, label: b.archived ? `${b.name} (archived)` : b.name }))]}
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

/**
 * Quick capture: a note, call, email, meeting or milestone on the client's timeline — and,
 * optionally, its next step: a title and a day make a task in the same save (owner: whoever logs
 * it; for the relationship picked, which the call's account and business pre-select), which is
 * what clears a relationship's "No next step" flag.
 */
export function ActivityForm({ clientId, type: initialType = 'note', accountId = '', businessId = '', accounts, businesses, relationships = [], onClose, onDone }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const [start] = useState(() => ({
    type: initialType, body: '', account_id: accountId, business_id: businessId, at: toDateTimeInput(), next_title: '', next_date: '', next_rel: null,
  }));
  const [v, setV] = useState(start);
  const [whenError, setWhenError] = useState(null);
  const [nextProblems, setNextProblems] = useState({});
  const { busy, error, run } = useAction();
  const saved = useRef({ activity: null, task: null }); // a retry after a failure doesn't save twice
  const set = (k) => (e) => setV({ ...v, [k]: e?.target ? e.target.value : e });
  const active = useMemo(() => relationships.filter((r) => r.status === 'active'), [relationships]);
  const lookups = useMemo(() => ({
    businessesById: new Map(businesses.map((b) => [b.id, b])),
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    relationshipsById: new Map(relationships.map((r) => [r.id, r])),
  }), [businesses, accounts, relationships]);
  // The next step's relationship follows the call's account and business until it is picked by hand.
  const nextRel = v.next_rel ?? guessRelationship(active, { accountId: v.account_id, businessId: v.business_id });
  return (
    <FormSheet
      title={activityTitle(v.type)}
      testId="activity-form"
      onClose={onClose}
      dirty={Boolean(textOrNull(v.body)) || isDirty({ ...start, body: '' }, { ...v, body: '' })}
      busy={busy}
      error={error}
      onSave={async () => {
        const at = activityAt(start.at, v.at);
        setWhenError(at ? null : 'Pick a date and time');
        const next = nextStepFields(
          { title: v.next_title, date: v.next_date, relationshipId: nextRel, accountId: v.account_id, businessId: v.business_id },
          {
            clientId, me, relationshipsById: lookups.relationshipsById,
            fallbackBusiness: defaultBusinessId({ lastUsed: getLastBusiness(me), businesses }),
          },
        );
        setNextProblems(next.problems);
        if (!at || Object.keys(next.problems).length) return;
        const ok = await run(async () => {
          saved.current.activity ??= await store.create('activity', {
            client_id: clientId, type: v.type, body: textOrNull(v.body), account_id: v.account_id || null, business_id: v.business_id || null, at,
          });
          if (next.fields && !saved.current.task) {
            saved.current.task = await store.create('task', next.fields);
            setLastBusiness(me, next.fields.business_id);
          }
        });
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
      <fieldset style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0, padding: 'var(--space-3) 0 0', display: 'grid', gap: 'var(--space-3)', minWidth: 0 }}>
        <legend style={{ fontSize: 'var(--text-sm)', fontWeight: 650, padding: '0 var(--space-2) 0 0' }}>Next step (optional) <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· becomes a task for you</span></legend>
        <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <TextField id="act-next-title" label="What’s next" value={v.next_title} onChange={set('next_title')} maxLength={300} error={nextProblems.title} />
          <TextField id="act-next-date" label="By" type="date" value={v.next_date} onChange={set('next_date')} error={nextProblems.date} />
        </div>
        {active.length ? (
          <SelectField
            id="act-next-rel"
            label="For (optional)"
            value={nextRel}
            onChange={(x) => setV({ ...v, next_rel: x })}
            options={[...none('No relationship'), ...active.map((r) => ({ value: r.id, label: relationshipLabel(r, { ...lookups, kindLabels: KIND_LABELS }) }))]}
            hint="A dated next step clears the relationship’s “No next step”"
          />
        ) : null}
        {nextStepWarning({ title: v.next_title, relationshipId: nextRel, activeCount: active.length }) ? (
          <Notice tone="warn"><span data-testid="next-step-warning">{nextStepWarning({ title: v.next_title, relationshipId: nextRel, activeCount: active.length })}</span></Notice>
        ) : null}
      </fieldset>
    </FormSheet>
  );
}
