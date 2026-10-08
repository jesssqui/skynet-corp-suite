// The automation framework (C8): a registry of automations, each with a trigger (a schedule in
// the server's local time, or an event), an on/off switch, silent or alert, and its runs; a
// restart-safe scheduler (one timer, a check every minute); in-app alerts as synced records.
// See CLAUDE.md, "Automations (C8)".
//
// A module registers an automation once (in createService, or `start` when it needs other
// services' data first):
//
//   ctx.services.automations.register({
//     id: 'friday-review', name: 'Friday review list', module: 'planner',
//     description: 'What it does, in one or two sentences.',
//     trigger: { type: 'schedule', every: 'week', day: 'fri', at: '08:00' },
//     defaults: { enabled: true, alert: true },
//     alertLink: '/plan/review',               // where its alerts open (optional)
//     run(ctx, { now, today, period, trigger, actor, made, create, data }) {
//       …reads…; const id = create('task', { … }, { key: period.key });
//       return { summary: 'Made the Friday review', alert?: { title, body, link } };
//     },
//   });
//
// Rules for run():
//  - synchronous (better-sqlite3): the whole run is ONE transaction with its bookkeeping — what it
//    creates, the record of what it made, the run row and the alert all commit together or not
//    at all. A run that throws changes nothing and is recorded as an error (retried after 15 min).
//  - writes only through sync (create() = sync.applyLocal as 'system', or ctx.services.sync
//    directly), so devices pull the results; reads through the modules' services.
//  - idempotent: look up what an earlier run made with made(key) and create only what is
//    missing. "Run now" relies on this (it has no run key); scheduled runs also have the run key.
//  - "they prepare, you approve": tasks, notes and alerts only. Never send anything outside.
import { newId } from '@suite/shared/ids';
import { nowIso, localDate } from '@suite/shared/time';
import { ACTORS } from '@suite/shared/actors';
import { HttpError } from '../../lib/httpError.js';
import { addDays } from '@suite/shared/planner';
import { checkTrigger, triggerText, periodOf, atLocal, clockText } from './schedule.js';

const ID_RE = /^[a-z][a-z0-9-]{0,59}$/;
/** After a failed scheduled run, try that period again no sooner than this. */
export const RETRY_MS = 15 * 60 * 1000;
/** How often the scheduler looks for due automations. */
export const TICK_MS = 60 * 1000;
/** The first look after start (a catch-up for a period missed while the server was down). */
export const FIRST_TICK_MS = 15 * 1000;
const RECENT_RUNS = 5;

export const ALERT_ENTITY = {
  entity: 'alert',
  table: 'automations_alerts',
  // Made by the server; devices only mark them read (update). Never deleted: read is enough.
  ops: ['create', 'update'],
  fields: {
    source: { type: 'text', max: 80 },
    title: { type: 'text', max: 200, required: true },
    body: { type: 'text', max: 4000 },
    link: { type: 'text', max: 300 },
    at: { type: 'datetime', required: true },
    read_by_owner: { type: 'boolean' },
    read_by_partner: { type: 'boolean' },
  },
};
/** Each person's read flag on an alert. */
export const ALERT_READ_FIELDS = Object.freeze(Object.fromEntries(ACTORS.map((a) => [a, `read_by_${a}`])));

/**
 * Alerts are made by the server only; a device may only mark one read for its own person
 * (`read_by_<actor>`). Right in any arrival order: it looks at the step's own fields and who sent it.
 */
export function checkAlert({ op, fields, actor, server }) {
  if (server) return null;
  if (op === 'create') return { code: 'op_not_allowed', reason: 'alert: alerts are made by the suite, not by devices' };
  if (op !== 'update' || !fields) return null;
  const own = ALERT_READ_FIELDS[actor];
  const other = Object.keys(fields).filter((k) => k !== own);
  return other.length ? { code: 'invalid_value', reason: `alert: you can only mark it read for yourself (${own ?? 'read_by_<you>'}), not ${other.join(', ')}` } : null;
}

/** Text cut to `max` characters, ending "…" when cut; null stays null. */
export function clip(text, max) {
  if (text === null || text === undefined) return null;
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function createAutomationsService(ctx) {
  const { db, services, log } = ctx;
  const clock = ctx.now ?? Date.now;
  const sync = services.sync;
  if (!sync) throw new Error('automations needs the sync module registered before it (modules/index.js)');
  sync.registerEntity({ module: 'automations', ...ALERT_ENTITY, check: checkAlert });

  const q = {
    settings: db.prepare('SELECT * FROM automations_settings WHERE id = ?'),
    upsertSettings: db.prepare(`INSERT INTO automations_settings (id, enabled, alert, changed_at, changed_by, changed_device)
      VALUES (@id, @enabled, @alert, @at, @actor, @device) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled,
      alert = excluded.alert, changed_at = excluded.changed_at, changed_by = excluded.changed_by, changed_device = excluded.changed_device`),
    change: db.prepare(`INSERT INTO automations_changes (id, automation_id, field, value, at, actor, device_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    runKeyTaken: db.prepare('SELECT 1 FROM automations_runs WHERE run_key = ?'),
    lastScheduledError: db.prepare(`SELECT * FROM automations_runs WHERE automation_id = ? AND period_key = ?
      AND trigger = 'schedule' AND status = 'error' ORDER BY started_at DESC, id DESC LIMIT 1`),
    insertRun: db.prepare(`INSERT INTO automations_runs (id, automation_id, trigger, period_key, run_key, actor, device_id,
      started_at, finished_at, status, summary, created_count, created, alert_id, error)
      VALUES (@id, @automation_id, @trigger, @period_key, @run_key, @actor, @device_id, @started_at, @finished_at, @status,
      @summary, @created_count, @created, @alert_id, @error)`),
    recentRuns: db.prepare(`SELECT * FROM automations_runs WHERE automation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`),
    made: db.prepare('SELECT entity, record_id AS id, made_at AS madeAt FROM automations_made WHERE automation_id = ? AND key = ? ORDER BY made_at, record_id'),
    remember: db.prepare(`INSERT OR IGNORE INTO automations_made (automation_id, key, entity, record_id, run_id, made_at)
      VALUES (?, ?, ?, ?, ?, ?)`),
    alert: db.prepare('SELECT * FROM automations_alerts WHERE id = ?'),
    ranBefore: db.prepare('SELECT 1 FROM automations_runs WHERE automation_id = ? AND started_at < ? LIMIT 1'),
  };

  /** id -> definition, in registration order (the page's order). */
  const registry = new Map();
  const alertListeners = new Set();

  function register(def) {
    const { id, name, description, module, trigger, run, defaults = {} } = def;
    if (!ID_RE.test(id ?? '')) throw new Error(`automations: bad id "${id}" (lowercase letters, digits and -)`);
    if (registry.has(id)) throw new Error(`automations: ${id} is already registered`);
    if (!name || !description || !module) throw new Error(`automations: ${id} needs a name, a description and its module`);
    if (typeof run !== 'function') throw new Error(`automations: ${id} needs run()`);
    checkTrigger(trigger);
    registry.set(id, {
      ...def,
      defaults: { enabled: defaults.enabled !== false, alert: defaults.alert === true },
    });
    return id;
  }

  function settingsOf(def) {
    const row = q.settings.get(def.id);
    return row
      ? { enabled: row.enabled === 1, alert: row.alert === 1, changedAt: row.changed_at, changedBy: row.changed_by }
      : { ...def.defaults, changedAt: null, changedBy: null };
  }

  function need(id) {
    const def = registry.get(id);
    if (!def) throw new HttpError(404, `No automation "${id}"`, undefined, { code: 'not_found' });
    return def;
  }

  /**
   * Change an automation's switches: { enabled?, alert? } (booleans). Logged with who and where.
   */
  function setSettings(id, patch, { actor, deviceId = null } = {}) {
    const def = need(id);
    const current = settingsOf(def);
    const next = { enabled: current.enabled, alert: current.alert };
    for (const k of ['enabled', 'alert']) {
      if (patch[k] === undefined) continue;
      if (typeof patch[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      next[k] = patch[k];
    }
    const changed = ['enabled', 'alert'].filter((k) => next[k] !== current[k]);
    if (!changed.length) return view(def);
    const at = nowIso(new Date(clock()));
    db.transaction(() => {
      q.upsertSettings.run({ id, enabled: next.enabled ? 1 : 0, alert: next.alert ? 1 : 0, at, actor, device: deviceId });
      for (const k of changed) q.change.run(newId(), id, k, next[k] ? 1 : 0, at, actor, deviceId);
    })();
    log?.info?.(`${id}: ${changed.map((k) => `${k} ${next[k] ? 'on' : 'off'}`).join(', ')} by ${actor}${deviceId ? ` (device ${deviceId})` : ''}`);
    return view(def);
  }

  // ---- runs ----------------------------------------------------------------------------------

  /**
   * Make an in-app alert (a synced record both people get). Inside a transaction is fine. Title and
   * body are clipped to the field limits (an over-long one must never fail the run that raises it).
   */
  function createAlert({ source = null, title, body = null, link = null, at = nowIso(new Date(clock())) }) {
    const { fields: f } = ALERT_ENTITY;
    const r = sync.applyLocal({
      entity: 'alert',
      op: 'create',
      fields: { source: clip(source, f.source.max), title: clip(title, f.title.max) || 'Alert', body: clip(body, f.body.max), link: clip(link, f.link.max), at },
    });
    if (r.status !== 'applied') throw new Error(`could not create the alert: ${r.code ?? r.status} ${r.reason ?? ''}`);
    return r.recordId;
  }

  function announce(alertId) {
    if (!alertId || !alertListeners.size) return;
    const alert = q.alert.get(alertId);
    for (const fn of alertListeners) {
      try {
        fn(alert);
      } catch (err) {
        log?.error?.(`an alert listener failed: ${err.message}`);
      }
    }
  }

  function runRow(r) {
    if (!r) return null;
    return {
      id: r.id, trigger: r.trigger, periodKey: r.period_key, actor: r.actor, startedAt: r.started_at, finishedAt: r.finished_at,
      status: r.status, summary: r.summary, createdCount: r.created_count, created: r.created ? JSON.parse(r.created) : [],
      alertId: r.alert_id, error: r.error,
    };
  }

  /**
   * Run one automation now. trigger: 'schedule' (with the period: claims its run key), 'manual'
   * (Run now: no run key, the automation's own checks keep it from repeating work) or 'event'.
   * Returns the run (or null when a scheduled period turned out to be done already — another
   * server got there first).
   */
  function execute(def, { trigger, nowMs, period = null, runKey = null, claimIfFree = false, actor = null, deviceId = null, data = null }) {
    const nowDate = new Date(nowMs);
    // Times come from the module's clock (ctx.now: real time in production, moved by tests), so
    // "last ran", retries and what the scheduler compares all agree.
    const startedAt = nowIso(nowDate);
    const finishedAt = () => nowIso(new Date(Math.max(clock(), nowMs)));
    const runId = newId();
    const settings = settingsOf(def);
    let alertId = null;
    try {
      const row = db.transaction(() => {
        if (runKey && q.runKeyTaken.get(runKey)) {
          if (!claimIfFree) return null;
          runKey = null; // Run now again in a period that already ran: runs, without the key
        }
        const created = [];
        const updated = [];
        const made = (key) => q.made.all(def.id, String(key));
        // Change a record the automation made before (refresh a summary, numbers): through sync too.
        const update = (entity, id, fields) => {
          const r = sync.applyLocal({ entity, op: 'update', recordId: id, fields });
          if (r.status !== 'applied' && r.status !== 'clash') throw new Error(`could not update the ${entity}: ${r.code ?? r.status} ${r.reason ?? ''}`.trim());
          updated.push({ entity, id });
          return id;
        };
        const create = (entity, fields, { key = null } = {}) => {
          const r = sync.applyLocal({ entity, op: 'create', fields });
          if (r.status !== 'applied') throw new Error(`could not create the ${entity}: ${r.code ?? r.status} ${r.reason ?? ''}`.trim());
          created.push({ entity, id: r.recordId });
          if (key !== null) q.remember.run(def.id, String(key), entity, r.recordId, runId, startedAt);
          return r.recordId;
        };
        const out = def.run(ctx, {
          now: nowDate, nowMs, today: localDate(nowDate), period, trigger, actor, data, made, create, update,
        }) ?? {};
        if (out && typeof out.then === 'function') throw new Error(`${def.id}: run() must be synchronous`);
        for (const c of out.created ?? []) if (!created.some((x) => x.id === c.id)) created.push({ entity: c.entity, id: c.id });
        const summary = out.summary ?? (created.length ? `Made ${created.length}` : 'Nothing to do');
        if (settings.alert && (created.length || updated.length)) {
          const a = out.alert ?? {};
          alertId = createAlert({
            source: def.id,
            title: a.title ?? `${def.name}: ${summary}`,
            body: a.body ?? null,
            link: a.link ?? def.alertLink ?? null,
            at: startedAt,
          });
        }
        const rec = {
          id: runId, automation_id: def.id, trigger, period_key: period?.key ?? null, run_key: runKey, actor, device_id: deviceId,
          started_at: startedAt, finished_at: finishedAt(), status: 'ok', summary, created_count: created.length,
          created: JSON.stringify(created), alert_id: alertId, error: null,
        };
        q.insertRun.run(rec);
        return rec;
      }).immediate();
      if (!row) return null;
      log?.info?.(`${def.id} ran (${trigger}${period ? ` ${period.key}` : ''}): ${row.summary}`);
      announce(alertId);
      return runRow(row);
    } catch (err) {
      const rec = {
        id: runId, automation_id: def.id, trigger, period_key: period?.key ?? null, run_key: null, actor, device_id: deviceId,
        started_at: startedAt, finished_at: finishedAt(), status: 'error', summary: null, created_count: 0, created: null,
        alert_id: null, error: String(err?.message ?? err).slice(0, 2000),
      };
      try {
        q.insertRun.run(rec);
      } catch (e) {
        log?.error?.(`${def.id}: could not record the failed run: ${e.message}`);
      }
      log?.error?.(`${def.id} failed (${trigger}${period ? ` ${period.key}` : ''}): ${rec.error}`);
      return runRow(rec);
    }
  }

  /**
   * Run now (from the page): idempotent through the automation's own checks; works when switched
   * off too. A successful Run now after this period's time has come counts as the period's run
   * (it takes the run key when free), so the scheduler doesn't run it again minutes later; one
   * before that time doesn't (things may change before the scheduled run).
   */
  function runNow(id, { actor = null, deviceId = null } = {}) {
    const def = need(id);
    const nowMs = clock();
    const period = def.trigger.type === 'schedule' ? periodOf(def.trigger, new Date(nowMs)) : null;
    const due = period && nowMs >= period.dueAt.getTime();
    return execute(def, {
      trigger: 'manual', nowMs, period, actor, deviceId, ...(due ? { runKey: `${def.id}:${period.key}`, claimIfFree: true } : {}),
    });
  }

  /** What the scheduler would do for one scheduled automation at `nowMs`: { due, period, runKey, retryAt }. */
  function scheduleState(def, nowMs) {
    const period = periodOf(def.trigger, new Date(nowMs));
    const runKey = `${def.id}:${period.key}`;
    const done = Boolean(q.runKeyTaken.get(runKey));
    const failed = done ? null : q.lastScheduledError.get(def.id, period.key);
    const retryAt = failed ? Date.parse(failed.started_at) + RETRY_MS : null;
    const due = !done && nowMs >= period.dueAt.getTime() && !(retryAt && nowMs < retryAt);
    return { period, runKey, done, retryAt, due };
  }

  /**
   * A weekly automation whose previous week went by without a run (the server was off from Friday
   * to Sunday, or every try failed) gets one 'missed' run for that week, holding its run key: the
   * page says so, and no late task is made for a week that is over. Only for an automation that
   * had run before that week (a fresh install hasn't missed anything). Returns the run or null.
   */
  function noteMissed(def, nowMs) {
    if (def.trigger.every !== 'week') return null;
    const current = periodOf(def.trigger, new Date(nowMs));
    const prev = periodOf(def.trigger, atLocal(addDays(current.start, -7), '12:00'));
    const runKey = `${def.id}:${prev.key}`;
    if (q.runKeyTaken.get(runKey) || !q.ranBefore.get(def.id, prev.dueAt.toISOString())) return null;
    const at = nowIso(new Date(nowMs));
    const rec = {
      id: newId(), automation_id: def.id, trigger: 'schedule', period_key: prev.key, run_key: runKey, actor: null,
      device_id: null, started_at: at, finished_at: at, status: 'missed', created_count: 0, created: null, alert_id: null,
      error: null,
      summary: `Missed the week of ${atLocal(prev.start, '12:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} (due ${atLocal(prev.day, '12:00').toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' })} at ${clockText(def.trigger.at)}): the server was off or `
        + 'failing until the week was over. Nothing was made late for it.',
    };
    try {
      q.insertRun.run(rec);
    } catch (err) {
      if (!/UNIQUE/.test(err.message)) throw err; // another server noted it first
      return null;
    }
    log?.warn?.(`${def.id}: ${rec.summary}`);
    return runRow(rec);
  }

  /**
   * One look by the scheduler: every switched-on scheduled automation whose period's time has
   * passed and whose period has no successful scheduled run runs once (and a weekly one whose
   * whole previous week went by without a run gets a 'missed' run). Returns the runs made.
   */
  function tick(nowMs = clock()) {
    const runs = [];
    for (const def of registry.values()) {
      if (def.trigger.type !== 'schedule' || !settingsOf(def).enabled) continue;
      const missed = noteMissed(def, nowMs);
      if (missed) runs.push({ automation: def.id, ...missed });
      const st = scheduleState(def, nowMs);
      if (!st.due) continue;
      const run = execute(def, { trigger: 'schedule', nowMs, period: st.period, runKey: st.runKey });
      if (run) runs.push({ automation: def.id, ...run });
    }
    return runs;
  }

  /**
   * An event happened (D packages: 'order.placed', …): every switched-on automation listening for
   * it runs once per event key (trigger.key(data), e.g. the order id; the run key makes a
   * re-delivered event a no-op). Returns the runs made.
   */
  function emit(event, data = {}) {
    const runs = [];
    for (const def of registry.values()) {
      if (def.trigger.type !== 'event' || def.trigger.event !== event || !settingsOf(def).enabled) continue;
      const part = def.trigger.key ? def.trigger.key(data) : null;
      const key = part === null || part === undefined ? null : String(part);
      const run = execute(def, {
        trigger: 'event', nowMs: clock(), period: key ? { key } : null, runKey: key ? `${def.id}:${key}` : null, data,
      });
      if (run) runs.push({ automation: def.id, ...run });
    }
    return runs;
  }

  /** When the automation runs next (ISO), or null (switched off, or event-driven). */
  function nextRunAt(def, nowMs, settings) {
    if (!settings.enabled || def.trigger.type !== 'schedule') return null;
    const st = scheduleState(def, nowMs);
    if (st.done) return st.period.nextDueAt.toISOString();
    if (st.retryAt && nowMs < st.retryAt) return new Date(st.retryAt).toISOString();
    if (nowMs < st.period.dueAt.getTime()) return st.period.dueAt.toISOString();
    return new Date(nowMs).toISOString(); // due now: the scheduler takes it within a minute
  }

  function view(def, nowMs = clock()) {
    const settings = settingsOf(def);
    const recent = q.recentRuns.all(def.id, RECENT_RUNS).map(runRow);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      module: def.module,
      trigger: { ...def.trigger, key: undefined },
      when: triggerText(def.trigger),
      enabled: settings.enabled,
      alert: settings.alert,
      defaults: def.defaults,
      changedAt: settings.changedAt,
      changedBy: settings.changedBy,
      lastRun: recent[0] ?? null,
      nextRunAt: nextRunAt(def, nowMs, settings),
      recent,
    };
  }

  const list = (nowMs = clock()) => [...registry.values()].map((def) => view(def, nowMs));

  /**
   * The timer (index.js starts it; tests call tick() themselves): a look every minute, the first
   * shortly after start. Runs are synchronous, so two looks never overlap in one process, and the
   * run key keeps a second server from running a period again. Returns stop().
   */
  function startScheduler({ everyMs = TICK_MS, firstAfterMs = FIRST_TICK_MS } = {}) {
    let timer = null;
    let stopped = false;
    const look = () => {
      if (stopped) return;
      try {
        tick();
      } catch (err) {
        log?.error?.(`scheduler: ${err.message}`);
      }
    };
    const first = setTimeout(() => {
      look();
      timer = setInterval(look, everyMs);
      timer.unref?.();
    }, firstAfterMs);
    first.unref?.();
    log?.info?.(`scheduler on: ${[...registry.values()].filter((d) => d.trigger.type === 'schedule').map((d) => `${d.id} (${triggerText(d.trigger)})`).join(', ') || 'nothing scheduled'}`);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return {
    register,
    list,
    get: (id) => (registry.has(id) ? view(registry.get(id)) : null),
    setSettings,
    runNow,
    tick,
    emit,
    startScheduler,
    createAlert,
    /**
     * C5's seam: fn(alertRow) is called after each alert an automation raises is saved (committed).
     * Phone notifications (quiet hours, the morning digest) hang off this. Returns unsubscribe.
     */
    onAlert(fn) {
      alertListeners.add(fn);
      return () => alertListeners.delete(fn);
    },
  };
}
