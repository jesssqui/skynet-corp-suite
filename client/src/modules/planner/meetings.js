// Meetings from Apple Calendar (C6b) on devices, no React (client/test/meetings.test.js). The `meeting`
// records are synced and read-only (the server writes them from each person's iCloud calendars), so
// Today, the morning plan and the day's load have them offline. Each person sees only their own.
//
// Days are the device's local calendar days, like tasks': a timed meeting's instants (start_at, end_at)
// are placed with the device's clock; an all-day one by its dates (start_date … end_date, inclusive).
// The load counts **busy timed** meetings only — all-day events (a holiday, a trip), ones shown as
// "free", and (review decision) timed events lasting 24 hours or more (a conference or trip entered with
// times: like all-day ones, they would otherwise fill whole days) are listed but add nothing — and overlapping
// meetings count once (the time they cover, not the sum), clipped to the day (a meeting past midnight counts
// on each day for its part).
import { parseLocalDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';

const MIN = 60_000;
/** A timed event this long or longer counts like an all-day one (listed, not in the load). */
export const LONG_EVENT_MS = 24 * 60 * MIN;
/** [start, end) of a local day in ms (23 or 25 hours across DST). */
export function dayBounds(day) {
  return [parseLocalDate(day).getTime(), parseLocalDate(addDays(day, 1)).getTime()];
}

/** The person's own meetings. */
export const myMeetings = (meetings, me) => (meetings ?? []).filter((m) => m.actor === me);

/** A timed meeting's span in ms (null when it has none — all day, or unreadable). */
export function meetingSpan(m) {
  if (m.all_day || !m.start_at) return null;
  const s = Date.parse(m.start_at);
  const e = Date.parse(m.end_at ?? m.start_at);
  if (!Number.isFinite(s)) return null;
  return [s, Number.isFinite(e) && e > s ? e : s];
}

/** Is the meeting on this local day? */
export function isOnDay(m, day) {
  if (m.all_day || !m.start_at) return Boolean(m.start_date) && m.start_date <= day && (m.end_date ?? m.start_date) >= day;
  const span = meetingSpan(m);
  if (!span) return false;
  const [a, b] = dayBounds(day);
  return span[1] > span[0] ? span[0] < b && span[1] > a : span[0] >= a && span[0] < b;
}

/** Order: all-day first, then by start, then title. */
export function compareMeetings(a, b) {
  if (Boolean(a.all_day) !== Boolean(b.all_day)) return a.all_day ? -1 : 1;
  const as = a.start_at ?? a.start_date ?? '';
  const bs = b.start_at ?? b.start_date ?? '';
  if (as !== bs) return as < bs ? -1 : 1;
  return String(a.title).localeCompare(String(b.title)) || (a.id < b.id ? -1 : 1);
}

/** This person's meetings on a day, in time order. */
export function meetingsOn(meetings, { me, day }) {
  return myMeetings(meetings, me).filter((m) => isOnDay(m, day)).sort(compareMeetings);
}

/** Minutes covered by busy timed meetings on the day (overlaps counted once, clipped to the day). */
export function busyMinutes(meetings, { me, day }) {
  const [a, b] = dayBounds(day);
  const spans = [];
  for (const m of myMeetings(meetings, me)) {
    if (!m.busy) continue;
    const span = meetingSpan(m);
    if (!span || span[1] - span[0] >= LONG_EVENT_MS) continue;
    const s = Math.max(span[0], a);
    const e = Math.min(span[1], b);
    if (e > s) spans.push([s, e]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur = null;
  for (const [s, e] of spans) {
    if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / MIN);
}

/** Busy minutes per day from `from` to `to` (inclusive): Map<day, minutes> (days with none left out). */
export function busyMinutesByDay(meetings, { me, from, to }) {
  const out = new Map();
  const mine = myMeetings(meetings, me).filter((m) => {
    const span = m.busy && meetingSpan(m);
    return span && span[1] - span[0] < LONG_EVENT_MS;
  });
  if (!mine.length) return out;
  const days = new Set();
  for (const m of mine) {
    // Each local day the meeting touches (normally one).
    const [s, e] = meetingSpan(m);
    for (let t = s, n = 0; t < Math.max(e, s + 1) && n < 400; n += 1) {
      const d = new Date(t);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (day >= from && (!to || day <= to)) days.add(day);
      t = dayBounds(day)[1];
    }
  }
  for (const day of days) {
    const minutes = busyMinutes(mine, { me, day });
    if (minutes) out.set(day, minutes);
  }
  return out;
}

const timeOf = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "9:00 AM – 10:00 AM", "All day", "Until 10:00 AM" (began the day before), "From 11:00 PM" (ends after it). */
export function meetingTimeText(m, day) {
  if (m.all_day || !m.start_at) return 'All day';
  const [s, e] = meetingSpan(m);
  const [a, b] = dayBounds(day);
  if (s < a && e > b) return 'All day';
  if (s < a) return `Until ${timeOf(e)}`;
  if (e > b) return `From ${timeOf(s)}`;
  return e > s ? `${timeOf(s)} – ${timeOf(e)}` : timeOf(s);
}

/** Has it ended (timed meetings, by the clock)? */
export function meetingOver(m, nowMs) {
  const span = meetingSpan(m);
  return Boolean(span) && span[1] <= nowMs;
}
