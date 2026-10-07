// Field types of synced records, and the check of one value against its field.
//
// The same rules run on the server (sync module: every step it applies) and on
// devices (the offline store checks a change before it goes into the outbox), so
// a change the phone accepted while offline is one the server will accept too.
// A field definition is what GET /api/sync/info describes:
//   { name, type, required?, max? (text), values? (enum), format? (text), ref? (id) }
// `format` (email, phone, postal, tags — ./normalize.js) means the value is stored in one clean
// form: devices normalise before making the step (normalizeFieldValue), the server refuses a
// value that isn't normalised. `ref` names the entity an id points to (the server checks it
// exists; see the sync module); it needs no check here.

import { isId } from './ids.js';
import { FORMATS } from './normalize.js';

export { FORMATS };

export const DEFAULT_TEXT_MAX = 10_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validDate(v) {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** type -> (value, field) => true when valid (null is handled by checkFieldValue). */
export const FIELD_TYPES = Object.freeze({
  text: (v, f) => typeof v === 'string' && v.length <= (f.max ?? DEFAULT_TEXT_MAX),
  integer: (v) => Number.isSafeInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  date: (v) => typeof v === 'string' && validDate(v),
  datetime: (v) => typeof v === 'string' && DATETIME_RE.test(v) && !Number.isNaN(Date.parse(v)),
  id: (v) => isId(v),
  enum: (v, f) => typeof v === 'string' && Array.isArray(f.values) && f.values.includes(v),
});

/** null when `value` is valid for `field`, else a short message. */
export function checkFieldValue(field, value) {
  if (value === null) return field.required ? `${field.name} is required` : null;
  if (value === undefined) return `${field.name} has no value`;
  const check = FIELD_TYPES[field.type];
  if (!check) return `${field.name}: unknown type ${field.type}`;
  if (!check(value, field)) return `${field.name}: not a valid ${field.type}`;
  if (field.format) {
    const fmt = FORMATS[field.format];
    if (!fmt) return `${field.name}: unknown format ${field.format}`;
    if (fmt.normalize(value) !== value) return `${field.name}: not stored as a clean ${fmt.label} (${fmt.stored})`;
    if (!fmt.valid(value)) return `${field.name}: not a valid ${fmt.label}`;
  }
  return null;
}

/**
 * The stored form of a value a person typed, for a field with a `format` (others: unchanged).
 * "" or spaces become null. Devices call this before checking a change; so does applyLocal.
 */
export function normalizeFieldValue(field, value) {
  if (!field?.format || typeof value !== 'string') return value;
  const fmt = FORMATS[field.format];
  return fmt ? fmt.normalize(value) : value;
}
