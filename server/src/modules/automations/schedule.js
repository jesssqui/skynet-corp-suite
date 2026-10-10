// Automation triggers (C8): when each automation runs, in plain English, and which period a
// moment belongs to. Times are the server's local time (the container's TZ, America/Toronto);
// every occurrence is built from the calendar day and "HH:MM" with the local Date constructor,
// so it stays at 8:00 a.m. across daylight-saving changes (a week with a change is 7 days ± 1 h).
//
// A trigger is one of:
//   { type: 'schedule', every: 'day', at: '07:30' }               every day at 7:30 a.m.
//   { type: 'schedule', every: 'week', day: 'fri', at: '08:00' }  every Friday at 8:00 a.m.
//   { type: 'schedule', every: 'month', at: '08:05' }             the first workday of each month (D8): the
//                                                                 month's first Monday–Friday (holidays aren't known)
//   { type: 'event', event: 'order.placed', label?, key(data) }   when an event happens (D packages)
//   { type: 'event', events: ['order.packed', 'order.shipped'], label?, key(data), accept?(data) }
//                                                                 when any of several events happens (D3);
//                                                                 accept(data) false = not this one (no run)
//
// A scheduled automation runs once per **period** (its day, its Monday–Sunday week, or its month): the run
// key is "<automation id>:<period key>" (period key "2026-10-08", ISO week "2026-W41" or "2026-10"). The
// scheduler runs it once the period's time has passed and that key has no successful scheduled
// run — so restarts, catch-ups and two servers never run a period twice, and after downtime only
// the current period is caught up (missed earlier ones are not run one by one).
import { localDate } from '@suite/shared/time';
import { addDays, weekStart, monthStart, addMonthStarts, weekday } from '@suite/shared/planner';

export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EVENT_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Throws unless `trigger` is a valid trigger (see the top of this file). */
export function checkTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') throw new Error('trigger: an object');
  if (trigger.type === 'schedule') {
    if (!TIME_RE.test(trigger.at ?? '')) throw new Error(`trigger.at: "HH:MM" (24-hour), got ${trigger.at}`);
    if (trigger.every === 'day' || trigger.every === 'month') return trigger;
    if (trigger.every === 'week') {
      if (!WEEKDAYS.includes(trigger.day)) throw new Error(`trigger.day: one of ${WEEKDAYS.join(', ')}`);
      return trigger;
    }
    throw new Error("trigger.every: 'day', 'week' or 'month'");
  }
  if (trigger.type === 'event') {
    if (trigger.events !== undefined) {
      if (trigger.event !== undefined) throw new Error('trigger: event or events, not both');
      if (!Array.isArray(trigger.events) || !trigger.events.length || !trigger.events.every((e) => EVENT_RE.test(e ?? ''))) {
        throw new Error('trigger.events: a list of names like "order.packed"');
      }
    } else if (!EVENT_RE.test(trigger.event ?? '')) {
      throw new Error(`trigger.event: a name like "order.placed", got ${trigger.event}`);
    }
    if (trigger.key !== undefined && typeof trigger.key !== 'function') throw new Error('trigger.key: (data) => the run key part');
    if (trigger.accept !== undefined && typeof trigger.accept !== 'function') throw new Error('trigger.accept: (data) => true to run');
    return trigger;
  }
  throw new Error("trigger.type: 'schedule' or 'event'");
}

/** "07:30" -> "7:30 a.m.", "12:00" -> "12:00 p.m.", "00:15" -> "12:15 a.m.". */
export function clockText(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/** The trigger in plain English: "Every Friday at 8:00 a.m.", "Every day at 7:30 a.m.". */
/** The event names an event trigger listens for (one or several). */
export function triggerEvents(trigger) {
  if (trigger?.type !== 'event') return [];
  return trigger.events ?? [trigger.event];
}

export function triggerText(trigger) {
  if (trigger.type === 'event') return trigger.label ?? `When ${triggerEvents(trigger).join(' or ')} happens`;
  const at = clockText(trigger.at);
  if (trigger.every === 'day') return `Every day at ${at}`;
  if (trigger.every === 'month') return `The first workday of each month at ${at}`;
  return `Every ${DAY_NAMES[WEEKDAYS.indexOf(trigger.day)]} at ${at}`;
}

/** Local time `hhmm` on the calendar day `ymd` ("2026-10-09", "08:00") as a Date. */
export function atLocal(ymd, hhmm) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
}

/** The first Monday–Friday of the month that starts on `first` ("YYYY-MM-01"). */
export function firstWorkday(first) {
  let d = first;
  while (['sat', 'sun'].includes(WEEKDAYS[weekday(d)])) d = addDays(d, 1);
  return d;
}

/** ISO 8601 week of a day: "2026-W41" (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeekKey(ymd) {
  const thursday = addDays(weekStart(ymd), 3);
  const [y, m, d] = thursday.split('-').map(Number);
  const dayOfYear = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000;
  return `${y}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, '0')}`;
}

/**
 * The period a moment falls in for a scheduled trigger:
 *   key        "2026-10-08" (day) or "2026-W41" (week)
 *   day        the calendar day it runs on in that period ("2026-10-09" for a Friday trigger)
 *   dueAt      when it runs in that period (Date)
 *   nextDueAt  when it runs in the next period (Date)
 *   start      the period's first day (the day itself, or its Monday)
 */
export function periodOf(trigger, now) {
  const today = localDate(now instanceof Date ? now : new Date(now));
  if (trigger.every === 'day') {
    return { key: today, start: today, day: today, dueAt: atLocal(today, trigger.at), nextDueAt: atLocal(addDays(today, 1), trigger.at) };
  }
  if (trigger.every === 'month') {
    const first = monthStart(today);
    const day = firstWorkday(first);
    return { key: first.slice(0, 7), start: first, day, dueAt: atLocal(day, trigger.at), nextDueAt: atLocal(firstWorkday(addMonthStarts(first, 1)), trigger.at) };
  }
  const monday = weekStart(today);
  const day = addDays(monday, WEEKDAYS.indexOf(trigger.day));
  return { key: isoWeekKey(monday), start: monday, day, dueAt: atLocal(day, trigger.at), nextDueAt: atLocal(addDays(day, 7), trigger.at) };
}
