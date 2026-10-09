// iCalendar (RFC 5545) for the task calendar feed (C6a). Pure: no database, no clock of its own.
//
//  - Lines end in CRLF and are folded at 75 octets (a continuation line starts with one space),
//    never inside a UTF-8 character.
//  - TEXT values escape \ ; , and newlines; other control characters are dropped.
//  - All-day events: DTSTART;VALUE=DATE + DTEND the next day (DTEND is exclusive).
//  - Timed events: DTSTART/DTEND;TZID=<zone> with the zone's VTIMEZONE in the feed, built from the
//    zone's real transitions in the feed's window (Intl's time-zone data), so the event stays at
//    09:00 local on both sides of a DST change whatever the subscriber's own zone.
import { addDays } from '@suite/shared/planner';

const CRLF = '\r\n';
const enc = new TextEncoder();

/** A TEXT value (RFC 5545 3.3.11): \ ; , escaped, newlines as \n, other control characters dropped. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Fold one content line into chunks of at most 75 octets, without splitting a character. */
export function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = enc.encode(ch).length;
    if (bytes + size > limit) {
      out.push(current);
      current = ' ';
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** "2026-10-06T14:03:22.120Z" → "20261006T140322Z". */
export function utcStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** "2026-11-02" → "20261102". */
export const dateValue = (ymd) => ymd.replace(/-/g, '');

// ---- time zones ---------------------------------------------------------------------------
const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, {
      parts: new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }),
      name: new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }),
    });
  }
  return formatters.get(zone);
}

function partsOf(zone, ms) {
  return Object.fromEntries(formatter(zone).parts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** The zone's offset from UTC at an instant, in minutes (Toronto in July: -240). */
export function zoneOffsetMinutes(zone, ms) {
  const p = partsOf(zone, ms);
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** The calendar date in the zone at an instant, "YYYY-MM-DD". */
export function dateIn(zone, ms) {
  const p = partsOf(zone, ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function zoneAbbreviation(zone, ms) {
  return formatter(zone).name.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? null;
}

/** Every change of the zone's offset in [fromMs, toMs]: { at (ms, UTC), from, to } (minutes). */
export function zoneTransitions(zone, fromMs, toMs) {
  const STEP = 24 * 3600_000;
  const out = [];
  let lo = fromMs;
  let loOff = zoneOffsetMinutes(zone, lo);
  while (lo < toMs) {
    const hi = Math.min(lo + STEP, toMs);
    const hiOff = zoneOffsetMinutes(zone, hi);
    if (hiOff !== loOff) {
      let a = lo;
      let b = hi;
      while (b - a > 1000) {
        const mid = Math.floor((a + b) / 2);
        if (zoneOffsetMinutes(zone, mid) === loOff) a = mid;
        else b = mid;
      }
      out.push({ at: Math.floor(b / 60_000) * 60_000, from: loOff, to: hiOff });
    }
    lo = hi;
    loOff = hiOff;
  }
  return out;
}

const offsetText = (min) => {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
};

/** Wall-clock "YYYYMMDDTHHMMSS" of an instant at a fixed offset. */
const wallAt = (ms, offsetMin) => new Date(ms + offsetMin * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');

/** Midnight UTC of a "YYYY-MM-DD" (only for bounds: a day either side is added). */
const ymdMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

/**
 * The VTIMEZONE lines for `zone`, valid for local times from `fromYmd` to `toYmd`: one observance
 * for the offset in force two days before `fromYmd`, then one per transition, each with its own
 * DTSTART (the wall-clock time just before the change, in the old offset), TZOFFSETFROM/TO and
 * TZNAME. DAYLIGHT when the new offset is above the year's standard one (the smaller of January's
 * and July's).
 */
export function vtimezoneLines(zone, fromYmd, toYmd) {
  const fromMs = ymdMs(fromYmd) - 2 * 86_400_000;
  const toMs = ymdMs(toYmd) + 2 * 86_400_000;
  const standardOf = (ms) => {
    const y = new Date(ms).getUTCFullYear();
    return Math.min(zoneOffsetMinutes(zone, Date.UTC(y, 0, 1)), zoneOffsetMinutes(zone, Date.UTC(y, 6, 1)));
  };
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  const observance = (atMs, from, to) => {
    const kind = to > standardOf(atMs) ? 'DAYLIGHT' : 'STANDARD';
    const name = zoneAbbreviation(zone, atMs + 60_000);
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${wallAt(atMs, from)}`,
      `TZOFFSETFROM:${offsetText(from)}`,
      `TZOFFSETTO:${offsetText(to)}`,
      ...(name ? [`TZNAME:${escapeText(name)}`] : []),
      `END:${kind}`,
    );
  };
  const startOff = zoneOffsetMinutes(zone, fromMs);
  {
    const kind = startOff > standardOf(fromMs) ? 'DAYLIGHT' : 'STANDARD';
    const name = zoneAbbreviation(zone, fromMs);
    lines.push(`BEGIN:${kind}`, `DTSTART:${wallAt(fromMs, startOff)}`, `TZOFFSETFROM:${offsetText(startOff)}`,
      `TZOFFSETTO:${offsetText(startOff)}`, ...(name ? [`TZNAME:${escapeText(name)}`] : []), `END:${kind}`);
  }
  for (const t of zoneTransitions(zone, fromMs, toMs)) observance(t.at, t.from, t.to);
  lines.push('END:VTIMEZONE');
  return lines;
}

// ---- events --------------------------------------------------------------------------------
export const DEFAULT_MINUTES = 30;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Start and end of a task's event. Date-only → all day (DTEND = the next day, exclusive). With a
 * valid "HH:MM" → that local time for `estimate_minutes` (30 when none), never past midnight
 * (a task at 23:45 ends at 00:00). A time that isn't "HH:MM" is ignored (all day).
 */
export function eventTimes({ due_date: date, due_time: time, estimate_minutes: estimate }) {
  const m = TIME_RE.exec(time ?? '');
  if (!m) return { allDay: true, start: dateValue(date), end: dateValue(addDays(date, 1)) };
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const minutes = Number.isInteger(estimate) && estimate > 0 ? estimate : DEFAULT_MINUTES;
  const endMin = Math.min(startMin + minutes, 24 * 60);
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}00`;
  return {
    allDay: false,
    start: `${dateValue(date)}T${hhmm(startMin)}`,
    end: endMin === 24 * 60 ? `${dateValue(addDays(date, 1))}T000000` : `${dateValue(date)}T${hhmm(endMin)}`,
  };
}

/** SEQUENCE from when the task last changed: seconds since 2026-01-01 (grows with every edit). */
const SEQUENCE_EPOCH = Date.UTC(2026, 0, 1);
export function sequenceOf(updatedAt) {
  const ms = Date.parse(updatedAt ?? '');
  return Number.isFinite(ms) ? Math.max(0, Math.floor((ms - SEQUENCE_EPOCH) / 1000)) : 0;
}

export const UID_DOMAIN = 'skynet-corp-suite';

/**
 * One task's VEVENT lines. `task`: { id, title, owner, due_date, due_time, estimate_minutes,
 * created_at, updated_at }; `businessName`; `link` = the task in the suite (or null).
 * Only the title, the business and the link: no notes, client or contact details.
 */
export function eventLines(task, { zone, businessName = null, link = null }) {
  const t = eventTimes(task);
  const stamp = utcStamp(task.updated_at) ?? utcStamp(task.created_at) ?? '20260101T000000Z';
  const shared = task.owner === 'shared';
  const description = [
    [businessName, shared ? 'Shared list' : null].filter(Boolean).join(' · '),
    link ? `Open in the suite: ${link}` : null,
  ].filter(Boolean).join('\n');
  return [
    'BEGIN:VEVENT',
    `UID:${task.id}@${UID_DOMAIN}`,
    `DTSTAMP:${stamp}`,
    ...(utcStamp(task.created_at) ? [`CREATED:${utcStamp(task.created_at)}`] : []),
    `LAST-MODIFIED:${stamp}`,
    `SEQUENCE:${sequenceOf(task.updated_at)}`,
    `SUMMARY:${escapeText(`${shared ? '[Shared] ' : ''}${task.title}`)}`,
    ...(t.allDay
      ? [`DTSTART;VALUE=DATE:${t.start}`, `DTEND;VALUE=DATE:${t.end}`, 'TRANSP:TRANSPARENT']
      : [`DTSTART;TZID=${zone}:${t.start}`, `DTEND;TZID=${zone}:${t.end}`]),
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    ...(link ? [`URL:${link}`] : []),
    'END:VEVENT',
  ];
}

/** Hints to calendar apps: refresh every 15 minutes. */
export const REFRESH = 'PT15M';

/**
 * The whole feed. `tasks` already chosen (dated, open, this person's and the shared list's);
 * `window` = { from, to } (YYYY-MM-DD), the range the VTIMEZONE must cover.
 */
export function buildCalendar({ name, zone, tasks, window, businessName = () => null, linkFor = () => null }) {
  const events = tasks.map((task) => eventLines(task, { zone, businessName: businessName(task.business_id), link: linkFor(task) }));
  const timed = tasks.some((task) => !eventTimes(task).allDay);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Skynet Corp Suite//Task calendar//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-CALDESC:${escapeText('Tasks with a due date from the suite (yours and the shared list’s). Read-only: change them in the suite.')}`,
    `X-WR-TIMEZONE:${zone}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
    ...(timed ? vtimezoneLines(zone, window.from, window.to) : []),
    ...events.flat(),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
