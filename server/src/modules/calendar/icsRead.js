// Reading Apple Calendar's events (C6b): iCalendar (RFC 5545) in, the instances that fall in a window
// out. Pure: no database, no network, no clock of its own. Hand-rolled (no dependency) on purpose —
// the suite needs a small, known part of RFC 5545, and every rule it reads is tested here:
//
//  - parse: line unfolding (CRLF or LF, a space or tab continues a line), parameters with quoted
//    values, TEXT unescaping, nested components;
//  - strip (`minimalCalendar`): only what the suite keeps — UID, RECURRENCE-ID, SUMMARY, DTSTART,
//    DTEND / DURATION, RRULE, EXDATE, RDATE, STATUS, TRANSP, whether the person declined (from the
//    ATTENDEE with their Apple ID; the attendees themselves are not kept) and the VTIMEZONE rules a
//    TZID needs. Never DESCRIPTION, LOCATION, attendees, organizer, URL, alarms or attachments;
//  - time zones: a TZID Intl knows (Apple writes IANA names: "America/Toronto") is used as such;
//    otherwise the event's own VTIMEZONE (its STANDARD/DAYLIGHT observances with yearly
//    BYMONTH/BYDAY rules or fixed onsets); otherwise a few Windows names (Exchange invitations);
//    otherwise the suite's zone. "…Z" is UTC; no TZID and no Z ("floating") is the suite's zone.
//    A wall time that doesn't exist (the spring-forward hour) is read with the offset before the gap
//    (RFC 5545 3.3.5: 2:30 → 3:30 daylight time);
//  - recurrence (`expandEvent`): RRULE FREQ=DAILY | WEEKLY | MONTHLY | YEARLY with INTERVAL, COUNT,
//    UNTIL, BYDAY (with ordinals: 1MO, -1FR), BYMONTHDAY (negative too), BYMONTH, BYSETPOS and WKST —
//    everything Apple Calendar's repeat options write — expanded in the event's own wall-clock time
//    (so a weekly 10:00 meeting stays at 10:00 across a DST change), then EXDATE removed, RDATE added,
//    and each overridden instance (a VEVENT with the same UID and a RECURRENCE-ID) put in its
//    original's place — moved, retitled, or (STATUS:CANCELLED) gone. A rule with parts the suite
//    doesn't read (BYHOUR, BYWEEKNO, BYYEARDAY, HOURLY…) keeps only its first instance and says so
//    (`unsupported`), never guesses.
//
// Instances: { key (the original start: "2026-10-12T14:00:00.000Z" or "2026-10-12"; '' for a single
// event), title, allDay, startMs/endMs (timed), startDate/endDate (all day: first day, and the day
// after the last), busy, recurring }.

// ---- parsing ---------------------------------------------------------------------------------------

/** A TEXT value's escapes: \\ \; \, \n \N. */
export function unescapeText(v) {
  return String(v ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** One content line → { name, params: { NAME: value }, value } (null when it isn't one). */
export function parseLine(line) {
  let i = 0;
  let name = '';
  while (i < line.length && line[i] !== ';' && line[i] !== ':') name += line[i++];
  if (!name || i >= line.length) return null;
  const params = {};
  while (line[i] === ';') {
    i += 1;
    let key = '';
    while (i < line.length && line[i] !== '=' && line[i] !== ':' && line[i] !== ';') key += line[i++];
    let value = '';
    if (line[i] === '=') {
      i += 1;
      const values = [];
      for (;;) {
        let v = '';
        if (line[i] === '"') {
          i += 1;
          while (i < line.length && line[i] !== '"') v += line[i++];
          i += 1;
        } else {
          while (i < line.length && line[i] !== ',' && line[i] !== ';' && line[i] !== ':') v += line[i++];
        }
        values.push(v);
        if (line[i] === ',') { i += 1; continue; }
        break;
      }
      value = values.join(',');
    }
    if (key) params[key.toUpperCase()] = value;
  }
  if (line[i] !== ':') return null;
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** The whole text → its components: { name, props: [{ name, params, value }], children }. */
export function parseIcs(text) {
  const physical = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (const l of physical) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && lines.length) lines[lines.length - 1] += l.slice(1);
    else if (l.length) lines.push(l);
  }
  const root = { name: null, props: [], children: [] };
  const stack = [root];
  for (const raw of lines) {
    const p = parseLine(raw);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      const c = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      stack.at(-1).children.push(c);
      stack.push(c);
    } else if (p.name === 'END') {
      const want = p.value.trim().toUpperCase();
      // Tolerate a missing END: close back to the matching BEGIN.
      const at = stack.map((c) => c.name).lastIndexOf(want);
      if (at > 0) stack.length = at;
    } else {
      stack.at(-1).props.push(p);
    }
  }
  return root;
}

const propOf = (c, name) => c.props.find((p) => p.name === name) ?? null;
const propsOf = (c, name) => c.props.filter((p) => p.name === name);
/** Every component with this name, anywhere below `c`. */
function componentsOf(c, name, out = []) {
  for (const ch of c.children) {
    if (ch.name === name) out.push(ch);
    componentsOf(ch, name, out);
  }
  return out;
}

// ---- dates and times ------------------------------------------------------------------------------
// A "wall" value is a local wall-clock time as milliseconds *as if it were UTC* (Date.UTC of its
// fields): plain arithmetic on it never meets DST; a zone turns it into a real instant.

const DAY = 86_400_000;
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** "YYYY-MM-DD" of a wall value. */
export const ymdOf = (wall) => {
  const d = new Date(wall);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const wallOfYmd = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
export const addDaysYmd = (ymd, n) => ymdOf(wallOfYmd(ymd) + n * DAY);

/**
 * A DATE or DATE-TIME property value → { date: 'YYYY-MM-DD' } | { wall, utc: true } | { wall, tzid }
 * | { wall, floating: true }; null when it can't be read.
 */
export function readDateValue(value, params = {}) {
  const v = String(value ?? '').trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || params.VALUE === 'DATE') {
    if (!d) return null;
    return { date: `${d[1]}-${d[2]}-${d[3]}` };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return null;
  const wall = Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]);
  if (Number.isNaN(wall)) return null;
  if (t[7]) return { wall, utc: true };
  if (params.TZID) return { wall, tzid: params.TZID };
  return { wall, floating: true };
}

/** "P1DT2H30M", "-PT15M", "P2W" → milliseconds (null when it isn't a duration). */
export function readDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value ?? '').trim());
  if (!m || value.trim() === 'P' || /T$/.test(value.trim())) return null;
  const ms = ((+m[2] || 0) * 7 * DAY) + ((+m[3] || 0) * DAY) + ((+m[4] || 0) * 3600_000) + ((+m[5] || 0) * 60_000) + ((+m[6] || 0) * 1000);
  return m[1] === '-' ? -ms : ms;
}

// ---- time zones ----------------------------------------------------------------------------------

const zoneFormatters = new Map();
function ianaOffset(zone, utcMs) {
  let f = zoneFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormatters.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** Is this a time zone name Intl knows? */
export function isIanaZone(name) {
  if (typeof name !== 'string' || !name) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** Windows zone names (Outlook / Exchange invitations), for when no VTIMEZONE came with them. */
const WINDOWS_ZONES = Object.freeze({
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'UTC': 'UTC',
});

const offsetMinutes = (v) => {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
};

/** A VTIMEZONE's observances in a small stored form: [{ start (wall), from, to, rrule?, rdates? }]. */
export function readVtimezone(vtz) {
  const out = [];
  for (const ob of vtz.children.filter((c) => c.name === 'STANDARD' || c.name === 'DAYLIGHT')) {
    const start = readDateValue(propOf(ob, 'DTSTART')?.value);
    const from = offsetMinutes(propOf(ob, 'TZOFFSETFROM')?.value);
    const to = offsetMinutes(propOf(ob, 'TZOFFSETTO')?.value);
    if (!start || start.date || from === null || to === null) continue;
    const rdates = propsOf(ob, 'RDATE').flatMap((p) => p.value.split(',')).map((v) => readDateValue(v)).filter((x) => x && !x.date).map((x) => x.wall);
    out.push({ start: start.wall, from, to, ...(propOf(ob, 'RRULE') ? { rrule: propOf(ob, 'RRULE').value } : {}), ...(rdates.length ? { rdates } : {}) });
  }
  return out;
}

/** Onsets (UTC ms) of one observance in a year, from its yearly rule, its start or its RDATEs. */
function observanceOnsets(ob, year) {
  const onsets = [];
  const toUtc = (wall) => wall - ob.from * 60_000;
  if (ob.rrule) {
    const r = parseRrule(ob.rrule);
    if (r && r.freq === 'YEARLY') {
      const startD = new Date(ob.start);
      if (year >= startD.getUTCFullYear()) {
        const months = r.bymonth?.length ? r.bymonth : [startD.getUTCMonth() + 1];
        const time = ob.start - Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth(), startD.getUTCDate());
        for (const month of months) {
          let days;
          if (r.byday?.length) days = monthDaysByDay(year, month, r.byday);
          else if (r.bymonthday?.length) days = monthDaysByMonthday(year, month, r.bymonthday);
          else days = [Date.UTC(year, month - 1, startD.getUTCDate())];
          for (const d of days) {
            const wall = d + time;
            if (wall < ob.start) continue;
            if (r.untilWall !== undefined && wall > r.untilWall) continue;
            onsets.push(toUtc(wall));
          }
        }
      }
    }
  }
  if (new Date(ob.start).getUTCFullYear() === year) onsets.push(toUtc(ob.start));
  for (const w of ob.rdates ?? []) if (new Date(w).getUTCFullYear() === year) onsets.push(toUtc(w));
  return onsets;
}

/** A zone: { name, offsetAt(utcMs) → minutes, toUtc(wall) → utcMs, wallOf(utcMs) → wall }. */
function makeZone(name, offsetAt) {
  return {
    name,
    offsetAt,
    wallOf: (utc) => utc + offsetAt(utc) * 60_000,
    toUtc(wall) {
      const guess = offsetAt(wall);
      let off = offsetAt(wall - guess * 60_000);
      let utc = wall - off * 60_000;
      if (offsetAt(utc) === off) return utc;
      const off2 = offsetAt(utc);
      const utc2 = wall - off2 * 60_000;
      if (offsetAt(utc2) === off2) return utc2;
      // A wall time in the spring-forward gap: the offset before the gap (2:30 → 3:30 daylight time).
      off = Math.min(off, off2);
      utc = wall - off * 60_000;
      return utc;
    },
  };
}

const zoneCache = new Map();
/** An IANA zone. */
export function ianaZone(name) {
  if (!zoneCache.has(name)) zoneCache.set(name, makeZone(name, (utc) => ianaOffset(name, utc)));
  return zoneCache.get(name);
}
export const UTC_ZONE = makeZone('UTC', () => 0);

/** A zone from a VTIMEZONE's observances (when its TZID isn't a name Intl knows). */
export function vtimezoneZone(name, observances) {
  if (!observances?.length) return null;
  const byYear = new Map();
  const onsetsAround = (year) => {
    if (!byYear.has(year)) {
      const list = [];
      for (const ob of observances) for (const y of [year - 1, year]) for (const at of observanceOnsets(ob, y)) list.push({ at, to: ob.to });
      list.sort((a, b) => a.at - b.at);
      byYear.set(year, list);
    }
    return byYear.get(year);
  };
  const earliest = [...observances].sort((a, b) => a.start - b.start)[0];
  return makeZone(name, (utc) => {
    const list = onsetsAround(new Date(utc).getUTCFullYear());
    let off = null;
    for (const o of list) if (o.at <= utc) off = o.to;
    return off ?? earliest.from;
  });
}

/**
 * The zone for a TZID: Intl's (also for "/mozilla.org/…/America/Toronto"-style names), else the
 * calendar's VTIMEZONE, else a Windows name, else the fallback (the suite's zone).
 */
export function resolveZone(tzid, zones = {}, fallback = 'America/Toronto') {
  if (tzid) {
    if (isIanaZone(tzid)) return ianaZone(tzid);
    const tail = /([A-Za-z_]+\/[A-Za-z_+\-0-9]+(?:\/[A-Za-z_]+)?)$/.exec(tzid)?.[1];
    if (tail && isIanaZone(tail)) return ianaZone(tail);
    const fromVtz = zones[tzid] ? vtimezoneZone(tzid, zones[tzid]) : null;
    if (fromVtz) return fromVtz;
    if (WINDOWS_ZONES[tzid]) return ianaZone(WINDOWS_ZONES[tzid]);
  }
  return ianaZone(fallback);
}

// ---- RRULE ------------------------------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const SUPPORTED_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST']);

/**
 * "FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T235959Z" → { freq, interval, count, until (date value),
 * byday: [{ n, wd }], bymonthday, bymonth, bysetpos, wkst, unsupported: [parts] } (null when unreadable).
 */
export function parseRrule(text) {
  const parts = Object.fromEntries(String(text ?? '').split(';').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim().toUpperCase(), kv.slice(i + 1).trim()];
  }));
  if (!parts.FREQ) return null;
  const nums = (v) => (v ? v.split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0) : null);
  const byday = parts.BYDAY ? parts.BYDAY.split(',').map((s) => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(s.trim());
    return m ? { n: m[1] ? Number(m[1]) : 0, wd: WEEKDAYS.indexOf(m[2].toUpperCase()) } : null;
  }).filter(Boolean) : null;
  const unsupported = Object.keys(parts).filter((k) => !SUPPORTED_PARTS.has(k));
  if (!SUPPORTED_FREQ.has(parts.FREQ.toUpperCase())) unsupported.push(`FREQ=${parts.FREQ}`);
  const until = parts.UNTIL ? readDateValue(parts.UNTIL) : null;
  return {
    freq: parts.FREQ.toUpperCase(),
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    count: parts.COUNT ? Math.max(0, Number(parts.COUNT) || 0) : null,
    until,
    untilWall: until ? (until.date ? wallOfYmd(until.date) + DAY - 1 : until.wall) : undefined,
    byday,
    bymonthday: nums(parts.BYMONTHDAY),
    bymonth: nums(parts.BYMONTH),
    bysetpos: nums(parts.BYSETPOS),
    wkst: WEEKDAYS.indexOf((parts.WKST ?? 'MO').toUpperCase()) >= 0 ? WEEKDAYS.indexOf((parts.WKST ?? 'MO').toUpperCase()) : 1,
    unsupported,
  };
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Days (wall at 00:00) of a month matching BYDAY entries (an ordinal counts within the month). */
function monthDaysByDay(y, m, byday) {
  const n = daysInMonth(y, m);
  const out = new Set();
  for (const { n: ord, wd } of byday) {
    const matches = [];
    for (let d = 1; d <= n; d += 1) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) matches.push(Date.UTC(y, m - 1, d));
    if (!ord) matches.forEach((x) => out.add(x));
    else {
      const pick = ord > 0 ? matches[ord - 1] : matches[matches.length + ord];
      if (pick !== undefined) out.add(pick);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function monthDaysByMonthday(y, m, list) {
  const n = daysInMonth(y, m);
  const out = new Set();
  for (const md of list) {
    const d = md > 0 ? md : n + md + 1;
    if (d >= 1 && d <= n) out.add(Date.UTC(y, m - 1, d));
  }
  return [...out].sort((a, b) => a - b);
}

function setPos(days, bysetpos) {
  if (!bysetpos?.length) return days;
  const out = new Set();
  for (const p of bysetpos) {
    const pick = p > 0 ? days[p - 1] : days[days.length + p];
    if (pick !== undefined) out.add(pick);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The starts (wall values) a rule makes from `startWall`, in order, up to `limitWall` (inclusive) —
 * the first is always the start itself (it counts in COUNT). Starts before `fromWall` count (COUNT) but aren't
 * returned, so a daily series begun years ago costs time, not memory. At most `max` starts.
 */
export function ruleStarts(rule, startWall, { limitWall, fromWall = -Infinity, max = 5000 } = {}) {
  const out = [startWall];
  if (!rule || rule.unsupported.length) return out;
  const s = new Date(startWall);
  const time = startWall - Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
  const sy = s.getUTCFullYear();
  const sm = s.getUTCMonth() + 1;
  const sd = s.getUTCDate();
  const swd = s.getUTCDay();
  let produced = 1;
  const stopAt = Math.min(limitWall ?? Infinity, rule.untilWall ?? Infinity);
  const monthOk = (d) => !rule.bymonth?.length || rule.bymonth.includes(new Date(d).getUTCMonth() + 1);
  const dayOk = (d) => {
    const dt = new Date(d);
    if (rule.bymonthday?.length) {
      const n = daysInMonth(dt.getUTCFullYear(), dt.getUTCMonth() + 1);
      if (!rule.bymonthday.some((md) => (md > 0 ? md : n + md + 1) === dt.getUTCDate())) return false;
    }
    if (rule.byday?.length && !rule.byday.some((b) => b.wd === dt.getUTCDay())) return false;
    return true;
  };
  // Each period's candidate days (wall at 00:00), in order.
  let periodDays;
  if (rule.freq === 'DAILY') {
    periodDays = (i) => {
      const d = Date.UTC(sy, sm - 1, sd + i * rule.interval);
      return monthOk(d) && dayOk(d) ? [d] : [];
    };
  } else if (rule.freq === 'WEEKLY') {
    const back = (swd - rule.wkst + 7) % 7;
    const week0 = Date.UTC(sy, sm - 1, sd - back);
    const wds = rule.byday?.length ? rule.byday.map((b) => b.wd) : [swd];
    periodDays = (i) => {
      const ws = week0 + i * rule.interval * 7 * DAY;
      const days = [];
      for (let k = 0; k < 7; k += 1) {
        const d = ws + k * DAY;
        if (wds.includes(new Date(d).getUTCDay()) && monthOk(d)) days.push(d);
      }
      return setPos(days, rule.bysetpos);
    };
  } else if (rule.freq === 'MONTHLY') {
    periodDays = (i) => {
      const mi = sm - 1 + i * rule.interval;
      const y = sy + Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      if (rule.bymonth?.length && !rule.bymonth.includes(m)) return [];
      let days;
      if (rule.byday?.length) {
        days = monthDaysByDay(y, m, rule.byday);
        if (rule.bymonthday?.length) {
          const md = new Set(monthDaysByMonthday(y, m, rule.bymonthday));
          days = days.filter((d) => md.has(d));
        }
      } else if (rule.bymonthday?.length) days = monthDaysByMonthday(y, m, rule.bymonthday);
      else days = sd <= daysInMonth(y, m) ? [Date.UTC(y, m - 1, sd)] : [];
      return setPos(days, rule.bysetpos);
    };
  } else {
    periodDays = (i) => {
      const y = sy + i * rule.interval;
      let days = [];
      if (rule.bymonth?.length) {
        for (const m of [...rule.bymonth].sort((a, b) => a - b)) {
          if (rule.byday?.length) {
            let md = monthDaysByDay(y, m, rule.byday);
            if (rule.bymonthday?.length) {
              const keep = new Set(monthDaysByMonthday(y, m, rule.bymonthday));
              md = md.filter((d) => keep.has(d));
            }
            days.push(...md);
          } else if (rule.bymonthday?.length) days.push(...monthDaysByMonthday(y, m, rule.bymonthday));
          else if (sd <= daysInMonth(y, m)) days.push(Date.UTC(y, m - 1, sd));
        }
      } else if (rule.byday?.length) {
        // BYDAY with no BYMONTH: an ordinal counts within the year.
        for (const { n: ord, wd } of rule.byday) {
          const all = [];
          for (let d = Date.UTC(y, 0, 1); d < Date.UTC(y + 1, 0, 1); d += DAY) if (new Date(d).getUTCDay() === wd) all.push(d);
          if (!ord) days.push(...all);
          else {
            const pick = ord > 0 ? all[ord - 1] : all[all.length + ord];
            if (pick !== undefined) days.push(pick);
          }
        }
      } else if (rule.bymonthday?.length) {
        days.push(...monthDaysByMonthday(y, sm, rule.bymonthday));
      } else if (sd <= daysInMonth(y, sm)) days.push(Date.UTC(y, sm - 1, sd));
      days = [...new Set(days)].sort((a, b) => a - b);
      return setPos(days, rule.bysetpos);
    };
  }
  // The first day of period i (no day of that period comes before it): the expansion stops once it is past the limit.
  const wkBack = (swd - rule.wkst + 7) % 7;
  const periodStart = (i) => {
    if (rule.freq === 'DAILY') return Date.UTC(sy, sm - 1, sd + i * rule.interval);
    if (rule.freq === 'WEEKLY') return Date.UTC(sy, sm - 1, sd - wkBack) + i * rule.interval * 7 * DAY;
    if (rule.freq === 'MONTHLY') return Date.UTC(sy, sm - 1 + i * rule.interval, 1);
    return Date.UTC(sy + i * rule.interval, 0, 1);
  };
  const MAX_PERIODS = 200_000;
  for (let i = 0; i < MAX_PERIODS; i += 1) {
    if (periodStart(i) + time > stopAt) return out;
    for (const day of periodDays(i)) {
      const wall = day + time;
      if (wall <= startWall) continue;
      if (wall > stopAt) return out;
      if (rule.count !== null && produced >= rule.count) return out;
      produced += 1;
      if (wall < fromWall) continue;
      out.push(wall);
      if (out.length >= max) return out;
    }
    if (rule.count !== null && produced >= rule.count) return out;
  }
  return out;
}

// ---- the stored form ----------------------------------------------------------------------------

/** The suite's own task feed (C6a) writes UIDs "<task id>@skynet-corp-suite": never read them back. */
export const OWN_UID_SUFFIX = '@skynet-corp-suite';

const keepProp = (p) => (p ? { v: p.value, ...(Object.keys(p.params).length ? { p: pickParams(p.params) } : {}) } : null);
function pickParams(params) {
  const out = {};
  for (const k of ['VALUE', 'TZID', 'RANGE']) if (params[k]) out[k] = params[k];
  return out;
}

/** "mailto:Jessy@Example.com" → "jessy@example.com". */
const mailOf = (v) => String(v ?? '').replace(/^mailto:/i, '').trim().toLowerCase();

/**
 * One calendar object (an .ics) → the suite's minimal stored form:
 * { events: [{ uid, rid?, title, status?, transp?, declined?, start, end?, duration?, rrule?, exdates?, rdates? }],
 *   zones: { TZID: observances } } — nothing else (no notes, location, attendees, organizer, URL, alarms).
 * `me`: the person's Apple ID (their attendee row says whether they declined).
 */
export function minimalCalendar(text, { me = null } = {}) {
  const root = parseIcs(text);
  const events = [];
  const usedTzids = new Set();
  for (const ev of componentsOf(root, 'VEVENT')) {
    const uid = propOf(ev, 'UID')?.value?.trim();
    const start = propOf(ev, 'DTSTART');
    if (!uid || !start || uid.endsWith(OWN_UID_SUFFIX)) continue;
    const mine = me ? propsOf(ev, 'ATTENDEE').find((a) => mailOf(a.value) === mailOf(me) || mailOf(a.params.EMAIL) === mailOf(me)) : null;
    const e = {
      uid,
      title: unescapeText(propOf(ev, 'SUMMARY')?.value ?? '').trim().slice(0, 300),
      start: keepProp(start),
    };
    const rid = propOf(ev, 'RECURRENCE-ID');
    if (rid) e.rid = keepProp(rid);
    if (propOf(ev, 'DTEND')) e.end = keepProp(propOf(ev, 'DTEND'));
    else if (propOf(ev, 'DURATION')) e.duration = propOf(ev, 'DURATION').value.trim();
    if (propOf(ev, 'RRULE')) e.rrule = propOf(ev, 'RRULE').value.trim();
    const exdates = propsOf(ev, 'EXDATE').flatMap((p) => p.value.split(',').map((v) => ({ v: v.trim(), ...(Object.keys(pickParams(p.params)).length ? { p: pickParams(p.params) } : {}) })));
    if (exdates.length) e.exdates = exdates;
    const rdates = propsOf(ev, 'RDATE').filter((p) => p.params.VALUE !== 'PERIOD')
      .flatMap((p) => p.value.split(',').map((v) => ({ v: v.trim(), ...(Object.keys(pickParams(p.params)).length ? { p: pickParams(p.params) } : {}) })));
    if (rdates.length) e.rdates = rdates;
    const status = propOf(ev, 'STATUS')?.value?.trim().toUpperCase();
    if (status && status !== 'CONFIRMED') e.status = status;
    if (propOf(ev, 'TRANSP')?.value?.trim().toUpperCase() === 'TRANSPARENT') e.transp = 'TRANSPARENT';
    if (mine && String(mine.params.PARTSTAT ?? '').toUpperCase() === 'DECLINED') e.declined = true;
    for (const p of [start, propOf(ev, 'DTEND'), rid, ...propsOf(ev, 'EXDATE'), ...propsOf(ev, 'RDATE')]) if (p?.params.TZID) usedTzids.add(p.params.TZID);
    events.push(e);
  }
  const zones = {};
  for (const vtz of componentsOf(root, 'VTIMEZONE')) {
    const tzid = propOf(vtz, 'TZID')?.value?.trim();
    if (tzid && usedTzids.has(tzid) && !isIanaZone(tzid)) {
      const obs = readVtimezone(vtz);
      if (obs.length) zones[tzid] = obs;
    }
  }
  return { events, zones };
}

// ---- instances ------------------------------------------------------------------------------------

/** A stored date value → { date } | { utc } (ms), in the zones given. */
function instantOf(stored, zones, fallback) {
  if (!stored) return null;
  const d = readDateValue(stored.v, stored.p ?? {});
  if (!d) return null;
  if (d.date) return { date: d.date };
  if (d.utc) return { utc: d.wall, zone: null, wall: d.wall };
  const zone = d.tzid ? resolveZone(d.tzid, zones, fallback) : ianaZone(fallback);
  return { utc: zone.toUtc(d.wall), zone, wall: d.wall };
}

/** An instance's key: its original start, as UTC ISO or a date. */
const keyOf = (inst) => (inst.date ? inst.date : new Date(inst.utc).toISOString());

/**
 * Every instance of one event series (its master and overrides, by UID) that overlaps the window.
 * `window`: { fromMs, toMs, fromDate, toDate } (dates: the first day, and the day after the last,
 * in the suite's zone — for all-day events). `zones`: the calendar object's VTIMEZONE rules;
 * `fallback`: the suite's zone. → { instances, unsupported: string | null }
 */
export function expandSeries({ master = null, overrides = [] }, { window, zones = {}, fallback = 'America/Toronto', max = 2000 }) {
  const out = [];
  let unsupported = null;
  const overrideByKey = new Map();
  for (const o of overrides) {
    const r = instantOf(o.rid, zones, fallback);
    if (r) overrideByKey.set(keyOf(r), o);
  }
  const pushInstance = (ev, startInst, key, recurring) => {
    if (ev.status === 'CANCELLED' || ev.declined) return;
    const inst = instanceOf(ev, startInst, { zones, fallback, key, recurring });
    if (!inst) return;
    if (inst.allDay ? (inst.startDate < window.toDate && inst.endDate > window.fromDate)
      : (inst.startMs < window.toMs && (inst.endMs > window.fromMs || (inst.endMs === inst.startMs && inst.startMs >= window.fromMs)))) out.push(inst);
  };
  if (master) {
    const start = instantOf(master.start, zones, fallback);
    if (start) {
      const recurring = Boolean(master.rrule || master.rdates?.length);
      const starts = [];
      if (master.rrule) {
        const rule = parseRrule(master.rrule);
        if (!rule || rule.unsupported.length) unsupported = rule ? rule.unsupported.join(', ') : 'unreadable rule';
        // Expand in the start's own wall clock (all-day: dates) up to a little past the window's end.
        const zone = start.zone ?? (start.date ? null : UTC_ZONE);
        const limitWall = start.date ? wallOfYmd(window.toDate) : (zone.wallOf(window.toMs) + DAY);
        const baseWall = start.date ? wallOfYmd(start.date) : start.wall;
        // A rule with UNTIL in UTC is compared on the instant: turn it into this wall clock.
        if (rule?.until && rule.until.utc && zone) rule.untilWall = zone.wallOf(rule.until.wall);
        // Starts that end before the window are skipped (with room for the event's own length).
        const s0 = instantOf(master.start, zones, fallback);
        const e0 = instantOf(master.end, zones, fallback);
        const lengthWall = e0 && s0 && !e0.date && !s0.date ? Math.max(0, e0.utc - s0.utc)
          : e0?.date && s0?.date ? wallOfYmd(e0.date) - wallOfYmd(s0.date) : Math.max(0, readDuration(master.duration ?? '') ?? 0);
        const fromWall = (start.date ? wallOfYmd(window.fromDate) : zone.wallOf(window.fromMs)) - lengthWall - DAY;
        for (const wall of ruleStarts(rule, baseWall, { limitWall, fromWall, max })) {
          starts.push(start.date ? { date: ymdOf(wall) } : { utc: zone.toUtc(wall), zone, wall });
        }
      } else starts.push(start);
      for (const rd of master.rdates ?? []) {
        const r = instantOf(rd, zones, fallback);
        if (r && !starts.some((s) => keyOf(s) === keyOf(r))) starts.push(r);
      }
      const ex = new Set();
      const exDates = new Set();
      for (const x of master.exdates ?? []) {
        const r = instantOf(x, zones, fallback);
        if (!r) continue;
        if (r.date) exDates.add(r.date);
        else ex.add(keyOf(r));
      }
      for (const s of starts) {
        const key = keyOf(s);
        if (ex.has(key)) continue;
        if (exDates.has(s.date ?? '') || (!s.date && exDates.size && exDates.has(ymdOf(s.wall)))) continue;
        const override = overrideByKey.get(key);
        if (override) {
          overrideByKey.delete(key);
          const os = instantOf(override.start, zones, fallback);
          if (os) pushInstance(override, os, recurring ? key : '', recurring);
          continue;
        }
        pushInstance(master, s, recurring ? key : '', recurring);
      }
    }
  }
  // Overrides whose original instance wasn't made here (outside the expansion, or no master): their own time counts.
  for (const [key, o] of overrideByKey) {
    const os = instantOf(o.start, zones, fallback);
    if (os) pushInstance(o, os, key, true);
  }
  out.sort((a, b) => (a.allDay ? wallOfYmd(a.startDate) : a.startMs) - (b.allDay ? wallOfYmd(b.startDate) : b.startMs) || (a.key < b.key ? -1 : 1));
  return { instances: out.slice(0, max), unsupported };
}

/** One instance from an event (master or override) and its start. */
function instanceOf(ev, start, { zones, fallback, key, recurring }) {
  const title = ev.title || '(No title)';
  const busy = ev.transp !== 'TRANSPARENT';
  if (start.date) {
    let days = 1;
    const s0 = instantOf(ev.start, zones, fallback);
    const end = instantOf(ev.end, zones, fallback);
    if (end?.date && s0?.date) days = Math.max(1, Math.round((wallOfYmd(end.date) - wallOfYmd(s0.date)) / DAY));
    else if (ev.duration) {
      const ms = readDuration(ev.duration);
      if (ms && ms > 0) days = Math.max(1, Math.round(ms / DAY));
    }
    return { key, title, allDay: true, startDate: start.date, endDate: addDaysYmd(start.date, days), busy: false, recurring };
  }
  // Timed: the event's own length (DTEND − DTSTART of its first start, or DURATION), from this start.
  let length = 0;
  const s0 = instantOf(ev.start, zones, fallback);
  const e0 = instantOf(ev.end, zones, fallback);
  if (e0 && !e0.date && s0 && !s0.date) length = Math.max(0, e0.utc - s0.utc);
  else if (ev.duration) length = Math.max(0, readDuration(ev.duration) ?? 0);
  return { key, title, allDay: false, startMs: start.utc, endMs: start.utc + length, busy, recurring };
}

/**
 * Every instance in the window from a list of stored calendar objects ({ events, zones }): series
 * grouped by UID within each object. → { instances: [{ …instance, uid }], unsupported: [uid] }
 */
export function expandObjects(objects, { window, fallback, maxPerSeries = 2000 }) {
  const instances = [];
  const unsupported = [];
  for (const obj of objects) {
    const series = new Map();
    for (const ev of obj.events ?? []) {
      if (!series.has(ev.uid)) series.set(ev.uid, { master: null, overrides: [] });
      const s = series.get(ev.uid);
      if (ev.rid) s.overrides.push(ev);
      else if (!s.master) s.master = ev;
    }
    for (const [uid, s] of series) {
      const r = expandSeries(s, { window, zones: obj.zones ?? {}, fallback, max: maxPerSeries });
      if (r.unsupported) unsupported.push(uid);
      for (const inst of r.instances) instances.push({ ...inst, uid, ...(obj.ref ? { ref: obj.ref } : {}) });
    }
  }
  // Soonest first (all-day ones by their day's midnight UTC, close enough to order a list).
  const t = (i) => (i.allDay ? wallOfYmd(i.startDate) : i.startMs);
  instances.sort((a, b) => t(a) - t(b) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return { instances, unsupported };
}
