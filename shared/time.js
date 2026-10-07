// One timestamp format everywhere: ISO-8601 in UTC with milliseconds and a "Z",
// made in JavaScript (not SQLite's datetime('now'), which drops the "Z" and the
// milliseconds and is easy to misread as local time). It sorts correctly as text.
//
// Calendar dates with no time (due dates, order dates) are plain "YYYY-MM-DD"
// strings in the user's local calendar; never turn them into Date objects with
// new Date('YYYY-MM-DD') — that parses as UTC midnight and shifts a day west of UTC.

/** Current time as "2026-10-06T14:03:22.120Z". */
export function nowIso(date = new Date()) {
  return date.toISOString();
}

/** A Date's local calendar date as "YYYY-MM-DD". */
export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse "YYYY-MM-DD" as local midnight (not UTC). */
export function parseLocalDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!m) throw new TypeError(`Not a YYYY-MM-DD date: ${value}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
