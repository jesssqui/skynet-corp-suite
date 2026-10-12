// Meetings from Apple Calendar (C6b), against a fake iCloud CalDAV server: the iCalendar reader (repeats
// across DST, exceptions, moved and cancelled instances, all-day, VTIMEZONE and Windows zones, the
// spring-forward gap, COUNT/UNTIL, unreadable rules, declined invitations, what is kept), the read-only client
// (PROPFIND/REPORT only, iCloud hosts only, redirects), connecting (checked first, the password sealed and never
// returned or logged), the pulls (CTag/ETag: only what changed is fetched; backoff; a revoked password stops
// every call; pause = no calls), the synced `meeting` records (devices can't write them; created, moved,
// deleted), choosing calendars, forgetting, restores, and the task feed never echoing meetings. Toronto time.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modules } from '../src/modules/index.js';
import { atLocal } from '../src/modules/automations/schedule.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup, KEPT_TABLES } from '../src/backup/restore.js';
import {
  parseIcs, parseLine, parseRrule, minimalCalendar, expandObjects, expandSeries, resolveZone, ruleStarts, wallOfYmd, readDuration,
} from '../src/modules/calendar/icsRead.js';
import { allowedUrl, createCaldavClient, CaldavError, isIcloudUrl, multistatus, parseXml, READ_METHODS } from '../src/modules/calendar/caldav.js';
import { cleanCredentials, meetingWindow, backoffMs, WINDOW_FUTURE_DAYS, WINDOW_PAST_DAYS } from '../src/modules/calendar/apple.js';
import { startFakeCaldav, ics, APPLE_ID, APP_PASSWORD } from './fixtures/caldavFake.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, testClock, capturingLog } from './helpers.js';

const ZONE = 'America/Toronto';
const at = (s) => {
  const [d, hm = '00:00'] = s.split(' ');
  return atLocal(d, hm).getTime();
};
const iso = (ms) => new Date(ms).toISOString();
const WIN = (from, to) => {
  const w = { fromDate: from, toDate: to };
  const z = resolveZone(ZONE);
  return { ...w, fromMs: z.toUtc(wallOfYmd(from)), toMs: z.toUtc(wallOfYmd(to)) };
};
const expand = (text, window, opts = {}) => expandObjects([minimalCalendar(text, opts)], { window, fallback: ZONE });

// ---- the iCalendar reader -------------------------------------------------------------------------------

test('parsing: folded lines, quoted parameters, escaped text, nested components', () => {
  const root = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Lunch\\, then a\r\n  long walk\\; ok\\nbye\r\nATTENDEE;CN="Smith, Pat";PARTSTAT=ACCEPTED:mailto:p@x.ca\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  const ev = root.children[0].children[0];
  assert.equal(ev.name, 'VEVENT');
  assert.equal(ev.props[0].value, 'Lunch\\, then a long walk\\; ok\\nbye');
  assert.deepEqual(parseLine('ATTENDEE;CN="Smith, Pat";PARTSTAT=ACCEPTED:mailto:p@x.ca').params, { CN: 'Smith, Pat', PARTSTAT: 'ACCEPTED' });
  const m = minimalCalendar('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART:20261012T140000Z\nSUMMARY:Lunch\\, then a\n  walk\nEND:VEVENT\nEND:VCALENDAR\n');
  assert.equal(m.events[0].title, 'Lunch, then a walk', 'LF-only files and TEXT escapes');
  assert.equal(readDuration('PT1H30M'), 5_400_000);
  assert.equal(readDuration('P1D'), 86_400_000);
  assert.equal(readDuration('-PT15M'), -900_000);
  assert.equal(readDuration('nonsense'), null);
});

test('what is kept of an event: title, times, repeats, free/busy — never notes, location, attendees, organizer, URL or alarms', () => {
  const text = ics([
    'UID:secret-1', 'SUMMARY:Dentist', 'DTSTART;TZID=America/Toronto:20261013T090000', 'DTEND;TZID=America/Toronto:20261013T100000',
    'DESCRIPTION:Bring the insurance card 1234-5678', 'LOCATION:12 Main St\\, Simcoe', 'ORGANIZER;CN=Dr Who:mailto:dr@clinic.ca',
    `ATTENDEE;CN=Jessy;PARTSTAT=ACCEPTED:mailto:${APPLE_ID}`, 'URL:https://clinic.ca/booking/77', 'X-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:42,-80',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
  ]);
  const m = minimalCalendar(text, { me: APPLE_ID });
  const stored = JSON.stringify(m);
  for (const gone of ['insurance', 'Main St', 'clinic', 'dr@', 'Jessy', APPLE_ID, 'geo:', 'Reminder', 'TRIGGER']) {
    assert.ok(!stored.includes(gone), `"${gone}" isn't kept`);
  }
  assert.deepEqual(Object.keys(m.events[0]).sort(), ['end', 'start', 'title', 'uid']);
});

test('a weekly meeting at 10:00 stays at 10:00 Toronto time across the November DST change; EXDATE removes, an override moves and retitles', () => {
  const text = ics(
    ['UID:w1', 'SUMMARY:Weekly sync', 'DTSTART;TZID=America/Toronto:20261019T100000', 'DTEND;TZID=America/Toronto:20261019T110000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=America/Toronto:20261109T100000'],
    ['UID:w1', 'RECURRENCE-ID;TZID=America/Toronto:20261102T100000', 'SUMMARY:Weekly sync (moved)',
      'DTSTART;TZID=America/Toronto:20261102T130000', 'DTEND;TZID=America/Toronto:20261102T143000'],
    ['UID:w1', 'RECURRENCE-ID;TZID=America/Toronto:20261123T100000', 'STATUS:CANCELLED', 'SUMMARY:Weekly sync',
      'DTSTART;TZID=America/Toronto:20261123T100000', 'DTEND;TZID=America/Toronto:20261123T110000'],
  );
  const { instances } = expand(text, WIN('2026-10-12', '2026-12-01'));
  assert.deepEqual(instances.map((i) => [i.key, i.title, iso(i.startMs), iso(i.endMs)]), [
    ['2026-10-19T14:00:00.000Z', 'Weekly sync', '2026-10-19T14:00:00.000Z', '2026-10-19T15:00:00.000Z'], // EDT (−4)
    ['2026-10-26T14:00:00.000Z', 'Weekly sync', '2026-10-26T14:00:00.000Z', '2026-10-26T15:00:00.000Z'],
    ['2026-11-02T15:00:00.000Z', 'Weekly sync (moved)', '2026-11-02T18:00:00.000Z', '2026-11-02T19:30:00.000Z'], // EST (−5), moved to 13:00
    // Nov 9: EXDATE; Nov 23: a cancelled override
    ['2026-11-16T15:00:00.000Z', 'Weekly sync', '2026-11-16T15:00:00.000Z', '2026-11-16T16:00:00.000Z'],
    ['2026-11-30T15:00:00.000Z', 'Weekly sync', '2026-11-30T15:00:00.000Z', '2026-11-30T16:00:00.000Z'],
  ]);
  assert.ok(instances.every((i) => i.recurring));
  // An instance moved INTO the window from outside it still shows; its original's place doesn't.
  const moved = ics(
    ['UID:m', 'SUMMARY:Board', 'DTSTART:20260901T150000Z', 'DTEND:20260901T160000Z', 'RRULE:FREQ=MONTHLY;COUNT=3'],
    ['UID:m', 'RECURRENCE-ID:20261001T150000Z', 'SUMMARY:Board (moved)', 'DTSTART:20261014T150000Z', 'DTEND:20261014T160000Z'],
  );
  assert.deepEqual(expand(moved, WIN('2026-10-05', '2026-10-31')).instances.map((i) => [i.title, iso(i.startMs)]),
    [['Board (moved)', '2026-10-14T15:00:00.000Z']]);
});

test('repeat rules Apple Calendar writes: every 2 weeks on two days, the last Friday, the last weekday, the 31st, yearly on the first Sunday of March', () => {
  const win = WIN('2026-10-01', '2027-04-01');
  const starts = (rrule, start = '20261002T090000', extra = []) => expand(ics(['UID:r', 'SUMMARY:R', `DTSTART;TZID=America/Toronto:${start}`, 'DURATION:PT30M', `RRULE:${rrule}`, ...extra]), win)
    .instances.map((i) => new Date(i.startMs).toLocaleDateString('en-CA'));
  assert.deepEqual(starts('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6', '20261006T090000'),
    ['2026-10-06', '2026-10-08', '2026-10-20', '2026-10-22', '2026-11-03', '2026-11-05']);
  assert.deepEqual(starts('FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T235959Z', '20261030T090000'), ['2026-10-30', '2026-11-27', '2026-12-25']);
  assert.deepEqual(starts('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4', '20261030T090000'), ['2026-10-30', '2026-11-30', '2026-12-31', '2027-01-29']);
  assert.deepEqual(starts('FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4', '20261031T090000'), ['2026-10-31', '2026-12-31', '2027-01-31', '2027-03-31'], 'months without a 31st are skipped');
  assert.deepEqual(starts('FREQ=YEARLY;BYMONTH=3;BYDAY=1SU', '20250302T090000'), ['2027-03-07']);
  assert.deepEqual(starts('FREQ=DAILY;INTERVAL=3;UNTIL=20261010', '20261002T090000'), ['2026-10-02', '2026-10-05', '2026-10-08'], 'an UNTIL date includes that day');
  // A daily meeting begun decades ago still has its instances in the window (counted, not kept).
  const old = expand(ics(['UID:d', 'SUMMARY:Standup', 'DTSTART;TZID=America/Toronto:19900102T091500', 'DTEND;TZID=America/Toronto:19900102T093000', 'RRULE:FREQ=DAILY']), WIN('2026-10-12', '2026-10-15'));
  assert.deepEqual(old.instances.map((i) => iso(i.startMs)), ['2026-10-12T13:15:00.000Z', '2026-10-13T13:15:00.000Z', '2026-10-14T13:15:00.000Z']);
  const r = parseRrule('FREQ=WEEKLY;BYDAY=1MO,-2FR;WKST=SU');
  assert.deepEqual(r.byday, [{ n: 1, wd: 1 }, { n: -2, wd: 5 }]);
  assert.equal(r.wkst, 0);
  // COUNT counts the first instance too, and starts before the window are counted, not returned.
  assert.equal(ruleStarts(parseRrule('FREQ=DAILY;COUNT=3'), Date.UTC(2026, 0, 1, 9)).length, 3);
});

test('a rule the suite can\'t read keeps only its first instance and is reported; EXDATE and RDATE by date; floating times are the suite\'s zone', () => {
  const r = expandSeries({ master: minimalCalendar(ics(['UID:h', 'SUMMARY:Hourly', 'DTSTART:20261012T140000Z', 'DURATION:PT10M', 'RRULE:FREQ=HOURLY;COUNT=5'])).events[0] },
    { window: WIN('2026-10-12', '2026-10-13'), fallback: ZONE });
  assert.equal(r.instances.length, 1);
  assert.match(r.unsupported, /HOURLY/);
  const withRdate = expand(ics(['UID:x', 'SUMMARY:Class', 'DTSTART:20261012T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;VALUE=DATE:20261013', 'RDATE:20261020T090000']), WIN('2026-10-12', '2026-10-25'));
  assert.deepEqual(withRdate.instances.map((i) => iso(i.startMs)), ['2026-10-12T13:00:00.000Z', '2026-10-14T13:00:00.000Z', '2026-10-20T13:00:00.000Z']);
});

test('all-day events: one day, several days, and a yearly birthday; they never have times', () => {
  const { instances } = expand(ics(
    ['UID:a1', 'SUMMARY:Thanksgiving', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261013'],
    ['UID:a2', 'SUMMARY:Trade show', 'DTSTART;VALUE=DATE:20261014', 'DTEND;VALUE=DATE:20261017', 'TRANSP:TRANSPARENT'],
    ['UID:a3', 'SUMMARY:Sam’s birthday', 'DTSTART;VALUE=DATE:19900315', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=20'],
  ), WIN('2026-10-12', '2026-10-25'));
  assert.deepEqual(instances.map((i) => [i.title, i.allDay, i.startDate, i.endDate]), [
    ['Thanksgiving', true, '2026-10-12', '2026-10-13'],
    ['Trade show', true, '2026-10-14', '2026-10-17'],
    ['Sam’s birthday', true, '2026-10-20', '2026-10-21'],
  ]);
});

test('time zones: a VTIMEZONE with a TZID Intl doesn\'t know, a Windows name, another zone, UTC, and the spring-forward gap', () => {
  const custom = [
    'BEGIN:VTIMEZONE', 'TZID:Custom Eastern', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'END:DAYLIGHT', 'END:VTIMEZONE',
  ];
  const text = `BEGIN:VCALENDAR\r\n${custom.join('\r\n')}\r\n${[
    'BEGIN:VEVENT', 'UID:c1', 'SUMMARY:Custom', 'DTSTART;TZID=Custom Eastern:20261030T100000', 'DTEND;TZID=Custom Eastern:20261030T110000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c2', 'SUMMARY:Windows', 'DTSTART;TZID=Pacific Standard Time:20261013T090000', 'DTEND;TZID=Pacific Standard Time:20261013T093000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c3', 'SUMMARY:London', 'DTSTART;TZID=Europe/London:20261013T170000', 'DTEND;TZID=Europe/London:20261013T180000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c4', 'SUMMARY:Mozilla-style', 'DTSTART;TZID=/mozilla.org/20050126_1/America/Toronto:20261014T080000', 'DURATION:PT1H', 'END:VEVENT',
  ].join('\r\n')}\r\nEND:VCALENDAR\r\n`;
  const m = minimalCalendar(text);
  assert.ok(m.zones['Custom Eastern'], 'the unknown TZID keeps its rules');
  assert.equal(m.zones['Europe/London'], undefined, 'known IANA names are not stored');
  const { instances } = expandObjects([m], { window: WIN('2026-10-12', '2026-11-10'), fallback: ZONE });
  assert.deepEqual(instances.map((i) => [i.title, iso(i.startMs)]), [
    ['London', '2026-10-13T16:00:00.000Z'],
    ['Windows', '2026-10-13T16:00:00.000Z'],
    ['Mozilla-style', '2026-10-14T12:00:00.000Z'],
    ['Custom', '2026-10-30T14:00:00.000Z'], // still −4
    ['Custom', '2026-11-06T15:00:00.000Z'], // −5 after Nov 1
  ]);
  const z = resolveZone(ZONE);
  assert.equal(iso(z.toUtc(Date.UTC(2026, 2, 8, 2, 30))), '2026-03-08T07:30:00.000Z', '2:30 that doesn\'t exist = 3:30 daylight time');
  assert.equal(iso(z.toUtc(Date.UTC(2026, 6, 1, 9))), '2026-07-01T13:00:00.000Z');
});

test('declined invitations, cancelled events and the suite\'s own task feed are left out; free time is marked not busy', () => {
  const { instances } = expand(ics(
    ['UID:inv', 'SUMMARY:Declined', 'DTSTART:20261013T150000Z', 'DTEND:20261013T160000Z', `ATTENDEE;PARTSTAT=DECLINED:mailto:${APPLE_ID.toUpperCase()}`],
    ['UID:acc', 'SUMMARY:Accepted', 'DTSTART:20261013T170000Z', 'DTEND:20261013T180000Z', `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${APPLE_ID}`, 'ATTENDEE;PARTSTAT=DECLINED:mailto:other@x.ca'],
    ['UID:can', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261013T190000Z', 'DTEND:20261013T200000Z'],
    ['UID:0192aaaa-0000-7000-8000-000000000000@skynet-corp-suite', 'SUMMARY:A suite task', 'DTSTART:20261013T200000Z', 'DTEND:20261013T203000Z'],
    ['UID:free', 'SUMMARY:Focus (free)', 'TRANSP:TRANSPARENT', 'DTSTART:20261013T210000Z', 'DTEND:20261013T220000Z'],
  ), WIN('2026-10-12', '2026-10-15'), { me: APPLE_ID });
  assert.deepEqual(instances.map((i) => [i.title, i.busy]), [['Accepted', true], ['Focus (free)', false]]);
});

// ---- the read-only client -------------------------------------------------------------------------------

test('the client reads only: PROPFIND and REPORT, iCloud https hosts only, no queries, redirects only to iCloud', async (t) => {
  assert.deepEqual(READ_METHODS, ['PROPFIND', 'REPORT']);
  for (const ok of ['https://caldav.icloud.com/', 'https://p42-caldav.icloud.com:443/1234567/calendars/']) assert.ok(isIcloudUrl(new URL(ok)), ok);
  for (const bad of ['http://caldav.icloud.com/', 'https://icloud.com.evil.net/', 'https://evil.net/caldav.icloud.com', 'https://user:pw@caldav.icloud.com/',
    'https://www.icloud.com/', 'https://evil.caldav.icloud.com/', 'https://p42-contacts.icloud.com/', 'https://icloud.com/']) {
    assert.ok(!isIcloudUrl(new URL(bad)), bad);
  }
  assert.throws(() => allowedUrl('https://caldav.icloud.com/x?y=1'), (e) => e.code === 'bad_host');
  assert.throws(() => allowedUrl('http://127.0.0.1:9/'), (e) => e.code === 'bad_host', 'a local address only for the test origin');
  const dav = await startFakeCaldav(t);
  const client = createCaldavClient({ appleId: APPLE_ID, password: APP_PASSWORD, baseUrl: dav.url });
  for (const method of ['PUT', 'DELETE', 'POST', 'GET', 'MKCALENDAR', 'PROPPATCH', 'MOVE', 'COPY']) {
    await assert.rejects(client.request(method, `${dav.url}/`, { depth: 0, body: '' }), (e) => e instanceof CaldavError && e.code === 'bad_method');
  }
  await assert.rejects(client.request('PROPFIND', 'https://example.com/', { depth: 0, body: '' }), (e) => e.code === 'bad_host');
  assert.equal(dav.requests.length, 0, 'nothing was sent');
  // A redirect elsewhere is refused before the password goes anywhere.
  dav.fail['/'] = { status: 302, times: 1, location: 'https://example.com/steal' };
  await assert.rejects(client.discover(), (e) => e.code === 'bad_host');
  // The partition host (here localhost) is followed.
  const r = await client.discover();
  assert.equal(r.homeUrl, `${dav.url.replace('127.0.0.1', 'localhost')}/1234567/calendars/`);
  const cals = await client.listCalendars(r.homeUrl);
  assert.deepEqual(cals.map((c) => [c.name, c.color]), [['Home', '#1badf8'], ['Work', '#ff2968']], 'not the inbox, outbox or the reminders list');
  assert.ok(dav.requests.every((q) => ['PROPFIND', 'REPORT'].includes(q.method)));
  // The module's sources: one fetch, in caldav.js, and no other way out.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/modules/calendar');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const fetches = sources.flatMap(([f, s]) => [...s.matchAll(/\bfetch(Impl)?\(/g)].map(() => f));
  assert.deepEqual(fetches, ['caldav.js']);
  for (const [f, s] of sources) assert.ok(!/node:(http|https|net|tls)['"]|\bXMLHttpRequest\b|axios|undici/.test(s), `${f} has no other HTTP client`);
  // multistatus reads only the 200 propstat.
  const m = multistatus('<multistatus xmlns="DAV:"><response><href>/a/</href><propstat><prop><displayname>A</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>'
    + '<propstat><prop><getctag/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>');
  assert.deepEqual(Object.keys(m[0].props), ['displayname']);
});

test('credentials: an Apple ID and an app-specific password in its shape — never the Apple ID\'s own password', () => {
  assert.deepEqual(cleanCredentials({ appleId: ' Jessy@iCloud.com ', password: 'ABCD EFGH IJKL MNOP' }), { appleId: 'jessy@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
  assert.deepEqual(cleanCredentials({ appleId: 'j@x.ca', password: 'abcdefghijklmnop' }).password, 'abcd-efgh-ijkl-mnop');
  assert.throws(() => cleanCredentials({ appleId: 'jessy', password: APP_PASSWORD }), (e) => e.code === 'bad_apple_id');
  for (const p of ['hunter2', 'Correct-Horse-Battery-1', 'abcd-efgh-ijkl', '']) {
    assert.throws(() => cleanCredentials({ appleId: APPLE_ID, password: p }), /app-specific password/);
  }
  assert.equal(backoffMs(1), 2 * 60_000);
  assert.equal(backoffMs(9), 60 * 60_000);
  const w = meetingWindow(ZONE, at('2026-10-12 08:00'));
  assert.deepEqual([w.today, w.fromDate, w.toDate], ['2026-10-12', '2026-10-05', '2026-12-12']);
  assert.equal(WINDOW_PAST_DAYS, 7);
  assert.equal(WINDOW_FUTURE_DAYS, 60);
});

// ---- the app ----------------------------------------------------------------------------------------------

async function setup(t, { start = at('2026-10-12 08:00'), connect = true, dav = null, config = null, log } = {}) {
  const clock = testClock();
  clock.offsetMs = start - Date.now();
  config ??= testConfig(tmpDir(t));
  dav ??= await startFakeCaldav(t);
  config.calendar.apple.baseUrl = dav.url;
  const env = await startApp(t, config, { modules, now: clock.now, ...(log ? { log } : {}) });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const partner = sessionFor(env.ctx, users.partner);
  const svc = env.ctx.services.calendar.apple;
  const call = async (method, url, { body, session = owner } = {}) => {
    const res = await fetch(`${env.base}${url}`, {
      method,
      headers: { cookie: session.cookie, ...(method !== 'GET' ? { origin: env.base } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  };
  const meetings = (actor = 'owner') => env.db.prepare('SELECT * FROM calendar_meetings WHERE actor = ? AND deleted_at IS NULL ORDER BY start_date, start_at, title').all(actor);
  const advance = (ms) => clock.advance(ms);
  const s = { ...env, config, clock, users, owner, partner, svc, dav, call, meetings, advance };
  if (connect) {
    const r = await call('PUT', '/api/calendar/apple', { body: { appleId: APPLE_ID, password: APP_PASSWORD } });
    assert.equal(r.status, 200, r.text);
    // Nothing is read until the calendars are chosen; choosing all of them reads at once.
    const c = await call('PUT', '/api/calendar/apple/calendars', { body: { excluded: [] } });
    assert.equal(c.status, 200, c.text);
  }
  return s;
}

test('done when: a meeting added in Apple Calendar is a synced meeting record for today at the next read (15 minutes)', async (t) => {
  const s = await setup(t);
  assert.equal(s.meetings().length, 0);
  s.dav.put('work', 'lunch', ics(['UID:lunch-1', 'SUMMARY:Lunch with Lefty’s', 'DTSTART;TZID=America/Toronto:20261012T120000', 'DTEND;TZID=America/Toronto:20261012T130000']));
  assert.deepEqual((await s.svc.pullRound()).people, { owner: 'not_due' }, 'not before the next read is due');
  s.advance(15 * 60_000);
  assert.deepEqual((await s.svc.pullRound()).people, { owner: 'read' });
  const [m] = s.meetings();
  assert.equal(m.title, 'Lunch with Lefty’s');
  assert.equal(m.calendar_name, 'Work');
  assert.deepEqual([m.start_date, m.end_date, m.start_at, m.end_at, m.all_day, m.busy], ['2026-10-12', '2026-10-12', '2026-10-12T16:00:00.000Z', '2026-10-12T17:00:00.000Z', 0, 1]);
  assert.equal(m.created_by, 'system');
  // Devices get it like any record, and can't write it.
  const pulled = await s.call('GET', '/api/sync/pull?limit=1000');
  assert.ok(pulled.body.changes.some((c) => c.entity === 'meeting' && c.fields.title === 'Lunch with Lefty’s'));
  const info = await s.call('GET', '/api/sync/info');
  assert.equal(info.body.entities.find((e) => e.entity === 'meeting')?.readOnly, true);
});

test('repeats across DST with an overridden instance come through as one record per instance, in Toronto days', async (t) => {
  const dav = await startFakeCaldav(t);
  dav.put('work', 'weekly', ics(
    ['UID:wk', 'SUMMARY:Weekly sync', 'DTSTART;TZID=America/Toronto:20261026T100000', 'DTEND;TZID=America/Toronto:20261026T110000', 'RRULE:FREQ=WEEKLY;COUNT=3'],
    ['UID:wk', 'RECURRENCE-ID;TZID=America/Toronto:20261102T100000', 'SUMMARY:Weekly sync — at the shop', 'DTSTART;TZID=America/Toronto:20261102T150000', 'DTEND;TZID=America/Toronto:20261102T160000'],
  ));
  const s = await setup(t, { dav });
  assert.deepEqual(s.meetings().map((m) => [m.start_date, m.title, m.start_at, m.recurring]), [
    ['2026-10-26', 'Weekly sync', '2026-10-26T14:00:00.000Z', 1],
    ['2026-11-02', 'Weekly sync — at the shop', '2026-11-02T20:00:00.000Z', 1],
    ['2026-11-09', 'Weekly sync', '2026-11-09T15:00:00.000Z', 1],
  ]);
});

test('reads fetch only what changed: unchanged calendars are skipped by CTag, changed objects by ETag; edits update, deletions delete', async (t) => {
  const dav = await startFakeCaldav(t);
  dav.put('home', 'a', ics(['UID:a', 'SUMMARY:Dentist', 'DTSTART:20261013T130000Z', 'DTEND:20261013T140000Z']));
  dav.put('home', 'b', ics(['UID:b', 'SUMMARY:Vet', 'DTSTART:20261014T130000Z', 'DTEND:20261014T140000Z']));
  const s = await setup(t, { dav });
  assert.equal(s.meetings().length, 2);
  const id = s.meetings()[0].id;
  // Nothing changed: only the calendar list is read.
  dav.requests.length = 0;
  s.advance(15 * 60_000);
  await s.svc.pullRound();
  assert.deepEqual(dav.requests.map((r) => r.method), ['PROPFIND']);
  // One edited: its ETag is new, so only it is fetched; the record is the same one, updated.
  dav.put('home', 'a', ics(['UID:a', 'SUMMARY:Dentist (moved)', 'DTSTART:20261013T170000Z', 'DTEND:20261013T180000Z']));
  dav.requests.length = 0;
  s.advance(15 * 60_000);
  await s.svc.pullRound();
  const multiget = dav.requests.filter((r) => r.body.includes('calendar-multiget'));
  assert.equal(multiget.length, 1);
  assert.equal([...multiget[0].body.matchAll(/<d:href>/g)].length, 1, 'only the changed object');
  const moved = s.meetings().find((m) => m.title === 'Dentist (moved)');
  assert.equal(moved.id, id, 'the same record, updated');
  assert.equal(moved.start_at, '2026-10-13T17:00:00.000Z');
  // Deleted in Apple Calendar → deleted here.
  dav.remove('home', 'b');
  s.advance(15 * 60_000);
  await s.svc.pullRound();
  assert.deepEqual(s.meetings().map((m) => m.title), ['Dentist (moved)']);
  // The window moves with the days: past meetings older than 7 days leave.
  s.advance(9 * 86_400_000);
  await s.svc.pullRound();
  assert.deepEqual(s.meetings(), []);
});

test('connecting: checked with iCloud before anything is saved; the password is sealed, never returned, never logged', async (t) => {
  const lines = [];
  const s = await setup(t, { connect: false, log: capturingLog(lines) });
  const bad = await s.call('PUT', '/api/calendar/apple', { body: { appleId: APPLE_ID, password: 'zzzz-zzzz-zzzz-zzzz' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'refused');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM calendar_apple').get().n, 0, 'nothing saved');
  assert.equal((await s.call('PUT', '/api/calendar/apple', { body: { appleId: APPLE_ID, password: 'my real password' } })).body.code, 'bad_password');
  const ok = await s.call('PUT', '/api/calendar/apple', { body: { appleId: APPLE_ID, password: APP_PASSWORD.toUpperCase() } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.connected, true);
  assert.deepEqual(ok.body.calendars.map((c) => [c.name, c.included]), [['Home', true], ['Work', true]]);
  // Chosen before anything is read: no event was fetched, no meeting made, no read due.
  assert.equal(ok.body.confirmed, false);
  assert.equal(ok.body.firstRead, 'choose_calendars');
  assert.ok(!s.dav.requests.some((q) => q.method === 'REPORT'), 'no events read before the calendars are chosen');
  assert.deepEqual((await s.svc.pullRound({ force: true })).people, { owner: 'not_confirmed' });
  assert.equal((await s.call('POST', '/api/calendar/apple/pull', { body: {} })).body.code, 'not_confirmed');
  assert.throws(() => cleanCredentials({ appleId: 'jes:sy@icloud.com', password: APP_PASSWORD }), (e) => e.code === 'bad_apple_id', 'no ":" (HTTP Basic)');
  const row = s.db.prepare('SELECT * FROM calendar_apple').get();
  assert.match(row.password_enc, /^v1:/);
  const everything = JSON.stringify(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map(({ name }) => s.db.prepare(`SELECT * FROM "${name}"`).all()));
  assert.ok(!everything.includes(APP_PASSWORD), 'the password is nowhere in the database');
  for (const r of [ok, await s.call('GET', '/api/calendar/apple'), await s.call('GET', '/api/connections')]) assert.ok(!r.text.includes(APP_PASSWORD));
  assert.ok(!lines.some((l) => l.text.includes(APP_PASSWORD) || l.text.includes(Buffer.from(`${APPLE_ID}:${APP_PASSWORD}`).toString('base64'))));
  assert.ok(fs.existsSync(s.config.calendar.apple.keyFile));
  // Each person has their own: the partner isn't connected.
  assert.equal((await s.call('GET', '/api/calendar/apple', { session: s.partner })).body.connected, false);
  // Origin/JSON rules hold.
  const noOrigin = await fetch(`${s.base}/api/calendar/apple`, { method: 'PUT', headers: { cookie: s.owner.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  assert.equal((await fetch(`${s.base}/api/calendar/apple`)).status, 401, 'signed in only');
});

test('choosing calendars: a calendar left out takes its meetings off devices and its events are forgotten; ticked again, it is read', async (t) => {
  const dav = await startFakeCaldav(t);
  dav.put('home', 'h', ics(['UID:h', 'SUMMARY:Groceries', 'DTSTART:20261013T220000Z', 'DTEND:20261013T230000Z']));
  dav.put('work', 'w', ics(['UID:w', 'SUMMARY:Client call', 'DTSTART:20261013T140000Z', 'DTEND:20261013T150000Z']));
  const s = await setup(t, { dav });
  const homeUrl = (await s.call('GET', '/api/calendar/apple')).body.calendars.find((c) => c.name === 'Home').url;
  const r = await s.call('PUT', '/api/calendar/apple/calendars', { body: { excluded: [homeUrl] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(s.meetings().map((m) => m.title), ['Client call']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM calendar_apple_objects WHERE calendar_url = ?').get(homeUrl).n, 0);
  s.advance(15 * 60_000);
  dav.requests.length = 0;
  await s.svc.pullRound();
  assert.ok(!dav.requests.some((q) => q.path.includes('/home/')), 'a calendar left out isn\'t read');
  await s.call('PUT', '/api/calendar/apple/calendars', { body: { excluded: [] } });
  await s.svc.pullRound({ force: true, actor: 'owner' });
  assert.deepEqual(s.meetings().map((m) => m.title), ['Client call', 'Groceries']);
  assert.equal((await s.call('PUT', '/api/calendar/apple/calendars', { body: { excluded: 'x' } })).status, 400);
});

test('failures back off; a revoked password stops every call until a new one is entered; pause = no calls, nothing deleted', async (t) => {
  const s = await setup(t);
  s.dav.put('work', 'm', ics(['UID:m', 'SUMMARY:Standup', 'DTSTART:20261013T130000Z', 'DTEND:20261013T131500Z']));
  s.dav.fail['*'] = { status: 503, times: 1 };
  s.advance(15 * 60_000);
  assert.deepEqual((await s.svc.pullRound()).people, { owner: 'failed' });
  let info = (await s.call('GET', '/api/calendar/apple')).body;
  assert.match(info.lastError, /503/);
  assert.equal(Date.parse(info.nextTryAt) - s.clock.now() > 60_000, true, 'waits 2 minutes');
  assert.deepEqual((await s.svc.pullRound()).people, { owner: 'not_due' });
  s.advance(2 * 60_000);
  assert.deepEqual((await s.svc.pullRound()).people, { owner: 'read' });
  assert.equal(s.meetings().length, 1);
  // Paused: no calls at all, and the meetings stay.
  assert.equal((await s.call('PUT', '/api/connections/calendar', { body: { paused: true } })).status, 200);
  s.dav.requests.length = 0;
  s.advance(60 * 60_000);
  assert.equal((await s.svc.pullRound()).skipped, 'paused');
  assert.equal((await s.call('POST', '/api/calendar/apple/pull', { body: {} })).body.code, 'paused');
  assert.equal(s.dav.requests.length, 0);
  assert.equal(s.meetings().length, 1);
  await s.call('PUT', '/api/connections/calendar', { body: { paused: false } });
  await s.svc.pullRound();
  // The password revoked at appleid.apple.com: one refused call, then none.
  s.dav.revoked = true;
  s.advance(15 * 60_000);
  assert.deepEqual((await s.svc.pullRound()).people, { owner: 'refused' });
  s.dav.requests.length = 0;
  s.advance(60 * 60_000);
  await s.svc.pullRound();
  assert.equal((await s.call('POST', '/api/calendar/apple/pull', { body: {} })).body.code, 'refused');
  assert.equal(s.dav.requests.length, 0, 'no calls with a refused password');
  info = (await s.call('GET', '/api/calendar/apple')).body;
  assert.ok(info.refusedAt);
  const conn = (await s.call('GET', '/api/connections')).body.connections.find((c) => c.id === 'calendar');
  assert.equal(conn.state, 'on');
  assert.match(conn.lastError, /refused the app-specific password/);
  assert.match(conn.queueLabel, /Jessy: password refused · Sam: not connected/);
  // A new password: read again at once.
  s.dav.revoked = false;
  s.dav.password = 'wxyz-wxyz-wxyz-wxyz';
  assert.equal((await s.call('PUT', '/api/calendar/apple', { body: { appleId: APPLE_ID, password: 'wxyz-wxyz-wxyz-wxyz' } })).status, 200);
  assert.equal((await s.call('GET', '/api/calendar/apple')).body.refusedAt, null);
  assert.equal(s.meetings().length, 1);
});

test('devices can\'t write meetings; forgetting takes the person\'s meetings off devices; the other person\'s stay', async (t) => {
  const s = await setup(t);
  s.dav.put('work', 'm', ics(['UID:m', 'SUMMARY:Standup', 'DTSTART:20261013T130000Z', 'DTEND:20261013T131500Z']));
  await s.svc.pullRound({ force: true });
  // The partner connects their own Apple ID (the fake takes one login: switch it).
  const dav2 = await startFakeCaldav(t, { appleId: 'sam@icloud.com' });
  dav2.put('home', 'p', ics(['UID:p', 'SUMMARY:Sam’s yoga', 'DTSTART:20261013T230000Z', 'DTEND:20261014T000000Z']));
  s.config.calendar.apple.baseUrl = dav2.url;
  assert.equal((await s.call('PUT', '/api/calendar/apple', { session: s.partner, body: { appleId: 'sam@icloud.com', password: APP_PASSWORD } })).status, 200);
  assert.equal((await s.call('PUT', '/api/calendar/apple/calendars', { session: s.partner, body: { excluded: [] } })).status, 200);
  assert.deepEqual(s.meetings('partner').map((m) => m.title), ['Sam’s yoga']);
  const [m] = s.meetings('owner');
  const push = await s.call('POST', '/api/sync/push', {
    body: { steps: [{ key: '0192f000-0000-7000-8000-000000000001', entity: 'meeting', recordId: m.id, op: 'update', fields: { title: 'x' }, hlc: `${Date.now()}-0-${s.owner.deviceId}` }] },
  });
  assert.equal(push.body.results[0].status, 'rejected');
  assert.equal(push.body.results[0].code, 'op_not_allowed');
  const forgot = await s.call('DELETE', '/api/calendar/apple');
  assert.equal(forgot.body.connected, false);
  assert.deepEqual(s.meetings('owner'), []);
  assert.deepEqual(s.meetings('partner').map((x) => x.title), ['Sam’s yoga']);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM calendar_apple_objects WHERE actor = 'owner'").get().n, 0);
});

test('the task calendar feed never sends meetings back (and the suite never reads its own feed as meetings)', async (t) => {
  const s = await setup(t);
  s.dav.put('work', 'm', ics(['UID:m', 'SUMMARY:Secret strategy meeting', 'DTSTART:20261013T130000Z', 'DTEND:20261013T140000Z']));
  s.dav.put('work', 'loop', ics(['UID:0192aaaa-0000-7000-8000-000000000000@skynet-corp-suite', 'SUMMARY:Ship order #12', 'DTSTART:20261013T150000Z', 'DTEND:20261013T153000Z']));
  await s.svc.pullRound({ force: true });
  assert.deepEqual(s.meetings().map((m) => m.title), ['Secret strategy meeting']);
  const link = await s.call('POST', '/api/calendar/link', { body: {} });
  const feed = await fetch(`${s.base}${link.body.path}`);
  assert.equal(feed.status, 200);
  assert.ok(!(await feed.text()).includes('Secret strategy'));
});

test('restores: the connection is kept (a password forgotten after the backup stays forgotten); meetings are put right at start', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const dav = await startFakeCaldav(t);
  dav.put('work', 'm', ics(['UID:m', 'SUMMARY:Before the backup', 'DTSTART:20261013T130000Z', 'DTEND:20261013T140000Z']));
  let s = await setup(t, { dav, config });
  assert.ok(KEPT_TABLES.includes('calendar_apple') && KEPT_TABLES.includes('calendar_apple_changes'));
  assert.ok(!KEPT_TABLES.includes('calendar_meetings'));
  const backup = await runBackup({ db: s.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  // After the backup: forgotten.
  await s.call('DELETE', '/api/calendar/apple');
  assert.deepEqual(s.meetings(), []);
  await s.close();
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  s = await setup(t, { dav, config, connect: false });
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM calendar_apple').get().n, 0, 'the forgotten connection doesn\'t come back');
  assert.deepEqual(s.meetings(), [], 'the restored meeting is taken off at start (its connection is gone)');
});

// ---- review fixes ------------------------------------------------------------------------------------------

test('a new password for the same Apple ID keeps the calendars left out (and reads at once); another Apple ID chooses again', async (t) => {
  const dav = await startFakeCaldav(t);
  dav.put('home', 'h', ics(['UID:h', 'SUMMARY:Therapy', 'DTSTART:20261013T220000Z', 'DTEND:20261013T230000Z']));
  dav.put('work', 'w', ics(['UID:w', 'SUMMARY:Client call', 'DTSTART:20261013T140000Z', 'DTEND:20261013T150000Z']));
  const s = await setup(t, { dav });
  const homeUrl = (await s.call('GET', '/api/calendar/apple')).body.calendars.find((c) => c.name === 'Home').url;
  await s.call('PUT', '/api/calendar/apple/calendars', { body: { excluded: [homeUrl] } });
  const callId = s.meetings()[0].id;
  dav.password = 'wxyz-wxyz-wxyz-wxyz';
  const r = await s.call('PUT', '/api/calendar/apple', { body: { appleId: APPLE_ID, password: 'wxyz-wxyz-wxyz-wxyz' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.confirmed, true);
  assert.deepEqual(r.body.calendars.map((c) => [c.name, c.included]), [['Home', false], ['Work', true]], 'Home stays left out');
  assert.deepEqual(s.meetings().map((m) => [m.title, m.id]), [['Client call', callId]], 'no therapy, and no churn of the record');
  assert.ok(!dav.requests.slice(-6).some((q) => q.path.includes('/home/') && q.method === 'REPORT'));
  // Another Apple ID: its calendars are chosen afresh, nothing read before, the old one's meetings gone.
  dav.appleId = 'other@icloud.com';
  const other = await s.call('PUT', '/api/calendar/apple', { body: { appleId: 'other@icloud.com', password: 'wxyz-wxyz-wxyz-wxyz' } });
  assert.equal(other.body.confirmed, false);
  assert.ok(other.body.calendars.every((c) => c.included));
  assert.deepEqual(s.meetings(), []);
});

test('two people forcing a read while one runs: both are read (neither request is lost)', async (t) => {
  const s = await setup(t);
  const dav2 = await startFakeCaldav(t, { appleId: 'sam@icloud.com' });
  dav2.put('home', 'p', ics(['UID:p', 'SUMMARY:Sam’s yoga', 'DTSTART:20261013T230000Z', 'DTEND:20261014T000000Z']));
  s.config.calendar.apple.baseUrl = dav2.url;
  await s.call('PUT', '/api/calendar/apple', { session: s.partner, body: { appleId: 'sam@icloud.com', password: APP_PASSWORD } });
  await s.call('PUT', '/api/calendar/apple/calendars', { session: s.partner, body: { excluded: [] } });
  dav2.put('home', 'q', ics(['UID:q', 'SUMMARY:Sam’s dentist', 'DTSTART:20261014T150000Z', 'DTEND:20261014T160000Z']));
  // A round is running (plain look); then the owner and the partner each tap Read now.
  s.advance(15 * 60_000);
  const plain = s.svc.pullRound();
  const owner = s.svc.pullRound({ force: true, actor: 'owner' });
  const partner = s.svc.pullRound({ force: true, actor: 'partner' });
  await plain;
  const [a, b] = await Promise.all([owner, partner]);
  assert.equal(a, b, 'one chained round for both');
  assert.equal(a.people.partner, 'read');
  assert.ok('owner' in a.people);
  assert.deepEqual(s.meetings('partner').map((m) => m.title), ['Sam’s yoga', 'Sam’s dentist']);
});

test('an EXDATE’d or out-of-series override doesn’t show; one past COUNT or UNTIL neither', () => {
  const win = WIN('2026-10-12', '2026-11-30');
  const text = ics(
    ['UID:s', 'SUMMARY:Sync', 'DTSTART;TZID=America/Toronto:20261012T100000', 'DTEND;TZID=America/Toronto:20261012T110000',
      'RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;TZID=America/Toronto:20261019T100000'],
    // Removed by EXDATE, though an override for it is still there (moved to a day in the window).
    ['UID:s', 'RECURRENCE-ID;TZID=America/Toronto:20261019T100000', 'SUMMARY:Sync (moved)', 'DTSTART;TZID=America/Toronto:20261021T100000', 'DTEND;TZID=America/Toronto:20261021T110000'],
    // Past COUNT=3 (Oct 12, 19, 26): left behind when the series was shortened.
    ['UID:s', 'RECURRENCE-ID;TZID=America/Toronto:20261102T100000', 'SUMMARY:Sync (stale)', 'DTSTART;TZID=America/Toronto:20261103T100000', 'DTEND;TZID=America/Toronto:20261103T110000'],
    // Not a Monday at all: not an instance of this series.
    ['UID:s', 'RECURRENCE-ID;TZID=America/Toronto:20261014T100000', 'SUMMARY:Sync (stray)', 'DTSTART;TZID=America/Toronto:20261014T100000', 'DTEND;TZID=America/Toronto:20261014T110000'],
  );
  assert.deepEqual(expand(text, win).instances.map((i) => i.title), ['Sync', 'Sync']);
  const until = ics(
    ['UID:u', 'SUMMARY:Class', 'DTSTART:20260901T140000Z', 'DTEND:20260901T150000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20261013T235959Z'],
    // Moved into the window from before it: a real instance (Sep 29), so it shows.
    ['UID:u', 'RECURRENCE-ID:20260929T140000Z', 'SUMMARY:Class (moved)', 'DTSTART:20261015T140000Z', 'DTEND:20261015T150000Z'],
    ['UID:u', 'RECURRENCE-ID:20261020T140000Z', 'SUMMARY:Class (after UNTIL)', 'DTSTART:20261021T140000Z', 'DTEND:20261021T150000Z'],
  );
  assert.deepEqual(expand(until, win).instances.map((i) => i.title), ['Class', 'Class (moved)']);
  // An override with no master (invited to one instance) still shows.
  const lone = ics(['UID:l', 'RECURRENCE-ID:20261020T140000Z', 'SUMMARY:One time', 'DTSTART:20261020T140000Z', 'DTEND:20261020T150000Z']);
  assert.deepEqual(expand(lone, win).instances.map((i) => i.title), ['One time']);
  // A zero-length event at a time that doesn't exist (the spring-forward gap) is kept, at 3:30 daylight time.
  const gap = expand(ics(['UID:g', 'SUMMARY:Reminder', 'DTSTART;TZID=America/Toronto:20260308T023000', 'DTEND;TZID=America/Toronto:20260308T023000']), WIN('2026-03-08', '2026-03-09'));
  assert.deepEqual(gap.instances.map((i) => [iso(i.startMs), i.endMs - i.startMs]), [['2026-03-08T07:30:00.000Z', 0]]);
});

test('declined under an alias: the principal’s calendar-user-address-set counts as “me”', async (t) => {
  const dav = await startFakeCaldav(t);
  dav.aliases = ['jessy.r@me.com'];
  dav.put('work', 'inv', ics(['UID:inv', 'SUMMARY:Declined via alias', 'DTSTART:20261013T150000Z', 'DTEND:20261013T160000Z', 'ATTENDEE;PARTSTAT=DECLINED:mailto:Jessy.R@me.com']));
  dav.put('work', 'acc', ics(['UID:acc', 'SUMMARY:Accepted', 'DTSTART:20261013T170000Z', 'DTEND:20261013T180000Z', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:jessy.r@me.com']));
  const s = await setup(t, { dav });
  assert.deepEqual(s.meetings().map((m) => m.title), ['Accepted']);
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT addresses FROM calendar_apple').get().addresses), [APPLE_ID, 'jessy.r@me.com']);
  assert.equal(minimalCalendar(ics(['UID:x', 'DTSTART:20261013T150000Z', 'ATTENDEE;PARTSTAT=DECLINED:mailto:b@x.ca']), { me: ['a@x.ca', 'B@x.ca'] }).events[0].declined, true);
});

test('meetings per calendar are counted by calendar, not by name (two calendars called “Work”)', async (t) => {
  const dav = await startFakeCaldav(t);
  dav.addCalendar('work2', { name: 'Work' });
  dav.put('work', 'a', ics(['UID:a', 'SUMMARY:A', 'DTSTART:20261013T130000Z', 'DTEND:20261013T140000Z']));
  dav.put('work2', 'b', ics(['UID:b', 'SUMMARY:B', 'DTSTART:20261013T150000Z', 'DTEND:20261013T160000Z']));
  dav.put('work2', 'c', ics(['UID:c', 'SUMMARY:C', 'DTSTART:20261013T170000Z', 'DTEND:20261013T180000Z']));
  const s = await setup(t, { dav });
  const counts = (await s.call('GET', '/api/calendar/apple')).body.calendars.filter((c) => c.name === 'Work').map((c) => c.meetings).sort();
  assert.deepEqual(counts, [1, 2]);
});

test('the XML reader is linear: unterminated comments, CDATA, PIs and tags stop the reading instead of scanning again', () => {
  const big = 200_000;
  const t0 = performance.now();
  for (const bad of ['<!--', '<![CDATA[', '<?', '<!DOCTYPE', '<a x="', '<a ']) parseXml(`<m>${bad.repeat(big)}`);
  parseXml(`${'<a>'.repeat(20_000)}${'x'.repeat(big)}`);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
  const r = parseXml('<d:a x="1>2"><!-- c --><?pi?><b/><![CDATA[q<]]>&amp;<!--unterminated');
  assert.deepEqual([r.children[0].attrs.x, r.children[0].children[0].name, r.children[0].text], ['1>2', 'b', 'q<&']);
});

test('answers over the size cap are stopped while being read, counted in bytes (not characters)', async () => {
  const body = (text, headers = {}) => async () => new Response(text, { status: 207, headers });
  // 600 "é" = 600 characters but 1,200 bytes: over a 1,000-byte cap.
  const client = createCaldavClient({ appleId: APPLE_ID, password: APP_PASSWORD, maxBytes: 1000, fetchImpl: body(`<multistatus xmlns="DAV:">${'é'.repeat(600)}</multistatus>`) });
  await assert.rejects(client.request('PROPFIND', 'https://caldav.icloud.com/', { depth: 0, body: '' }), (e) => e.code === 'too_big');
  // A stream that never ends is cut at the cap (it would otherwise run the server out of memory).
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(512)); } });
  const c2 = createCaldavClient({ appleId: APPLE_ID, password: APP_PASSWORD, maxBytes: 4096, fetchImpl: async () => new Response(endless, { status: 207 }) });
  await assert.rejects(c2.request('REPORT', 'https://p1-caldav.icloud.com/x/', { depth: 1, body: '' }), (e) => e.code === 'too_big');
  assert.ok(pulled < 20, `stopped after ${pulled} chunks`);
  const ok = createCaldavClient({ appleId: APPLE_ID, password: APP_PASSWORD, maxBytes: 1000, fetchImpl: body('<multistatus xmlns="DAV:"></multistatus>') });
  assert.equal((await ok.request('PROPFIND', 'https://caldav.icloud.com/', { depth: 0, body: '' })).status, 207);
});
