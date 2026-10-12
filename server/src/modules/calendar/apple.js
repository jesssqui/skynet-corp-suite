// Meetings from Apple Calendar (C6b): each person's iCloud calendars, read over CalDAV with an
// app-specific password, become synced read-only `meeting` records — so Today, the morning plan and the
// day's load have them offline on every device.
//
//   connection   per person (Account → Calendar, the session's own actor): Apple ID + app-specific
//                password, checked against iCloud (discover the calendar home, list the calendars)
//                before anything is saved; the password AES-256-GCM-sealed with the key file
//                config.calendar.apple.keyFile (../../lib/sealed.js) — never in the database or the
//                backups in usable form, never sent back, never logged. Which calendars count: all event
//                calendars, minus the ones the person unticks (`excluded`: a calendar added later is read).
//   pulls        every CALDAV_PULL_EVERY_MIN (15) minutes per person, the window today − 7 … today + 60
//                days (the suite's zone): list the calendars (CTag), and for each calendar whose CTag or
//                window moved, its events' ETags in the window, then only the changed objects (multiget).
//                Kept per object in its minimal form (icsRead.js: no notes, location or attendees). A
//                failure backs off 2, 4 … 60 minutes; 401 (the app-specific password was revoked) stops
//                every call for that person until a new one is entered. Paused (Connections) = no calls,
//                and nothing is deleted.
//   meetings     after each pull, the person's instances in the window (repeats expanded, exceptions and
//                moved instances applied, declined and cancelled ones left out) are projected into the
//                synced `meeting` records through sync.applyLocal (actor system): created, updated where
//                they differ, deleted when gone — keyed by a hash of (person, calendar, UID, instance).
//   Connections  the 'calendar' row (the placeholder's slot): last success, last error, who is connected.
//
// Read only by construction: caldav.js only makes PROPFIND and REPORT requests to iCloud hosts.
import crypto from 'node:crypto';
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { ACTORS } from '@suite/shared/actors';
import { addDays } from '@suite/shared/planner';
import { HttpError } from '../../lib/httpError.js';
import { loadKey, encryptSecret, decryptSecret } from '../../lib/sealed.js';
import { createCaldavClient, CaldavError } from './caldav.js';
import { minimalCalendar, expandObjects, ianaZone, wallOfYmd } from './icsRead.js';
import { dateIn } from './ics.js';

export const CONNECTION_ID = 'calendar';
export const MEETING_ENTITY = 'meeting';
/** The window read: from this many days back (the week plan's Monday) … */
export const WINDOW_PAST_DAYS = 7;
/** … through this many days ahead (the Monday plan, a month's planning). */
export const WINDOW_FUTURE_DAYS = 60;
/** At most this many meetings per person in the window (the soonest first). */
export const MAX_MEETINGS = 3000;
const MINUTE = 60_000;
export const LOOK_EVERY_MS = MINUTE;
export const FIRST_LOOK_MS = 25_000;
/** After n failures in a row: wait min(2^n, 60) minutes. */
export const backoffMs = (failures) => Math.min(2 ** Math.max(1, failures), 60) * MINUTE;

const APPLE_ID_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const APP_PASSWORD_RE = /^([a-z]{4})-?([a-z]{4})-?([a-z]{4})-?([a-z]{4})$/;

/** The record type devices see. Written by the server only. */
export const MEETING_FIELDS = Object.freeze({
  actor: { type: 'enum', values: ACTORS, required: true },
  source_key: { type: 'text', max: 64, required: true },
  calendar_name: { type: 'text', max: 200 },
  title: { type: 'text', max: 300, required: true },
  all_day: { type: 'boolean' },
  start_at: { type: 'datetime' },
  end_at: { type: 'datetime' },
  start_date: { type: 'date', required: true },
  end_date: { type: 'date', required: true },
  busy: { type: 'boolean' },
  recurring: { type: 'boolean' },
});

/** Devices may not write meetings at all (they come from Apple Calendar). */
export function checkMeeting({ server }) {
  if (server) return null;
  return { code: 'op_not_allowed', reason: 'Meetings come from Apple Calendar: change them there' };
}

/**
 * "jessy@icloud.com", "abcd-efgh-ijkl-mnop" → the stored forms, or throws HttpError 400 with what's wrong.
 */
export function cleanCredentials({ appleId, password } = {}) {
  const id = String(appleId ?? '').trim().toLowerCase();
  if (!APPLE_ID_RE.test(id) || id.length > 200) {
    throw new HttpError(400, 'Enter your Apple ID: the email you sign in to iCloud with', undefined, { code: 'bad_apple_id' });
  }
  const m = APP_PASSWORD_RE.exec(String(password ?? '').replace(/\s+/g, '').toLowerCase());
  if (!m) {
    throw new HttpError(400, 'That isn’t an app-specific password (four groups of four letters, like abcd-efgh-ijkl-mnop). '
      + 'Make one at appleid.apple.com → Sign-In and Security → App-Specific Passwords. Never type your Apple ID’s own password here.',
    undefined, { code: 'bad_password' });
  }
  return { appleId: id, password: `${m[1]}-${m[2]}-${m[3]}-${m[4]}` };
}

/** The window for `ms` in `zone`: { today, fromDate, toDate (the day after the last), fromMs, toMs }. */
export function meetingWindow(zone, ms) {
  const today = dateIn(zone, ms);
  const fromDate = addDays(today, -WINDOW_PAST_DAYS);
  const toDate = addDays(today, WINDOW_FUTURE_DAYS + 1);
  const z = ianaZone(zone);
  return { today, fromDate, toDate, fromMs: z.toUtc(wallOfYmd(fromDate)), toMs: z.toUtc(wallOfYmd(toDate)) };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** A meeting's stable key: (person, calendar, UID, instance) — never the title, so a rename is an update. */
export const sourceKey = (actor, calendarUrl, uid, instanceKey) => sha(`${actor}\n${calendarUrl}\n${uid}\n${instanceKey}`).slice(0, 40);

/** One instance → the record's fields (days in the suite's zone; an all-day end is the last day, inclusive). */
export function meetingFields(inst, { actor, calendarName, zone, key }) {
  if (inst.allDay) {
    return {
      actor, source_key: key, calendar_name: calendarName, title: inst.title, all_day: true, start_at: null, end_at: null,
      start_date: inst.startDate, end_date: addDays(inst.endDate, -1), busy: false, recurring: Boolean(inst.recurring),
    };
  }
  const end = Math.max(inst.startMs, inst.endMs);
  return {
    actor, source_key: key, calendar_name: calendarName, title: inst.title, all_day: false,
    start_at: new Date(inst.startMs).toISOString(), end_at: new Date(end).toISOString(),
    start_date: dateIn(zone, inst.startMs), end_date: dateIn(zone, end > inst.startMs ? end - 1 : end),
    busy: Boolean(inst.busy), recurring: Boolean(inst.recurring),
  };
}

export function createAppleService(ctx) {
  const { db, config, log, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const { sync, connections } = services;
  if (!sync) throw new Error('calendar (meetings) needs the sync module registered before it');
  const cfg = config.calendar.apple;
  const zone = config.calendar.timeZone;

  sync.registerEntity({ module: 'calendar', entity: MEETING_ENTITY, table: 'calendar_meetings', fields: MEETING_FIELDS, readOnly: true, check: checkMeeting });

  const q = {
    conn: db.prepare('SELECT * FROM calendar_apple WHERE actor = ?'),
    conns: db.prepare('SELECT * FROM calendar_apple'),
    put: db.prepare(`INSERT INTO calendar_apple (actor, conn_id, apple_id, password_enc, home_url, excluded, set_at, set_device, refused_at)
      VALUES (@actor, @connId, @appleId, @enc, @home, '[]', @at, @device, NULL)
      ON CONFLICT (actor) DO UPDATE SET conn_id = excluded.conn_id, apple_id = excluded.apple_id, password_enc = excluded.password_enc,
        home_url = excluded.home_url, excluded = '[]', set_at = excluded.set_at, set_device = excluded.set_device, refused_at = NULL`),
    setHome: db.prepare('UPDATE calendar_apple SET home_url = ? WHERE actor = ? AND conn_id = ?'),
    setExcluded: db.prepare('UPDATE calendar_apple SET excluded = ? WHERE actor = ?'),
    refuse: db.prepare('UPDATE calendar_apple SET refused_at = ? WHERE actor = ? AND conn_id = ? AND refused_at IS NULL'),
    forget: db.prepare('DELETE FROM calendar_apple WHERE actor = ?'),
    change: db.prepare('INSERT INTO calendar_apple_changes (id, actor, at, device_id, action, apple_id) VALUES (?, ?, ?, ?, ?, ?)'),
    changes: db.prepare('SELECT at, device_id AS deviceId, action, apple_id AS appleId FROM calendar_apple_changes WHERE actor = ? ORDER BY at DESC, id DESC LIMIT ?'),
    pull: db.prepare('SELECT * FROM calendar_apple_pulls WHERE actor = ?'),
    pulls: db.prepare('SELECT * FROM calendar_apple_pulls'),
    pullOk: db.prepare(`INSERT INTO calendar_apple_pulls (actor, conn_id, last_attempt_at, fetched_at, failures, next_try_at, last_error, last_error_at, unsupported)
      VALUES (@actor, @connId, @at, @at, 0, NULL, NULL, NULL, @unsupported)
      ON CONFLICT (actor) DO UPDATE SET conn_id = excluded.conn_id, last_attempt_at = excluded.last_attempt_at, fetched_at = excluded.fetched_at,
        failures = 0, next_try_at = NULL, last_error = NULL, last_error_at = NULL, unsupported = excluded.unsupported`),
    pullFail: db.prepare(`INSERT INTO calendar_apple_pulls (actor, conn_id, last_attempt_at, last_error_at, last_error, failures, next_try_at)
      VALUES (@actor, @connId, @at, @at, @error, 1, @next)
      ON CONFLICT (actor) DO UPDATE SET conn_id = excluded.conn_id, last_attempt_at = excluded.last_attempt_at, last_error_at = excluded.last_error_at,
        last_error = excluded.last_error, failures = calendar_apple_pulls.failures + 1, next_try_at = excluded.next_try_at`),
    clearPull: db.prepare('DELETE FROM calendar_apple_pulls WHERE actor = ?'),
    calendars: db.prepare('SELECT * FROM calendar_apple_calendars WHERE actor = ? AND conn_id = ? ORDER BY name, url'),
    putCalendar: db.prepare(`INSERT INTO calendar_apple_calendars (actor, conn_id, url, name, color, ctag, window_from) VALUES (@actor, @connId, @url, @name, @color, NULL, NULL)
      ON CONFLICT (actor, url) DO UPDATE SET conn_id = excluded.conn_id, name = excluded.name, color = excluded.color,
        ctag = CASE WHEN calendar_apple_calendars.conn_id = excluded.conn_id THEN calendar_apple_calendars.ctag ELSE NULL END,
        window_from = CASE WHEN calendar_apple_calendars.conn_id = excluded.conn_id THEN calendar_apple_calendars.window_from ELSE NULL END`),
    readCalendar: db.prepare('UPDATE calendar_apple_calendars SET ctag = ?, window_from = ? WHERE actor = ? AND url = ?'),
    dropCalendar: db.prepare('DELETE FROM calendar_apple_calendars WHERE actor = ? AND url = ?'),
    clearCalendars: db.prepare('DELETE FROM calendar_apple_calendars WHERE actor = ?'),
    objects: db.prepare('SELECT url, etag FROM calendar_apple_objects WHERE actor = ? AND calendar_url = ?'),
    allObjects: db.prepare('SELECT calendar_url, url, minimal FROM calendar_apple_objects WHERE actor = ? AND conn_id = ?'),
    putObject: db.prepare(`INSERT INTO calendar_apple_objects (actor, conn_id, calendar_url, url, etag, minimal) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (actor, url) DO UPDATE SET conn_id = excluded.conn_id, calendar_url = excluded.calendar_url, etag = excluded.etag, minimal = excluded.minimal`),
    dropObject: db.prepare('DELETE FROM calendar_apple_objects WHERE actor = ? AND url = ?'),
    dropCalendarObjects: db.prepare('DELETE FROM calendar_apple_objects WHERE actor = ? AND calendar_url = ?'),
    clearObjects: db.prepare('DELETE FROM calendar_apple_objects WHERE actor = ?'),
    staleObjects: db.prepare('DELETE FROM calendar_apple_objects WHERE actor = ? AND conn_id <> ?'),
    staleCalendars: db.prepare('DELETE FROM calendar_apple_calendars WHERE actor = ? AND conn_id <> ?'),
    meetings: db.prepare('SELECT * FROM calendar_meetings WHERE actor = ? AND deleted_at IS NULL ORDER BY created_at, id'),
    meetingCount: db.prepare('SELECT COUNT(*) AS n FROM calendar_meetings WHERE actor = ? AND deleted_at IS NULL'),
    meetingsByCalendar: db.prepare('SELECT calendar_name AS name, COUNT(*) AS n FROM calendar_meetings WHERE actor = ? AND deleted_at IS NULL GROUP BY calendar_name'),
  };
  const at = () => nowIso(new Date(clock()));
  const excludedOf = (row) => {
    try {
      const v = JSON.parse(row?.excluded ?? '[]');
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  };
  const checkActor = (actor) => {
    if (!ACTORS.includes(actor)) throw new HttpError(403, 'Only the two people connect their calendars', undefined, { code: 'not_a_person' });
  };
  const refused = (status, code, message) => new HttpError(status, message, undefined, { code });

  // ---- the sealed password ------------------------------------------------------------------------
  const secretCache = new Map(); // actor -> { enc, password }
  function passwordOf(row) {
    if (!row) return null;
    const c = secretCache.get(row.actor);
    if (c?.enc === row.password_enc) return c.password;
    let password = null;
    try {
      password = decryptSecret(loadKey(cfg.keyFile, { create: false }), row.password_enc);
    } catch (err) {
      log?.error?.(`can't read the calendar key file: ${err.message}`);
    }
    secretCache.set(row.actor, { enc: row.password_enc, password });
    return password;
  }
  const clientFor = (appleId, password) => createCaldavClient({ appleId, password, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs });

  // ---- what the Account page shows (never the password) ---------------------------------------------
  function info(actor) {
    checkActor(actor);
    const row = q.conn.get(actor);
    const pull = q.pull.get(actor);
    const w = meetingWindow(zone, clock());
    const base = {
      connected: Boolean(row), paused: handle?.isPaused() ?? false, everyMinutes: cfg.everyMinutes, timeZone: zone,
      window: { from: w.fromDate, to: addDays(w.toDate, -1) }, changes: q.changes.all(actor, 10),
    };
    if (!row) return { ...base, appleId: null, calendars: [], meetingCount: 0 };
    const excluded = excludedOf(row);
    const counts = new Map(q.meetingsByCalendar.all(actor).map((r) => [r.name, r.n]));
    return {
      ...base,
      appleId: row.apple_id,
      setAt: row.set_at,
      refusedAt: row.refused_at,
      readable: passwordOf(row) !== null,
      calendars: q.calendars.all(actor, row.conn_id).map((c) => ({
        url: c.url, name: c.name, color: c.color, included: !excluded.has(c.url), meetings: excluded.has(c.url) ? 0 : (counts.get(c.name) ?? 0),
      })),
      meetingCount: q.meetingCount.get(actor).n,
      lastSuccessAt: pull?.conn_id === row.conn_id ? pull.fetched_at : null,
      lastAttemptAt: pull?.conn_id === row.conn_id ? pull.last_attempt_at : null,
      lastError: pull?.conn_id === row.conn_id ? pull.last_error : null,
      lastErrorAt: pull?.conn_id === row.conn_id ? pull.last_error_at : null,
      nextTryAt: pull?.conn_id === row.conn_id ? pull.next_try_at : null,
      unsupported: pull?.conn_id === row.conn_id ? pull.unsupported : 0,
    };
  }

  // ---- connect / choose calendars / forget ------------------------------------------------------------
  /**
   * Connect (or replace) this person's Apple Calendar: the Apple ID and app-specific password are checked
   * against iCloud first (its calendar home and calendars), and saved only when iCloud accepts them.
   */
  async function connect(actor, input, { deviceId = null } = {}) {
    checkActor(actor);
    if (handle.isPaused()) throw refused(409, 'paused', 'Apple Calendar is switched off on System → Connections: switch it on, then connect');
    const { appleId, password } = cleanCredentials(input);
    let homeUrl;
    try {
      const client = clientFor(appleId, password);
      ({ homeUrl } = await client.discover());
      await client.listCalendars(homeUrl);
    } catch (err) {
      if (!(err instanceof CaldavError)) throw err;
      if (err.code === 'unauthorized') throw refused(400, 'refused', `${err.message}. Nothing was saved.`);
      if (err.code === 'network' || err.code === 'timeout') throw refused(502, 'unreachable', `${err.message}: nothing was saved`);
      throw refused(502, err.code, `${err.message}: nothing was saved`);
    }
    const enc = encryptSecret(loadKey(cfg.keyFile), password);
    const before = q.conn.get(actor);
    const connId = newId();
    const when = at();
    db.transaction(() => {
      q.put.run({ actor, connId, appleId, enc, home: homeUrl, at: when, device: deviceId });
      q.staleObjects.run(actor, connId);
      q.staleCalendars.run(actor, connId);
      q.clearPull.run(actor);
      q.change.run(newId(), actor, when, deviceId, before ? 'replaced' : 'connected', appleId);
    })();
    secretCache.set(actor, { enc, password });
    log?.info?.(`Apple Calendar ${before ? 'replaced' : 'connected'} for ${actor}`);
    const first = await pullRound({ force: true, actor }).catch((err) => {
      log?.error?.('the first Apple Calendar read failed:', err);
      return null;
    });
    return { ...info(actor), firstRead: first?.people?.[actor] ?? null };
  }

  /** Which calendars count: `excluded` = calendar URLs left out (any others, and new ones, count). */
  async function setCalendars(actor, { excluded } = {}, { deviceId = null } = {}) {
    checkActor(actor);
    const row = q.conn.get(actor);
    if (!row) throw refused(409, 'not_set_up', 'Connect Apple Calendar first');
    if (!Array.isArray(excluded) || excluded.some((u) => typeof u !== 'string') || excluded.length > 200) {
      throw refused(400, 'bad_calendars', 'excluded must be a list of calendar addresses');
    }
    const known = new Set(q.calendars.all(actor, row.conn_id).map((c) => c.url));
    const next = [...new Set(excluded.filter((u) => known.has(u)))].sort();
    const before = excludedOf(row);
    db.transaction(() => {
      q.setExcluded.run(JSON.stringify(next), actor);
      for (const url of next) {
        if (before.has(url)) continue;
        q.dropCalendarObjects.run(actor, url); // left out: what was read from it goes (privacy), read again if ticked
        q.readCalendar.run(null, null, actor, url);
      }
      q.change.run(newId(), actor, at(), deviceId, 'calendars', row.apple_id);
    })();
    project(actor);
    // A calendar ticked again has nothing read yet: read it now (in the background, when calls are allowed).
    if ([...before].some((u) => !next.includes(u)) && !handle.isPaused()) {
      pullRound({ force: true, actor }).catch((err) => log?.error?.('Apple Calendar read failed (tried again later):', err));
    }
    return info(actor);
  }

  /** Forget this person's connection here: the password, what was read, and their meetings on devices. */
  function forget(actor, { deviceId = null } = {}) {
    checkActor(actor);
    const row = q.conn.get(actor);
    if (!row) return info(actor);
    db.transaction(() => {
      q.forget.run(actor);
      q.clearCalendars.run(actor);
      q.clearObjects.run(actor);
      q.clearPull.run(actor);
      q.change.run(newId(), actor, at(), deviceId, 'forgotten', row.apple_id);
    })();
    secretCache.delete(actor);
    project(actor);
    log?.info?.(`Apple Calendar forgotten for ${actor}`);
    return info(actor);
  }

  // ---- pulls --------------------------------------------------------------------------------------------
  function due(row, pull, nowMs, force) {
    if (!row || row.refused_at) return false;
    if (pull?.conn_id === row.conn_id && pull?.next_try_at && Date.parse(pull.next_try_at) > nowMs && !force) return false;
    if (force) return true;
    if (pull?.conn_id !== row.conn_id || !pull?.fetched_at) return true;
    return nowMs - Date.parse(pull.fetched_at) >= cfg.everyMinutes * MINUTE;
  }

  /** One person's read: calendars, changed objects, then their meetings. Throws CaldavError. */
  async function readPerson(row, { force }) {
    const password = passwordOf(row);
    if (!password) throw new CaldavError('unreadable', 'The app-specific password can’t be read on this machine (its key file is missing): enter it again');
    const client = clientFor(row.apple_id, password);
    let home = row.home_url;
    let calendars;
    try {
      if (!home) throw new CaldavError('no_home', 'no home');
      calendars = await client.listCalendars(home);
    } catch (err) {
      const moved = err instanceof CaldavError && (err.code === 'no_home' || err.code === 'bad_answer' || [404, 410].includes(err.status));
      if (!moved) throw err;
      // The home moved (another partition) or was never found: ask iCloud again, once.
      ({ homeUrl: home } = await client.discover());
      q.setHome.run(home, row.actor, row.conn_id);
      calendars = await client.listCalendars(home);
    }
    const stillConnected = () => q.conn.get(row.actor)?.conn_id === row.conn_id && !handle.isPaused();
    const w = meetingWindow(zone, clock());
    const excluded = excludedOf(q.conn.get(row.actor));
    const listed = new Set(calendars.map((c) => c.url));
    const stored = new Map(q.calendars.all(row.actor, row.conn_id).map((c) => [c.url, c]));
    db.transaction(() => {
      for (const c of calendars) q.putCalendar.run({ actor: row.actor, connId: row.conn_id, url: c.url, name: c.name, color: c.color });
      for (const url of stored.keys()) {
        if (listed.has(url)) continue;
        q.dropCalendar.run(row.actor, url);
        q.dropCalendarObjects.run(row.actor, url);
      }
    })();
    for (const cal of calendars) {
      if (!stillConnected()) return false;
      if (excluded.has(cal.url)) continue;
      const prev = stored.get(cal.url);
      if (!force && cal.ctag && prev?.ctag === cal.ctag && prev?.window_from === w.fromDate) continue;
      const etags = await client.eventEtags(cal.url, { fromMs: w.fromMs, toMs: w.toMs });
      const have = new Map(q.objects.all(row.actor, cal.url).map((o) => [o.url, o.etag]));
      const wanted = etags.filter((e) => !have.has(e.url) || have.get(e.url) !== e.etag || !e.etag).map((e) => e.url);
      const fetched = wanted.length ? await client.fetchEvents(cal.url, wanted) : [];
      if (!stillConnected()) return false;
      const listedObjects = new Set(etags.map((e) => e.url));
      db.transaction(() => {
        for (const url of have.keys()) if (!listedObjects.has(url)) q.dropObject.run(row.actor, url);
        for (const f of fetched) {
          let minimal;
          try {
            minimal = minimalCalendar(f.data, { me: row.apple_id });
          } catch (err) {
            log?.warn?.(`Apple Calendar: an event couldn't be read (${err.message}); left out`);
            continue;
          }
          q.putObject.run(row.actor, row.conn_id, cal.url, f.url, f.etag ?? null, JSON.stringify(minimal));
        }
        q.readCalendar.run(cal.ctag ?? null, w.fromDate, row.actor, cal.url);
      })();
    }
    return true;
  }

  let running = null;
  let forcedNext = null;
  /**
   * One round: each connected person whose read is due (all, or just `actor`, with `force`). Never throws for
   * iCloud's problems (recorded per person). → { skipped?, people: { actor: 'read' | 'failed' | 'refused' | … } }
   * One round at a time; a forced request while one runs gets one forced round after it.
   */
  function pullRound(opts = {}) {
    if (!running) {
      running = doRound(opts).finally(() => { running = null; });
      return running;
    }
    if (!opts.force) return running;
    forcedNext ??= running.catch(() => {}).then(() => {
      forcedNext = null;
      return pullRound(opts);
    });
    return forcedNext;
  }

  async function doRound({ force = false, actor = null } = {}) {
    if (handle.isPaused()) return { skipped: 'paused', people: {} };
    const people = {};
    for (const row of q.conns.all()) {
      if (actor && row.actor !== actor) continue;
      if (handle.isPaused()) break;
      const pull = q.pull.get(row.actor);
      if (row.refused_at) { people[row.actor] = 'refused'; continue; }
      if (!due(row, pull, clock(), force)) { people[row.actor] = 'not_due'; continue; }
      try {
        const done = await readPerson(row, { force });
        if (!done) { people[row.actor] = 'stopped'; continue; }
        const { unsupported } = project(row.actor);
        q.pullOk.run({ actor: row.actor, connId: row.conn_id, at: at(), unsupported });
        people[row.actor] = 'read';
      } catch (err) {
        const message = String(err?.message ?? err).slice(0, 500);
        if (!(err instanceof CaldavError)) log?.error?.(`Apple Calendar read for ${row.actor}: unexpected error`, err);
        const failures = (pull?.conn_id === row.conn_id ? pull.failures : 0) + 1;
        q.pullFail.run({ actor: row.actor, connId: row.conn_id, at: at(), error: message, next: new Date(clock() + backoffMs(failures)).toISOString() });
        if (err instanceof CaldavError && err.code === 'unauthorized') {
          // The app-specific password was revoked (or the Apple ID changed): no more calls until a new one is entered —
          // repeated refused sign-ins could get the Apple ID locked.
          const when = at();
          db.transaction(() => {
            if (q.refuse.run(when, row.actor, row.conn_id).changes) q.change.run(newId(), row.actor, when, null, 'refused', row.apple_id);
          })();
          log?.warn?.(`Apple refused ${row.actor}'s app-specific password: no more calls until a new one is entered`);
          people[row.actor] = 'refused';
        } else {
          log?.warn?.(`Apple Calendar read for ${row.actor} failed: ${message}`);
          people[row.actor] = 'failed';
        }
      }
    }
    return { people };
  }

  /** "Pull now" (Account → Calendar): this person's calendars, now. */
  async function pullNow(actor) {
    checkActor(actor);
    const row = q.conn.get(actor);
    if (!row) throw refused(409, 'not_set_up', 'Connect Apple Calendar first');
    if (row.refused_at) throw refused(409, 'refused', 'Apple refused the app-specific password: enter a new one');
    if (handle.isPaused()) throw refused(409, 'paused', 'Apple Calendar is switched off on System → Connections');
    const round = await pullRound({ force: true, actor });
    return { round, ...info(actor) };
  }

  /** The pull loop (production): a look every minute; reads only when due. → stop() */
  function startPuller({ everyMs = LOOK_EVERY_MS, firstMs = FIRST_LOOK_MS } = {}) {
    const look = () => pullRound().catch((err) => log?.error?.('Apple Calendar read failed (tried again later):', err));
    const first = setTimeout(look, firstMs);
    const timer = setInterval(look, everyMs);
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  // ---- meetings on devices ----------------------------------------------------------------------------
  /** The meetings this person should have now, from what was read: Map<source_key, fields>. */
  function desiredMeetings(actor) {
    const row = q.conn.get(actor);
    const out = new Map();
    if (!row) return { desired: out, unsupported: 0 };
    const excluded = excludedOf(row);
    const names = new Map(q.calendars.all(actor, row.conn_id).map((c) => [c.url, c.name]));
    const objects = [];
    for (const o of q.allObjects.all(actor, row.conn_id)) {
      if (excluded.has(o.calendar_url) || !names.has(o.calendar_url)) continue;
      try {
        objects.push({ ...JSON.parse(o.minimal), ref: o.calendar_url });
      } catch { /* a damaged row: read again next time its ETag differs */ }
    }
    const w = meetingWindow(zone, clock());
    const { instances, unsupported } = expandObjects(objects, { window: w, fallback: zone });
    const start = (i) => (i.allDay ? ianaZone(zone).toUtc(wallOfYmd(i.startDate)) : i.startMs);
    instances.sort((a, b) => start(a) - start(b));
    for (const inst of instances) {
      if (out.size >= MAX_MEETINGS) break;
      const key = sourceKey(actor, inst.ref, inst.uid, inst.key);
      if (out.has(key)) continue; // the same UID in two objects of one calendar: the first counts
      out.set(key, meetingFields(inst, { actor, calendarName: names.get(inst.ref) ?? null, zone, key }));
    }
    return { desired: out, unsupported: unsupported.length };
  }

  const asStored = (k, v) => (MEETING_FIELDS[k]?.type === 'boolean' ? (v === null || v === undefined ? null : v ? 1 : 0) : v);

  /**
   * Make this person's meeting records match what was read: create, update what differs, delete the rest
   * (and extras with the same key, e.g. after a restore). Through sync, as the server. → { created, updated, deleted, unsupported }
   */
  function project(actor) {
    const { desired, unsupported } = desiredMeetings(actor);
    const live = q.meetings.all(actor);
    const seen = new Set();
    const ops = [];
    for (const m of live) {
      const want = desired.get(m.source_key);
      if (!want || seen.has(m.source_key)) {
        ops.push({ op: 'delete', recordId: m.id });
        continue;
      }
      seen.add(m.source_key);
      const fields = {};
      for (const [k, v] of Object.entries(want)) if (asStored(k, v) !== m[k]) fields[k] = v;
      if (Object.keys(fields).length) ops.push({ op: 'update', recordId: m.id, fields });
    }
    for (const [key, fields] of desired) if (!seen.has(key)) ops.push({ op: 'create', fields });
    const counts = { created: 0, updated: 0, deleted: 0, unsupported };
    const CHUNK = 200;
    for (let i = 0; i < ops.length; i += CHUNK) {
      db.transaction(() => {
        for (const o of ops.slice(i, i + CHUNK)) {
          const r = sync.applyLocal({ entity: MEETING_ENTITY, ...o });
          if (r.status === 'rejected') throw new Error(`meeting ${o.op}: ${r.code} ${r.reason}`);
          counts[{ create: 'created', update: 'updated', delete: 'deleted' }[o.op]] += 1;
        }
      })();
    }
    return counts;
  }

  /** At start: bring every person's meetings in line with what was read (a restore rolls them back). Not while paused. */
  function start() {
    if (handle.isPaused()) return;
    for (const actor of ACTORS) {
      try {
        project(actor);
      } catch (err) {
        log?.error?.(`Apple Calendar: meetings for ${actor} couldn't be brought up to date at start:`, err);
      }
    }
  }

  // ---- the Connections row ----------------------------------------------------------------------------
  function displayName(actor) {
    try {
      return services.auth?.accounts?.listUsers().find((u) => u.actor === actor)?.display_name ?? actor;
    } catch {
      return actor;
    }
  }
  function describe() {
    const conns = new Map(q.conns.all().map((r) => [r.actor, r]));
    const pulls = new Map(q.pulls.all().map((p) => [p.actor, p]));
    let lastSuccessAt = null;
    let lastErrorAt = null;
    let lastError = null;
    const who = ACTORS.map((actor) => {
      const row = conns.get(actor);
      const name = displayName(actor);
      if (!row) return `${name}: not connected`;
      const p = pulls.get(actor)?.conn_id === row.conn_id ? pulls.get(actor) : null;
      if (p?.fetched_at && (!lastSuccessAt || p.fetched_at > lastSuccessAt)) lastSuccessAt = p.fetched_at;
      if (row.refused_at) {
        if (!lastErrorAt || row.refused_at > lastErrorAt) {
          lastErrorAt = row.refused_at;
          lastError = `${name}: Apple refused the app-specific password — enter a new one on Account → Calendar`;
        }
        return `${name}: password refused`;
      }
      if (p?.last_error_at && (!lastErrorAt || p.last_error_at > lastErrorAt)) {
        lastErrorAt = p.last_error_at;
        lastError = `${name}: ${p.last_error}`;
      }
      const n = q.calendars.all(actor, row.conn_id).filter((c) => !excludedOf(row).has(c.url)).length;
      return `${name}: ${n} calendar${n === 1 ? '' : 's'}`;
    });
    return {
      lastSuccessAt, lastErrorAt, lastError, queueSize: null,
      queueLabel: who.join(' · '),
      detail: `Read every ${cfg.everyMinutes} minutes, ${WINDOW_PAST_DAYS} days back to ${WINDOW_FUTURE_DAYS} ahead. Read only: the suite never changes your calendars. Each person connects on Account → Calendar.`,
    };
  }
  const handle = connections?.register({
    id: CONNECTION_ID,
    name: 'Apple Calendar',
    module: 'calendar',
    description: 'Each person’s meetings, read from their iCloud calendars (with an app-specific password) into Today, '
      + 'the morning plan and the day’s load. Read only.',
    describe: () => describe(),
    // Paused: no calls to iCloud at all, and nothing is deleted (meetings stay as last read).
    pause() { log?.info?.('paused: no calls to iCloud until it is switched on'); },
    resume() {
      log?.info?.('on again: reading Apple Calendar');
      pullRound().catch((err) => log?.error?.('Apple Calendar read failed (tried again later):', err));
    },
  }) ?? { isPaused: () => false };

  return { info, connect, setCalendars, forget, pullRound, pullNow, startPuller, project, start, describe, desiredMeetings };
}
