// What each add/edit form holds and the fields it saves — without React, so the "only what you
// changed" rule is tested against a real engine (client/test/clients-forms.test.js).
//
// An edit sends ONLY the fields the person changed since the form opened (compared with the
// snapshot taken then), never the whole form: if the other person's change to another field
// arrives while the sheet is open, saving must not put the old value back (it would apply as a
// normal later edit, with no clash to review).
import { parseDollars, centsToInput, textOrNull } from './logic.js';
import { fromDateTimeInput, nowIso } from '../../ui/format.js';

/** Form values from a record (or the defaults for a new one). */
export function valuesFrom(form, record) {
  const out = { ...form.defaults };
  for (const k of Object.keys(form.defaults)) {
    if (record && record[k] !== null && record[k] !== undefined) out[k] = record[k];
  }
  return form.fromRecord ? form.fromRecord(out, record) : out;
}

/** Fields that differ between two field sets (both from form.toFields). */
export function changedFields(before, after) {
  const out = {};
  for (const [k, v] of Object.entries(after)) if (before[k] !== v) out[k] = v;
  return out;
}

/**
 * What saving an edit sends: the fields whose form value changed since `start` (the values the
 * form opened with). { fields, problems } — problems (per input) stop the save.
 */
export function editChanges(form, start, values) {
  const now = form.toFields(values);
  if (now.problems && Object.keys(now.problems).length) return { fields: {}, problems: now.problems };
  return { fields: changedFields(form.toFields(start).fields, now.fields), problems: {} };
}

/** Has the person typed or picked anything since the form opened? */
export function isDirty(start, values) {
  return Object.keys({ ...start, ...values }).some((k) => (start[k] ?? '') !== (values[k] ?? ''));
}

const ok = (fields) => ({ fields, problems: {} });

export const clientForm = {
  defaults: { name: '', status: 'active', tags: '', notes: '' },
  toFields: (v) => ok({ name: textOrNull(v.name), status: v.status, tags: textOrNull(v.tags), notes: textOrNull(v.notes) }),
};

export const accountForm = {
  defaults: { name: '', street: '', city: '', region: '', postal_code: '', country: '', website: '', tags: '', notes: '', age_restricted: false },
  toFields: (v) => ok({
    name: textOrNull(v.name), street: textOrNull(v.street), city: textOrNull(v.city), region: textOrNull(v.region),
    postal_code: textOrNull(v.postal_code), country: textOrNull(v.country), website: textOrNull(v.website),
    tags: textOrNull(v.tags), notes: textOrNull(v.notes), age_restricted: Boolean(v.age_restricted),
  }),
};

export const contactForm = {
  defaults: { name: '', role: '', account_id: '', email: '', phone: '', preferred_channel: '', notes: '' },
  toFields: (v) => ok({
    name: textOrNull(v.name), role: textOrNull(v.role), account_id: v.account_id || null, email: textOrNull(v.email),
    phone: textOrNull(v.phone), preferred_channel: v.preferred_channel || null, notes: textOrNull(v.notes),
  }),
};

export const relationshipForm = {
  defaults: { account_id: '', business_id: '', kind: '', status: 'active', start_date: '', notes: '' },
  toFields: (v) => ok({
    account_id: v.account_id || null, business_id: v.business_id || null, kind: v.kind || null, status: v.status,
    start_date: v.start_date || null, notes: textOrNull(v.notes),
  }),
};

export const serviceForm = {
  defaults: {
    name: '', status: 'active', stage: '', billing: '', period: '', sessions: '', start_date: '', renewal_date: '', scope: '', notes: '',
    amount: '', rate: '',
  },
  // Money is typed in dollars: the form keeps the text, the record keeps cents.
  fromRecord: (v, record) => ({ ...v, sessions: record?.sessions ?? '', amount: centsToInput(record?.amount_cents), rate: centsToInput(record?.rate_cents) }),
  toFields(v) {
    const amount = parseDollars(v.amount);
    const rate = parseDollars(v.rate);
    const sessions = String(v.sessions ?? '').trim() === '' ? null : Number(v.sessions);
    const problems = {};
    if (Number.isNaN(amount)) problems.amount = 'Enter dollars, like 1500 or 1,500.00';
    if (Number.isNaN(rate)) problems.rate = 'Enter dollars, like 95 or 95.50';
    if (sessions !== null && !(Number.isSafeInteger(sessions) && sessions >= 0)) problems.sessions = 'Enter a whole number';
    return {
      problems,
      fields: {
        name: textOrNull(v.name), status: v.status, stage: textOrNull(v.stage), billing: v.billing || null,
        amount_cents: amount, rate_cents: rate, period: v.period || null, sessions,
        start_date: v.start_date || null, renewal_date: v.renewal_date || null, scope: textOrNull(v.scope), notes: textOrNull(v.notes),
      },
    };
  },
};

/**
 * When a quick-capture activity happened: what was typed if the person changed "When" (back-dating a
 * call), else the moment of saving — not when the sheet opened, which may have been a while ago.
 * null when the typed value isn't a date and time.
 */
export function activityAt(startAt, typedAt, now = new Date()) {
  return typedAt === startAt ? nowIso(now) : fromDateTimeInput(typedAt);
}
