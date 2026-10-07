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

// Characters that are invisible but would make two equal-looking values differ (zero-width
// spaces/joiners, word joiner, byte-order mark, soft hyphen) — pasted from web pages and PDFs.
const INVISIBLE_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/**
 * " Bob@Example.COM " -> "bob@example.com": Unicode NFC (one encoding for accented letters),
 * invisible characters removed, trimmed, lowercase.
 */
export function normalizeEmail(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).normalize('NFC').replace(INVISIBLE_RE, '').trim().toLowerCase();
  return s === '' ? null : s;
}

/** A plausible single address (one @, a dot in the domain, no spaces), at most 254 characters. */
export function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// "… ext. 22", "… x22", "… #22" at the end: an extension, not part of the number.
const EXTENSION_RE = /\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i;
// A North American (NANP) number without its +1: area code and exchange each start with 2–9.
const NANP_RE = /^[2-9]\d{2}[2-9]\d{6}$/;
const INTERNATIONAL_RE = /^\+[2-9]\d{6,14}$/; // E.164: country code (not 1) + number, 7–15 digits

/**
 * The stored form of a phone number — one of two shapes, so a number has exactly one spelling
 * and two different numbers never share one:
 *  - North America (+1): the 10 digits, "5195550100" — from "(519) 555-0100", "519.555.0100",
 *    "1-519-555-0100" or "+1 519 555 0100". Exactly 10: a 7-digit local number is refused
 *    (the same 7 digits exist in every area code, and D2 would link strangers).
 *  - Anywhere else: "+" and the digits with the country code, "+4312345678" — typed with "+",
 *    "00" or "011" in front. Without one it is refused rather than guessed: "(431) 234-5678"
 *    (North American) and "+43 1 2345678" (Vienna) must not both become "4312345678", nor a
 *    Chinese mobile "138 0013 8000" turn into the North American "380 013 8000".
 * An extension at the end ("x22", "ext. 22") is dropped: keep it in the contact's notes.
 * Returns what was typed in that shape; isPhone() says whether it is a valid one.
 */
export function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  const typed = String(input).replace(EXTENSION_RE, '').trim();
  let digits = typed.replace(/\D/g, '');
  if (digits === '') return null;
  let international = typed.startsWith('+');
  if (!international && /^(00|011)/.test(digits)) {
    digits = digits.replace(/^(00|011)/, ''); // dialled with an international prefix
    international = true;
  }
  if (international) return digits.startsWith('1') ? digits.slice(1) : `+${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && NANP_RE.test(digits.slice(1))) return digits.slice(1);
  return digits;
}

/** A stored phone: a North American 10-digit number or "+" with an international one. */
export function isPhone(value) {
  return typeof value === 'string' && (NANP_RE.test(value) || INTERNATIONAL_RE.test(value));
}

/** A stored phone for reading: "5195550100" -> "(519) 555-0100"; international ones as stored. */
export function formatPhone(stored) {
  if (typeof stored !== 'string') return stored ?? null;
  if (/^\d{10}$/.test(stored)) return `(${stored.slice(0, 3)}) ${stored.slice(3, 6)}-${stored.slice(6)}`;
  return stored;
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
  email: { label: 'email address', normalize: normalizeEmail, valid: isEmail, stored: 'trimmed, lowercase, NFC' },
  phone: {
    label: 'phone number', normalize: normalizePhone, valid: isPhone,
    stored: '10 digits for North America, "+" and the country code for others',
  },
  postal: { label: 'postal code', normalize: normalizePostalCode, valid: isPostalCode, stored: 'uppercase, "A1A 1A1" in Canada' },
  tags: { label: 'list of tags', normalize: normalizeTags, valid: isTags, stored: '"tag, tag", no repeats' },
});
