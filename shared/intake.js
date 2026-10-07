// Bringing clients in (C7): the quick-add brain dump (devices, offline) and the accounting CSV
// import (server) share one row shape, one cleaning, one "is this client already here?" check and
// one plan of the records to create — so both flag and create the same way. Nothing here
// overwrites: a row either makes a new client, or adds only what is missing to an existing one.
//
// A row (what a person typed, or a CSV row through a column mapping):
//   { client: { name, tags, notes },
//     account: { name, street, city, region, postal_code, country, website },   name: default = client's
//     relationships: [{ business_id, kind, notes }],
//     contact: { name, role, email, phone, notes } }                            all optional
// cleanRow() gives the stored forms (normalize.js) plus `warnings` (shown, not blocking) and
// `problems` (the row can't be saved as it is).
//
// Matching (the plan's "Matching the same client across businesses", applied to new rows):
//   same clean email or phone as a live contact -> "Already here: <client>"     (state 'same')
//   a similar client or account name            -> "Maybe the same as <client>" (state 'similar')
//   the same as an earlier row of this batch    -> "Same as line N"             (state 'duplicate')
// Flagged rows are skipped unless the person chooses otherwise. Nothing is linked or merged
// automatically: that is D2's review list.
import { RELATIONSHIP_KINDS } from './crm.js';
import { isId } from './ids.js';
import {
  normalizeEmail, isEmail, normalizePhone, isPhone, normalizePostalCode, isPostalCode, normalizeTags, parseTags,
} from './normalize.js';

// ---- text helpers ------------------------------------------------------------------------

const INVISIBLE_RE = /[­​-‍⁠﻿]/g;

/** Trimmed, single-spaced text without invisible characters; '' for nothing. */
export function squash(value) {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFC').replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
}

/** Text clipped to `max` characters (on a whole character), or null when empty. */
function clip(value, max, { keepLines = false } = {}) {
  const s = keepLines
    ? String(value ?? '').normalize('NFC').replace(INVISIBLE_RE, '').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim()
    : squash(value);
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Legal and filler words that don't tell two businesses apart ("Lefty's Inc" = "Leftys").
const NOISE_WORDS = new Set(['inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'corp', 'corporation', 'co', 'company', 'the']);

/**
 * A business or person name for comparing: accents and apostrophes dropped, lowercase, "&" as
 * "and", punctuation as spaces, legal words (Inc, Ltd, Co, The…) left out.
 * "The Lefty’s Café Inc." -> "leftys cafe"
 */
export function nameKey(name) {
  const words = squash(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`´]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
  const kept = words.filter((w) => !NOISE_WORDS.has(w));
  return (kept.length ? kept : words).join(' ');
}

/**
 * Do two names look like the same business? Same key; or every word of the shorter one, in
 * order and side by side, inside the longer one ("Lefty's" ~ "Leftys Cannabis Dispensary",
 * "Green Leaf" ~ "The Green Leaf Dispensary"); or the same letters with the spaces taken out
 * ("Northwind" ~ "North Wind"). A shorter name under 4 letters never counts ("Al", "BB").
 */
export function similarNames(a, b) {
  const ka = typeof a === 'string' ? nameKey(a) : a?.key;
  const kb = typeof b === 'string' ? nameKey(b) : b?.key;
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const fa = ka.replace(/ /g, '');
  const fb = kb.replace(/ /g, '');
  if (fa === fb) return fa.length >= 4;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.replace(/ /g, '').length < 4) return false;
  return ` ${long} `.includes(` ${short} `);
}

// ---- cleaning -------------------------------------------------------------------------------

const EXTENSION_RE = /\s*(?:ext\.?|extension|x|#)\s*(\d+)\s*$/i;

/** Field lengths (server/src/modules/crm/entities.js), so a clean row always fits. */
const MAX = Object.freeze({
  name: 200, role: 100, street: 300, city: 100, region: 100, country: 60, website: 500, notes: 20_000, tag: 60, tags: 1000,
});

function cleanTags(value) {
  const tags = parseTags(String(value ?? '').replace(/#/g, ' ')).map((t) => t.slice(0, MAX.tag).trim()).filter(Boolean);
  const out = [];
  let length = 0;
  for (const t of tags) {
    const more = (out.length ? 2 : 0) + t.length;
    if (length + more > MAX.tags) break;
    out.push(t);
    length += more;
  }
  return normalizeTags(out);
}

const joinNotes = (...parts) => clip(parts.filter(Boolean).join('\n'), MAX.notes, { keepLines: true });

/**
 * A row as it will be stored: names trimmed, emails and phones in their clean form, tags joined,
 * postal codes formatted. What can't be stored as typed goes into notes with a warning:
 *  - a phone the normaliser refuses (7 digits with no area code, a foreign number without its
 *    country code) -> the contact's notes, "Phone as typed: …"; an extension -> "Ext. 22";
 *  - an email that isn't one -> the contact's notes, "Email as typed: …";
 *  - a postal code that isn't one -> the account's notes.
 * The contact's name defaults to the client's name when only an email or phone is given; the
 * account's name to the client's name. `problems` (no client name) block saving the row.
 * @returns {{ client, account, relationships, contact, warnings: string[], problems: string[] }}
 */
export function cleanRow(input = {}) {
  const warnings = [];
  const problems = [];
  const clientName = clip(input.client?.name, MAX.name);
  if (!clientName) problems.push('Needs a client name');

  const a = input.account ?? {};
  let accountNotes = null;
  let postal = normalizePostalCode(squash(a.postal_code) || null);
  if (postal && !isPostalCode(postal)) {
    warnings.push(`Postal code “${squash(a.postal_code)}” isn’t one we can save: it goes in the account’s notes`);
    accountNotes = `Postal code as typed: ${squash(a.postal_code)}`;
    postal = null;
  }
  const account = {
    name: clip(a.name, MAX.name) ?? clientName,
    street: clip(a.street, MAX.street),
    city: clip(a.city, MAX.city),
    region: clip(a.region, MAX.region),
    postal_code: postal,
    country: clip(a.country, MAX.country),
    website: clip(a.website, MAX.website)?.replace(/\s/g, '') ?? null,
    notes: accountNotes,
  };

  const relationships = [];
  for (const r of input.relationships ?? []) {
    if (!r || !isId(r.business_id) || !RELATIONSHIP_KINDS.includes(r.kind)) continue;
    if (relationships.some((x) => x.business_id === r.business_id && x.kind === r.kind)) continue;
    relationships.push({ business_id: r.business_id, kind: r.kind, notes: clip(r.notes, MAX.notes) });
  }

  let contact = null;
  const c = input.contact ?? {};
  const typedEmail = squash(c.email);
  const typedPhone = squash(c.phone);
  if (squash(c.name) || typedEmail || typedPhone || squash(c.role)) {
    const notes = [];
    let email = normalizeEmail(typedEmail.replace(/^mailto:/i, '') || null);
    if (email && !isEmail(email)) {
      warnings.push(`Email “${typedEmail}” isn’t an address we can save: it goes in the contact’s notes`);
      notes.push(`Email as typed: ${typedEmail}`);
      email = null;
    }
    let phone = null;
    if (typedPhone) {
      const ext = EXTENSION_RE.exec(typedPhone);
      const p = normalizePhone(typedPhone);
      if (p && isPhone(p)) {
        phone = p;
        if (ext) notes.push(`Ext. ${ext[1]}`);
      } else {
        const digits = typedPhone.replace(ext ? EXTENSION_RE : /$^/, '').replace(/\D/g, '').length;
        const why = digits === 7 ? 'it needs the area code' : 'it needs all 10 digits, or + and the country code';
        warnings.push(`Phone “${typedPhone}” isn’t a full number (${why}): it goes in the contact’s notes as typed`);
        notes.push(`Phone as typed: ${typedPhone}`);
      }
    }
    contact = {
      name: clip(c.name, MAX.name) ?? clientName,
      role: clip(c.role, MAX.role),
      email,
      phone,
      notes: joinNotes(clip(c.notes, MAX.notes, { keepLines: true }), ...notes),
    };
  }

  return {
    client: {
      name: clientName,
      tags: cleanTags(input.client?.tags),
      notes: clip(input.client?.notes, MAX.notes, { keepLines: true }),
    },
    account,
    relationships,
    contact,
    warnings,
    problems,
  };
}

// ---- matching against what is already here ---------------------------------------------------

function nameEntry(name, clientId) {
  const key = nameKey(name);
  if (!key) return null;
  const tokens = key.split(' ');
  return { key, flat: key.replace(/ /g, ''), tokens, clientId, name };
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * What new rows are compared with: live clients, their accounts' names and their contacts'
 * clean emails and phones (records under a deleted client left out by the caller or here).
 * @param {{ clients: Array<{id, name}>, accounts?: Array<{client_id, name}>, contacts?: Array<{client_id, email, phone}> }} records
 */
export function buildMatchIndex({ clients = [], accounts = [], contacts = [] }) {
  const clientsById = new Map(clients.map((c) => [c.id, c]));
  const byEmail = new Map();
  const byPhone = new Map();
  const byToken = new Map(); // every word of a name -> entries
  const byFlat = new Map(); // the name without spaces -> entries
  const add = (name, clientId) => {
    const e = nameEntry(name, clientId);
    if (!e) return;
    for (const t of new Set(e.tokens)) pushTo(byToken, t, e);
    pushTo(byFlat, e.flat, e);
  };
  for (const c of clients) add(c.name, c.id);
  for (const a of accounts) if (clientsById.has(a.client_id)) add(a.name, a.client_id);
  for (const p of contacts) {
    if (!clientsById.has(p.client_id)) continue;
    if (p.email) pushTo(byEmail, p.email, p.client_id);
    if (p.phone) pushTo(byPhone, p.phone, p.client_id);
  }
  return { clientsById, byEmail, byPhone, byToken, byFlat };
}

/** Index entries whose name is similar to `name` (only those sharing a word or its letters are compared). */
function similarEntries(index, name) {
  const e = nameEntry(name, null);
  if (!e) return [];
  const seen = new Set();
  const out = [];
  const consider = (list) => {
    for (const x of list ?? []) {
      if (seen.has(x)) continue;
      seen.add(x);
      if (similarNames(e, x)) out.push({ entry: x, exact: x.key === e.key });
    }
  };
  for (const t of e.tokens) consider(index.byToken.get(t));
  consider(index.byFlat.get(e.flat));
  return out;
}

/**
 * Is this clean row a client that is already here?
 * @param {object} row from cleanRow
 * @param {ReturnType<typeof buildMatchIndex>} index
 * @param {{ exclude?: Set<string> }} opts client ids not to report (the row's own, once made)
 * @returns {null | { state: 'same', by: 'email'|'phone', clientId, clientName }
 *   | { state: 'similar', by: 'name', clientId, clientName, name }}
 */
export function findMatch(row, index, { exclude = null } = {}) {
  const ok = (id) => index.clientsById.has(id) && !exclude?.has(id);
  const client = (id) => index.clientsById.get(id);
  for (const by of ['email', 'phone']) {
    const value = row.contact?.[by];
    const id = value ? (by === 'email' ? index.byEmail : index.byPhone).get(value)?.find(ok) : null;
    if (id) return { state: 'same', by, clientId: id, clientName: client(id).name };
  }
  const found = [];
  for (const name of new Set([row.client?.name, row.account?.name].filter(Boolean))) {
    for (const f of similarEntries(index, name)) if (ok(f.entry.clientId)) found.push(f);
  }
  if (!found.length) return null;
  // Exact name matches first, then by client name: the same answer every time.
  found.sort((x, y) => (y.exact - x.exact) || String(client(x.entry.clientId).name).localeCompare(String(client(y.entry.clientId).name)));
  const best = found[0];
  return { state: 'similar', by: 'name', clientId: best.entry.clientId, clientName: client(best.entry.clientId).name, name: best.entry.name };
}

/**
 * Flags for a batch of clean rows, in order: a row with problems is 'invalid'; one matching a
 * client already here is 'same' / 'similar' (findMatch); one with the same email, phone or name
 * as an earlier row of the batch is 'duplicate' (`duplicateOf` = that row's index); else 'new'.
 * @param {object[]} rows clean rows
 * @param {{ exclude?: (i: number) => Set<string>|null }} opts per row: client ids to ignore (its own)
 * @returns {Array<{ state, match?, duplicateOf? }>}
 */
export function flagRows(rows, index, { exclude = () => null } = {}) {
  const emails = new Map();
  const phones = new Map();
  const names = new Map();
  return rows.map((row, i) => {
    let flag;
    if (row.problems?.length) {
      flag = { state: 'invalid' };
    } else {
      const match = findMatch(row, index, { exclude: exclude(i) });
      if (match) {
        flag = { state: match.state, match };
      } else {
        const key = nameKey(row.client.name);
        let dup = row.contact?.email ? emails.get(row.contact.email) : undefined;
        if (dup === undefined && row.contact?.phone) dup = phones.get(row.contact.phone);
        if (dup === undefined) dup = names.get(key);
        flag = dup === undefined ? { state: 'new' } : { state: 'duplicate', duplicateOf: dup };
      }
      const key = nameKey(row.client.name);
      if (row.contact?.email && !emails.has(row.contact.email)) emails.set(row.contact.email, i);
      if (row.contact?.phone && !phones.has(row.contact.phone)) phones.set(row.contact.phone, i);
      if (key && !names.has(key)) names.set(key, i);
    }
    return flag;
  });
}

/** What a person may do with a row in this state; the first is the default. */
export function actionsFor(state, { canAdd = true } = {}) {
  switch (state) {
    case 'new': return ['create', 'skip'];
    case 'same':
    case 'similar': return canAdd ? ['skip', 'add', 'create'] : ['skip', 'create'];
    case 'changed': return canAdd ? ['skip', 'add', 'create'] : ['skip', 'create'];
    case 'imported':
    case 'duplicate': return ['skip', 'create'];
    default: return ['skip'];
  }
}

export const ACTION_LABELS = Object.freeze({
  create: 'Create', skip: 'Skip', add: 'Add only what’s missing',
});

// ---- the records a row makes -------------------------------------------------------------------

const without = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

/**
 * The records to create for a clean row, in order (each one's parents first):
 *  - action 'create': a new client, its account, a relationship per business, the contact;
 *  - action 'add' (target = an existing client with its live accounts, contacts, relationships):
 *    only what is missing — the account with the same (or a similar) name, or the client's first
 *    one when the row named none of its own; a new account otherwise — relationships that account doesn't
 *    have (same business and kind), and the contact unless one with the same email or phone (or,
 *    with neither, the same name) is already on the client. Nothing existing is changed.
 * `makeId(key)` gives each new record its id (key: 'client' | 'account' | 'contact' | 'rel:<business>:<kind>'),
 * so a device can make them once and retry with the same ids.
 * @returns {{ ops: Array<{ key, entity, id, fields }>, clientId, accountId, summary: {
 *   client: 'new'|'existing', account: 'new'|'existing', relationships: Array<{business_id, kind, state}>,
 *   contact: 'new'|'existing'|null } }}
 */
export function planRow(row, { action = 'create', target = null, makeId }) {
  const ops = [];
  const summary = { client: 'new', account: 'new', relationships: [], contact: null };
  let clientId;
  let accountId = null;
  let accounts = [];
  let contacts = [];
  let rels = [];
  if (action === 'add') {
    if (!target?.client?.id) throw new Error('planRow: add needs the target client');
    clientId = target.client.id;
    summary.client = 'existing';
    accounts = [...(target.accounts ?? [])].sort((x, y) => String(x.name).localeCompare(String(y.name)) || (x.id < y.id ? -1 : 1));
    contacts = target.contacts ?? [];
    rels = target.relationships ?? [];
    const key = nameKey(row.account.name);
    const named = accounts.find((x) => nameKey(x.name) === key) ?? accounts.find((x) => similarNames(x.name, row.account.name));
    const ownName = key && key !== nameKey(row.client.name) && key !== nameKey(target.client.name);
    const pick = named ?? (!ownName ? accounts[0] : null);
    if (pick) {
      accountId = pick.id;
      summary.account = 'existing';
    }
  } else {
    clientId = makeId('client');
    ops.push({ key: 'client', entity: 'client', id: clientId, fields: without({ name: row.client.name, status: 'active', tags: row.client.tags, notes: row.client.notes }) });
  }
  if (!accountId) {
    accountId = makeId('account');
    const { name, ...rest } = row.account;
    ops.push({ key: 'account', entity: 'account', id: accountId, fields: without({ client_id: clientId, name: name ?? row.client.name, ...rest }) });
  }
  for (const r of row.relationships) {
    // On an existing account: missing when no account of the client has it. On a new one: always.
    const has = summary.account === 'existing' && rels.some((x) => x.business_id === r.business_id && x.kind === r.kind);
    summary.relationships.push({ business_id: r.business_id, kind: r.kind, state: has ? 'existing' : 'new' });
    if (has) continue;
    const key = `rel:${r.business_id}:${r.kind}`;
    ops.push({ key, entity: 'relationship', id: makeId(key), fields: without({ account_id: accountId, business_id: r.business_id, kind: r.kind, status: 'active', notes: r.notes }) });
  }
  if (row.contact) {
    const c = row.contact;
    const known = contacts.find((x) => (c.email && x.email === c.email) || (c.phone && x.phone === c.phone)
      || (!c.email && !c.phone && nameKey(x.name) === nameKey(c.name)));
    if (known) {
      summary.contact = 'existing';
    } else {
      summary.contact = 'new';
      ops.push({ key: 'contact', entity: 'contact', id: makeId('contact'), fields: without({ client_id: clientId, account_id: accountId, ...c }) });
    }
  }
  return { ops, clientId, accountId, summary };
}

// ---- imports: remembering rows ----------------------------------------------------------------

/**
 * The text an imported row is remembered by (the server hashes it): every value of the clean
 * row except the relationships — the business picked for an import is a choice made then, not
 * part of the customer list, so importing the same file again for another business is still
 * "imported before". Same file, same text; any edited value, a different text.
 */
export function fingerprintText(row) {
  const a = row.account;
  const c = row.contact ?? {};
  return JSON.stringify([
    'v1', nameKey(row.client.name), row.client.tags, row.client.notes,
    nameKey(a.name), a.street, a.city, a.region, a.postal_code, a.country, a.website, a.notes,
    nameKey(c.name), c.role, c.email, c.phone, c.notes,
  ].map((v) => v ?? null));
}

/** Which customer a row is about (to tell "changed since last import" from "new"): its client name. */
export function rowKey(row) {
  return nameKey(row.client.name);
}

// ---- accounting customer lists (CSV) ------------------------------------------------------------

/** The columns an import can use, in the order the mapping screen shows them. */
export const MAPPING_FIELDS = Object.freeze([
  { key: 'name', label: 'Client name', hint: 'The customer’s display name' },
  { key: 'company', label: 'Business (account) name', hint: 'Company / organisation; the client name when empty' },
  { key: 'contact', label: 'Contact name' },
  { key: 'first', label: 'Contact first name' },
  { key: 'last', label: 'Contact last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'street', label: 'Street' },
  { key: 'street2', label: 'Street, line 2' },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'Province / state' },
  { key: 'postal', label: 'Postal / ZIP code' },
  { key: 'country', label: 'Country' },
  { key: 'website', label: 'Website' },
  { key: 'notes', label: 'Notes' },
]);
export const MAPPING_KEYS = Object.freeze(MAPPING_FIELDS.map((f) => f.key));

// Header patterns from QuickBooks (Online and Desktop), Wave, Xero and FreshBooks customer
// exports, tested against the header in lowercase with punctuation as spaces. First match wins;
// each column is used once. Shipping ("SA…", "Ship to") columns are left for the person to pick.
const HEADER_PATTERNS = [
  ['name', /^(customer( full)?( name)?|customer display name|display name|client( name)?|contactname|contact name xero|name)$/],
  ['company', /^(company( name)?|organi[sz]ation( name)?|business( name)?|account name|legal name)$/],
  ['first', /^((contact|primary contact) )?first ?name$/],
  ['last', /^((contact|primary contact) )?last ?name$/],
  ['contact', /^(primary contact|contact( name| person)?|full name|attention|po ?attention ?to)$/],
  ['email', /^((main|primary|billing|contact) )?e ?mail( address)?$|^emailaddress$|^e mail address$/],
  ['mobile', /^(mobile|cell)( phone| number)?$|^mobilenumber$/],
  ['phone', /^((main|business|work|primary|billing|contact) )?phone( numbers?)?$|^phonenumber$|^telephone$|^tel$/],
  ['street', /^((billing|bill to|po|mailing) )?(street|address)( address)?( line)?( ?1)?$|^bill to 1$|^billing address line 1$|^poaddressline1$|^address line 1$|^street address$/],
  ['street2', /^((billing|po|mailing) )?(street|address)( line)? ?2$|^bill to 2$|^billing address line 2$|^poaddressline2$/],
  ['city', /^((billing|po|mailing) )?(city|town)$|^pocity$|^city town$/],
  ['region', /^((billing|po|mailing) )?(province( state)?|state( province)?|region|province or state|state or province)$|^poregion$|^province state$/],
  ['postal', /^((billing|po|mailing) )?(postal( code)?( zip( code)?)?|zip( code)?( postal code)?|post ?code)$|^popostalcode$|^postal code zip$/],
  ['country', /^((billing|po|mailing) )?country$|^pocountry$/],
  ['website', /^(website|web site|web|url|website url)$/],
  ['notes', /^(notes?|memo|comments?|customer notes)$/],
];

function headerText(h) {
  return String(h ?? '').toLowerCase().replace(/^\*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Guess which column holds what from the headers, and which program made the file.
 * @returns {{ mapping: { [field]: number|null }, source: 'QuickBooks'|'Wave'|'Xero'|'FreshBooks'|null }}
 */
export function detectMapping(headers) {
  const texts = headers.map(headerText);
  const mapping = Object.fromEntries(MAPPING_KEYS.map((k) => [k, null]));
  const used = new Set();
  for (const [field, re] of HEADER_PATTERNS) {
    if (mapping[field] !== null) continue;
    const i = texts.findIndex((t, idx) => !used.has(idx) && re.test(t));
    if (i >= 0) {
      mapping[field] = i;
      used.add(i);
    }
  }
  const has = (re) => texts.some((t) => re.test(t));
  let source = null;
  if (has(/^contactname$|^poaddressline1$|^emailaddress$/)) source = 'Xero';
  else if (has(/^customer name$/) && has(/^contact first name$/)) source = 'Wave';
  else if (has(/^organization$/) && has(/^first name$/)) source = 'FreshBooks';
  else if (has(/^customer( full name)?$|^bill to 1$|^open balance$|^main phone$/)) source = 'QuickBooks';
  return { mapping, source };
}

/** A mapping from a request: field -> column index within `width`, or null. Anything else -> null. */
export function checkMapping(mapping, width) {
  const out = Object.fromEntries(MAPPING_KEYS.map((k) => [k, null]));
  if (!mapping || typeof mapping !== 'object') return out;
  for (const k of MAPPING_KEYS) {
    const v = mapping[k];
    if (Number.isInteger(v) && v >= 0 && v < width) out[k] = v;
  }
  return out;
}

/**
 * One CSV row through the column mapping -> a row (as typed). The client is the customer's
 * name (else the business's, else the contact's); the account is the business name (else the
 * client's); a second number (mobile) goes in the contact's notes.
 * @param {string[]} cells
 * @param {object} mapping field -> column index
 * @param {{ relationships?: Array<{business_id, kind}> }} opts what our business does for them
 */
export function rowFromCells(cells, mapping, { relationships = [] } = {}) {
  const get = (k) => (mapping[k] === null || mapping[k] === undefined ? '' : squash(cells[mapping[k]]));
  const person = get('contact') || squash(`${get('first')} ${get('last')}`);
  const company = get('company');
  const clientName = get('name') || company || person;
  const phone = get('phone');
  const mobile = get('mobile');
  const street = [get('street'), get('street2')].filter(Boolean).join(', ');
  return {
    client: { name: clientName, notes: mapping.notes === null || mapping.notes === undefined ? '' : String(cells[mapping.notes] ?? '').trim() },
    account: { name: company || clientName, street, city: get('city'), region: get('region'), postal_code: get('postal'), country: get('country'), website: get('website') },
    relationships,
    contact: {
      name: person,
      email: get('email'),
      phone: phone || mobile,
      notes: phone && mobile && phone !== mobile ? `Mobile: ${mobile}` : '',
    },
  };
}
