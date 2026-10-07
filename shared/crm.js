// CRM facts shared by the server and devices: the lists of values its records use, our own
// businesses (seeded at first start with these fixed ids), and the consent rule. The record
// types themselves are registered by the server's crm module (server/src/modules/crm/entities.js)
// and reach devices through GET /api/sync/info. See CLAUDE.md, "CRM (crm module, C3a)".
import { OWNERS, SHARED } from './actors.js';
import { localDate } from './time.js';

export { OWNERS, SHARED };

/** The CRM's synced record types (entity names), in the order a client's records hang together. */
export const CRM_ENTITY_NAMES = Object.freeze([
  'business', 'client', 'account', 'contact', 'consent', 'relationship', 'service', 'activity', 'link',
]);

export const CLIENT_STATUSES = Object.freeze(['active', 'closed']);
/** What one of our businesses does for one of theirs. */
export const RELATIONSHIP_KINDS = Object.freeze(['wholesale', 'website', 'social', 'consulting']);
export const RELATIONSHIP_STATUSES = Object.freeze(['active', 'paused', 'ended']);
export const SERVICE_STATUSES = Object.freeze(['active', 'paused', 'done', 'cancelled']);
export const SERVICE_BILLING = Object.freeze(['flat', 'hourly']);
/** How often a service's amount comes round: a one-off build, or a retainer. */
export const SERVICE_PERIODS = Object.freeze(['once', 'monthly', 'quarterly', 'yearly']);
export const ACTIVITY_TYPES = Object.freeze(['note', 'call', 'email', 'meeting', 'order', 'milestone']);
export const CONTACT_CHANNELS = Object.freeze(['email', 'call', 'text', 'social', 'in_person']);
/**
 * CASL: express (they said yes: never lapses until withdrawn) or implied by an existing business
 * relationship, which lapses — 2 years after their last purchase, 6 months after an inquiry.
 * (Other implied grounds — a published or handed-over address — use implied_inquiry or set
 * expires_on by hand.) A given row with no kind counts as implied (CONSENT_DEFAULT_KIND, the
 * shorter lapse): only an explicit 'express' never lapses.
 */
export const CONSENT_KINDS = Object.freeze(['express', 'implied_purchase', 'implied_inquiry']);
const CONSENT_LAPSE_MONTHS = Object.freeze({ implied_purchase: 24, implied_inquiry: 6 });
export const CONSENT_DEFAULT_KIND = 'implied_inquiry';
/** How a link was made: a strong match linked on its own, or one of you approved it. */
export const LINK_MATCHED_BY = Object.freeze(['auto', 'approved']);
/** Apps whose records link to accounts and contacts (D2 matching). 'wom' = the Wholesale Order Manager. */
export const LINK_APPS = Object.freeze(['wom']);

/**
 * Our businesses (and Personal), created at first start through the sync steps (applyLocal) with
 * these ids — the same on every install and after any restore, so code and devices can name them.
 * Only created when the id has never existed: renaming, recolouring or deleting one in the app
 * sticks. `key` is for code only (not stored).
 */
export const OUR_BUSINESSES = Object.freeze([
  { key: 'wholesale', id: '01a1163c-1a00-7273-aed1-8d4ae71d27a7', name: 'Wholesale', default_owner: 'owner', position: 1 },
  { key: 'agency', id: '01a1163c-1a01-7593-b888-119295f1fc8b', name: 'Great White North Design', default_owner: 'owner', position: 2 },
  { key: 'consulting', id: '01a1163c-1a02-7027-8a57-0f455a626426', name: 'Business consulting', default_owner: 'owner', position: 3 },
  { key: 'save_point', id: '01a1163c-1a03-7217-b478-155d9f3c955c', name: 'Save Point Shop', default_owner: 'partner', position: 4 },
  { key: 'retail', id: '01a1163c-1a04-7005-9cd7-b9f83f986c43', name: 'Retail stores', default_owner: SHARED, position: 5 },
  { key: 'personal', id: '01a1163c-1a05-70a2-9afb-7cbee433162d', name: 'Personal', default_owner: SHARED, position: 6 },
].map((b) => Object.freeze(b)));

/** key -> id, e.g. BUSINESS_IDS.wholesale */
export const BUSINESS_IDS = Object.freeze(Object.fromEntries(OUR_BUSINESSES.map((b) => [b.key, b.id])));

/** "YYYY-MM-DD" plus whole months, on the calendar (Aug 31 + 6 months = Feb 28/29). */
export function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * The day an implied consent lapses (it counts on the days before it), from its kind and date:
 * implied_purchase: date + 2 years, implied_inquiry (and no kind): date + 6 months; express or
 * withdrawn: null. Writers store it in `expires_on` (screens prefill it, editable); readers fall
 * back to this when a row has none, so an implied consent always lapses.
 */
export function consentExpiresOn({ kind, date, withdrawn = false }) {
  const months = CONSENT_LAPSE_MONTHS[kind ?? CONSENT_DEFAULT_KIND];
  return withdrawn || !months || !date ? null : addMonths(date, months);
}

// Order of consent rows: by date; on the same day a withdrawal comes last (it wins); then by id
// (a UUIDv7: recorded later).
function later(r, cur) {
  if (r.date !== cur.date) return r.date > cur.date;
  if (Boolean(r.withdrawn) !== Boolean(cur.withdrawn)) return Boolean(r.withdrawn);
  return r.id > cur.id;
}

/**
 * The most recent consent row per business (for showing "last recorded"). Whether consent is
 * given is consentStatus(): an older express consent can still count after a later implied one.
 * @returns {Map<string, object>} business id -> its most recent row
 */
export function latestConsents(rows) {
  const out = new Map();
  for (const r of rows ?? []) {
    const cur = out.get(r.business_id);
    if (!cur || later(r, cur)) out.set(r.business_id, r);
  }
  return out;
}

/**
 * Where a contact stands with one of our businesses on `today` ("YYYY-MM-DD", the device's local
 * date). Consent is append-only; only what was given after the last withdrawal counts (a give on
 * the same day as a withdrawal doesn't: the unsubscribe wins). Of those rows: any express one →
 * given (never lapses); otherwise given while the latest-lapsing implied one hasn't lapsed — so a
 * later inquiry never cuts short an earlier purchase's 2 years, and a later implied row never
 * ends an express consent.
 * @returns {{ given, withdrawn, expired, expiresOn, row }} row = the row that decides it (the
 *   express one, the latest-lapsing implied one, or the last withdrawal); expiresOn = when that
 *   implied consent lapses (null for express).
 */
export function consentStatus(rows, businessId, today = localDate()) {
  const mine = (rows ?? []).filter((r) => r.business_id === businessId);
  if (!mine.length) return { given: false, withdrawn: false, expired: false, expiresOn: null, row: null };
  let lastWithdrawal = null;
  for (const r of mine) if (r.withdrawn && (!lastWithdrawal || later(r, lastWithdrawal))) lastWithdrawal = r;
  const gives = mine.filter((r) => !r.withdrawn && (!lastWithdrawal || r.date > lastWithdrawal.date));
  if (!gives.length) return { given: false, withdrawn: Boolean(lastWithdrawal), expired: false, expiresOn: null, row: lastWithdrawal };
  const express = gives.filter((r) => r.kind === 'express');
  if (express.length) {
    const row = express.reduce((a, b) => (later(b, a) ? b : a));
    return { given: true, withdrawn: false, expired: false, expiresOn: null, row };
  }
  let row = null;
  let expiresOn = null;
  for (const r of gives) {
    const until = r.expires_on ?? consentExpiresOn(r);
    if (until && (!expiresOn || until > expiresOn || (until === expiresOn && later(r, row)))) {
      expiresOn = until;
      row = r;
    }
  }
  const expired = !expiresOn || today >= expiresOn;
  return { given: !expired, withdrawn: false, expired, expiresOn, row: row ?? gives[0] };
}

/** May this business email this contact today? */
export function hasConsent(rows, businessId, today = localDate()) {
  return consentStatus(rows, businessId, today).given;
}
