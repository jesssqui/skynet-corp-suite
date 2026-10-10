// Leads and the pipeline (D8) without React: labels, the lead form, stage changes (with the lead's own
// timeline row), the pipeline's columns and totals, the duplicate check before winning, the win itself
// as a list of store writes with ids made once, a call's next step for a lead, and the client page's view
// of a client's leads. Tested in client/test/leads.test.js (logic + two devices against a real server).
import { LEAD_STAGES, OPEN_LEAD_STAGES, LEAD_STAGE_FIELDS, isOpenLead, leadNeedsLook, pipelineTotals, firstYearValue } from '@suite/shared/leads';
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
export { LEAD_STAGES, OPEN_LEAD_STAGES, LEAD_STAGE_FIELDS, isOpenLead, leadNeedsLook };

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
 * or { problem } when it can't be done. `fields` is always the whole LEAD_STAGE_FIELDS set (what doesn't
 * apply as null) and saveStageChange sends all of it, so concurrent moves clash on all of it together.
 */
export function stageChange(lead, to, { now = nowIso(), reason = null, note = null } = {}) {
  if (!LEAD_STAGES.includes(to) || to === 'won') return { problem: 'Use Won… to win a lead (it makes the client)' };
  if (to === lead.stage) return { problem: 'Already there' };
  if (to === 'lost' && !reason) return { problem: 'Say why it was lost' };
  const lost = to === 'lost';
  const fields = {
    stage: to, stage_changed_at: now, closed_at: lost ? now : null, lost_reason: lost ? reason : null,
    lost_note: lost ? textOrNull(note) : null, won_client_id: null, won_relationship_id: null,
  };
  const body = lost ? `${LOST_LABELS[reason] ?? reason}${textOrNull(note) ? `: ${textOrNull(note)}` : ''}` : null;
  return { fields, activity: { lead_id: lead.id, type: 'stage', stage_from: lead.stage, stage_to: to, body, at: now } };
}

/** Save a stage change: the lead (its whole stage set, even fields unchanged here), then its timeline row. */
export async function saveStageChange(store, lead, change) {
  await store.update('lead', lead.id, change.fields, { send: Object.keys(change.fields) });
  await store.create('lead_activity', change.activity);
}

/** Open clashes on a lead's stage set (two devices moved it at once). */
export function stageClashes(lead) {
  return (lead?._sync?.clashes ?? []).filter((c) => c.kind === 'field' && !c.resolved && LEAD_STAGE_FIELDS.includes(c.field));
}

/**
 * Settle a lead's stage clashes as one: keep_winner keeps the row as it is (consistent: the later move
 * won every field of the set); keep_loser applies the other move's values — the other fields first, the
 * stage last (so "Lost" arrives after its reason). Needs a connection (settling clashes does).
 * @param {{ resolveClash }} engine
 */
export async function settleStageClashes(engine, lead, resolution) {
  const clashes = stageClashes(lead).sort((a, b) => (a.field === 'stage') - (b.field === 'stage'));
  for (const c of clashes) await engine.resolveClash(c.id, resolution);
  return clashes.length;
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

/** The ids a win uses, made once per lead and choice (kept until the win is saved, so a retry never makes a second client). */
export function winIds(newId) {
  return { client: newId(), account: newId(), contact: newId(), relationship: newId(), activity: newId(), stage: newId() };
}

/**
 * What the kept ids belong to: a new client, or "add to <client>" with its account (or a new one) and the
 * kind. A retry with another choice gets other ids (review fix): reusing them would answer `already_exists`
 * for records made for the first choice (a relationship on another account) and skip what this one needs.
 */
export const winChoiceKey = ({ clientId = '', accountId = '', kind = '' } = {}) => (clientId ? `add:${clientId}:${accountId || 'new'}:${kind}` : `new:${kind}`);

const winStoreKey = (leadId) => `suite.crm.winIds.${leadId}`;
/**
 * The ids for this lead and choice, kept in `storage` (localStorage) until the win is saved: a retry after
 * a failure part-way, a double tap or a reload re-uses them; another choice gets new ones (the old are
 * dropped). Works without storage too (this session only, `memory`).
 */
export function keptWinIds(storage, leadId, choice, newId, memory = new Map()) {
  const key = winChoiceKey(choice);
  let kept = null;
  try { kept = JSON.parse(storage?.getItem(winStoreKey(leadId)) ?? 'null'); } catch { kept = null; }
  kept ??= memory.get(leadId) ?? null;
  if (kept?.key === key && kept.ids?.client) return kept.ids;
  const fresh = { key, ids: winIds(newId) };
  memory.set(leadId, fresh);
  try { storage?.setItem(winStoreKey(leadId), JSON.stringify(fresh)); } catch { /* best effort: memory still has them */ }
  return fresh.ids;
}

export function forgetWinIds(storage, leadId, memory = new Map()) {
  memory.delete(leadId);
  try { storage?.removeItem(winStoreKey(leadId)); } catch { /* fine */ }
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
  const made = [];
  if (!existing) made.push(`client:${ids.client}`);
  if (steps.some((x) => x.entity === 'account')) made.push(`account:${ids.account}`);
  const hasPerson = Boolean(lead.contact_name || lead.email || lead.phone);
  const clientContacts = contacts.filter((p) => p.client_id === clientId);
  const known = clientContacts.some((p) => (lead.email && p.email === lead.email) || (lead.phone && p.phone === lead.phone)
    || (!lead.email && !lead.phone && lead.contact_name && fold(p.name) === fold(lead.contact_name)));
  if (hasPerson && !known) {
    steps.push({
      op: 'create', entity: 'contact', id: ids.contact,
      fields: { client_id: clientId, account_id: accountId, name: lead.contact_name || lead.name, email: lead.email ?? null, phone: lead.phone ?? null },
    });
    made.push(`contact:${ids.contact}`);
  }
  const reuse = relationships.find((r) => r.account_id === accountId && r.business_id === lead.business_id && r.kind === kind);
  let relationshipId;
  const startDate = choice.startDate || today;
  const restarted = Boolean(reuse && reuse.status !== 'active');
  if (reuse) {
    relationshipId = reuse.id;
    // Made active again: it restarts on the day picked (only these two fields are sent; review fix).
    if (restarted) {
      steps.push({ op: 'update', entity: 'relationship', id: reuse.id, fields: { status: 'active', start_date: startDate } });
      made.push(`restarted:relationship:${reuse.id}`);
    }
  } else {
    relationshipId = ids.relationship;
    steps.push({
      op: 'create', entity: 'relationship', id: ids.relationship,
      fields: { account_id: accountId, business_id: lead.business_id, kind, status: 'active', start_date: startDate },
    });
    made.push(`relationship:${ids.relationship}`);
  }
  const value = leadValueText(lead);
  steps.push({
    op: 'create', entity: 'activity', id: ids.activity,
    fields: {
      client_id: clientId, account_id: accountId, business_id: lead.business_id, type: 'milestone', at: now,
      body: `Won the lead “${lead.name}”: ${KIND_LABELS[kind] ?? kind}${choice.businessName ? ` with ${choice.businessName}` : ''}${restarted ? ' (restarted)' : ''}${value ? ` (${value})` : ''}.`,
    },
  });
  made.push(`activity:${ids.activity}`);
  // The lead: its whole stage set, sent even where unchanged (see stageChange), plus the kind.
  steps.push({
    op: 'update', entity: 'lead', id: lead.id, send: true,
    fields: {
      stage: 'won', stage_changed_at: now, closed_at: now, lost_reason: null, lost_note: null,
      won_client_id: clientId, won_relationship_id: relationshipId, kind,
    },
  });
  steps.push({
    op: 'create', entity: 'lead_activity', id: ids.stage,
    fields: {
      lead_id: lead.id, type: 'stage', stage_from: lead.stage, stage_to: 'won', at: now,
      won_client_id: clientId, won_relationship_id: relationshipId, won_made: made.join(' '),
    },
  });
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
      await store.update(s.entity, s.id, s.fields, s.send ? { send: Object.keys(s.fields) } : undefined);
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

/**
 * A client's leads: those pointing at it (cross-sell), won into it (only while the lead IS won — an open
 * lead still naming a client is "needs a look", not a win), or with a win that made something here (a lead
 * won on two devices at once: both clients show it, with "Won twice"). Open first, then newest.
 */
export function clientLeads(leads, clientId, leadActivities = []) {
  const winHere = new Set(leadActivities.filter((a) => isWinRow(a) && a.won_client_id === clientId).map((a) => a.lead_id));
  return leads.filter((l) => l.client_id === clientId || (l.stage === 'won' && l.won_client_id === clientId) || winHere.has(l.id))
    .sort((a, b) => (isOpenLead(b) - isOpenLead(a)) || byStageTime(a, b));
}

// ---- won twice (two devices winning the same lead offline) -------------------------------------

/** A win's own stage row (it names the client it went to). */
export const isWinRow = (a) => a?.type === 'stage' && a.stage_to === 'won' && Boolean(a.won_client_id);

/** What a win made, from its row: [{ entity, id, restarted }]. */
export function winMade(row) {
  return String(row?.won_made ?? '').split(/\s+/).filter(Boolean).map((part) => {
    const bits = part.split(':');
    return bits[0] === 'restarted' ? { entity: bits[1], id: bits[2], restarted: true } : { entity: bits[0], id: bits[1], restarted: false };
  }).filter((x) => x.entity && x.id);
}

/**
 * The lead's wins still standing (their client — and relationship, if any — still on the device) and which
 * one the lead keeps: the one it names (client and relationship, else client). Won twice = more than one.
 * → { wins, kept, extras }
 */
export function leadWins(lead, leadActivities, { clientsById = new Map(), relationshipsById = new Map() } = {}) {
  const wins = leadActivities.filter((a) => a.lead_id === lead.id && isWinRow(a)
    && clientsById.has(a.won_client_id) && (!a.won_relationship_id || relationshipsById.has(a.won_relationship_id)))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.id < b.id ? -1 : 1));
  const named = lead.stage === 'won' ? wins.filter((w) => w.won_client_id === lead.won_client_id) : [];
  const kept = named.find((w) => w.won_relationship_id === lead.won_relationship_id) ?? named[0] ?? null;
  const extras = wins.length > 1 ? wins.filter((w) => w !== kept && !(kept && sameWin(w, kept))) : [];
  return { wins, kept, extras };
}
const sameWin = (a, b) => a.won_client_id === b.won_client_id && a.won_relationship_id === b.won_relationship_id;

// Edited since it was made: on the server (pulled times differ), or with a change here not sent yet (review fix:
// this device's own unsent edit counts; a record still `local` — made here, never sent — is waiting too).
const changedSince = (r) => Boolean(r?._sync?.pending || r?._sync?.local
  || (r?._sync?.updatedAt && r?._sync?.createdAt && r._sync.updatedAt !== r._sync.createdAt));

/**
 * What taking back an extra win does, on the device's copy (D2's undo in spirit): remove what the win
 * made only if it is still as the win left it and nothing else uses it — the client it made (its account,
 * contact, relationship and milestone go with it, hidden), else the account it made, else the relationship
 * (and a contact it made). Whatever stays is listed with why. Pure.
 * d: { clients, accounts, contacts, relationships, services, consents, activities, links, tasks, costs,
 *      wholesaleCustomers, leads } (live records), `leadId` the lead.
 * → { remove: [{ entity, id, name }], left: [string], noteOn: client id | null }
 */
export function extraWinPlan(row, d, leadId) {
  const made = winMade(row);
  const madeIds = new Set(made.filter((m) => !m.restarted).map((m) => m.id));
  const byId = (list, id) => (list ?? []).find((r) => r.id === id) ?? null;
  const left = [];
  const remove = [];
  const nameOf = (r) => r?.name ?? r?.title ?? '';
  const other = (list, pred) => (list ?? []).filter((r) => pred(r) && !madeIds.has(r.id));
  const tasksNaming = ({ client, account, relationship }) => (d.tasks ?? []).filter((t) => (client && t.client_id === client)
    || (account && t.account_id === account) || (relationship && t.relationship_id === relationship));
  // Uses of a set of accounts / relationships / contacts that the win didn't make.
  const usesOf = ({ clientId = null, accountIds = [], relationshipIds = [], contactIds = [] }) => {
    const why = [];
    const acc = new Set(accountIds);
    const rel = new Set(relationshipIds);
    const con = new Set(contactIds);
    if (clientId) {
      for (const a of other(d.accounts, (x) => x.client_id === clientId)) why.push(`its account “${a.name}”`);
      for (const p of other(d.contacts, (x) => x.client_id === clientId)) why.push(`its contact “${p.name}”`);
      const n = other(d.activities, (x) => x.client_id === clientId).length;
      if (n) why.push(`${n} timeline ${n === 1 ? 'entry' : 'entries'}`);
      for (const l of (d.leads ?? []).filter((x) => x.id !== leadId && (x.client_id === clientId || x.won_client_id === clientId))) why.push(`the lead “${l.name}”`);
    }
    for (const r of other(d.relationships, (x) => acc.has(x.account_id))) why.push('another of our businesses works with it');
    for (const s of (d.services ?? []).filter((x) => rel.has(x.relationship_id))) why.push(`the service “${s.name}”`);
    for (const c of (d.costs ?? []).filter((x) => rel.has(x.relationship_id))) why.push(`the resold cost “${c.name}”`);
    if ((d.consents ?? []).some((x) => con.has(x.contact_id))) why.push('consent recorded on its contact');
    if ((d.links ?? []).some((x) => acc.has(x.account_id) || con.has(x.contact_id))) why.push('an Order Manager link');
    for (const w of (d.wholesaleCustomers ?? []).filter((x) => acc.has(x.account_id))) why.push(`the Order Manager customer “${w.name}”`);
    for (const t of tasksNaming({ client: clientId, account: null, relationship: null }).concat(
      (d.tasks ?? []).filter((t) => acc.has(t.account_id) || rel.has(t.relationship_id)),
    )) why.push(`the task “${t.title}”`);
    return [...new Set(why.filter(Boolean))];
  };
  const madeOf = (entity) => made.filter((m) => m.entity === entity && !m.restarted).map((m) => m.id);
  const [clientMade] = madeOf('client');
  const accountsMade = madeOf('account');
  const relsMade = madeOf('relationship');
  const contactsMade = madeOf('contact');
  const edited = (entity, ids, list) => ids.map((id) => byId(list, id)).filter((r) => changedSince(r)).map((r) => `the ${entity} “${nameOf(r)}” was edited`);

  if (clientMade && byId(d.clients, clientMade)) {
    const why = [
      ...edited('client', [clientMade], d.clients), ...edited('account', accountsMade, d.accounts),
      ...edited('contact', contactsMade, d.contacts), ...edited('relationship', relsMade, d.relationships),
      ...usesOf({ clientId: clientMade, accountIds: accountsMade, relationshipIds: relsMade, contactIds: contactsMade }),
    ];
    const client = byId(d.clients, clientMade);
    if (why.length) left.push(`The client “${client.name}” stays: ${why.join(', ')}.`);
    else remove.push({ entity: 'client', id: clientMade, name: client.name });
    return { remove, left, noteOn: why.length ? clientMade : null }; // a client that stays gets a note (its milestone can't be deleted)
  }
  // Added to a client that was already here: take back the account, else the relationship (and a contact).
  for (const accountId of accountsMade) {
    const account = byId(d.accounts, accountId);
    if (!account) continue;
    const why = [...edited('account', [accountId], d.accounts), ...edited('relationship', relsMade, d.relationships),
      ...usesOf({ accountIds: [accountId], relationshipIds: relsMade, contactIds: contactsMade }),
      ...other(d.contacts, (x) => x.account_id === accountId).map((p) => `its contact “${p.name}”`)];
    if (why.length) left.push(`The account “${account.name}” stays: ${why.join(', ')}.`);
    else remove.push({ entity: 'account', id: accountId, name: account.name });
  }
  if (!remove.some((r) => r.entity === 'account')) {
    for (const relId of relsMade) {
      const rel = byId(d.relationships, relId);
      if (!rel) continue;
      const why = [...edited('relationship', [relId], d.relationships), ...usesOf({ relationshipIds: [relId] })];
      if (why.length) left.push(`The relationship stays: ${why.join(', ')}.`);
      else remove.push({ entity: 'relationship', id: relId, name: 'the relationship' });
    }
  }
  for (const contactId of contactsMade) {
    const p = byId(d.contacts, contactId);
    if (!p || remove.some((r) => r.entity === 'account' && r.id === p.account_id)) continue;
    const why = [...edited('contact', [contactId], d.contacts), ...usesOf({ contactIds: [contactId] })];
    if (why.length) left.push(`The contact “${p.name}” stays: ${why.join(', ')}.`);
    else remove.push({ entity: 'contact', id: contactId, name: p.name });
  }
  if (made.some((m) => m.restarted)) left.push('A relationship it made active again stays active.');
  return { remove, left, noteOn: row.won_client_id };
}

const WIN_FIX_ENTITIES = ['client', 'account', 'contact', 'relationship', 'service', 'consent', 'activity', 'link', 'task',
  'recurring_cost', 'wholesale_customer', 'lead'];

/** What extraWinPlan reads, from the device's copy (unsent changes included). */
export async function winFixData(engine) {
  const l = await engine.listMany(WIN_FIX_ENTITIES);
  return {
    clients: l.client, accounts: l.account, contacts: l.contact, relationships: l.relationship, services: l.service, consents: l.consent,
    activities: l.activity, links: l.link, tasks: l.task, costs: l.recurring_cost, wholesaleCustomers: l.wholesale_customer, leads: l.lead,
  };
}

/**
 * Take back the extra wins of a lead won twice. First syncs and re-reads (so what the other device and this
 * one did meanwhile counts), plans each extra (extraWinPlan) and removes what it may, syncs again and
 * re-reads each removed record: one the server kept (changed on the other device: a delete-vs-edit clash
 * keeps it) is reported "Kept". A note goes on a client that stays and lost something (or whose removal was
 * undone) — never when nothing was removed, so pressing again repeats nothing. Then the lead's clashes are
 * settled keep_winner (the win it names). Needs a connection (settling clashes does).
 * @param {{ remove, create, get, list, listMany, syncNow, resolveClash }} engine
 * @returns {Promise<{ removed: object[], kept: object[], left: string[], settled: number }>}
 */
export async function removeExtraWins(engine, leadId, { now = nowIso() } = {}) {
  await engine.syncNow('won-twice');
  const lead = await engine.get('lead', leadId);
  if (!lead) return { removed: [], kept: [], left: [], settled: 0 };
  const d = await winFixData(engine);
  const { extras } = leadWins(lead, await engine.list('lead_activity'), {
    clientsById: new Map(d.clients.map((c) => [c.id, c])), relationshipsById: new Map(d.relationships.map((r) => [r.id, r])),
  });
  const done = [];
  for (const row of extras) {
    const plan = extraWinPlan(row, d, lead.id);
    const removed = [];
    for (const r of plan.remove) {
      try {
        await engine.remove(r.entity, r.id);
        removed.push(r);
      } catch (err) {
        if (err?.code !== 'not_found') throw err; // already gone
      }
    }
    done.push({ plan, removed });
  }
  await engine.syncNow('won-twice'); // the removals reach the server before anything is reported or settled
  const out = { removed: [], kept: [], left: [], settled: 0 };
  for (const { plan, removed } of done) {
    const gone = [];
    const back = [];
    for (const r of removed) ((await engine.get(r.entity, r.id)) ? back : gone).push(r);
    out.removed.push(...gone);
    out.kept.push(...back);
    out.left.push(...plan.left, ...back.map((r) => `Kept: ${r.name} was changed on the other device.`));
    const noteOn = back.find((r) => r.entity === 'client')?.id ?? (gone.length || back.length ? plan.noteOn : null);
    if (noteOn && (await engine.get('client', noteOn))) {
      const parts = [];
      if (gone.length) parts.push(`taken back: ${gone.map((r) => r.name).join(', ')}`);
      if (back.length) parts.push(`kept, because it was changed on the other device: ${back.map((r) => r.name).join(', ')}`);
      if (plan.left.length) parts.push(plan.left.join(' '));
      await engine.create('activity', {
        client_id: noteOn, business_id: lead.business_id, type: 'note', at: now,
        body: `The lead “${lead.name}” was won on two devices at once; its extra win here was ${parts.join('; ')}.`,
      });
    }
  }
  await engine.syncNow('won-twice');
  const fresh = await engine.get('lead', lead.id);
  const leadClashes = (fresh?._sync?.clashes ?? []).filter((c) => c.kind === 'field' && !c.resolved && (LEAD_STAGE_FIELDS.includes(c.field) || c.field === 'kind'));
  for (const c of leadClashes) {
    await engine.resolveClash(c.id, 'keep_winner'); // the lead keeps the win it names
    out.settled += 1;
  }
  return out;
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
