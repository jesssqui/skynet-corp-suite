// The quick-add brain dump (C7), without React: one client per line in a loose format, parsed
// into a row (@suite/shared/intake's shape), cleaned, flagged against what is already on this
// device, and planned into records the page creates through the offline store. Tested in
// client/test/quickadd.test.js.
//
// A line: the client's name first, then anything, separated by " - ", "—", "–", ";", "|", a tab or ",":
//   - our businesses / relationship kinds from keywords: website, web, site, design, seo -> Great
//     White North Design (website); social, social media, instagram -> GWND (social); consulting,
//     coaching -> Business consulting; wholesale -> Wholesale ("social retainer": the extra words
//     go in that relationship's notes);
//   - emails and phone numbers anywhere; the words next to them are the contact's name;
//   - "account: …" (or "Client (Account)"), "contact: …" / "owner: …", "role: …", "tags: …",
//     "notes: …" (the rest of the line), #hashtags;
//   - a role ("Karen O'Neil, owner"); a person's name (capitalised words, "Jan de Vries") is the
//     contact; anything else goes into the client's notes — never dropped, never a junk tag.
//   Commas separate only on a line without a stronger separator; "Client: website" works too.
import { BUSINESS_IDS, RELATIONSHIP_KINDS } from '@suite/shared/crm';
import { cleanRow, buildMatchIndex, flagRows, actionsFor, squash } from '@suite/shared/intake';

export const EXAMPLE = [
  'Harbour Lights Bakery - website, social retainer - Ada Moss ada@harbourlights.test 519-555-0101',
  'Birch & Bark | consulting | Ben Cole | 519.555.0102',
  'Northwind Holdings (Green Leaf Dispensary) — website — owner: Robin Ortega robin@greenleaf.test',
  'Kettle Creek Outfitters; web; #referral; notes: wants a quote before spring',
  'Lakeview Dental',
].join('\n');

/** The relationships a person can pick per row (and as the default for lines without a keyword). */
export const RELATIONSHIP_CHOICES = Object.freeze([
  { id: 'agency:website', business_id: BUSINESS_IDS.agency, kind: 'website' },
  { id: 'agency:social', business_id: BUSINESS_IDS.agency, kind: 'social' },
  { id: 'consulting:consulting', business_id: BUSINESS_IDS.consulting, kind: 'consulting' },
  { id: 'wholesale:wholesale', business_id: BUSINESS_IDS.wholesale, kind: 'wholesale' },
]);
export const choiceId = (r) => `${Object.entries(BUSINESS_IDS).find(([, id]) => id === r.business_id)?.[0] ?? r.business_id}:${r.kind}`;
export const choiceById = (id) => RELATIONSHIP_CHOICES.find((c) => c.id === id) ?? null;

// ---- keywords ---------------------------------------------------------------------------------

const AGENCY_WEB = { business_id: BUSINESS_IDS.agency, kind: 'website' };
const AGENCY_SOCIAL = { business_id: BUSINESS_IDS.agency, kind: 'social' };
const CONSULTING = { business_id: BUSINESS_IDS.consulting, kind: 'consulting' };
const WHOLESALE = { business_id: BUSINESS_IDS.wholesale, kind: 'wholesale' };

// Longest phrases first (as word lists).
const KEYWORDS = [
  ['great white north design', AGENCY_WEB], ['social media', AGENCY_SOCIAL], ['web design', AGENCY_WEB], ['web site', AGENCY_WEB],
  ['website', AGENCY_WEB], ['websites', AGENCY_WEB], ['web', AGENCY_WEB], ['site', AGENCY_WEB], ['webdesign', AGENCY_WEB],
  ['design', AGENCY_WEB], ['seo', AGENCY_WEB], ['redesign', AGENCY_WEB], ['agency', AGENCY_WEB], ['gwnd', AGENCY_WEB],
  ['social', AGENCY_SOCIAL], ['smm', AGENCY_SOCIAL], ['instagram', AGENCY_SOCIAL], ['facebook', AGENCY_SOCIAL], ['tiktok', AGENCY_SOCIAL],
  ['consulting', CONSULTING], ['consult', CONSULTING], ['consultant', CONSULTING], ['coaching', CONSULTING], ['advisory', CONSULTING],
  ['wholesale', WHOLESALE], ['wholesaler', WHOLESALE],
].map(([phrase, rel]) => [phrase.split(' '), rel]).sort((a, b) => b[0].length - a[0].length);
const CONNECTORS = new Set(['and', '&', '+', '/', 'plus', 'n']);
// Words that may sit beside a keyword without making the segment something else ("social retainer").
const FILLERS = new Set([
  'retainer', 'build', 'rebuild', 'project', 'monthly', 'client', 'customer', 'work', 'services', 'service', 'package', 'plan',
  'refresh', 'maintenance', 'hosting', 'ads', 'management', 'strategy', 'growth', 'new', 'ongoing', 'support', 'audit', 'only',
  'ecommerce', 'e-commerce', 'shop', 'store', 'content', 'posts', 'marketing', 'manager', 'session', 'sessions', 'call', 'calls',
]);

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}&+/'-]+/gu, ' ').split(' ').filter(Boolean);

/** The relationships a segment names when it is only keywords (plus connectors and fillers), else null. */
function keywordSegment(text) {
  const ws = words(text);
  const found = [];
  let extra = false;
  for (let i = 0; i < ws.length;) {
    const hit = KEYWORDS.find(([phrase]) => phrase.every((w, j) => ws[i + j] === w));
    if (hit) {
      found.push(hit[1]);
      i += hit[0].length;
    } else if (CONNECTORS.has(ws[i])) {
      i += 1;
    } else if (FILLERS.has(ws[i])) {
      extra = true;
      i += 1;
    } else {
      return null;
    }
  }
  return found.length ? { relationships: found, notes: extra ? squash(text) : null } : null;
}

// ---- contact details ------------------------------------------------------------------------------

const EMAIL_RE = /(?:mailto:)?[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// A phone: optional +, digits with spaces ( ) . - between, an optional extension. 7–15 digits;
// dates (2026-03-01) aren't phones.
const PHONE_RE = /(?<![\p{L}\p{N}@])\+?\(?\d[\d\s().-]{4,}\d(?:\s*(?:ext\.?|x|#)\s*\d{1,6})?(?![\p{L}\p{N}@])/giu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MARK_RE = /⟦([ep])(\d+)⟧/g; // ⟦e0⟧ ⟦p1⟧ stand in for what was taken out

/**
 * Does this run of digits read as a phone number? A + / 00 / 011 or a bracketed area code, 10
 * digits, 11 starting with 1, or a 7-digit local number written "555-0100" (kept as typed, with
 * a warning). Not "15000 2026" (a budget and a year), not a date.
 */
function phoneLike(m) {
  const t = m.trim();
  const core = t.replace(/\s*(?:ext\.?|x|#)\s*\d+$/i, '');
  const digits = core.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || DATE_RE.test(t)) return false;
  if (/^(\+|\(|00|011)/.test(core)) return true;
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) return true;
  return /^\d{3}[\s.-]\d{4}$/.test(core);
}

function takeContacts(line) {
  const emails = [];
  const phones = [];
  let text = line.replace(EMAIL_RE, (m) => {
    emails.push(m.replace(/^mailto:/i, ''));
    return ` ⟦e${emails.length - 1}⟧ `;
  });
  // Never across a " - " separator ("budget 15000 2026 - 2 sessions" is no phone).
  text = text.split(/(\s+[-–—]+\s+)/).map((piece, i) => (i % 2 ? piece : piece.replace(PHONE_RE, (m) => {
    if (!phoneLike(m)) return m;
    phones.push(m.trim());
    return ` ⟦p${phones.length - 1}⟧ `;
  }))).join('');
  return { text, emails, phones };
}

// Separators. Commas count only on a line without a stronger one, so "Smith, Jones & Associates -
// consulting" and "Johnson, Mike - website" keep their names whole.
const STRONG_RE = /\s+[-–—]+\s+|\s*[—–|;\t]\s*/;
const ANY_RE = /\s+[-–—]+\s+|\s*[—–|;,\t]\s*/;
const TRAILING_RE = /[\s,;|—–-]+$/;
const BULLET_RE = /^\s*(?:[-*•·▪◦]|\d{1,3}[.)])\s+/;
const LABEL_RE = /^(account|acct|store|location|contact|attn|person|owner|manager|role|title|email|e-mail|mail|phone|tel|cell|mobile|ph)\s*[:=]\s*/i;
const ROLE_LABELS = { owner: 'Owner', manager: 'Manager' };
// "Karen O'Neil, owner" / a segment that is only a role.
const ROLES = new Set([
  'owner', 'co-owner', 'manager', 'gm', 'general manager', 'office manager', 'store manager', 'president', 'ceo', 'coo', 'cfo',
  'director', 'founder', 'co-founder', 'partner', 'bookkeeper', 'accountant', 'assistant', 'admin', 'marketing', 'buyer', 'principal',
]);
const roleOf = (text) => (ROLES.has(text.toLowerCase().replace(/\.$/, '')) ? text.charAt(0).toUpperCase() + text.slice(1) : null);
// Name particles that may be lowercase inside a name ("Jan de Vries", "Ludwig van Beethoven").
const PARTICLES = new Set(['de', 'da', 'di', 'du', 'del', 'della', 'der', 'den', 'van', 'von', 'la', 'le', 'st', 'st.', 'bin', 'al', 'and', '&']);

/**
 * A person's name, probably: 1–5 words, letters only, each capitalised except particles and "&"
 * ("Pat", "Jan de Vries", "Amy & Tom Baker", "Dr. Paula Quinn").
 */
function personLike(text) {
  const ws = text.split(/\s+/).filter(Boolean);
  if (!ws.length || ws.length > 5) return false;
  if (!ws.every((w) => PARTICLES.has(w.toLowerCase()) || /^\p{Lu}[\p{L}'’.-]*$/u.test(w))) return false;
  return /^\p{Lu}/u.test(ws[0]) && /^\p{Lu}/u.test(ws.at(-1)) && !keywordSegment(text);
}

/** Text that reads as a name next to an email/phone ("Ada Moss", "ada", "Dr. Lee"): no digits, 1–5 words. */
function nameLike(text) {
  const ws = text.split(/\s+/).filter(Boolean);
  return ws.length >= 1 && ws.length <= 5 && ws.every((w) => /^[\p{L}'’.&-]+$/u.test(w));
}

/**
 * One line -> a row as typed (cleanRow cleans it), plus `usedDefault` when it named none of our
 * businesses and got the page's default. Nothing is dropped: whatever isn't recognised goes into
 * the client's notes (shown in the preview). Only #hashtags and "tags:" make tags.
 * @param {string} line
 * @param {{ defaults?: Array<{business_id, kind}> }} opts relationships for lines without a keyword
 */
export function parseLine(line, { defaults = [] } = {}) {
  let rest = squash(String(line ?? '').replace(/\t/g, ' | ').replace(BULLET_RE, ''));
  const notes = []; // the client's notes: leftovers in line order, then "notes: …"
  let notesLabel = '';
  const tags = [];
  const labelTags = [];
  // "notes: …" takes the rest of the line (it may have commas).
  const n = /(?:^|[\s,;|—–-])(?:notes?|memo)\s*:\s*/i.exec(rest);
  if (n) {
    notesLabel = rest.slice(n.index + n[0].length).trim();
    rest = rest.slice(0, n.index).replace(TRAILING_RE, '');
  }
  // "tags: a, b" runs to the next separator other than a comma.
  const tg = /(?:^|[\s,;|—–-])tags?\s*:\s*/i.exec(rest);
  if (tg) {
    const after = rest.slice(tg.index + tg[0].length);
    const stop = STRONG_RE.exec(after);
    const list = stop ? after.slice(0, stop.index) : after;
    labelTags.push(...list.split(/\s*,\s*/).map(squash).filter(Boolean));
    rest = `${rest.slice(0, tg.index)}${stop ? ` | ${after.slice(stop.index + stop[0].length)}` : ''}`;
  }
  rest = rest.replace(/(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu, (_, sp, tag) => {
    tags.push(tag);
    return sp;
  });
  tags.push(...labelTags);
  rest = rest.replace(TRAILING_RE, '');
  const { text, emails, phones } = takeContacts(rest);

  const relationships = [];
  const contact = { name: '', role: '', email: emails[0] ?? '', phone: phones[0] ?? '', notes: '' };
  const contactNotes = [];
  const account = { name: '' };
  let clientName = '';
  const strong = STRONG_RE.test(text.replace(MARK_RE, ' '));
  let segments = text.split(strong ? STRONG_RE : ANY_RE).map(squash).filter((s) => s && !/^[-–—]+$/.test(s));
  // "Brantford Auto Body: website" — a colon after the client's name separates too.
  const colon = segments.length ? /^([^:]+?)\s*:\s+(.+)$/.exec(segments[0]) : null;
  if (colon && !LABEL_RE.test(segments[0])) segments = [colon[1], colon[2], ...segments.slice(1)];
  const contactName = (value) => {
    if (!contact.name && value) contact.name = value;
  };
  const keywords = (kw) => kw.relationships.forEach((r, j) => relationships.push({ ...r, notes: j === kw.relationships.length - 1 ? kw.notes : null }));

  segments.forEach((segment, i) => {
    const marks = [...segment.matchAll(MARK_RE)];
    let plain = squash(segment.replace(MARK_RE, ' ').replace(/^(?:email|e-mail|mail|phone|tel|cell|mobile|ph)\b\s*[:=]?\s*/i, ''));
    if (!/[\p{L}\p{N}]/u.test(plain)) plain = ''; // "/" or "+" left between two numbers
    if (i === 0) {
      // The client's name ("Client (Their business)" names the account too).
      const paren = /^(.*?)\s*\(([^()]+)\)\s*(.*)$/.exec(plain);
      if (paren && paren[1]) {
        clientName = squash(`${paren[1]} ${paren[3]}`);
        account.name = squash(paren[2]);
      } else {
        clientName = plain;
      }
      return;
    }
    if (!plain) return; // only an email/phone (already taken), or punctuation
    const label = LABEL_RE.exec(plain);
    if (label) {
      const key = label[1].toLowerCase();
      const value = squash(plain.slice(label[0].length));
      if (['account', 'acct', 'store', 'location'].includes(key)) account.name = value;
      else if (['role', 'title'].includes(key)) contact.role = value;
      else if (['contact', 'attn', 'person', 'owner', 'manager'].includes(key)) {
        contactName(value);
        if (ROLE_LABELS[key] && !contact.role) contact.role = ROLE_LABELS[key];
      } else if (value) notes.push(value); // "email: …" with text that wasn't an address
      return;
    }
    // "Karen O'Neil, owner": a name and a role.
    const withRole = /^(.+?),\s*([^,]+)$/.exec(plain);
    if (withRole && roleOf(withRole[2]) && (personLike(withRole[1]) || nameLike(withRole[1]))) {
      contactName(withRole[1]);
      if (!contact.role) contact.role = roleOf(withRole[2]);
      return;
    }
    if (marks.length) {
      if (nameLike(plain) && !contact.name) contactName(plain);
      else notes.push(plain);
      return;
    }
    // "website, social retainer" on a line with stronger separators: each comma part on its own.
    const parts = plain.split(/\s*,\s*/).filter(Boolean);
    const kws = parts.map(keywordSegment);
    if (kws.every(Boolean)) {
      kws.forEach(keywords);
      return;
    }
    const kw = keywordSegment(plain);
    if (kw) {
      keywords(kw);
      return;
    }
    if (roleOf(plain)) {
      if (!contact.role) contact.role = roleOf(plain);
      else notes.push(plain);
    } else if (!contact.name && personLike(plain)) contact.name = plain;
    else notes.push(plain); // "2 sessions", "net 30", "Simcoe": kept, never junk tags
  });

  for (const e of emails.slice(1)) contactNotes.push(`Also: ${e}`);
  for (const p of phones.slice(1)) contactNotes.push(`Also: ${p}`);
  contact.notes = contactNotes.join('\n');
  if (notesLabel) notes.push(notesLabel);
  const usedDefault = relationships.length === 0 && defaults.length > 0;
  return {
    client: { name: clientName, tags: tags.join(', '), notes: notes.join('\n') },
    account,
    relationships: usedDefault ? defaults.map((d) => ({ business_id: d.business_id, kind: d.kind })) : relationships,
    contact,
    usedDefault,
  };
}

/**
 * The brain dump's lines, each with a stable key: the line's text plus which copy of it this is
 * (two identical lines are two rows), so edits and "already added" survive typing elsewhere.
 * @returns {Array<{ key, number, text }>} number = line number in the box (1-based)
 */
export function splitLines(text) {
  const seen = new Map();
  const out = [];
  String(text ?? '').split(/\r\n|\r|\n/).forEach((raw, i) => {
    const t = squash(raw);
    if (!t || !/[\p{L}\p{N}]/u.test(t)) return;
    const copy = (seen.get(t) ?? 0) + 1;
    seen.set(t, copy);
    out.push({ key: `${copy}\u0001${t}`, number: i + 1, text: t });
  });
  return out;
}

/**
 * Every row of the box, cleaned and flagged against what is on this device.
 * @param {string} text
 * @param {object} opts
 * @param {object} opts.data { clients, accounts, contacts } (the device's copy)
 * @param {Array} opts.defaults relationships for lines without a keyword
 * @param {Map<string, object>} opts.edits row key -> row as typed, replacing the parsed one
 * @param {Map<string, {action, status}>} opts.choices row key -> what the person chose, for that status
 * @param {Map<string, {ids, done, clientId}>} opts.session rows already (partly) created here
 * @param {object} [opts.index] a buildMatchIndex result (built once per data change)
 */
export function buildRows(text, { data, defaults = [], edits = new Map(), choices = new Map(), session = new Map(), index = null }) {
  const lines = splitLines(text);
  const typed = lines.map((l) => edits.get(l.key) ?? parseLine(l.text, { defaults }));
  const clean = typed.map((t) => cleanRow(t));
  const idx = index ?? buildMatchIndex(data ?? {});
  const flags = flagRows(clean, idx, { exclude: (i) => { const id = session.get(lines[i].key)?.ids?.client; return id ? new Set([id]) : null; } });
  return lines.map((l, i) => {
    const s = session.get(l.key);
    const flag = flags[i];
    const status = s?.done ? 'done' : flag.state;
    const actions = status === 'done' ? [] : actionsFor(status, { canAdd: true });
    const chosen = choices.get(l.key);
    const action = chosen && chosen.status === status && actions.includes(chosen.action) ? chosen.action : (actions[0] ?? null);
    return {
      key: l.key,
      line: l.number,
      text: l.text,
      typed: typed[i],
      clean: clean[i],
      edited: edits.has(l.key),
      usedDefault: Boolean(typed[i].usedDefault),
      status,
      match: flag.match ?? null,
      duplicateOf: flag.duplicateOf === undefined ? null : lines[flag.duplicateOf].number,
      actions,
      action,
      clientId: s?.clientId ?? null,
    };
  });
}

/** An existing client with what planRow's 'add' needs, from the device's copy. */
export function targetFrom(data, clientId) {
  const client = data.clients.find((c) => c.id === clientId);
  if (!client) return null;
  const accounts = data.accounts.filter((a) => a.client_id === clientId);
  const accountIds = new Set(accounts.map((a) => a.id));
  return {
    client,
    accounts,
    contacts: data.contacts.filter((p) => p.client_id === clientId),
    relationships: data.relationships.filter((r) => accountIds.has(r.account_id)),
  };
}

/** How many rows each button press would touch: { create, add, skip }. */
export function saveCounts(rows) {
  const out = { create: 0, add: 0, skip: 0 };
  for (const r of rows) if (r.status !== 'done' && r.status !== 'invalid' && out[r.action] !== undefined) out[r.action] += 1;
  return out;
}

/** The typed row with one field changed (path 'client.name', 'contact.email', …). */
export function editRow(typed, path, value) {
  const [part, field] = path.split('.');
  return { ...typed, [part]: { ...(typed[part] ?? {}), [field]: value } };
}

/** The typed row with a relationship choice switched on or off. */
export function toggleRelationship(typed, choice, on) {
  const others = (typed.relationships ?? []).filter((r) => !(r.business_id === choice.business_id && r.kind === choice.kind));
  return { ...typed, usedDefault: false, relationships: on ? [...others, { business_id: choice.business_id, kind: choice.kind, notes: null }] : others };
}

export const isKind = (k) => RELATIONSHIP_KINDS.includes(k);
