// Leads and the pipeline (D8) without React: labels, the lead form, stage changes (with the lead's own
// timeline row), the pipeline's columns and totals, the duplicate check before winning, the win itself
// as a list of store writes with ids made once, a call's next step for a lead, and the client page's view
// of a client's leads. Tested in client/test/leads.test.js (logic + two devices against a real server).
import { LEAD_STAGES, OPEN_LEAD_STAGES, isOpenLead, pipelineTotals, firstYearValue } from '@suite/shared/leads';
import { buildMatchIndex, findMatch } from '@suite/shared/intake';
import { isCurrency } from '@suite/shared/costs';
import { nowIso, localDate } from '../../ui/format.js';
import { parseDollars, centsToInput, textOrNull, fold, KIND_LABELS } from './logic.js';

export const STAGE_LABELS = Object.freeze({ lead: 'Lead', talking: 'Talking', quoted: 'Quoted', won: 'Won', lost: 'Lost' });
export const SOURCE_LABELS = Object.freeze({
  referral: 'Referral', website: 'Our website', social: 'Social media', inbox: 'Inbox', event: 'Event', outreach: 'We reached out',
  cross_sell: 'Cross-sell (current client)', other: 'Other',
});
export const LOST_LABELS = Object.freeze({
  price: 'Price', timing: 'Timing — not now', went_elsewhere: 'Went with someone else', no_reply: 'Stopped replying',
  not_a_fit: 'Not a fit for us', other: 'Other',
});
export const LEAD_ACTIVITY_LABELS = Object.freeze({ note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', stage: 'Stage' });
export { LEAD_STAGES, OPEN_LEAD_STAGES, isOpenLead };

// ---- the form ---------------------------------------------------------------------------------

/**
 * The lead sheet's fields (add / edit). The stage isn't here: it moves with its own buttons (a stage
 * change also writes a timeline row). An edit sends only what changed (formFields.editChanges).
 */
export const leadForm = {
  defaults: {
    name: '', contact_name: '', email: '', phone: '', source: '', business_id: '', kind: '', value: '', value_period: 'once',
    currency: 'CAD', owner: '', notes: '', client_id: '', account_id: '',
  },
  fromRecord: (v, record) => ({ ...v, value: centsToInput(record?.value_cents), currency: record?.currency ?? 'CAD', value_period: record?.value_period ?? 'once' }),
  toFields(v) {
    const problems = {};
    const name = textOrNull(v.name);
    if (!name) problems.name = 'Who is it? A business or a person’s name';
    if (!v.business_id) problems.business_id = 'Pick which of our businesses it is for';
    const value = parseDollars(v.value);
    if (Number.isNaN(value)) problems.value = 'Enter dollars, like 2500 or 2,500.00';
    const currency = String(v.currency ?? '').trim().toUpperCase();
    if (currency && !isCurrency(currency)) problems.currency = 'Three letters, like CAD or USD';
    return {
      problems,
      fields: {
        name, contact_name: textOrNull(v.contact_name), email: textOrNull(v.email), phone: textOrNull(v.phone),
        source: v.source || null, business_id: v.business_id || null, kind: v.kind || null,
        value_cents: Number.isNaN(value) ? null : value, value_period: value === null || Number.isNaN(value) ? null : (v.value_period || 'once'),
        currency: !currency || currency === 'CAD' ? null : currency, owner: v.owner || null, notes: textOrNull(v.notes),
        client_id: v.client_id || null, account_id: v.client_id ? (v.account_id || null) : null,
      },
    };
  },
};

/** A new lead's fields: the form's, plus stage `lead` and when it got there. */
export function newLeadFields(formFields, { now = nowIso() } = {}) {
  return { ...formFields, stage: 'lead', stage_changed_at: now };
}

// ---- stage changes --------------------------------------------------------------------------------

/**
 * Moving a lead to another open stage, or losing it (reason required), or reopening a closed one —
 * never to `won` (that is winLead). → { fields, activity } for the lead's update and its timeline row,
 * or { problem } when it can't be done.
 */
export function stageChange(lead, to, { now = nowIso(), reason = null, note = null } = {}) {
  if (!LEAD_STAGES.includes(to) || to === 'won') return { problem: 'Use Won… to win a lead (it makes the client)' };
  if (to === lead.stage) return { problem: 'Already there' };
  if (to === 'lost' && !reason) return { problem: 'Say why it was lost' };
  const fields = { stage: to, stage_changed_at: now };
  if (to === 'lost') {
    fields.lost_reason = reason;
    fields.lost_note = textOrNull(note);
    fields.closed_at = now;
  } else if (!isOpenLead(lead)) {
    fields.closed_at = null; // reopened
  }
  const body = to === 'lost' ? `${LOST_LABELS[reason] ?? reason}${textOrNull(note) ? `: ${textOrNull(note)}` : ''}` : null;
  return { fields, activity: { lead_id: lead.id, type: 'stage', stage_from: lead.stage, stage_to: to, body, at: now } };
}

/** Save a stage change: the lead, then its timeline row. */
export async function saveStageChange(store, lead, change) {
  await store.update('lead', lead.id, change.fields);
  await store.create('lead_activity', change.activity);
}

// ---- the pipeline ---------------------------------------------------------------------------------

/** Leads matching the page's filters (business; a search over name, contact, email, phone). */
export function filterLeads(leads, { business = '', q = '', owner = '' } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  const digits = String(q).replace(/\D/g, '');
  return leads.filter((l) => (!business || l.business_id === business)
    && (!owner || l.owner === owner || (owner === 'shared' && !l.owner))
    && (!words.length || words.every((w) => fold(`${l.name} ${l.contact_name ?? ''} ${l.email ?? ''}`).includes(w))
      || (digits.length >= 3 && String(l.phone ?? '').includes(digits))));
}

const byStageTime = (a, b) => String(b.stage_changed_at ?? b.created_at ?? '').localeCompare(String(a.stage_changed_at ?? a.created_at ?? '')) || (a.id < b.id ? 1 : -1);

/**
 * The pipeline page: open leads by stage (most recently moved first), won and lost this month, and the
 * totals (pipelineTotals: counts and first-year value per currency per stage).
 */
export function pipelineView(leads, { today = localDate() } = {}) {
  const month = today.slice(0, 7);
  const inMonth = (l) => l.closed_at && localDate(new Date(l.closed_at)).slice(0, 7) === month;
  const columns = Object.fromEntries(OPEN_LEAD_STAGES.map((s) => [s, leads.filter((l) => l.stage === s).sort(byStageTime)]));
  return {
    columns,
    won: leads.filter((l) => l.stage === 'won' && inMonth(l)).sort(byStageTime),
    lost: leads.filter((l) => l.stage === 'lost' && inMonth(l)).sort(byStageTime),
    totals: pipelineTotals(leads, { today }),
  };
}

const money = (cents, currency) => new Intl.NumberFormat('en-CA', {
  style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0, minimumFractionDigits: 0,
}).format(cents / 100);

/** "$12,000 · US$500" — a value per currency (CAD first); '' when none. */
export function valueText(byCurrency) {
  return [...(byCurrency ?? new Map())].sort(([a], [b]) => (a === 'CAD' ? -1 : b === 'CAD' ? 1 : a.localeCompare(b)))
    .map(([cur, cents]) => money(cents, cur)).join(' · ');
}

/** One lead's value: "$2,500 one-off", "$300/mo ($3,600 in a year)"; '' when none. */
export function leadValueText(lead) {
  if (!Number.isSafeInteger(lead?.value_cents)) return '';
  const cur = lead.currency ?? 'CAD';
  const amount = money(lead.value_cents, cur);
  const suffix = { once: ' one-off', monthly: '/mo', quarterly: '/quarter', yearly: '/yr' }[lead.value_period ?? 'once'] ?? '';
  const year = firstYearValue(lead);
  return lead.value_period && lead.value_period !== 'once' && lead.value_period !== 'yearly'
    ? `${amount}${suffix} (${money(year, cur)} in a year)` : `${amount}${suffix}`;
}

/** "Talking since Oct 3" style: how long it has been in its stage, in days (0 = today). */
export function daysInStage(lead, today = localDate()) {
  const since = lead.stage_changed_at ?? lead.created_at ?? null;
  if (!since) return null;
  const a = Date.UTC(...localDate(new Date(since)).split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  const b = Date.UTC(...today.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// ---- winning --------------------------------------------------------------------------------------

/**
 * A likely client already here for this lead (C7's rule on the device's copy): the same clean email or
 * phone on a contact → `same`; a similar client or account name → `similar`; null when none. A lead that
 * already names its client (cross-sell) is that client.
 */
export function leadDuplicate(lead, { clients = [], accounts = [], contacts = [] }) {
  if (lead.client_id) return null;
  const index = buildMatchIndex({ clients, accounts, contacts });
  return findMatch({ client: { name: lead.name }, account: { name: lead.name }, contact: { email: lead.email, phone: lead.phone } }, index);
}

/** The ids a win uses, made once per lead (kept until the win is saved, so a retry never makes a second client). */
export function winIds(newId) {
  return { client: newId(), account: newId(), contact: newId(), relationship: newId(), activity: newId(), stage: newId() };
}

/**
 * The win as ordered store writes (pure). choice:
 *   { clientId: '' (a new client) | an existing client's id, accountId: '' (a new account) | its account,
 *     kind, startDate, businessName }
 * data: the device's accounts, contacts and relationships (live). For a NEW client: client (active) →
 * account (the lead's name) → a contact when the lead has a contact name, email or phone → relationship
 * (our business + kind, active, start date) → a milestone activity → the lead won → its stage row. For an
 * EXISTING client: the account chosen (or a new one under it) → a contact only when none of the client's
 * has the lead's email or phone (or, with neither, its contact name) → the relationship, or the one the
 * account already has with that business and kind (made active again when it isn't) → milestone → lead.
 * → { steps: [{ op: 'create'|'update', entity, id, fields }], clientId, accountId, relationshipId } or { problem }
 */
export function planWin(lead, choice, { accounts = [], contacts = [], relationships = [] }, ids, { now = nowIso(), today = localDate() } = {}) {
  const kind = choice.kind || lead.kind;
  if (!kind) return { problem: 'Pick what we’ll do for them (website, social media, consulting or wholesale)' };
  const steps = [];
  const existing = Boolean(choice.clientId);
  const clientId = existing ? choice.clientId : ids.client;
  if (!existing) steps.push({ op: 'create', entity: 'client', id: ids.client, fields: { name: lead.name, status: 'active' } });
  let accountId = existing && choice.accountId ? choice.accountId : null;
  if (accountId && !accounts.some((a) => a.id === accountId && a.client_id === clientId)) return { problem: 'Pick one of this client’s accounts' };
  if (!accountId) {
    accountId = ids.account;
    steps.push({ op: 'create', entity: 'account', id: ids.account, fields: { client_id: clientId, name: lead.name } });
  }
  const hasPerson = Boolean(lead.contact_name || lead.email || lead.phone);
  const clientContacts = contacts.filter((p) => p.client_id === clientId);
  const known = clientContacts.some((p) => (lead.email && p.email === lead.email) || (lead.phone && p.phone === lead.phone)
    || (!lead.email && !lead.phone && lead.contact_name && fold(p.name) === fold(lead.contact_name)));
  if (hasPerson && !known) {
    steps.push({
      op: 'create', entity: 'contact', id: ids.contact,
      fields: { client_id: clientId, account_id: accountId, name: lead.contact_name || lead.name, email: lead.email ?? null, phone: lead.phone ?? null },
    });
  }
  const reuse = relationships.find((r) => r.account_id === accountId && r.business_id === lead.business_id && r.kind === kind);
  let relationshipId;
  if (reuse) {
    relationshipId = reuse.id;
    if (reuse.status !== 'active') steps.push({ op: 'update', entity: 'relationship', id: reuse.id, fields: { status: 'active' } });
  } else {
    relationshipId = ids.relationship;
    steps.push({
      op: 'create', entity: 'relationship', id: ids.relationship,
      fields: { account_id: accountId, business_id: lead.business_id, kind, status: 'active', start_date: choice.startDate || today },
    });
  }
  const value = leadValueText(lead);
  steps.push({
    op: 'create', entity: 'activity', id: ids.activity,
    fields: {
      client_id: clientId, account_id: accountId, business_id: lead.business_id, type: 'milestone', at: now,
      body: `Won the lead “${lead.name}”: ${KIND_LABELS[kind] ?? kind}${choice.businessName ? ` with ${choice.businessName}` : ''}${value ? ` (${value})` : ''}.`,
    },
  });
  steps.push({
    op: 'update', entity: 'lead', id: lead.id,
    fields: { stage: 'won', won_client_id: clientId, won_relationship_id: relationshipId, kind, closed_at: now, stage_changed_at: now },
  });
  steps.push({ op: 'create', entity: 'lead_activity', id: ids.stage, fields: { lead_id: lead.id, type: 'stage', stage_from: lead.stage, stage_to: 'won', at: now } });
  return { steps, clientId, accountId, relationshipId };
}

/**
 * Carry out a win's steps in order. Creates use their fixed ids; one already made (a retry after a
 * failure part-way, or a double tap) answers `already_exists` and counts as done. Works offline.
 */
export async function applyWin(store, plan) {
  for (const s of plan.steps) {
    if (s.op === 'create') {
      try {
        await store.create(s.entity, s.fields, { id: s.id });
      } catch (err) {
        if (err?.code !== 'already_exists') throw err;
      }
    } else {
      await store.update(s.entity, s.id, s.fields);
    }
  }
  return plan;
}

// ---- next steps and the client page ---------------------------------------------------------------

/**
 * The task a note or call on a lead sets as its next step (title and day together), or nothing: owner =
 * whoever logs it, the lead's business, the lead (`lead_id` — what clears its "No next step"), and its
 * client and account when it has them. → { fields, problems }
 */
export function leadNextStepFields(next, { lead, me }) {
  const title = String(next.title ?? '').trim();
  const date = next.date || '';
  if (!title && !date) return { fields: null, problems: {} };
  const problems = {};
  if (!title) problems.title = 'What is the next step?';
  if (!date) problems.date = 'Pick a day for the next step';
  if (title.length > 300) problems.title = 'Keep it under 300 characters';
  if (Object.keys(problems).length) return { fields: null, problems };
  return {
    problems,
    fields: {
      title, owner: me, business_id: lead.business_id, lead_id: lead.id,
      client_id: lead.won_client_id ?? lead.client_id ?? null, account_id: lead.account_id ?? null, due_date: date,
    },
  };
}

/**
 * A lead's next step: its earliest open task with a due date (what clears "No next step"), or null.
 * Pass the tasks naming it (any owner's).
 */
export function nextStepOf(tasks = []) {
  let best = null;
  for (const t of tasks) {
    if (t.done_at || !t.due_date) continue;
    if (!best || t.due_date < best.due_date || (t.due_date === best.due_date && String(t.due_time ?? '') < String(best.due_time ?? ''))) best = t;
  }
  return best;
}

/** The lead "Make a lead" saves for a cross-sell line: the account, for the business and service it lacks. */
export function crossSellLeadFields(entry, { me, now = nowIso() }) {
  const person = entry.contacts.find((p) => p.contact.account_id === entry.account.id) ?? entry.contacts[0];
  return {
    name: entry.account.name,
    client_id: entry.client.id,
    account_id: entry.account.id,
    business_id: entry.pair.to.business,
    kind: entry.pair.to.kind,
    source: 'cross_sell',
    stage: 'lead',
    stage_changed_at: now,
    owner: me,
    contact_name: person?.contact.name ?? null,
    notes: `From the cross-sell list: ${entry.pair.why}.`,
  };
}

/** A client's leads: those pointing at it (cross-sell) or won into it, open first then newest. */
export function clientLeads(leads, clientId) {
  return leads.filter((l) => l.client_id === clientId || l.won_client_id === clientId)
    .sort((a, b) => (isOpenLead(b) - isOpenLead(a)) || byStageTime(a, b));
}

/**
 * The client page's timeline items for its leads' own activities (notes, calls and stage changes made
 * while it was a lead): shaped like the timeline's other items ({ id, source: 'lead_activity', type, body,
 * at, business_id, account_id, record, lead }) so the filters work on them; a stage row is a milestone
 * "Lead “X”: Lead → Talking". Their account is the lead's (a cross-sell), else the one it was won into.
 */
export function leadTimelineItems(leadActivities, leadsById, relationshipsById = new Map()) {
  return leadActivities.map((a) => {
    const lead = leadsById.get(a.lead_id) ?? null;
    const body = a.type === 'stage'
      ? `Lead “${lead?.name ?? ''}”: ${STAGE_LABELS[a.stage_from] ?? '—'} → ${STAGE_LABELS[a.stage_to] ?? a.stage_to}${a.body ? ` (${a.body})` : ''}`
      : a.body;
    const wonAccount = lead?.won_relationship_id ? relationshipsById.get(lead.won_relationship_id)?.account_id ?? null : null;
    return {
      id: a.id, source: 'lead_activity', type: a.type === 'stage' ? 'milestone' : a.type, body, at: a.at,
      business_id: lead?.business_id ?? null, account_id: lead?.account_id ?? wonAccount, record: a, lead,
    };
  });
}
