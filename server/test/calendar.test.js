// The task calendar feed (C6a): each person's feed (their own tasks and the shared list's, never the
// other person's own), all-day vs timed events, the time zone across DST, escaping and folding,
// what drops out (done, deleted, undated, outside the window), the link's life (make, replace, turn
// off — the old one stops at once), 404s and the per-address throttle, no session needed but nothing
// else reachable with the token, ETags, the pause switch, and restores. Every feed is checked by a
// small RFC 5545 reader below (CRLF, 75-octet lines, nesting, required properties, unescaping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { redactPath } from '../src/lib/redact.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup, KEPT_TABLES } from '../src/backup/restore.js';
import { escapeText, foldLine, eventTimes, zoneTransitions } from '../src/modules/calendar/ics.js';
import { FAIL_LIMIT, PAST_DAYS, FUTURE_DAYS } from '../src/modules/calendar/service.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from './helpers.js';

const ZONE = 'America/Toronto';
const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;
// Friday Oct 9 2026, noon in Toronto.
const OCT_9 = Date.UTC(2026, 9, 9, 16, 0);

// ---- a small RFC 5545 reader ------------------------------------------------------------------
function unescapeText(v) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Parse a feed, checking the wire format on the way; returns the VCALENDAR component. */
function parseIcs(body) {
  assert.ok(body.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(body), 'every line ends in CRLF, no bare CR or LF');
  const physical = body.slice(0, -2).split('\r\n');
  for (const line of physical) assert.ok(Buffer.byteLength(line) <= 75, `line over 75 octets: ${line}`);
  const lines = [];
  for (const line of physical) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      assert.ok(lines.length, 'a continuation line needs a line before it');
      lines[lines.length - 1] += line.slice(1);
    } else lines.push(line);
  }
  const root = { name: null, props: [], children: [] };
  const stack = [root];
  for (const line of lines) {
    const colon = line.indexOf(':');
    assert.ok(colon > 0, `no ":" in ${line}`);
    const [name, ...params] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    if (name === 'BEGIN') {
      const c = { name: value, props: [], children: [] };
      stack.at(-1).children.push(c);
      stack.push(c);
    } else if (name === 'END') {
      assert.equal(stack.pop().name, value, `END:${value} closes what was opened`);
    } else {
      stack.at(-1).props.push({ name, params: Object.fromEntries(params.map((p) => p.split('='))), value });
    }
  }
  assert.equal(stack.length, 1, 'every BEGIN has its END');
  assert.equal(root.children.length, 1);
  const cal = root.children[0];
  assert.equal(cal.name, 'VCALENDAR');
  assert.equal(prop(cal, 'VERSION').value, '2.0');
  assert.ok(prop(cal, 'PRODID'));
  for (const ev of events(cal)) {
    for (const required of ['UID', 'DTSTAMP', 'DTSTART']) assert.ok(prop(ev, required), `VEVENT has ${required}`);
  }
  // Every TZID used is defined.
  const zones = new Set(cal.children.filter((c) => c.name === 'VTIMEZONE').map((z) => prop(z, 'TZID').value));
  for (const ev of events(cal)) {
    for (const p of ev.props) if (p.params.TZID) assert.ok(zones.has(p.params.TZID), `VTIMEZONE for ${p.params.TZID}`);
  }
  return cal;
}
const prop = (c, name) => c.props.find((p) => p.name === name);
const events = (cal) => cal.children.filter((c) => c.name === 'VEVENT');
const summaries = (cal) => events(cal).map((e) => unescapeText(prop(e, 'SUMMARY').value)).sort();
const byTitle = (cal, title) => events(cal).find((e) => unescapeText(prop(e, 'SUMMARY').value).endsWith(title));

/** "YYYYMMDDTHHMMSS" in the feed's VTIMEZONE → the UTC instant, as a client would read it. */
function resolveLocal(cal, tzid, local) {
  const z = cal.children.find((c) => c.name === 'VTIMEZONE' && prop(c, 'TZID').value === tzid);
  const obs = z.children.map((o) => ({ start: prop(o, 'DTSTART').value, to: prop(o, 'TZOFFSETTO').value }))
    .filter((o) => o.start <= local).sort((a, b) => (a.start < b.start ? -1 : 1));
  assert.ok(obs.length, `an observance covers ${local}`);
  const off = obs.at(-1).to;
  const minutes = (off[0] === '-' ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
  const ms = Date.UTC(+local.slice(0, 4), +local.slice(4, 6) - 1, +local.slice(6, 8), +local.slice(9, 11), +local.slice(11, 13));
  return new Date(ms - minutes * 60_000).toISOString();
}

// ---- setup ------------------------------------------------------------------------------------
async function setup(t, { at = OCT_9, env = {}, config } = {}) {
  const clock = { t: at };
  const cfg = config ?? testConfig(tmpDir(t), { CALENDAR_TIME_ZONE: ZONE, ...env });
  const app = await startApp(t, cfg, { now: () => clock.t });
  const users = await ensureTestUsers(app.ctx);
  const owner = sessionFor(app.ctx, users.owner);
  const partner = sessionFor(app.ctx, users.partner);
  const call = async (method, url, { session = owner, body, headers = {} } = {}) => {
    const res = await fetch(`${app.base}${url}`, {
      method,
      headers: {
        ...(session ? { cookie: session.cookie } : {}),
        ...(method !== 'GET' && method !== 'HEAD' ? { origin: app.base } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, text, body: json };
  };
  /** Fetch a feed like a calendar app: no cookie, no Origin. */
  const feed = (pathOrToken, headers = {}) => call('GET', pathOrToken.startsWith('/') ? pathOrToken : `/api/calendar/feed/${pathOrToken}.ics`, { session: null, headers });
  const sync = app.ctx.services.sync;
  const task = (fields, { actor = 'owner' } = {}) => {
    const r = sync.applyLocal({ actor, entity: 'task', op: 'create', fields: { business_id: AGENCY, owner: 'owner', ...fields } });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const update = (id, fields) => assert.equal(sync.applyLocal({ actor: 'owner', entity: 'task', op: 'update', recordId: id, fields }).status, 'applied');
  const remove = (id) => assert.equal(sync.applyLocal({ actor: 'owner', entity: 'task', op: 'delete', recordId: id }).status, 'applied');
  const makeLink = async (session = owner) => {
    const r = await call('POST', '/api/calendar/link', { session, body: {} });
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  return { ...app, clock, users, owner, partner, call, feed, task, update, remove, makeLink, service: app.ctx.services.calendar };
}

// ---- the pure parts ---------------------------------------------------------------------------
test('ics: escaping, folding at 75 octets without splitting a character, event times', () => {
  assert.equal(escapeText('a,b;c\\d\ne\r\nf\u0007g'), 'a\\,b\\;c\\\\d\\ne\\nfg');
  const folded = foldLine(`SUMMARY:${'é'.repeat(50)}${'😀'.repeat(20)}`);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 2);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 75);
  assert.ok(parts.slice(1).every((p) => p.startsWith(' ')));
  assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(''), `SUMMARY:${'é'.repeat(50)}${'😀'.repeat(20)}`, 'unfolds to the original');
  assert.equal(foldLine('X:short'), 'X:short');

  assert.deepEqual(eventTimes({ due_date: '2026-12-31' }), { allDay: true, start: '20261231', end: '20270101' });
  assert.deepEqual(eventTimes({ due_date: '2026-11-02', due_time: '09:00' }), { allDay: false, start: '20261102T090000', end: '20261102T093000' }, '30 minutes when no estimate');
  assert.deepEqual(eventTimes({ due_date: '2026-11-02', due_time: '09:00', estimate_minutes: 90 }).end, '20261102T103000');
  assert.deepEqual(eventTimes({ due_date: '2026-11-02', due_time: '23:45', estimate_minutes: 120 }).end, '20261103T000000', 'never past midnight');
  assert.equal(eventTimes({ due_date: '2026-11-02', due_time: '9am' }).allDay, true, 'a time that isn’t HH:MM is ignored');

  // Toronto's changes in the window: Nov 1 2026 06:00Z (−4 → −5), Mar 14 2027 07:00Z (−5 → −4).
  const ts = zoneTransitions(ZONE, Date.UTC(2026, 9, 1), Date.UTC(2027, 5, 1));
  assert.deepEqual(ts.map((x) => [new Date(x.at).toISOString(), x.from, x.to]), [
    ['2026-11-01T06:00:00.000Z', -240, -300],
    ['2027-03-14T07:00:00.000Z', -300, -240],
  ]);
});

// ---- feeds --------------------------------------------------------------------------------------
test('each person’s feed: their own dated tasks and the shared list’s, never the other person’s own; titles and business only', async (t) => {
  const s = await setup(t);
  const client = s.ctx.services.sync.applyLocal({ actor: 'owner', entity: 'client', op: 'create', fields: { name: 'Lefty’s Secret Client', status: 'active' } }).recordId;
  s.task({ title: 'Mine, all day', due_date: '2026-10-12', notes: 'private note text', client_id: client });
  s.task({ title: 'Shared renewal', owner: 'shared', business_id: PERSONAL, due_date: '2026-10-13' });
  s.task({ title: 'Sam’s own', owner: 'partner', due_date: '2026-10-12' }, { actor: 'partner' });
  s.task({ title: 'No date', owner: 'owner' });

  const mine = await s.makeLink(s.owner);
  const theirs = await s.makeLink(s.partner);
  assert.notEqual(mine.token, theirs.token);
  assert.match(mine.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(mine.path, `/api/calendar/feed/${mine.token}.ics`);

  const r = await s.feed(mine.path);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/calendar; charset=utf-8/);
  const cal = parseIcs(r.text);
  assert.deepEqual(summaries(cal), ['Mine, all day', '[Shared] Shared renewal']);
  assert.equal(unescapeText(prop(cal, 'X-WR-CALNAME').value), 'Suite tasks · Jessy');
  assert.equal(prop(cal, 'REFRESH-INTERVAL').value, 'PT15M');
  assert.equal(prop(cal, 'X-PUBLISHED-TTL').value, 'PT15M');
  // No notes, no client — the link can leak, so the feed carries as little as possible.
  assert.ok(!r.text.includes('private note text'));
  assert.ok(!r.text.includes('Secret Client'));
  const ev = byTitle(cal, 'Mine, all day');
  const id = prop(ev, 'UID').value.split('@')[0];
  assert.equal(prop(ev, 'UID').value, `${id}@skynet-corp-suite`);
  assert.equal(unescapeText(prop(ev, 'DESCRIPTION').value), `Great White North Design\nOpen in the suite: ${s.base}/tasks?open=${id}`);
  assert.equal(prop(ev, 'URL').value, `${s.base}/tasks?open=${id}`);
  assert.match(unescapeText(prop(byTitle(cal, 'Shared renewal'), 'DESCRIPTION').value), /^Personal · Shared list\n/);

  const partnerCal = parseIcs((await s.feed(theirs.path)).text);
  assert.deepEqual(summaries(partnerCal), ['Sam’s own', '[Shared] Shared renewal']);
  assert.equal(unescapeText(prop(partnerCal, 'X-WR-CALNAME').value), 'Suite tasks · Sam');
});

test('all-day and timed events; timed ones keep their local time on both sides of DST (Nov 1 2026, Mar 14 2027)', async (t) => {
  const s = await setup(t);
  s.task({ title: 'All day', due_date: '2026-10-20' });
  s.task({ title: 'Before the change', due_date: '2026-10-30', due_time: '09:00' });
  s.task({ title: 'Change day', due_date: '2026-11-01', due_time: '09:00' });
  s.task({ title: 'Nov 2', due_date: '2026-11-02', due_time: '09:00', estimate_minutes: 45 });
  s.task({ title: 'Mar 8', due_date: '2027-03-08', due_time: '09:00' });
  s.task({ title: 'Mar 15', due_date: '2027-03-15', due_time: '09:00' });
  const cal = parseIcs((await s.feed((await s.makeLink()).path)).text);

  const allDay = byTitle(cal, 'All day');
  assert.deepEqual([prop(allDay, 'DTSTART').params, prop(allDay, 'DTSTART').value], [{ VALUE: 'DATE' }, '20261020']);
  assert.deepEqual([prop(allDay, 'DTEND').params, prop(allDay, 'DTEND').value], [{ VALUE: 'DATE' }, '20261021']);

  const nov2 = byTitle(cal, 'Nov 2');
  assert.deepEqual(prop(nov2, 'DTSTART').params, { TZID: ZONE });
  assert.equal(prop(nov2, 'DTSTART').value, '20261102T090000');
  assert.equal(prop(nov2, 'DTEND').value, '20261102T094500', 'its estimate');
  const utc = (title) => resolveLocal(cal, ZONE, prop(byTitle(cal, title), 'DTSTART').value);
  assert.equal(utc('Before the change'), '2026-10-30T13:00:00.000Z', '09:00 EDT');
  assert.equal(utc('Change day'), '2026-11-01T14:00:00.000Z', '09:00 EST, the day the clocks go back');
  assert.equal(utc('Nov 2'), '2026-11-02T14:00:00.000Z', '09:00 EST');
  assert.equal(utc('Mar 8'), '2027-03-08T14:00:00.000Z', '09:00 EST');
  assert.equal(utc('Mar 15'), '2027-03-15T13:00:00.000Z', '09:00 EDT after Mar 14');
  assert.equal(prop(cal, 'X-WR-TIMEZONE').value, ZONE);
});

test('spring forward: on Mar 1 2026 a 09:00 task on Mar 8 (the change day) is 13:00Z, Mar 7 is 14:00Z', async (t) => {
  const s = await setup(t, { at: Date.UTC(2026, 2, 1, 17) });
  s.task({ title: 'Mar 7', due_date: '2026-03-07', due_time: '09:00' });
  s.task({ title: 'Mar 8', due_date: '2026-03-08', due_time: '09:00' });
  const cal = parseIcs((await s.feed((await s.makeLink()).path)).text);
  assert.equal(resolveLocal(cal, ZONE, prop(byTitle(cal, 'Mar 7'), 'DTSTART').value), '2026-03-07T14:00:00.000Z');
  assert.equal(resolveLocal(cal, ZONE, prop(byTitle(cal, 'Mar 8'), 'DTSTART').value), '2026-03-08T13:00:00.000Z');
});

test('only all-day events: no VTIMEZONE; an empty feed is still a valid calendar', async (t) => {
  const s = await setup(t);
  const { path: p } = await s.makeLink();
  const empty = parseIcs((await s.feed(p)).text);
  assert.equal(events(empty).length, 0);
  s.task({ title: 'All day', due_date: '2026-10-20' });
  const cal = parseIcs((await s.feed(p)).text);
  assert.equal(cal.children.filter((c) => c.name === 'VTIMEZONE').length, 0);
});

test('escaping and folding survive awkward titles', async (t) => {
  const s = await setup(t);
  const title = `Call Lefty’s, re: 10; back\\slash — ${'Ünïcödé '.repeat(20)}😀`.slice(0, 300);
  s.task({ title, due_date: '2026-10-14', due_time: '13:30', owner: 'shared' });
  const r = await s.feed((await s.makeLink()).path);
  const cal = parseIcs(r.text);
  assert.deepEqual(summaries(cal), [`[Shared] ${title}`]);
  assert.ok(r.text.includes('\\,') && r.text.includes('\\;') && r.text.includes('\\\\'));
});

test('done, deleted, undated, other people’s and out-of-window tasks drop out; overdue ones (30 days) stay on their due date', async (t) => {
  const s = await setup(t);
  const done = s.task({ title: 'Done later', due_date: '2026-10-15' });
  const gone = s.task({ title: 'Deleted later', due_date: '2026-10-16' });
  s.task({ title: 'Overdue 30 days', due_date: '2026-09-09' });
  s.task({ title: 'Overdue 31 days', due_date: '2026-09-08' });
  s.task({ title: 'A year ahead', due_date: '2027-10-09' });
  s.task({ title: 'A year and a day', due_date: '2027-10-10' });
  s.task({ title: 'Undated with a stray time', due_time: null });
  assert.equal(PAST_DAYS, 30);
  assert.equal(FUTURE_DAYS, 365);
  const { path: p } = await s.makeLink();
  let cal = parseIcs((await s.feed(p)).text);
  assert.deepEqual(summaries(cal), ['A year ahead', 'Deleted later', 'Done later', 'Overdue 30 days']);
  assert.equal(prop(byTitle(cal, 'Overdue 30 days'), 'DTSTART').value, '20260909', 'on its due date, not moved to today');

  s.update(done, { done_at: new Date().toISOString() });
  s.remove(gone);
  cal = parseIcs((await s.feed(p)).text);
  assert.deepEqual(summaries(cal), ['A year ahead', 'Overdue 30 days'], 'finished and deleted tasks are gone at the next refresh');

  // A day later the window moves: "Overdue 30 days" is now 31 days old, "A year and a day" a year ahead.
  s.clock.t += 24 * 3600_000;
  cal = parseIcs((await s.feed(p)).text);
  assert.deepEqual(summaries(cal), ['A year ahead', 'A year and a day']);
});

test('an edit changes the event: LAST-MODIFIED, SEQUENCE and the ETag; an unchanged feed answers 304', async (t) => {
  const s = await setup(t);
  const sync = s.ctx.services.sync;
  const id = sync.applyLocal({ actor: 'owner', entity: 'task', op: 'create', stampMs: Date.now() - 120_000,
    fields: { title: 'Quote', owner: 'owner', business_id: AGENCY, due_date: '2026-10-21' } }).recordId;
  const { path: p } = await s.makeLink();
  const first = await s.feed(p);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[A-Za-z0-9_-]{32}"$/);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const again = await s.feed(p, { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');

  const before = byTitle(parseIcs(first.text), 'Quote');
  s.update(id, { title: 'Quote for Lefty’s', due_time: '10:00' });
  const changed = await s.feed(p, { 'if-none-match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  const after = byTitle(parseIcs(changed.text), 'Quote for Lefty’s');
  assert.equal(prop(after, 'UID').value, prop(before, 'UID').value, 'same UID: the same event, updated');
  assert.ok(Number(prop(after, 'SEQUENCE').value) > Number(prop(before, 'SEQUENCE').value));
  assert.ok(prop(after, 'LAST-MODIFIED').value > prop(before, 'LAST-MODIFIED').value);
  assert.equal(prop(after, 'DTSTAMP').value, prop(after, 'LAST-MODIFIED').value);

  const head = await s.call('HEAD', p, { session: null });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('SUITE_URL sets the links back to the suite', async (t) => {
  const s = await setup(t, { env: { SUITE_URL: 'https://mac-mini.tail1234.ts.net:8443' } });
  const id = s.task({ title: 'Linked', due_date: '2026-10-21' });
  const made = await s.makeLink();
  assert.equal(made.publicUrl, 'https://mac-mini.tail1234.ts.net:8443');
  const cal = parseIcs((await s.feed(made.path)).text);
  assert.equal(prop(byTitle(cal, 'Linked'), 'URL').value, `https://mac-mini.tail1234.ts.net:8443/tasks?open=${id}`);
  assert.throws(() => testConfig(tmpDir(t), { SUITE_URL: 'https://x.ts.net/suite' }), /SUITE_URL/);
  assert.throws(() => testConfig(tmpDir(t), { CALENDAR_TIME_ZONE: 'Mars/Olympus' }), /CALENDAR_TIME_ZONE/);
});

// ---- the link ---------------------------------------------------------------------------------
test('make, replace, turn off: the old link stops at once; the state never shows the token; each person only their own', async (t) => {
  const s = await setup(t);
  s.task({ title: 'Something', due_date: '2026-10-21' });
  let state = await s.call('GET', '/api/calendar/link');
  assert.deepEqual(state.body.feed, { on: false, createdAt: null, lastFetchedAt: null, paused: false });
  assert.equal(state.body.timeZone, ZONE);

  const first = await s.call('POST', '/api/calendar/link', { body: {} });
  assert.equal(first.headers.get('cache-control'), 'no-store', 'the answer with the token is never cached');
  assert.equal(first.body.replaced, false);
  assert.equal((await s.feed(first.body.path)).status, 200);
  state = await s.call('GET', '/api/calendar/link');
  assert.equal(state.body.feed.on, true);
  assert.ok(state.body.feed.lastFetchedAt, 'a calendar read it');
  assert.ok(!state.text.includes(first.body.token));
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM calendar_feeds').all()).includes(first.body.token), 'only the hash is stored');

  const second = await s.call('POST', '/api/calendar/link', { body: {} });
  assert.equal(second.body.replaced, true);
  assert.equal(second.body.feed.lastFetchedAt, null, 'the new link hasn’t been read yet');
  assert.equal((await s.feed(first.body.path)).status, 404, 'the replaced link stops working at once');
  assert.equal((await s.feed(second.body.path)).status, 200);

  // The partner's link is theirs: replacing it leaves the owner's alone.
  const sams = await s.makeLink(s.partner);
  assert.equal((await s.feed(second.body.path)).status, 200);
  const off = await s.call('DELETE', '/api/calendar/link');
  assert.deepEqual([off.status, off.body.turnedOff, off.body.feed.on], [200, true, false]);
  assert.equal((await s.feed(second.body.path)).status, 404, 'turned off');
  assert.equal((await s.feed(sams.path)).status, 200, 'the partner’s still works');
  assert.equal((await s.call('DELETE', '/api/calendar/link')).body.turnedOff, false);

  assert.deepEqual(s.service.changes('owner').map((c) => c.action), ['turned_off', 'replaced', 'made']);
  // Changing the link needs the session and follows the request rules.
  assert.equal((await s.call('POST', '/api/calendar/link', { session: null, body: {} })).status, 401);
  assert.equal((await s.call('GET', '/api/calendar/link', { session: null })).status, 401);
  assert.equal((await s.call('POST', '/api/calendar/link', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('wrong links: 404 with no detail; 20 from one address within an hour lock it out (429), other addresses are fine; a good read clears it', async (t) => {
  const s = await setup(t);
  const { path: good } = await s.makeLink();
  const from = (ip) => ({ 'x-forwarded-for': ip }); // the test server trusts loopback, like Tailscale Serve
  const bad = `A${'b'.repeat(42)}`;
  for (const p of [`/api/calendar/feed/${bad}.ics`, '/api/calendar/feed/short.ics', `/api/calendar/feed/${bad}.txt`, `/api/calendar/feed/${bad}`]) {
    const r = await s.feed(p, from('100.64.0.9'));
    assert.deepEqual([r.status, r.text], [404, 'Not found'], p);
  }
  // A good read from that address clears its count.
  assert.equal((await s.feed(good, from('100.64.0.9'))).status, 200);
  for (let i = 0; i < FAIL_LIMIT - 1; i += 1) assert.equal((await s.feed(bad, from('100.64.0.7'))).status, 404);
  const last = await s.feed(bad, from('100.64.0.7'));
  assert.equal(last.status, 404);
  const locked = await s.feed(good, from('100.64.0.7'));
  assert.equal(locked.status, 429, 'locked out: even a good link answers 429 from there');
  assert.ok(Number(locked.headers.get('retry-after')) > 3000);
  assert.equal((await s.feed(good, from('100.64.0.8'))).status, 200, 'other addresses are not affected');
  s.clock.t += 3600_000 + 1000;
  assert.equal((await s.feed(good, from('100.64.0.7'))).status, 200, 'an hour later it is open again');
  const row = s.ctx.services.connections.list().find((c) => c.id === 'calendar-feed');
  assert.match(row.lastError, /^24 requests with an unknown, replaced or turned-off link/);
  assert.ok(row.lastSuccessAt);
});

test('no session needed for the feed, but the token opens nothing else', async (t) => {
  const s = await setup(t);
  const { token, path: p } = await s.makeLink();
  assert.equal((await s.feed(p)).status, 200);
  for (const headers of [{ cookie: `suite_session=${token}` }, { authorization: `Bearer ${token}` }]) {
    for (const url of ['/api/crm/clients', '/api/calendar/link', '/api/auth/session', `/api/sync/pull`]) {
      assert.equal((await s.call('GET', url, { session: null, headers })).status, 401, `${url} with the token`);
    }
  }
  assert.equal((await s.call('GET', `/api/calendar/feed/${token}.ics/extra`, { session: null })).status, 401, 'only the exact path');
  assert.equal((await s.call('GET', '/api/calendar/feed', { session: null })).status, 401);
  assert.equal((await s.call('POST', p, { session: null, headers: { origin: s.base } })).status, 401, 'GET (and HEAD) only');
  assert.equal((await s.call('DELETE', p, { session: null, headers: { origin: s.base } })).status, 401);
});

test('switched off on Connections: every feed answers 503 (calendars keep what they have); on again: 200', async (t) => {
  const s = await setup(t);
  const { path: p } = await s.makeLink();
  const conn = await s.call('PUT', '/api/connections/calendar-feed', { body: { paused: true } });
  assert.equal(conn.body.connection.state, 'paused');
  const r = await s.feed(p);
  assert.deepEqual([r.status, r.headers.get('retry-after')], [503, '900']);
  assert.equal((await s.feed(`A${'b'.repeat(42)}`)).status, 503, 'nothing is looked up while off');
  assert.equal((await s.call('GET', '/api/calendar/link')).body.feed.paused, true);
  await s.call('PUT', '/api/connections/calendar-feed', { body: { paused: false } });
  assert.equal((await s.feed(p)).status, 200);
});

test('restores keep the links as they are now: a replaced link doesn’t come back; the current one keeps working', async (t) => {
  assert.ok(KEPT_TABLES.includes('calendar_feeds') && KEPT_TABLES.includes('calendar_feed_changes'));
  assert.deepEqual(modules.find((m) => m.name === 'calendar').keepOnRestore, ['calendar_feeds', 'calendar_feed_changes']);
  const dir = tmpDir(t);
  const config = testConfig(dir, { CALENDAR_TIME_ZONE: ZONE });
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const first = await setup(t, { config });
  first.task({ title: 'Before the backup', due_date: '2026-10-21' });
  const leaked = await first.makeLink();
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  const current = await first.makeLink(); // replaced after the backup (say the first one leaked)
  await first.close();

  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const second = await setup(t, { config });
  assert.equal((await second.feed(leaked.path)).status, 404, 'the replaced link stays dead');
  const r = await second.feed(current.path);
  assert.equal(r.status, 200, 'the current link keeps working');
  assert.deepEqual(summaries(parseIcs(r.text)), ['Before the backup']);
});

// ---- the token never reaches the log (review fix) ---------------------------------------------
/** A logger that keeps every line. */
function capturingLog(lines = []) {
  const make = () => {
    const out = (level) => (...args) => lines.push({ level, text: args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ') });
    return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error'), child: () => make() };
  };
  return Object.assign(make(), { lines });
}

test('a feed that fails answers 503 and logs nothing of its token; the app’s error handler redacts feed paths too', async (t) => {
  assert.equal(redactPath('/api/calendar/feed/AbC_-123.ics?x=1'), '/api/calendar/feed/[link]?x=1');
  assert.equal(redactPath('/api/crm/clients?q=1'), '/api/crm/clients?q=1');
  assert.equal(redactPath('/API/Calendar/FEED/AbC_-123.ics'), '/API/Calendar/FEED/[link]', 'routing is case-insensitive, so is redaction');
  const config = testConfig(tmpDir(t), { CALENDAR_TIME_ZONE: ZONE });
  const db = openDb(config.dbPath);
  const log = capturingLog();
  // A test-only route on a feed-like path that fails, to reach app.js's own error handler with it.
  const SECRETISH = 'lowercasesecretlookingtokenthatmustnotbelogged';
  const thrower = {
    name: 'throwdemo',
    migrationsDir: null,
    signedRoutes: [{ method: 'post', path: `/api/calendar/feed/${SECRETISH}`, handlers: () => [(_req, _res, next) => next(new Error('boom'))] }],
  };
  const { app, ctx } = await createApp({ config, db, log, modules: [...modules, thrower] });
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  t.after(() => new Promise((resolve) => server.close(() => { db.close(); resolve(); })));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { token, path: p } = ctx.services.calendar.makeLink({ actor: 'owner' });
  ctx.services.planner.feedTasks = () => { throw new Error('SQLITE_BUSY: database is locked'); };
  const res = await fetch(`${base}${p}`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '300');
  assert.equal(await res.text(), 'The task calendar can’t be read right now.');
  const errorsLogged = log.lines.filter((l) => l.level === 'error');
  assert.ok(errorsLogged.some((l) => /calendar feed: could not answer a feed request: SQLITE_BUSY/.test(l.text)));

  const failed = await fetch(`${base}/api/calendar/feed/${SECRETISH}`, { method: 'POST' });
  assert.equal(failed.status, 500);
  assert.ok(log.lines.some((l) => l.level === 'error' && l.text.includes('POST /api/calendar/feed/[link]:')));
  const all = log.lines.map((l) => l.text).join('\n');
  assert.ok(!all.includes(token), 'the real token is never logged');
  assert.ok(!all.includes(SECRETISH), 'nor a feed path through the app’s error handler');
});
