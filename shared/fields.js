// Field types of synced records, and the check of one value against its field.
//
// The same rules run on the server (sync module: every step it applies) and on
// devices (the offline store checks a change before it goes into the outbox), so
// a change the phone accepted while offline is one the server will accept too.
// A field definition is what GET /api/sync/info describes:
//   { name, type, required?, max? (text), values? (enum) }

import { isId } from './ids.js';

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
  return check(value, field) ? null : `${field.name}: not a valid ${field.type}`;
}
