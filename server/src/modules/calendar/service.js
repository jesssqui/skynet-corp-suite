// The task calendar feed (C6a): each person's dated tasks (their own and the shared list's) as an
// iCalendar feed that Apple Calendar subscribes to, by a secret link — one per person, made, replaced
// or turned off on Account → Calendar. The feed route has no session (a calendar app can't sign in):
// the link's token is the only key, so it is 32 random bytes, only its SHA-256 is stored, it is
// compared in constant time, and failed lookups are rate-limited per address.
//
// This module owns calendar_feeds / calendar_feed_changes only. Tasks are read through the planner
// (planner.feedTasks), business names through the CRM, display names through auth.
import crypto from 'node:crypto';
import { newId } from '@suite/shared/ids';
import { ACTORS } from '@suite/shared/actors';
import { addDays } from '@suite/shared/planner';
import { HttpError } from '../../lib/httpError.js';
import { buildCalendar, dateIn } from './ics.js';

export const CONNECTION_ID = 'calendar-feed';
/** The feed covers overdue tasks from this many days back (shown on their due date)… */
export const PAST_DAYS = 30;
/** …through this many days ahead. */
export const FUTURE_DAYS = 365;
/** At most this many events (the soonest first): a feed stays well under ~1.5 MB. */
export const MAX_EVENTS = 2000;
/** Failed lookups from one address: this many within an hour lock it out for an hour (429). */
export const FAIL_LIMIT = 20;
export const FAIL_WINDOW_MS = 3600_000;
export const LOCK_MS = 3600_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const feedPath = (token) => `/api/calendar/feed/${token}.ics`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** "jessy" → "Suite tasks · Jessy" (Apple Calendar's default name for the subscription). */
const calendarName = (displayName) => (displayName ? `Suite tasks · ${displayName}` : 'Suite tasks');

export function createCalendarService({ db, config, log, services, now = Date.now }) {
  const { planner, crm, auth, connections } = services;
  if (!planner) throw new Error('calendar needs the planner module registered before it (it reads tasks through it)');
  const zone = config.calendar.timeZone;
  const iso = () => new Date(now()).toISOString();

  const q = {
    all: db.prepare('SELECT actor, token_hash, created_at, last_fetched_at FROM calendar_feeds'),
    get: db.prepare('SELECT actor, created_at, last_fetched_at FROM calendar_feeds WHERE actor = ?'),
    put: db.prepare(`INSERT INTO calendar_feeds (actor, token_hash, created_at, created_device, last_fetched_at)
      VALUES (@actor, @hash, @at, @device, NULL)
      ON CONFLICT (actor) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at,
        created_device = excluded.created_device, last_fetched_at = NULL`),
    del: db.prepare('DELETE FROM calendar_feeds WHERE actor = ?'),
    fetched: db.prepare('UPDATE calendar_feeds SET last_fetched_at = ? WHERE actor = ?'),
    log: db.prepare('INSERT INTO calendar_feed_changes (id, actor, action, at, device_id) VALUES (?, ?, ?, ?, ?)'),
    changes: db.prepare('SELECT * FROM calendar_feed_changes WHERE actor = ? ORDER BY at DESC, id DESC LIMIT ?'),
  };

  const lastWrite = new Map(); // actor -> ms of the last last_fetched_at write (markFetched)
  const checkActor = (actor) => {
    if (!ACTORS.includes(actor)) throw new HttpError(403, 'Only the two people have calendar links', undefined, { code: 'not_a_person' });
  };

  /** What the Account page shows: on/off, when made, when a calendar last read it. Never the token. */
  function state(actor) {
    const row = q.get.get(actor);
    return {
      on: Boolean(row),
      createdAt: row?.created_at ?? null,
      lastFetchedAt: row?.last_fetched_at ?? null,
      paused: connections?.isPaused(CONNECTION_ID) ?? false,
    };
  }

  /**
   * Make this person's link, or replace it (the old one stops working at once). Returns the token —
   * the only time it exists outside the person's calendar apps.
   */
  function makeLink({ actor, deviceId = null }) {
    checkActor(actor);
    const token = crypto.randomBytes(32).toString('base64url');
    const at = iso();
    const replaced = db.transaction(() => {
      const had = Boolean(q.get.get(actor));
      q.put.run({ actor, hash: sha256(token).toString('hex'), at, device: deviceId });
      q.log.run(newId(), actor, had ? 'replaced' : 'made', at, deviceId);
      return had;
    })();
    lastWrite.delete(actor);
    log?.info?.(`calendar link ${replaced ? 'replaced' : 'made'} for ${actor}`);
    return { token, path: feedPath(token), replaced, feed: state(actor) };
  }

  /** Turn this person's link off: every calendar subscribed to it gets 404 from now on. */
  function turnOff({ actor, deviceId = null }) {
    checkActor(actor);
    const removed = db.transaction(() => {
      const n = q.del.run(actor).changes;
      if (n) q.log.run(newId(), actor, 'turned_off', iso(), deviceId);
      return n > 0;
    })();
    if (removed) log?.info?.(`calendar link turned off for ${actor}`);
    return { turnedOff: removed, feed: state(actor) };
  }

  /**
   * Whose link this is, or null. The token must look like one (43 base64url characters); its SHA-256
   * is compared with every stored hash (two at most) in constant time, so the answer's timing says
   * nothing about how close a guess was.
   */
  function actorForToken(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const hash = sha256(token);
    let found = null;
    for (const row of q.all.all()) {
      const stored = Buffer.from(row.token_hash, 'hex');
      if (stored.length === hash.length && crypto.timingSafeEqual(stored, hash) && !found) found = row.actor;
    }
    return found;
  }

  /** The feed's window: today (in the tasks' zone) − PAST_DAYS … today + FUTURE_DAYS. */
  function window(ms = now()) {
    const today = dateIn(zone, ms);
    return { today, from: addDays(today, -PAST_DAYS), to: addDays(today, FUTURE_DAYS) };
  }

  function displayName(actor) {
    try {
      return auth?.accounts?.listUsers().find((u) => u.actor === actor)?.display_name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The feed for one person: { body, etag, events }. `baseUrl` = the suite's address for the links
   * back to each task (config SUITE_URL, else the address the calendar app used).
   */
  function feedFor(actor, { baseUrl = null } = {}) {
    const w = window();
    const tasks = planner.feedTasks({ owner: actor, from: w.from, to: w.to, limit: MAX_EVENTS });
    const names = new Map();
    const businessName = (id) => {
      if (!names.has(id)) names.set(id, crm?.getBusiness(id)?.name ?? null);
      return names.get(id);
    };
    const base = config.calendar.publicUrl ?? baseUrl;
    const body = buildCalendar({
      name: calendarName(displayName(actor)),
      zone,
      tasks,
      window: w,
      businessName,
      linkFor: (task) => (base ? `${base}/tasks?open=${task.id}` : null),
    });
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 32)}"`;
    return { body, etag, events: tasks.length };
  }

  // ---- reads by calendars: last read, failures -------------------------------------------------
  /** Note a successful read (at most one write a minute per person). */
  function markFetched(actor) {
    const t = now();
    if (t - (lastWrite.get(actor) ?? 0) < 60_000) return;
    lastWrite.set(actor, t);
    q.fetched.run(new Date(t).toISOString(), actor);
  }

  // Failed lookups (unknown, replaced or turned-off links, or anything that isn't one), per address,
  // in memory: FAIL_LIMIT within an hour lock that address out of every feed for an hour. Each tailnet
  // device has its own address (trust proxy), so an old subscription still polling on one phone
  // (4 an hour at a 15-minute refresh) never gets near it; a good read from an address clears it.
  const failures = new Map(); // ip -> { count, first, lockedUntil }
  const refused = { count: 0, lastAt: null };
  function lockedFor(ip) {
    const t = now();
    const e = failures.get(ip);
    if (!e) return 0;
    if (e.lockedUntil > t) return e.lockedUntil - t;
    if (t - e.first > FAIL_WINDOW_MS) failures.delete(ip);
    return 0;
  }
  function failed(ip) {
    const t = now();
    let e = failures.get(ip);
    if (!e || t - e.first > FAIL_WINDOW_MS) e = { count: 0, first: t, lockedUntil: 0 };
    e.count += 1;
    if (e.count >= FAIL_LIMIT) {
      e.lockedUntil = t + LOCK_MS;
      e.count = 0;
      e.first = t;
      log?.warn?.(`calendar feed: ${FAIL_LIMIT} unknown links from ${ip} within an hour; that address is locked out for an hour`);
    }
    failures.set(ip, e);
    if (failures.size > 5000) failures.delete(failures.keys().next().value);
    refused.count += 1;
    refused.lastAt = new Date(t).toISOString();
  }
  function succeeded(ip) {
    failures.delete(ip);
  }

  // ---- the Connections row ---------------------------------------------------------------------
  function describe() {
    const rows = q.all.all();
    const last = rows.map((r) => r.last_fetched_at).filter(Boolean).sort().at(-1) ?? null;
    const who = ACTORS.map((actor) => {
      const row = rows.find((r) => r.actor === actor);
      const name = displayName(actor) ?? actor;
      return `${name}: ${row ? 'on' : 'off'}`;
    }).join(' · ');
    return {
      lastSuccessAt: last,
      lastErrorAt: refused.lastAt,
      lastError: refused.count
        ? `${refused.count} request${refused.count === 1 ? '' : 's'} with an unknown, replaced or turned-off link since the server started — an old subscription still asking? Remove it from that device.`
        : null,
      queueSize: null,
      queueLabel: 'Nothing to send: calendars read it',
      detail: `Links: ${who}`,
    };
  }
  const handle = connections?.register({
    id: CONNECTION_ID,
    name: 'Task calendar feed',
    module: 'calendar',
    description: 'Each person’s dated tasks (their own and the shared list’s) as a calendar that Apple Calendar '
      + 'subscribes to, read-only, by a secret link made on Account → Calendar.',
    describe: () => describe(),
    // Paused: every feed request answers 503 (calendars keep what they last read and try again later).
    pause() { log?.info?.('paused: calendar feeds answer 503 until switched on'); },
    resume() { log?.info?.('on again: calendar feeds answer'); },
  });

  return {
    state,
    makeLink,
    turnOff,
    actorForToken,
    feedFor,
    window,
    markFetched,
    lockedFor,
    failed,
    succeeded,
    isPaused: () => handle?.isPaused() ?? false,
    changes: (actor, limit = 20) => q.changes.all(actor, limit),
    timeZone: zone,
  };
}
