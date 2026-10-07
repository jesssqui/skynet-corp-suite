// One clean, stored format for contact details, so the same email or phone typed two ways
// is the same value (matching across businesses, D2, compares them with `=`).
//
// The device normalises a value before it makes the change step (the sync engine does it for
// every field with a `format`), and the server refuses a value that isn't already in this
// format — so a phone and the server always agree on what was saved. Server code writing with
// applyLocal (imports, automations) gets the same normalising.
//
// Each normaliser takes what a person typed and returns the stored form, or null for "nothing"
// (empty or only spaces). It doesn't decide validity: `valid` does, on the stored form.

/** " Bob@Example.COM " -> "bob@example.com" (trimmed, lowercase). */
export function normalizeEmail(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase();
  return s === '' ? null : s;
}

/** A plausible single address (one @, a dot in the domain, no spaces), at most 254 characters. */
export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// "… ext. 22", "… x22", "… #22" at the end: an extension, not part of the number.
const EXTENSION_RE = /\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i;

/**
 * Digits only, with North American numbers in their 10-digit form:
 * "+1 (519) 555-0100", "519.555.0100" and "1-519-555-0100" are all "5195550100".
 * An extension at the end ("x22", "ext. 22") is dropped: keep it in the contact's notes.
 * Other countries' numbers keep every digit of their international form ("+44 20 …" -> "4420…").
 */
export function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(EXTENSION_RE, '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1); // +1 = North America
  return digits === '' ? null : digits;
}

/** 7 to 15 digits (15 = the international maximum, E.164). */
export function isPhone(value) {
  return typeof value === 'string' && /^\d{7,15}$/.test(value);
}

/** "n3y4k3" -> "N3Y 4K3" (Canadian postal codes get their space); others: uppercase, single spaces. */
export function normalizePostalCode(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toUpperCase().replace(/\s+/g, ' ');
  if (s === '') return null;
  const ca = /^([A-Z]\d[A-Z]) ?(\d[A-Z]\d)$/.exec(s);
  return ca ? `${ca[1]} ${ca[2]}` : s;
}

export function isPostalCode(value) {
  return typeof value === 'string' && value.length <= 12 && /^[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?$/.test(value);
}

/**
 * Tags as one text: "vip, referral". Splits on commas, semicolons and new lines, trims and
 * collapses spaces, drops empty ones and repeats (case-insensitive, the first spelling stays),
 * keeps the order given. Accepts an array too.
 */
export function normalizeTags(input) {
  if (input === null || input === undefined) return null;
  const parts = Array.isArray(input) ? input.map(String) : String(input).split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const tag = p.replace(/[,;]/g, ' ').trim().replace(/\s+/g, ' ');
    const k = tag.toLowerCase();
    if (!tag || seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
  }
  return out.length ? out.join(', ') : null;
}

/** "vip, referral" -> ['vip', 'referral'] */
export function parseTags(value) {
  return normalizeTags(value)?.split(', ') ?? [];
}

export function isTags(value) {
  return typeof value === 'string' && parseTags(value).every((t) => t.length <= 60);
}

/**
 * Field formats (a synced text field's `format`): how to normalise and check a value.
 * `label` names it in messages.
 */
export const FORMATS = Object.freeze({
  email: { label: 'email address', normalize: normalizeEmail, valid: isEmail, stored: 'trimmed and lowercase' },
  phone: { label: 'phone number', normalize: normalizePhone, valid: isPhone, stored: 'digits only, 10 digits for North America' },
  postal: { label: 'postal code', normalize: normalizePostalCode, valid: isPostalCode, stored: 'uppercase, "A1A 1A1" in Canada' },
  tags: { label: 'list of tags', normalize: normalizeTags, valid: isTags, stored: '"tag, tag", no repeats' },
});
