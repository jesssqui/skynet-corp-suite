// Dates and times for reading, in the device's local time zone (CLAUDE.md "Times"):
// calendar dates are "YYYY-MM-DD" (never new Date('YYYY-MM-DD'): that is UTC midnight and shows
// the day before west of UTC), moments are nowIso() strings (UTC). Plain functions (no React),
// so pages and tests share them.
import { localDate, nowIso, parseLocalDate } from '@suite/shared/time';

export { localDate, nowIso, parseLocalDate };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-10-07" -> "Oct 7, 2026" (local calendar; '' for nothing, the text itself if it isn't a date). */
export function formatDate(ymd, { weekday = false } = {}) {
  if (!ymd) return '';
  if (!DATE_RE.test(ymd)) return String(ymd);
  return parseLocalDate(ymd).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' } : {}),
  });
}

/** An ISO moment -> "Oct 7, 2026, 2:05 PM" in local time. */
export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** An ISO moment -> its local calendar day, for reading ("Oct 7, 2026"). */
export function formatDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : formatDate(localDate(d));
}

/** An ISO moment -> the value of an <input type="datetime-local"> ("2026-10-07T14:05", local time). */
export function toDateTimeInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The value of an <input type="datetime-local"> (local time) -> an ISO moment, or null if it isn't one. */
export function fromDateTimeInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : nowIso(d);
}
