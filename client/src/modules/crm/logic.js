// The client screens' logic, without React: search over the device's copy, list rows, timeline
// filters, money, consent wording, business colours and plain-English errors. Pages build the
// lookup structures once per data change (useMemo on the record lists) and filter them per
// keystroke, so a few thousand clients stay quick on a phone. Tested in client/test/clients.test.js.
import { normalizePhone } from '@suite/shared/normalize';
import { BUSINESS_IDS, consentStatus } from '@suite/shared/crm';

// ---- labels -----------------------------------------------------------------------------

export const KIND_LABELS = Object.freeze({ wholesale: 'Wholesale', website: 'Website', social: 'Social media', consulting: 'Consulting' });
export const ACTIVITY_LABELS = Object.freeze({ note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', order: 'Order', milestone: 'Milestone' });
/** Activity types a person logs by hand (orders come from the Order Manager's automations, D). */
export const MANUAL_ACTIVITY_TYPES = Object.freeze(['note', 'call', 'email', 'meeting', 'milestone']);
export const CHANNEL_LABELS = Object.freeze({ email: 'Email', call: 'Phone call', text: 'Text message', social: 'Social media', in_person: 'In person' });
export const PERIOD_LABELS = Object.freeze({ once: 'One-off', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' });
const PER_PERIOD = Object.freeze({ once: 'one-off', monthly: '/ month', quarterly: '/ quarter', yearly: '/ year' });
export const BILLING_LABELS = Object.freeze({ flat: 'Flat fee', hourly: 'Hourly' });
export const CONSENT_KIND_LABELS = Object.freeze({
  express: 'Express', implied_purchase: 'Implied · purchase', implied_inquiry: 'Implied · inquiry',
});

/** "in_person" -> "In person", "active" -> "Active" */
export function titleCase(value) {
  if (!value) return '';
  const s = String(value).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Who did something, from the signed-in person's side: You / Your partner / Automatic. */
export function actorLabel(actor, me) {
  if (!actor) return null;
  if (actor === 'system') return 'Automatic';
  if (me && actor === me) return 'You';
  return me ? 'Your partner' : titleCase(actor);
}

// ---- our businesses ----------------------------------------------------------------------

// Colours for our seeded businesses until one is set on the business (Clients → Our businesses).
const DEFAULT_COLORS = Object.freeze({
  [BUSINESS_IDS.wholesale]: '#2f7d4f',
  [BUSINESS_IDS.agency]: '#1d6fa5',
  [BUSINESS_IDS.consulting]: '#7a4fb5',
  [BUSINESS_IDS.save_point]: '#c2571a',
  [BUSINESS_IDS.retail]: '#a8790a',
  [BUSINESS_IDS.personal]: '#6b7280',
});
const SPARE_COLORS = ['#b03a6f', '#0f8a8a', '#5a6b1f', '#8a5a2b', '#3b55c2'];

/** A business's colour: its own (`color`, "#rrggbb"), else a fixed default per business. */
export function businessColor(business) {
  if (!business) return '#8a8f96';
  if (/^#[0-9a-f]{6}$/i.test(business.color ?? '')) return business.color;
  if (DEFAULT_COLORS[business.id]) return DEFAULT_COLORS[business.id];
  let h = 0;
  for (const ch of business.id ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE_COLORS[h % SPARE_COLORS.length];
}

/** A short name for chips: names up to 13 characters as they are, longer ones as initials ("GWND"). */
export function businessShortName(business) {
  const name = (business?.name ?? '').trim();
  if (name.length <= 13) return name || '?';
  const words = name.split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.map((w) => w[0].toUpperCase()).join('') : `${name.slice(0, 12)}…`;
}

/**
 * Businesses to offer in a picker: not archived, by position — plus `keep` (the record's current
 * value) even when archived, so editing a record never silently drops its business.
 */
export function pickableBusinesses(businesses, keep = null) {
  return [...businesses]
    .filter((b) => !b.archived || b.id === keep)
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || String(a.name).localeCompare(String(b.name)));
}

/** A guess at the relationship kind for one of our businesses (the form pre-fills it, editable). */
export function defaultKindFor(businessId) {
  if (businessId === BUSINESS_IDS.wholesale) return 'wholesale';
  if (businessId === BUSINESS_IDS.consulting) return 'consulting';
  if (businessId === BUSINESS_IDS.agency) return 'website';
  return '';
}

// ---- search --------------------------------------------------------------------------------

/** Text for matching: lowercase, accents and apostrophes dropped ("Lefty’s Café" -> "leftys cafe"). */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`´]/g, '')
    .toLowerCase();
}

/**
 * What a search box query looks for: `words` (each must appear somewhere in a client's names
 * and emails) and, when it looks like part of a phone number (digits, spaces, ( ) + . -, at least
 * 3 digits), `phones` — the query in the stored phone form ("(519) 555" -> "519555",
 * "+1 519 555 01" -> "51955501"; "1-519-555" also as "519555"), matched as part of a contact's
 * stored phone. The server's search (GET /api/crm/clients?q=) has the same rule except that last case.
 */
export function parseQuery(q) {
  const text = String(q ?? '').trim();
  if (!text) return null;
  const phones = [];
  if (/^[\d\s()+.-]+$/.test(text)) {
    const p = normalizePhone(text);
    if (p && p.replace('+', '').length >= 3) phones.push(p);
    // A partial number typed with the +1 country code ("1-519-555", "+1 519"): normalizePhone drops
    // the 1 only from a complete number, so also try it without. (The server's search doesn't yet.)
    // Only when it reads as one: "1" then a separator ("1-519…", "1 (519…"), or 7+ digits "1[2-9]…".
    if (p && /^1\d{3,}$/.test(p) && (/^1[\s.(-]/.test(text) || /^1[2-9]\d{5,}$/.test(p))) phones.push(p.slice(1));
  }
  return { words: fold(text).split(/\s+/).filter(Boolean), phones };
}

/**
 * One row per client, with what the list shows and what search looks at — built once per data
 * change. Records come from the device's copy (engine.list: records under a deleted parent are
 * already left out). `lastActivity` (Map client id -> at, computed once per activity change) can
 * stand in for `activities`.
 * @returns {Array<{ client, accountNames: string[], businessIds: string[], lastActivityAt: string|null,
 *   text: string, phones: string[] }>} sorted by client name
 */
export function buildClientIndex({ clients = [], accounts = [], contacts = [], relationships = [], activities = [], lastActivity = null }) {
  const byClient = new Map();
  for (const c of clients) {
    byClient.set(c.id, { client: c, accountNames: [], businessIds: new Set(), lastActivityAt: null, parts: [c.name], phones: [] });
  }
  const accountClient = new Map();
  for (const a of [...accounts].sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
    const row = byClient.get(a.client_id);
    accountClient.set(a.id, a.client_id);
    if (!row) continue;
    row.accountNames.push(a.name);
    row.parts.push(a.name);
  }
  for (const p of contacts) {
    const row = byClient.get(p.client_id);
    if (!row) continue;
    row.parts.push(p.name, p.email);
    if (p.phone) row.phones.push(p.phone);
  }
  // Every live relationship counts (any status), as on the server: "clients who work with X".
  for (const r of relationships) byClient.get(accountClient.get(r.account_id))?.businessIds.add(r.business_id);
  if (lastActivity) {
    for (const [clientId, at] of lastActivity) {
      const row = byClient.get(clientId);
      if (row) row.lastActivityAt = at;
    }
  } else {
    for (const t of activities) {
      const row = byClient.get(t.client_id);
      if (row && t.at && (!row.lastActivityAt || t.at > row.lastActivityAt)) row.lastActivityAt = t.at;
    }
  }
  return [...byClient.values()]
    .map(({ parts, businessIds, ...row }) => ({ ...row, businessIds: [...businessIds], text: fold(parts.filter(Boolean).join(' \u0001 ')) }))
    .sort((a, b) => String(a.client.name).localeCompare(String(b.client.name), undefined, { sensitivity: 'base' }) || (a.client.id < b.client.id ? -1 : 1));
}

/** Does an index row match a parsed query? */
export function matchesQuery(row, query) {
  if (!query) return true;
  if (query.phones.some((q) => row.phones.some((p) => p.includes(q)))) return true;
  return query.words.every((w) => row.text.includes(w));
}

/**
 * The list's rows: search (q), our business ('' = any: clients with a relationship with it) and
 * status ('active' | 'closed' | 'all').
 */
export function filterClients(index, { q = '', business = '', status = 'active' } = {}) {
  const query = parseQuery(q);
  return index.filter((row) => (status === 'all' || row.client.status === status)
    && (!business || row.businessIds.includes(business))
    && matchesQuery(row, query));
}

// ---- timeline -------------------------------------------------------------------------------

/** Newest first: by `at`, then by id (recorded later). */
export function sortTimeline(activities) {
  return [...activities].sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : (a.at < b.at ? 1 : -1)));
}

/**
 * A client's activities for the timeline's filters: business / account / type, each 'all' or a
 * value. An activity with no business (or no account) shows only under "All" for that filter.
 */
export function filterTimeline(activities, { business = 'all', account = 'all', type = 'all' } = {}) {
  return sortTimeline(activities.filter((t) => (business === 'all' || t.business_id === business)
    && (account === 'all' || t.account_id === account)
    && (type === 'all' || t.type === type)));
}

// ---- money (stored as integer cents) ---------------------------------------------------------

const money = (cents) => new Intl.NumberFormat('en-CA', {
  style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
}).format(cents / 100);

/** 150000 -> "$1,500", 12550 -> "$125.50"; '' for nothing. */
export function formatMoney(cents) {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  return money(cents);
}

/**
 * Dollars typed in a form -> integer cents. "1,500" / "$1500.5" / " 99.99 " -> 150000 / 150050 / 9999;
 * '' -> null; anything else (letters, more than 2 decimals, negative) -> NaN.
 */
export function parseDollars(text) {
  const s = String(text ?? '').trim().replace(/^\$/, '').replace(/[,\s]/g, '');
  if (s === '') return null;
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return Number.NaN;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : Number.NaN;
}

/** Cents -> what the form shows: 150000 -> "1500", 150050 -> "1500.50". */
export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * A service's price in one line: "$1,500 / month", "$3,000 one-off", "$120 / hour · 10 sessions";
 * '' when nothing about money is set.
 */
export function billingSummary(service) {
  const parts = [];
  if (service.billing === 'hourly') {
    if (service.rate_cents !== null && service.rate_cents !== undefined) parts.push(`${formatMoney(service.rate_cents)} / hour`);
    else parts.push('Hourly');
    if (service.amount_cents) parts.push(`${formatMoney(service.amount_cents)}${service.period ? ` ${PER_PERIOD[service.period]}` : ''}`);
  } else if (service.amount_cents !== null && service.amount_cents !== undefined) {
    parts.push(`${formatMoney(service.amount_cents)}${service.period ? ` ${PER_PERIOD[service.period]}` : ''}`);
  } else if (service.billing === 'flat') {
    parts.push(service.period ? `Flat fee, ${PERIOD_LABELS[service.period].toLowerCase()}` : 'Flat fee');
  } else if (service.period) {
    parts.push(PERIOD_LABELS[service.period]);
  }
  if (service.sessions) parts.push(`${service.sessions} session${service.sessions === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// ---- consent ----------------------------------------------------------------------------------

/**
 * Where a contact stands with one of our businesses, for display (consentStatus with the device's
 * local date): state 'given' | 'expired' | 'withdrawn' | 'none', a tone for the badge, the
 * deciding row's kind label and date, and `until` (when an implied consent lapses).
 */
export function consentView(rows, businessId, today) {
  const st = consentStatus(rows, businessId, today);
  const kind = st.row && !st.row.withdrawn ? (CONSENT_KIND_LABELS[st.row.kind] ?? 'Implied') : null;
  if (st.given) return { state: 'given', label: 'Given', tone: 'ok', kind, date: st.row.date, until: st.expiresOn, source: st.row.source ?? null };
  if (st.withdrawn) return { state: 'withdrawn', label: 'Withdrawn', tone: 'danger', kind: null, date: st.row.date, until: null, source: st.row.source ?? null };
  if (st.expired) return { state: 'expired', label: 'Expired', tone: 'warn', kind, date: st.row.date, until: st.expiresOn, source: st.row.source ?? null };
  return { state: 'none', label: 'None', tone: 'neutral', kind: null, date: null, until: null, source: null };
}

// ---- errors -------------------------------------------------------------------------------------

const FIELD_NAMES = Object.freeze({
  client_id: 'Client', account_id: 'Account', business_id: 'Our business', relationship_id: 'Relationship', contact_id: 'Contact',
  postal_code: 'Postal code', preferred_channel: 'Preferred channel', start_date: 'Start date', renewal_date: 'Renewal date',
  amount_cents: 'Amount', rate_cents: 'Hourly rate', expires_on: 'Lapses on', age_restricted: 'Age-restricted', at: 'When',
  body: 'Text',
});
const fieldName = (name) => FIELD_NAMES[name] ?? titleCase(name);

const FORMAT_HELP = Object.freeze({
  email: 'isn’t an email address we can save (like name@example.com)',
  phone: 'isn’t a phone number we can save: type all 10 digits (North America), or + and the country code',
  postal: 'isn’t a postal code we can save',
  tags: 'has a tag that is too long',
});

/** A SyncError (or any error) from the store, in plain English for the form it happened in. */
export function errorText(err) {
  if (!err) return null;
  const msg = String(err.message ?? err);
  switch (err.code) {
    case 'invalid_value': {
      let m = /^(\w+) is required$/.exec(msg);
      if (m) return `${fieldName(m[1])} is required.`;
      m = /^(\w+): not (?:stored as )?a (?:clean |valid )?(email address|phone number|postal code|list of tags)/.exec(msg);
      if (m) {
        const key = { 'email address': 'email', 'phone number': 'phone', 'postal code': 'postal', 'list of tags': 'tags' }[m[2]];
        return `${fieldName(m[1])} ${FORMAT_HELP[key]}.`;
      }
      m = /^(\w+): not a valid (\w+)/.exec(msg);
      if (m) return m[2] === 'text' ? `${fieldName(m[1])} is too long.` : `${fieldName(m[1])} isn’t valid.`;
      return msg;
    }
    case 'not_ready': return 'This device hasn’t connected to the suite yet, so it can’t save. Connect once, then try again.';
    case 'not_found': return 'This record isn’t on this device any more (deleted on another device?). Go back and look again.';
    case 'op_not_allowed': return 'This kind of record can’t be changed that way.';
    case 'too_large': return 'This is too long to save. Shorten it and try again.';
    case 'storage_full': return 'This device is out of storage space. Free some space, then try again.';
    case 'storage_error': return 'This device couldn’t save to its offline copy. Try again; if it keeps failing, reload the app.';
    case 'stopped': return 'You’re signed out on this device. Sign in again, then try again.';
    case 'already_exists':
    case 'invalid_step':
    case 'unknown_field':
    case 'unknown_entity':
      return `Something went wrong saving this (${err.code}). Reload the app and try again.`;
    default: return msg;
  }
}

// ---- small helpers for pages --------------------------------------------------------------------

/** A website as a link target: "leftys.ca" -> "https://leftys.ca"; other schemes (javascript:) -> null. */
export function websiteHref(website) {
  const w = String(website ?? '').trim();
  if (!w) return null;
  if (/^https?:\/\//i.test(w)) return w;
  if (/^[a-z][a-z0-9+.-]*:/i.test(w)) return null;
  return `https://${w}`;
}

/** An account's address as lines: ["12 Main St", "Simcoe, ON N3Y 4K3", "Canada"]. */
export function addressLines(a) {
  const line2 = [[a.city, a.region].filter(Boolean).join(', '), a.postal_code].filter(Boolean).join(' ');
  return [a.street, line2, a.country].filter(Boolean);
}

/** '' -> null, trimmed text otherwise (form values to fields). */
export function textOrNull(value) {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}
