// Leads and the pipeline (D8): the facts the server and devices share — a lead's stages, sources and
// lost reasons, the "no next step" rule for leads, the pipeline's totals, and the monthly cross-sell
// list (which current clients could use another of our services). The record types `lead` and
// `lead_activity` are registered by the server's crm module (server/src/modules/crm/entities.js).
// See CLAUDE.md, "Leads and the pipeline (D8)".
import { localDate } from './time.js';
import { addDays } from './planner.js';
import { BUSINESS_IDS, consentStatus } from './crm.js';

/** Where a lead is: three open stages, then won or lost. "quoted" is set by hand until D17 (quotes) sets it. */
export const LEAD_STAGES = Object.freeze(['lead', 'talking', 'quoted', 'won', 'lost']);
export const OPEN_LEAD_STAGES = Object.freeze(['lead', 'talking', 'quoted']);
export const CLOSED_LEAD_STAGES = Object.freeze(['won', 'lost']);
/** Where a lead came from. `cross_sell` = made from the cross-sell list (a current client); `inbox` = sorted from the capture inbox. */
export const LEAD_SOURCES = Object.freeze(['referral', 'website', 'social', 'inbox', 'event', 'outreach', 'cross_sell', 'other']);
/** Why a lead was lost (a short list + other, with words in lost_note). */
export const LOST_REASONS = Object.freeze(['price', 'timing', 'went_elsewhere', 'no_reply', 'not_a_fit', 'other']);
/** A lead's own timeline (it may have no client yet, so not the CRM's `activity`): notes, calls… and each stage change. */
export const LEAD_ACTIVITY_TYPES = Object.freeze(['note', 'call', 'email', 'meeting', 'stage']);
/** A lead's estimated value: an amount per period, as services have. */
export const LEAD_VALUE_PERIODS = Object.freeze(['once', 'monthly', 'quarterly', 'yearly']);
const PER_YEAR = Object.freeze({ once: 1, monthly: 12, quarterly: 4, yearly: 1 });

export const isOpenLead = (lead) => Boolean(lead) && OPEN_LEAD_STAGES.includes(lead.stage);

/**
 * The fields that say where a lead stands. Every stage move sends ALL of them (the ones that don't apply
 * as null), even when unchanged on the device: two devices moving the same lead at once then clash on the
 * whole set together, and settling the clash (either way) leaves a consistent row — never "Talking" with a
 * lost reason and a close date. See CLAUDE.md, "Leads and the pipeline (D8)", "Concurrent moves".
 */
export const LEAD_STAGE_FIELDS = Object.freeze(['stage', 'stage_changed_at', 'closed_at', 'lost_reason', 'lost_note', 'won_client_id', 'won_relationship_id']);

/**
 * Why a lead's row doesn't add up ("needs a look"), or [] when it does: an open stage carrying a close
 * date, a lost reason or the client it was won into; won without its client; lost without a reason. Only
 * possible after concurrent edits settled field by field (or old steps); readers flag it, never guess.
 */
export function leadNeedsLook(lead) {
  if (!lead) return [];
  const out = [];
  if (isOpenLead(lead)) {
    if (lead.closed_at) out.push('it has a close date');
    if (lead.lost_reason) out.push('it has a lost reason');
    if (lead.won_client_id) out.push('it names a client it was won into');
  } else if (lead.stage === 'won' && !lead.won_client_id) {
    out.push('it is won but names no client');
  } else if (lead.stage === 'lost' && !lead.lost_reason) {
    out.push('it is lost with no reason');
  }
  return out;
}
const openTask = (t) => t && !t.done_at && !t.deleted_at;

/**
 * Leads with no next step (the same shape as C4a's rule for relationships): an OPEN lead (lead,
 * talking, quoted) with no open task naming it (`task.lead_id`) that has a due date — overdue still
 * counts (it shows as overdue instead). Any owner's task counts. Pass live leads and tasks.
 */
export function leadsWithoutNextStep({ leads = [], tasks = [] }) {
  const covered = new Set();
  for (const t of tasks) if (openTask(t) && t.lead_id && t.due_date) covered.add(t.lead_id);
  return leads.filter((l) => isOpenLead(l) && !covered.has(l.id));
}

/**
 * A lead's estimated value over its first year, in cents (null when it has none): a one-off amount
 * as is, a monthly one × 12, quarterly × 4, yearly × 1 — so leads of different periods add up.
 */
export function firstYearValue(lead) {
  if (!Number.isSafeInteger(lead?.value_cents) || lead.value_cents < 0) return null;
  return lead.value_cents * (PER_YEAR[lead.value_period ?? 'once'] ?? 1);
}

/** The local calendar month ("YYYY-MM") of an ISO moment, or null. */
export const monthOf = (iso) => (iso ? localDate(new Date(iso)).slice(0, 7) : null);

/**
 * The pipeline's numbers: per stage, how many leads and their first-year value per currency (null =
 * CAD; never added across currencies); won and lost in the month of `today` (by closed_at).
 * @returns {{ stages: { [stage]: { count, value: Map<currency, cents> } }, wonThisMonth, lostThisMonth, wonValueThisMonth: Map }}
 */
export function pipelineTotals(leads, { today = localDate() } = {}) {
  const stages = Object.fromEntries(LEAD_STAGES.map((s) => [s, { count: 0, value: new Map() }]));
  const month = today.slice(0, 7);
  let wonThisMonth = 0;
  let lostThisMonth = 0;
  const wonValueThisMonth = new Map();
  const add = (map, lead) => {
    const v = firstYearValue(lead);
    if (v === null) return;
    const cur = lead.currency ?? 'CAD';
    map.set(cur, (map.get(cur) ?? 0) + v);
  };
  for (const l of leads) {
    const s = stages[l.stage];
    if (!s) continue;
    s.count += 1;
    add(s.value, l);
    if (l.stage === 'won' && monthOf(l.closed_at) === month) {
      wonThisMonth += 1;
      add(wonValueThisMonth, l);
    }
    if (l.stage === 'lost' && monthOf(l.closed_at) === month) lostThisMonth += 1;
  }
  return { stages, wonThisMonth, lostThisMonth, wonValueThisMonth };
}

// ---- the monthly cross-sell list -----------------------------------------------------------------

const B = BUSINESS_IDS;
/**
 * Which current clients could use another of our services (D8 decision; one table, used by the
 * server's monthly automation and the device's page). A pair: an active relationship `from` (our
 * business + kind) on an account with no relationship `to` (any status: one ended is a "no thanks").
 * Wholesale is never a `from` or `to`: its accounts are age-restricted (nicotine) and the shops
 * buy from us already; the age rule below keeps them off every other list too.
 */
export const CROSS_SELL_PAIRS = Object.freeze([
  { id: 'website-social', from: { business: B.agency, kind: 'website' }, to: { business: B.agency, kind: 'social' }, why: 'Website with us, no social media' },
  { id: 'social-website', from: { business: B.agency, kind: 'social' }, to: { business: B.agency, kind: 'website' }, why: 'Social media with us, no website' },
  { id: 'consulting-website', from: { business: B.consulting, kind: 'consulting' }, to: { business: B.agency, kind: 'website' }, why: 'Consulting client, no website from us' },
  { id: 'website-consulting', from: { business: B.agency, kind: 'website' }, to: { business: B.consulting, kind: 'consulting' }, why: 'Website client, no business consulting' },
].map((p) => Object.freeze(p)));

/** A lead lost for the same account and service is left off the list for this many days ("not now"). */
export const LOST_COOLDOWN_DAYS = 180;

/**
 * The cross-sell list on `today` (pass live records: clients, accounts, relationships, contacts,
 * consents, leads). An entry per (account, pair) where:
 *   - the client is active, the account live, and it has an ACTIVE relationship `from`;
 *   - the account has no relationship `to` (any status);
 *   - no open lead for that account (or its client) and service, and none lost for it in the last
 *     LOST_COOLDOWN_DAYS days;
 *   - **the age-restricted rule** (CLAUDE.md, CRM): an age-restricted account — and its contacts —
 *     may only be selected for a business that already has a relationship (any status) with that
 *     account. Contacts with no account belong to the whole client: they are listed only when none of
 *     the client's age-restricted accounts lacks such a relationship.
 * Each entry lists the account's contacts (and the client's with no account) with whether the `to`
 * business may email them (consentStatus): nothing is sent — the list makes tasks and leads only.
 * @returns {Array<{ key, pair, client, account, relationship, contacts: Array<{ contact, emailConsent }> }>}
 */
export function crossSellList({ clients = [], accounts = [], relationships = [], contacts = [], consents = [], leads = [], today = localDate() }) {
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const relsByAccount = new Map();
  for (const r of relationships) {
    if (!accountsById.has(r.account_id)) continue;
    const list = relsByAccount.get(r.account_id) ?? [];
    list.push(r);
    relsByAccount.set(r.account_id, list);
  }
  const accountsByClient = new Map();
  for (const a of accounts) {
    const list = accountsByClient.get(a.client_id) ?? [];
    list.push(a);
    accountsByClient.set(a.client_id, list);
  }
  const hasBusiness = (accountId, businessId) => (relsByAccount.get(accountId) ?? []).some((r) => r.business_id === businessId);
  const consentsByContact = new Map();
  for (const k of consents) {
    const list = consentsByContact.get(k.contact_id) ?? [];
    list.push(k);
    consentsByContact.set(k.contact_id, list);
  }
  const since = addDays(today, -LOST_COOLDOWN_DAYS);
  const leadBlocks = (lead, account, to) => lead.business_id === to.business && lead.kind === to.kind
    && (lead.account_id === account.id || (!lead.account_id && lead.client_id === account.client_id))
    && (isOpenLead(lead) || (lead.stage === 'lost' && lead.closed_at && localDate(new Date(lead.closed_at)) >= since));
  const out = [];
  for (const pair of CROSS_SELL_PAIRS) {
    for (const rel of relationships) {
      if (rel.status !== 'active' || rel.business_id !== pair.from.business || rel.kind !== pair.from.kind) continue;
      const account = accountsById.get(rel.account_id);
      const client = account ? clientsById.get(account.client_id) : null;
      if (!client || client.status !== 'active') continue;
      if ((relsByAccount.get(account.id) ?? []).some((r) => r.business_id === pair.to.business && r.kind === pair.to.kind)) continue;
      // The age-restricted rule: never selected for a business with no relationship with it.
      if (account.age_restricted && !hasBusiness(account.id, pair.to.business)) continue;
      if (leads.some((l) => leadBlocks(l, account, pair.to))) continue;
      const key = `${account.id}:${pair.id}`;
      if (out.some((e) => e.key === key)) continue;
      const clientWideOk = !(accountsByClient.get(client.id) ?? [])
        .some((a) => a.age_restricted && !hasBusiness(a.id, pair.to.business));
      const people = contacts.filter((p) => p.client_id === client.id
        && (p.account_id === account.id || (!p.account_id && clientWideOk)))
        .map((contact) => ({ contact, emailConsent: Boolean(contact.email) && consentStatus(consentsByContact.get(contact.id) ?? [], pair.to.business, today).given }));
      out.push({ key, pair, client, account, relationship: rel, contacts: people });
    }
  }
  const order = new Map(CROSS_SELL_PAIRS.map((p, i) => [p.id, i]));
  return out.sort((a, b) => (order.get(a.pair.id) - order.get(b.pair.id))
    || String(a.client.name).localeCompare(String(b.client.name)) || String(a.account.name).localeCompare(String(b.account.name)));
}
