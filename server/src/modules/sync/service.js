// The sync service: applies change steps exactly once, in order, decides clashes,
// and serves "what changed since my bookmark" to devices. CLAUDE.md, "Offline sync",
// explains the rules; this file is the only code that writes synced module tables.
import { isDeepStrictEqual } from 'node:util';
import { newId, isId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { createHlc, parseHlc, encodeHlc } from '@suite/shared/hlc';
import { HttpError } from '../../lib/httpError.js';
import { createRegistry, OPS } from './registry.js';
import { ACTORS } from './identity.js';

export const SYSTEM_ACTOR = 'system';

export const LIMITS = {
  maxStepsPerPush: 500,
  maxStepBytes: 64 * 1024,
  // A device stamp further ahead of the server clock than this is clamped to the
  // server's time, so a phone whose clock is set to next year can't win every clash.
  maxFutureMs: 5 * 60 * 1000,
  pullDefault: 200,
  pullMax: 1000,
};

const STEP_KEYS = new Set(['key', 'entity', 'recordId', 'op', 'fields', 'hlc', 'seen']);
const CURSOR_RE = /^([0-9a-f-]{36})\.(\d{1,15})$/;
const RESOLUTIONS = ['keep_winner', 'keep_loser'];

/** A step that can't be applied; becomes { status: 'rejected', code, reason }. */
class StepError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hlcIso = (hlc) => new Date(parseHlc(hlc).ms).toISOString();
const json = (v) => (v === undefined ? null : JSON.stringify(v));
const unjson = (v) => (v === null || v === undefined ? null : JSON.parse(v));

export function createSyncService({ db, log }) {
  const registry = createRegistry(db);

  // ---- statements -------------------------------------------------------
  const getMeta = db.prepare('SELECT value FROM sync_meta WHERE key = ?');
  const setMeta = db.prepare(`INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
  const delMeta = db.prepare('DELETE FROM sync_meta WHERE key = ?');

  const getDevice = db.prepare('SELECT * FROM sync_devices WHERE device_id = ?');
  const insertDevice = db.prepare(`INSERT INTO sync_devices (device_id, actor, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?)`);
  const touchPush = db.prepare(`UPDATE sync_devices SET last_seen_at = ?, last_push_at = ?,
    clock_skew_ms = coalesce(?, clock_skew_ms) WHERE device_id = ?`);
  const touchPull = db.prepare(`UPDATE sync_devices SET last_seen_at = ?, last_pull_at = ?, last_pull_cursor = ?
    WHERE device_id = ?`);
  const setDeviceHlc = db.prepare('UPDATE sync_devices SET last_device_hlc = ? WHERE device_id = ?');

  const getStep = db.prepare('SELECT * FROM sync_steps WHERE key = ?');
  const insertStep = db.prepare(`INSERT INTO sync_steps
    (key, seq, device_id, actor, entity, record_id, op, fields, device_hlc, hlc, seen, status, received_at)
    VALUES (@key, @seq, @device_id, @actor, @entity, @record_id, @op, @fields, @device_hlc, @hlc, @seen, @status, @received_at)`);

  const getRecord = db.prepare('SELECT * FROM sync_records WHERE entity = ? AND record_id = ?');
  const insertRecord = db.prepare(`INSERT INTO sync_records (entity, record_id, created_seq, created_hlc, changed_seq)
    VALUES (?, ?, ?, ?, ?)`);
  const touchRecord = db.prepare('UPDATE sync_records SET changed_seq = ? WHERE entity = ? AND record_id = ?');
  const markDeleted = db.prepare(`UPDATE sync_records SET deleted = 1, deleted_seq = @seq, deleted_hlc = @hlc,
    deleted_by = @actor, deleted_device = @device, deleted_step = @step, flagged = 0, changed_seq = @seq
    WHERE entity = @entity AND record_id = @id`);
  const markUndeletedFlagged = db.prepare(`UPDATE sync_records SET deleted = 0, deleted_seq = NULL, deleted_hlc = NULL,
    deleted_by = NULL, deleted_device = NULL, deleted_step = NULL, flagged = 1 WHERE entity = ? AND record_id = ?`);
  const setFlagged = db.prepare('UPDATE sync_records SET flagged = ? WHERE entity = ? AND record_id = ?');
  const changedSince = db.prepare('SELECT * FROM sync_records WHERE changed_seq > ? ORDER BY changed_seq LIMIT ?');

  const getVersion = db.prepare('SELECT * FROM sync_field_versions WHERE entity = ? AND record_id = ? AND field = ?');
  const putVersion = db.prepare(`INSERT INTO sync_field_versions (entity, record_id, field, hlc, seq, device_id, actor, step_key)
    VALUES (@entity, @record_id, @field, @hlc, @seq, @device_id, @actor, @step_key)
    ON CONFLICT (entity, record_id, field) DO UPDATE SET hlc = excluded.hlc, seq = excluded.seq,
      device_id = excluded.device_id, actor = excluded.actor, step_key = excluded.step_key`);
  // The newest edit of this record that the deleting device had not seen (made elsewhere, after its cursor).
  const unseenEdit = db.prepare(`SELECT * FROM sync_field_versions
    WHERE entity = ? AND record_id = ? AND device_id <> ? AND seq > ? ORDER BY hlc DESC LIMIT 1`);

  const insertClash = db.prepare(`INSERT INTO sync_clashes (id, entity, record_id, kind, field,
      winner_value, winner_actor, winner_device, winner_hlc, winner_step,
      loser_value, loser_actor, loser_device, loser_hlc, loser_step, created_at)
    VALUES (@id, @entity, @record_id, @kind, @field, @winner_value, @winner_actor, @winner_device, @winner_hlc,
      @winner_step, @loser_value, @loser_actor, @loser_device, @loser_hlc, @loser_step, @created_at)`);
  const getClash = db.prepare('SELECT * FROM sync_clashes WHERE id = ?');
  const openClashesFor = db.prepare(`SELECT * FROM sync_clashes WHERE entity = ? AND record_id = ? AND resolved = 0
    ORDER BY created_at, id`);
  const openDeleteClashCount = db.prepare(`SELECT count(*) AS n FROM sync_clashes
    WHERE entity = ? AND record_id = ? AND kind = 'delete' AND resolved = 0`);
  const resolveClashStmt = db.prepare(`UPDATE sync_clashes SET resolved = 1, resolved_at = ?, resolved_by = ?, resolution = ?
    WHERE id = ?`);
  const supersedeOpen = db.prepare(`UPDATE sync_clashes SET resolved = 1, resolved_at = ?, resolved_by = ?,
    resolution = 'superseded' WHERE entity = ? AND record_id = ? AND resolved = 0`);

  // ---- start-up: generation, sequence, server clock ---------------------
  let generation;
  let serverDeviceId;
  let restoredAt = null;
  db.transaction(() => {
    const restored = getMeta.get('restore_pending')?.value;
    if (!getMeta.get('generation') || restored) {
      // First start, or this database was just restored from a backup: devices'
      // cursors and pushed steps may be ahead of it, so they must resync.
      setMeta.run('generation', newId());
      if (restored) {
        restoredAt = restored;
        setMeta.run('last_restore_at', restored);
        delMeta.run('restore_pending');
      }
    }
    if (!getMeta.get('seq')) setMeta.run('seq', '0');
    if (!getMeta.get('server_device_id')) setMeta.run('server_device_id', newId());
    generation = getMeta.get('generation').value;
    serverDeviceId = getMeta.get('server_device_id').value;
    if (!getDevice.get(serverDeviceId)) insertDevice.run(serverDeviceId, SYSTEM_ACTOR, nowIso(), nowIso());
  })();
  if (restoredAt) log?.warn(`database was restored (${restoredAt}): new sync generation ${generation}, devices will resync`);

  const clock = createHlc(serverDeviceId, { last: getMeta.get('hlc')?.value ?? null });

  const currentSeq = () => Number(getMeta.get('seq').value);
  function nextSeq() {
    const n = currentSeq() + 1;
    setMeta.run('seq', String(n));
    return n;
  }
  const makeCursor = (seq) => `${generation}.${seq}`;
  function parseCursor(value) {
    const m = typeof value === 'string' ? CURSOR_RE.exec(value) : null;
    return m && isId(m[1]) ? { generation: m[1], seq: Number(m[2]) } : null;
  }

  // ---- devices ----------------------------------------------------------
  function ensureDevice(deviceId, actor, now) {
    if (deviceId === serverDeviceId) throw new HttpError(403, 'That device id belongs to the server');
    const d = getDevice.get(deviceId);
    if (!d) {
      insertDevice.run(deviceId, actor, now, now);
      return getDevice.get(deviceId);
    }
    // A device belongs to one person. (C1 makes this a property of the session.)
    if (d.actor !== actor) throw new HttpError(403, `Device ${deviceId} belongs to ${d.actor}`);
    return d;
  }

  // ---- validation (no database writes) ----------------------------------
  function validateShape(step) {
    if (!isPlainObject(step)) throw new StepError('invalid_step', 'step must be an object');
    if (json(step).length > LIMITS.maxStepBytes) throw new StepError('too_large', `step is over ${LIMITS.maxStepBytes} bytes`);
    for (const k of Object.keys(step)) if (!STEP_KEYS.has(k)) throw new StepError('invalid_step', `unknown step property ${k}`);
    if (!isId(step.key)) throw new StepError('invalid_step', 'key must be a UUIDv7 made on the device');
  }

  function validateStep(step, who) {
    const entry = registry.get(step.entity);
    if (!entry) throw new StepError('unknown_entity', `unknown entity ${String(step.entity).slice(0, 64)}`);
    if (!OPS.includes(step.op)) throw new StepError('invalid_step', 'op must be create, update or delete');
    if (!entry.ops.has(step.op)) throw new StepError('op_not_allowed', `${step.entity} does not allow ${step.op}`);
    if (!isId(step.recordId)) throw new StepError('invalid_step', 'recordId must be a UUIDv7 made on the device');

    const stamp = parseHlc(step.hlc);
    if (!stamp) throw new StepError('invalid_step', 'hlc must be a stamp from @suite/shared/hlc');
    if (stamp.node !== who.deviceId) throw new StepError('invalid_step', 'hlc was not made by this device');

    let seen = 0;
    if (step.seen !== undefined && step.seen !== null) {
      const c = parseCursor(step.seen);
      if (!c) throw new StepError('invalid_step', 'seen must be a pull cursor');
      if (c.generation === generation) {
        if (c.seq > currentSeq()) throw new StepError('invalid_step', 'seen is ahead of the server');
        seen = c.seq;
      } // a cursor from before a restore: unknown, treat as "saw nothing" (safest)
    }

    let fields = null;
    if (step.op === 'delete') {
      if (step.fields !== undefined && step.fields !== null && !(isPlainObject(step.fields) && !Object.keys(step.fields).length)) {
        throw new StepError('invalid_step', 'a delete has no fields');
      }
    } else {
      if (!isPlainObject(step.fields)) throw new StepError('invalid_step', 'fields must be an object');
      fields = {};
      for (const [name, value] of Object.entries(step.fields)) {
        const f = entry.fields.get(name);
        if (!f) throw new StepError('unknown_field', `${step.entity} has no synced field ${name.slice(0, 64)}`);
        const problem = registry.checkValue(f, value);
        if (problem) throw new StepError('invalid_value', problem);
        fields[name] = value;
      }
      if (step.op === 'create') {
        for (const f of entry.fields.values()) {
          if (f.required && (fields[f.name] === undefined || fields[f.name] === null)) {
            throw new StepError('invalid_value', `${f.name} is required`);
          }
        }
      } else if (!Object.keys(fields).length) {
        throw new StepError('invalid_step', 'an update changes at least one field');
      }
    }
    return { entry, fields, seen };
  }

  // ---- applying ---------------------------------------------------------
  function clash(values) {
    const id = newId();
    insertClash.run({ id, field: null, winner_value: null, loser_value: null, created_at: nowIso(), ...values });
    return id;
  }

  function applyCreate(ctx) {
    const { entry, step, fields, who, hlc, seq } = ctx;
    if (getRecord.get(entry.entity, step.recordId)) throw new StepError('already_exists', 'a record with this id already exists');
    const at = hlcIso(hlc);
    const values = {};
    for (const f of entry.fields.values()) values[f.name] = registry.encode(f, fields[f.name] ?? null);
    Object.assign(values, registry.standardValues(entry, {
      created_at: at, created_by: who.actor, updated_at: at, updated_by: who.actor, flagged: 0,
    }));
    registry.asWriter(() => registry.insertRow(entry, step.recordId, values));
    insertRecord.run(entry.entity, step.recordId, seq, hlc, seq);
    for (const f of entry.fields.values()) {
      putVersion.run({
        entity: entry.entity, record_id: step.recordId, field: f.name, hlc, seq,
        device_id: who.deviceId, actor: who.actor, step_key: step.key,
      });
    }
    return { status: 'applied', clashes: [] };
  }

  function applyUpdate(ctx) {
    const { entry, step, fields, who, hlc, seq, seen } = ctx;
    const rec = getRecord.get(entry.entity, step.recordId);
    if (!rec) throw new StepError('not_found', 'no such record');
    const clashes = [];
    const me = { actor: who.actor, device: who.deviceId, hlc, step: step.key };

    if (rec.deleted) {
      const concurrent = rec.deleted_device !== who.deviceId && rec.deleted_seq > seen;
      if (!concurrent) throw new StepError('deleted', 'the record was deleted');
      // Deleted on one device while edited on another: keep the record, flag it, record the clash.
      registry.asWriter(() => registry.updateRow(entry, step.recordId, {
        deleted_at: null, ...registry.standardValues(entry, { flagged: 1 }),
      }));
      clashes.push(clash({
        entity: entry.entity, record_id: step.recordId, kind: 'delete',
        winner_value: json(fields), winner_actor: me.actor, winner_device: me.device, winner_hlc: hlc, winner_step: step.key,
        loser_actor: rec.deleted_by, loser_device: rec.deleted_device, loser_hlc: rec.deleted_hlc, loser_step: rec.deleted_step,
      }));
      markUndeletedFlagged.run(entry.entity, step.recordId);
    }

    const current = registry.decodeRow(entry, entry.selectRow.get(step.recordId));
    const write = {};
    const applied = [];
    const lost = [];
    for (const [name, value] of Object.entries(fields)) {
      const f = entry.fields.get(name);
      const v = getVersion.get(entry.entity, step.recordId, name);
      // Sequential: same device (its steps arrive in order), or the device had already pulled that version.
      const sequential = !v || v.device_id === who.deviceId || v.seq <= seen;
      let wins = true;
      if (!sequential && !isDeepStrictEqual(current[name], value)) {
        // Two people changed the same detail without seeing each other's change: later stamp wins.
        wins = hlc > v.hlc;
        const theirs = { value: json(current[name]), actor: v.actor, device: v.device_id, hlc: v.hlc, step: v.step_key };
        const mine = { value: json(value), ...me };
        const [w, l] = wins ? [mine, theirs] : [theirs, mine];
        clashes.push(clash({
          entity: entry.entity, record_id: step.recordId, kind: 'field', field: name,
          winner_value: w.value, winner_actor: w.actor, winner_device: w.device, winner_hlc: w.hlc, winner_step: w.step,
          loser_value: l.value, loser_actor: l.actor, loser_device: l.device, loser_hlc: l.hlc, loser_step: l.step,
        }));
      } else if (!sequential) {
        wins = hlc > v.hlc; // same value both ways: nothing to review, keep the later version info
      }
      if (wins) {
        write[name] = registry.encode(f, value);
        applied.push(name);
        putVersion.run({
          entity: entry.entity, record_id: step.recordId, field: name, hlc, seq,
          device_id: who.deviceId, actor: who.actor, step_key: step.key,
        });
      } else {
        lost.push(name);
      }
    }
    if (applied.length) {
      const at = hlcIso(hlc);
      Object.assign(write, registry.standardValues(entry, { updated_at: at, updated_by: who.actor }));
      registry.asWriter(() => registry.updateRow(entry, step.recordId, write));
    }
    touchRecord.run(seq, entry.entity, step.recordId);
    return { status: clashes.length ? 'clash' : 'applied', applied, lost, clashes };
  }

  function applyDelete(ctx) {
    const { entry, step, who, hlc, seq, seen } = ctx;
    const rec = getRecord.get(entry.entity, step.recordId);
    if (!rec) throw new StepError('not_found', 'no such record');
    if (rec.deleted) return { status: 'applied', alreadyDeleted: true, clashes: [] };

    const edit = unseenEdit.get(entry.entity, step.recordId, who.deviceId, seen);
    if (edit) {
      // Edited elsewhere after this device last looked: keep the record, flag it, record the clash.
      registry.asWriter(() => registry.updateRow(entry, step.recordId, registry.standardValues(entry, { flagged: 1 })));
      setFlagged.run(1, entry.entity, step.recordId);
      touchRecord.run(seq, entry.entity, step.recordId);
      const id = clash({
        entity: entry.entity, record_id: step.recordId, kind: 'delete',
        winner_actor: edit.actor, winner_device: edit.device_id, winner_hlc: edit.hlc, winner_step: edit.step_key,
        loser_actor: who.actor, loser_device: who.deviceId, loser_hlc: hlc, loser_step: step.key,
      });
      return { status: 'clash', kept: true, clashes: [id] };
    }

    const at = hlcIso(hlc);
    registry.asWriter(() => registry.updateRow(entry, step.recordId, {
      deleted_at: at, ...registry.standardValues(entry, { updated_at: at, updated_by: who.actor, flagged: 0 }),
    }));
    markDeleted.run({ seq, hlc, actor: who.actor, device: who.deviceId, step: step.key, entity: entry.entity, id: step.recordId });
    // Deleted on purpose with everything seen: open questions about this record no longer apply.
    supersedeOpen.run(nowIso(), who.actor, entry.entity, step.recordId);
    return { status: 'applied', clashes: [] };
  }

  const APPLY = { create: applyCreate, update: applyUpdate, delete: applyDelete };

  /**
   * Apply one step in its own transaction (all or nothing).
   * @param {object} step
   * @param {{ actor: string, deviceId: string, server?: boolean }} who
   */
  function applyStep(step, who) {
    const key = isPlainObject(step) && typeof step.key === 'string' ? step.key.slice(0, 64) : null;
    try {
      validateShape(step);
      return db.transaction(() => {
        const prior = getStep.get(step.key);
        if (prior) {
          if (prior.device_id !== who.deviceId || prior.entity !== step.entity || prior.record_id !== step.recordId
            || prior.op !== step.op) {
            throw new StepError('key_reused', 'this key was already used for a different change');
          }
          return { key, status: 'duplicate', seq: prior.seq, original: prior.status };
        }
        const { entry, fields, seen } = validateStep(step, who);

        let hlc = step.hlc;
        if (!who.server) {
          const device = getDevice.get(who.deviceId);
          if (device.last_device_hlc && step.hlc <= device.last_device_hlc) {
            throw new StepError('out_of_order', 'this device already sent a later change; steps must be sent in order');
          }
          const stamp = parseHlc(step.hlc);
          if (stamp.ms > Date.now() + LIMITS.maxFutureMs) {
            const s = parseHlc(clock.now()); // device clock is ahead: use the server's time instead
            hlc = encodeHlc({ ms: s.ms, counter: s.counter, node: who.deviceId });
          }
          setDeviceHlc.run(step.hlc, who.deviceId);
        }
        clock.receive(hlc);
        setMeta.run('hlc', clock.peek());

        const seq = nextSeq();
        const result = APPLY[step.op]({ entry, step, fields, who, hlc, seq, seen });
        insertStep.run({
          key: step.key, seq, device_id: who.deviceId, actor: who.actor, entity: entry.entity,
          record_id: step.recordId, op: step.op, fields: json(fields ?? undefined), device_hlc: step.hlc, hlc, seen,
          status: result.status === 'clash' ? 'clash' : 'applied', received_at: nowIso(),
        });
        const out = { key, status: result.status, seq };
        if (hlc !== step.hlc) out.hlc = hlc;
        if (result.applied) out.applied = result.applied;
        if (result.lost?.length) out.lost = result.lost;
        if (result.clashes.length) out.clashes = result.clashes;
        if (result.kept) out.kept = true;
        if (result.alreadyDeleted) out.alreadyDeleted = true;
        return out;
      })();
    } catch (err) {
      if (err instanceof StepError) return { key, status: 'rejected', code: err.code, reason: err.message };
      if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
        return { key, status: 'rejected', code: 'constraint', reason: err.message };
      }
      throw err;
    }
  }

  // ---- public API -------------------------------------------------------

  /** POST /api/sync/push */
  function push({ actor, deviceId, steps, deviceTime }) {
    if (!Array.isArray(steps)) throw new HttpError(400, 'steps must be an array');
    if (steps.length > LIMITS.maxStepsPerPush) {
      throw new HttpError(413, `At most ${LIMITS.maxStepsPerPush} steps per push; send the rest in another push`);
    }
    const now = nowIso();
    let skew = null;
    if (typeof deviceTime === 'string' && Number.isFinite(Date.parse(deviceTime))) {
      skew = Date.parse(deviceTime) - Date.parse(now);
    }
    db.transaction(() => {
      ensureDevice(deviceId, actor, now);
      touchPush.run(now, now, skew, deviceId);
    })();
    const who = { actor, deviceId };
    const results = steps.map((step) => applyStep(step, who));
    return {
      generation,
      seq: currentSeq(),
      hlc: clock.peek(),
      serverTime: nowIso(),
      ...(skew !== null && Math.abs(skew) > LIMITS.maxFutureMs ? { clockWarning: `Device clock is off by ${Math.round(skew / 1000)} s` } : {}),
      results,
    };
  }

  function publicClash(c) {
    return {
      id: c.id,
      entity: c.entity,
      recordId: c.record_id,
      kind: c.kind,
      field: c.field,
      winner: { value: unjson(c.winner_value), actor: c.winner_actor, device: c.winner_device, at: hlcIso(c.winner_hlc), hlc: c.winner_hlc, step: c.winner_step },
      loser: { value: unjson(c.loser_value), actor: c.loser_actor, device: c.loser_device, at: hlcIso(c.loser_hlc), hlc: c.loser_hlc, step: c.loser_step },
      createdAt: c.created_at,
      resolved: c.resolved === 1,
      resolvedAt: c.resolved_at,
      resolvedBy: c.resolved_by,
      resolution: c.resolution,
    };
  }

  function toChange(rec) {
    const entry = registry.get(rec.entity);
    if (!entry) return null; // entity no longer registered
    if (rec.deleted) return { entity: rec.entity, id: rec.record_id, seq: rec.changed_seq, deleted: true };
    const row = entry.selectRow.get(rec.record_id);
    return {
      entity: rec.entity,
      id: rec.record_id,
      seq: rec.changed_seq,
      deleted: false,
      flagged: rec.flagged === 1,
      fields: registry.decodeRow(entry, row),
      clashes: openClashesFor.all(rec.entity, rec.record_id).map(publicClash),
    };
  }

  /** GET /api/sync/pull */
  function pull({ actor, deviceId, since, limit }) {
    let max = LIMITS.pullDefault;
    if (limit !== undefined && limit !== '') {
      max = Number(limit);
      if (!Number.isInteger(max) || max < 1 || max > LIMITS.pullMax) throw new HttpError(400, `limit must be 1–${LIMITS.pullMax}`);
    }
    let from = 0;
    let reset = true;
    if (since !== undefined && since !== '') {
      const c = parseCursor(since);
      if (!c) throw new HttpError(400, 'since must be a cursor from a previous pull');
      // Another generation (restored database) or a cursor ahead of the server: start again.
      if (c.generation === generation && c.seq <= currentSeq()) {
        from = c.seq;
        reset = false;
      }
    }
    const now = nowIso();
    return db.transaction(() => {
      ensureDevice(deviceId, actor, now);
      const rows = changedSince.all(from, max + 1);
      const hasMore = rows.length > max;
      const page = rows.slice(0, max);
      const cursor = makeCursor(hasMore ? page.at(-1).changed_seq : currentSeq());
      touchPull.run(now, now, cursor, deviceId);
      return {
        generation,
        reset,
        cursor,
        hasMore,
        hlc: clock.peek(),
        changes: page.map(toChange).filter(Boolean),
      };
    })();
  }

  /**
   * Write a synced record from server code (an import, an automation): same rules,
   * same log, made by the server's own device id. Returns the step result plus recordId.
   */
  function applyLocal({ actor = SYSTEM_ACTOR, entity, op, recordId, fields }) {
    if (actor !== SYSTEM_ACTOR && !ACTORS.includes(actor)) throw new Error(`applyLocal: unknown actor ${actor}`);
    const id = recordId ?? (op === 'create' ? newId() : undefined);
    const step = {
      key: newId(), entity, recordId: id, op, hlc: clock.now(), seen: makeCursor(currentSeq()),
      ...(op === 'delete' ? {} : { fields }),
    };
    return { ...applyStep(step, { actor, deviceId: serverDeviceId, server: true }), recordId: id };
  }

  function listClashes({ status = 'open', entity, recordId, limit = 500 } = {}) {
    if (!['open', 'all'].includes(status)) throw new HttpError(400, 'status must be open or all');
    const where = [];
    const args = [];
    if (status === 'open') where.push('resolved = 0');
    if (entity) { where.push('entity = ?'); args.push(entity); }
    if (recordId) { where.push('record_id = ?'); args.push(recordId); }
    const n = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const rows = db.prepare(`SELECT * FROM sync_clashes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ${n}`).all(...args);
    return rows.map(publicClash);
  }

  /**
   * Settle a clash. keep_winner: leave the record as it is. keep_loser: apply the
   * other value (field clash) or the delete (delete clash) as a new change.
   * Needs a connection for now (C2b may add an offline "resolve" step).
   */
  function resolveClash({ id, resolution, actor }) {
    if (!RESOLUTIONS.includes(resolution)) throw new HttpError(400, `resolution must be ${RESOLUTIONS.join(' or ')}`);
    return db.transaction(() => {
      const c = getClash.get(id);
      if (!c) throw new HttpError(404, 'No such clash');
      if (c.resolved) {
        if (c.resolution === resolution) return { clash: publicClash(c), alreadyResolved: true };
        throw new HttpError(409, `This clash was already settled (${c.resolution})`);
      }
      const entry = registry.get(c.entity);
      if (!entry) throw new HttpError(409, `${c.entity} is no longer synced`);
      const rec = getRecord.get(c.entity, c.record_id);
      let step = null;

      if (resolution === 'keep_loser') {
        if (rec.deleted) throw new HttpError(409, 'The record has been deleted since');
        if (c.kind === 'field') {
          const v = getVersion.get(c.entity, c.record_id, c.field);
          if (v.step_key !== c.winner_step) throw new HttpError(409, 'That detail has changed again since; look at it afresh');
          step = applyLocal({ actor, entity: c.entity, op: 'update', recordId: c.record_id, fields: { [c.field]: unjson(c.loser_value) } });
        } else {
          step = applyLocal({ actor, entity: c.entity, op: 'delete', recordId: c.record_id });
        }
        if (step.status !== 'applied') throw new HttpError(409, step.reason ?? `Could not apply (${step.status})`);
      } else {
        touchRecord.run(nextSeq(), c.entity, c.record_id); // so devices pull the settled state
      }
      resolveClashStmt.run(nowIso(), actor, resolution, id);
      if (c.kind === 'delete' && !getRecord.get(c.entity, c.record_id).deleted && !openDeleteClashCount.get(c.entity, c.record_id).n) {
        setFlagged.run(0, c.entity, c.record_id);
        registry.asWriter(() => registry.updateRow(entry, c.record_id, registry.standardValues(entry, { flagged: 0 })));
      }
      return { clash: publicClash(getClash.get(id)), ...(step ? { step } : {}) };
    })();
  }

  /** For module code: a record's sync state (flag, deleted, open clashes). */
  function recordState(entity, recordId) {
    const rec = getRecord.get(entity, recordId);
    if (!rec) return null;
    return {
      deleted: rec.deleted === 1,
      flagged: rec.flagged === 1,
      clashes: openClashesFor.all(entity, recordId).map(publicClash),
    };
  }

  function info() {
    return {
      generation,
      seq: currentSeq(),
      cursor: makeCursor(currentSeq()),
      hlc: clock.peek(),
      lastRestoreAt: getMeta.get('last_restore_at')?.value ?? null,
      actors: ACTORS,
      limits: LIMITS,
      entities: registry.describe(),
    };
  }

  return {
    registerEntity: registry.registerEntity,
    push,
    pull,
    applyLocal,
    listClashes,
    resolveClash,
    recordState,
    info,
  };
}
