// The connections registry (C8): every connection between the suite and another app or service,
// with its last success, queue size and last error, and an off switch that pauses it without
// breaking anything. See CLAUDE.md, "Connections (C8)".
//
// A module that talks to something outside registers its connection once, in createService:
//
//   ctx.services.connections.register({
//     id: 'wom', name: 'Wholesale Order Manager', module: 'wom',
//     description: 'Customers, orders and payments from the Order Manager',
//     describe: () => ({ lastSuccessAt, lastErrorAt, lastError, queueSize, detail }),
//     pause() { … stop sending/pulling … },   // called when switched off (and at start when it is off)
//     resume() { … catch up … },              // called when switched on again
//   });
//
// The contract (proved by server/test/fixtures/conndemo): while paused the connection does no
// outside work and logs nothing as a failure; its queue keeps building (describe() still answers,
// so the page shows it growing); on resume it catches up, in order. The switch is stored here (a
// server setting, not a synced record), survives restarts (pause() is called at registration when
// it is off) and restores (restore.js copies connections_switches from the database it replaces).
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { readStatus } from '../../backup/backup.js';
import { HttpError } from '../../lib/httpError.js';

const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A backup older than this is "behind" (same limit as GET /api/health's backup.ok). */
export const STALE_BACKUP_MS = 26 * 60 * 60 * 1000;

/**
 * The rows shown before their package registers the real connection. A real register() with the
 * same id takes the row's place (and its position on the page).
 */
export const PLACEHOLDERS = Object.freeze([
  {
    id: 'wom', name: 'Wholesale Order Manager', comesWith: 'D1',
    description: 'Customers, orders, payments, returns and refunds from the Order Manager, through its outbox.',
  },
  {
    id: 'calendar', name: 'Apple Calendar', comesWith: 'C6',
    description: 'Meetings for Today and the morning plan, read from iCloud; tasks with a date as a subscribed calendar.',
  },
  {
    id: 'stockroom', name: 'Stockroom (Inventory Hub)', comesWith: 'D16',
    description: 'Running-low items, counts and differences, read-only on a schedule. The suite never changes stock.',
  },
]);

/**
 * The off-machine backup as a connection row, from backup/status.json: last success, last error,
 * and how far behind it is ("queue"): whole days since the last good backup once it is over 26 h
 * old (0 while fresh). Always on: never pausable from the app.
 */
export function backupDescription(status, { now = Date.now(), scheduled = true, time = null, offsiteConfigured = true } = {}) {
  const lastSuccessAt = status?.lastSuccessAt ?? null;
  const age = lastSuccessAt ? now - Date.parse(lastSuccessAt) : null;
  const behind = lastSuccessAt === null ? null : (age > STALE_BACKUP_MS ? Math.floor(age / DAY_MS) : 0);
  const problems = [];
  const offsiteFailing = !offsiteConfigured || Boolean(status?.offsite && status.offsite !== 'ok');
  if (!offsiteConfigured) problems.push('no off-machine folder is set');
  else if (offsiteFailing) problems.push(`off-machine copy: ${status.offsite}`);
  // A fresh local copy whose off-machine copy fails is not "up to date": the copy that matters is missing.
  const fresh = behind === 0 ? (offsiteFailing ? 'Off-machine copy failing' : 'Up to date') : null;
  return {
    lastSuccessAt,
    lastErrorAt: status?.lastErrorAt ?? null,
    lastError: status?.lastError ?? null,
    queueSize: behind,
    queueLabel: behind === null ? 'No backup yet' : fresh ?? `${behind} day${behind === 1 ? '' : 's'} behind`,
    detail: [scheduled ? `Nightly at ${time}` : 'Nightly schedule off (development)', ...problems].join(' · '),
  };
}

export function createConnectionsService({ db, config, log, now: clock = Date.now }) {
  const q = {
    get: db.prepare('SELECT * FROM connections_switches WHERE id = ?'),
    upsert: db.prepare(`INSERT INTO connections_switches (id, paused, changed_at, changed_by, changed_device)
      VALUES (@id, @paused, @at, @actor, @device) ON CONFLICT (id) DO UPDATE SET paused = excluded.paused,
      changed_at = excluded.changed_at, changed_by = excluded.changed_by, changed_device = excluded.changed_device`),
    log: db.prepare(`INSERT INTO connections_changes (id, connection_id, paused, at, actor, device_id)
      VALUES (?, ?, ?, ?, ?, ?)`),
  };

  /** id -> entry; Map order = the page's order (placeholders keep their slot when replaced). */
  const entries = new Map();

  const isPaused = (id) => q.get.get(id)?.paused === 1;

  function placeholder({ id, name, description, comesWith }) {
    if (entries.has(id)) return;
    entries.set(id, { id, name, description, comesWith, kind: 'placeholder' });
  }

  /**
   * Register a connection (see the top of this file). Returns { isPaused } for the module's own
   * checks. When its switch is off, pause() is called now, before any work can start.
   */
  function register({ id, name, module, description = null, describe, pause, resume, pausable = true, alwaysOnReason = null }) {
    if (!ID_RE.test(id ?? '')) throw new Error(`connections: bad id "${id}" (lowercase letters, digits, - and _)`);
    if (!name || !module) throw new Error(`connections: ${id} needs a name and its module`);
    if (typeof describe !== 'function') throw new Error(`connections: ${id} needs describe()`);
    if (pausable && (typeof pause !== 'function' || typeof resume !== 'function')) {
      throw new Error(`connections: ${id} needs pause() and resume() (or pausable: false with alwaysOnReason)`);
    }
    if (!pausable && !alwaysOnReason) throw new Error(`connections: ${id} can't be paused: say why (alwaysOnReason)`);
    if (entries.get(id)?.kind === 'real') throw new Error(`connections: ${id} is already registered`);
    entries.set(id, { id, name, module, description, describe, pause, resume, pausable, alwaysOnReason, kind: 'real' });
    if (pausable && isPaused(id)) {
      try {
        pause();
        log?.info?.(`${id} starts paused (switched off ${q.get.get(id).changed_at} by ${q.get.get(id).changed_by})`);
      } catch (err) {
        log?.error?.(`${id}: pause() failed at start: ${err.message}`);
      }
    }
    return { isPaused: () => isPaused(id) };
  }

  function view(e, now = clock()) {
    const sw = q.get.get(e.id);
    const base = { id: e.id, name: e.name, module: e.module ?? null, description: e.description ?? null };
    if (e.kind === 'placeholder') {
      return { ...base, state: 'not_connected', pausable: false, comesWith: e.comesWith };
    }
    let status;
    try {
      status = e.describe({ now }) ?? {};
    } catch (err) {
      status = { lastError: `Could not read its status: ${err.message}`, lastErrorAt: new Date(now).toISOString() };
    }
    const paused = e.pausable && sw?.paused === 1;
    return {
      ...base,
      state: !e.pausable ? 'always_on' : paused ? 'paused' : 'on',
      pausable: e.pausable,
      alwaysOnReason: e.alwaysOnReason,
      lastSuccessAt: status.lastSuccessAt ?? null,
      lastErrorAt: status.lastErrorAt ?? null,
      lastError: status.lastError ?? null,
      queueSize: Number.isFinite(status.queueSize) ? status.queueSize : null,
      queueLabel: status.queueLabel ?? null,
      detail: status.detail ?? null,
      changedAt: sw?.changed_at ?? null,
      changedBy: sw?.changed_by ?? null,
    };
  }

  function list(now = clock()) {
    return [...entries.values()].map((e) => view(e, now));
  }

  /**
   * Switch a connection off (paused: true) or on. Stored first (one transaction with the change
   * log), then the connection is told; a failing pause()/resume() is logged and leaves the switch
   * as asked (the connection reads isPaused() too). Switching to the state it is already in only
   * answers. Throws HttpError 404 (unknown) / 409 (not pausable: backups, placeholders).
   */
  function setPaused(id, paused, { actor, deviceId = null } = {}) {
    const e = entries.get(id);
    if (!e) throw new HttpError(404, `No connection "${id}"`, undefined, { code: 'not_found' });
    if (e.kind === 'placeholder') throw new HttpError(409, `${e.name} is not connected yet (comes with ${e.comesWith})`, undefined, { code: 'not_connected' });
    if (!e.pausable) throw new HttpError(409, `${e.name} can't be switched off from the app: ${e.alwaysOnReason}`, undefined, { code: 'not_pausable' });
    if (typeof paused !== 'boolean') throw new HttpError(400, 'paused must be true or false');
    if (isPaused(id) === paused) return view(e);
    const at = nowIso(new Date(clock()));
    db.transaction(() => {
      q.upsert.run({ id, paused: paused ? 1 : 0, at, actor, device: deviceId });
      q.log.run(newId(), id, paused ? 1 : 0, at, actor, deviceId);
    })();
    log?.info?.(`${id} switched ${paused ? 'off (paused)' : 'on'} by ${actor}${deviceId ? ` (device ${deviceId})` : ''}`);
    try {
      if (paused) e.pause();
      else e.resume();
    } catch (err) {
      log?.error?.(`${id}: ${paused ? 'pause' : 'resume'}() failed: ${err.message}`);
    }
    return view(e);
  }

  /** The switch changes of one connection, newest first. */
  const changes = (id, limit = 20) => db.prepare(`SELECT * FROM connections_changes WHERE connection_id = ?
    ORDER BY at DESC, id DESC LIMIT ?`).all(id, limit);

  // ---- the rows the suite has today ---------------------------------------------------------
  register({
    id: 'backup',
    name: 'Off-machine backup',
    module: 'backup',
    description: 'A copy of the database every night, checked and copied to the folder off this Mac.',
    pausable: false,
    alwaysOnReason: 'Backups protect everything else, so the app can’t pause them; the schedule is set where the server is deployed.',
    describe: ({ now }) => backupDescription(readStatus(config.backup.dir), {
      now, scheduled: config.backup.enabled, time: config.backup.time, offsiteConfigured: Boolean(config.backup.offsiteDir),
    }),
  });
  for (const p of PLACEHOLDERS) placeholder(p);

  return { register, placeholder, isPaused, setPaused, list, get: (id) => (entries.has(id) ? view(entries.get(id)) : null), changes };
}
