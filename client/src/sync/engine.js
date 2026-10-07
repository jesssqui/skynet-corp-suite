// The browser half of offline sync (C2b). Entity-agnostic: what can be saved comes from
// GET /api/sync/info; modules (C3a/C4a) read and write synced records only through this
// engine (via `store` / the hooks in ./index.js), never with their own API calls.
//
// Writing: create/update/remove check the change against the entity's field definitions,
// then write it as a step to the outbox in one IndexedDB transaction (with the device's HLC
// stamp and the cursor of the last complete pull as `seen`), and ask for a sync soon.
// Reading: list/get return the pulled copy with the outbox replayed on top (./overlay.js).
// Syncing (one cycle at a time per device, across tabs, under the Web Lock 'suite-sync'):
//   1. GET /info (entity definitions, generation; a new generation = the server was restored)
//   2. push the outbox in order (lane 0 = kept steps re-sent after a restore, then lane 1)
//   3. pull pages until hasMore is false (a pull from scratch fills `staging`, then swaps)
//   4. push the steps parked as not_found once more (their record may just have arrived)
//   5. drop kept sent steps older than 30 days
// See CLAUDE.md, "Offline sync (C2b: browser side)".
import { newId, isId } from '@suite/shared/ids';
import { createHlc } from '@suite/shared/hlc';
import { checkFieldValue } from '@suite/shared/fields';
import { transact } from './idb.js';
import { openLocalDb, deleteLocalDb, DB_NAME } from './localdb.js';
import { changesFor, overlay, toView } from './overlay.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const LIMITS = {
  pushSteps: 500, // server: at most 500 steps per push
  pushBytes: 900 * 1024, // server: 1 MB body
  stepBytes: 64 * 1024, // server: 64 KB per step
  pullLimit: 500,
  keepSentMs: 30 * DAY_MS, // backup retention: a restore can bring back a copy up to 30 days old
  maxRounds: 4, // push/pull rounds per cycle (a reset in the middle needs a second one)
};

export const SESSION_CODES = ['not_signed_in', 'session_expired', 'device_signed_out'];
export const LOCK_NAME = 'suite-sync';

/** A change the engine refuses before it reaches the outbox, or a state it can't work in. */
export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** One-at-a-time lock for when the browser has no Web Locks (one tab, or tests). */
export function createLocalLocks() {
  const chains = new Map();
  return {
    request(name, fn) {
      const run = (chains.get(name) ?? Promise.resolve()).then(() => fn());
      chains.set(name, run.catch(() => {}));
      return run;
    },
  };
}

const sortByKey = (a, b) => (a.k[0] - b.k[0]) || (a.k[1] - b.k[1]);
const isNetworkError = (err) => !err?.status; // status 0 / missing: never reached the server

function definitionsFrom(info) {
  const map = new Map();
  for (const e of info?.entities ?? []) {
    const fields = {};
    for (const [name, f] of Object.entries(e.fields ?? {})) fields[name] = { name, ...f };
    map.set(e.entity, { entity: e.entity, module: e.module, ops: new Set(e.ops), appendOnly: Boolean(e.appendOnly), fields });
  }
  return map;
}

function matches(where, rec) {
  if (!where) return true;
  if (typeof where === 'function') return where(rec);
  return Object.entries(where).every(([k, v]) => rec[k] === v);
}

function sorter(sort) {
  if (typeof sort === 'function') return sort;
  const field = typeof sort === 'string' ? sort.replace(/^-/, '') : 'id';
  const dir = typeof sort === 'string' && sort.startsWith('-') ? -1 : 1;
  return (a, b) => {
    const x = a[field];
    const y = b[field];
    if (x === y) return a.id < b.id ? -1 : 1;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x < y ? -1 : 1) * dir;
  };
}

/**
 * @param {object} opts
 * @param {string} opts.deviceId  this device's id (from sign-in); stamps every change
 * @param {{ get(path: string): Promise<any>, post(path: string, body: object): Promise<any> }} opts.transport
 *   API calls; reject with an error carrying `status` (0 = no connection) and `code` (e.g. session_expired)
 * @param {IDBFactory} [opts.idbFactory]
 * @param {string} [opts.dbName]
 * @param {{ request(name: string, fn: () => Promise<any>): Promise<any> }} [opts.locks]  Web Locks (navigator.locks)
 * @param {{ postMessage(msg: any): void, addEventListener(type: string, fn: Function): void,
 *          removeEventListener(type: string, fn: Function): void } | null} [opts.channel]  BroadcastChannel to other tabs
 * @param {() => number} [opts.wallClock]
 * @param {() => boolean} [opts.isOnline]  navigator.onLine
 * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers]
 * @param {boolean} [opts.autoSync]  sync soon after each change and retry after failures (off in some tests)
 * @param {() => Record<string, string> | null} [opts.pullScope]  extra pull parameters (scope hook, see pullScope below)
 * @param {(code: string) => void} [opts.onSessionLost]  a request found the session gone (401)
 */
export function createSyncEngine({
  deviceId,
  transport,
  idbFactory = globalThis.indexedDB,
  dbName = DB_NAME,
  locks = globalThis.navigator?.locks ?? createLocalLocks(),
  channel = null,
  wallClock = () => Date.now(),
  isOnline = () => globalThis.navigator?.onLine ?? true,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) },
  autoSync = true,
  debounceMs = 1500,
  retryBaseMs = 2000,
  retryMaxMs = 5 * 60 * 1000,
  // TODO(C3a, scope): the server sends every synced record today. When it can filter
  // ("active clients only", open tasks, Today and this month's plans), return its parameters
  // here (e.g. { scope: 'offline' }) and they go on every pull. Records that leave the scope
  // need tombstone-like "left scope" changes from the server, or a pull from scratch.
  pullScope = () => null,
  onSessionLost = () => {},
}) {
  if (!isId(deviceId)) throw new SyncError('no_device', 'Sign in first: this device has no id yet');

  let conn = null;
  let stopped = true;
  let starting = null;
  let definitions = new Map();
  let running = null;
  let again = false;
  let attempt = 0;
  let retryTimer = null;
  let soonTimer = null;
  const listeners = new Set();
  let status = {
    deviceId,
    phase: 'starting', // starting | idle | syncing | offline | error | stopped
    ready: false, // entity definitions known (needs one connection ever)
    waiting: 0, // outbox steps (including parked)
    parked: 0, // waiting for their record (not_found)
    attention: 0,
    lastSyncAt: null,
    lastError: null,
    nextRetryAt: null,
    generation: null,
    clockWarning: null,
    stoppedBy: null, // session code when a 401 stopped it
  };

  // ---- events -------------------------------------------------------------
  function emit(type) {
    for (const fn of [...listeners]) {
      try {
        fn({ type, status });
      } catch {
        /* a listener's problem is not the engine's */
      }
    }
  }
  function setStatus(patch) {
    status = { ...status, ...patch };
    emit('status');
  }
  function onChannel(e) {
    const msg = e?.data ?? e;
    if (stopped || msg?.deviceId !== deviceId) return;
    if (msg.type === 'data') {
      refreshCounts().catch(() => {});
      emit('data');
    } else if (msg.type === 'synced' && (status.phase === 'error' || status.phase === 'offline') && isOnline()) {
      syncNow('other-tab');
    }
  }
  function broadcast(type) {
    try {
      channel?.postMessage({ type, deviceId });
    } catch {
      /* channel closed */
    }
  }
  /** Local data changed (here): tell this tab's listeners and the other tabs. */
  async function dataChanged() {
    await refreshCounts();
    emit('data');
    broadcast('data');
  }

  // ---- database -------------------------------------------------------------
  function db() {
    if (stopped || !conn) throw new SyncError('stopped', 'The offline copy is closed (signed out?)');
    return conn.db;
  }
  const tx = (stores, mode, fn) => transact(db(), stores, mode, fn);

  function onDbClosed() {
    // Deleted or closed under us (clearLocalData, another tab, the browser): stop for good.
    if (stopped) return;
    halt({ phase: 'stopped' });
    emit('data');
  }

  async function openDb() {
    let c = await openLocalDb(idbFactory, { name: dbName });
    const owner = await transact(c.db, 'meta', 'readonly', (t) => t.get('meta', 'deviceId'));
    if (owner && owner !== deviceId) {
      // Left by another device id (another person signed in here): never mix their copy with ours.
      c.close();
      await deleteLocalDb(idbFactory, { name: dbName });
      c = await openLocalDb(idbFactory, { name: dbName });
    }
    if (owner !== deviceId) await transact(c.db, 'meta', 'readwrite', (t) => t.put('meta', deviceId, 'deviceId'));
    c.setOnClosed(onDbClosed);
    conn = c;
    if (stopped) {
      // stop() was called while opening
      conn = null;
      c.close();
      throw new SyncError('stopped', 'Stopped while opening the offline copy');
    }
  }

  async function readMeta(keys) {
    return tx('meta', 'readonly', async (t) => {
      const out = {};
      for (const k of keys) out[k] = (await t.get('meta', k)) ?? null;
      return out;
    });
  }

  async function refreshCounts() {
    const { outbox, attention } = await tx(['outbox', 'attention'], 'readonly', async (t) => ({
      outbox: await t.getAll('outbox'),
      attention: await t.count('attention'),
    }));
    setStatus({ waiting: outbox.length, parked: outbox.filter((o) => o.parked).length, attention });
  }

  /** Move the HLC past a stamp from the server (after every push and pull). */
  async function receiveHlc(t, remote) {
    if (!remote) return;
    const clock = createHlc(deviceId, { last: (await t.get('meta', 'hlc')) ?? null, wallClock });
    clock.receive(remote);
    await t.put('meta', clock.peek(), 'hlc');
  }

  // ---- lifecycle ------------------------------------------------------------
  async function start() {
    if (!stopped) return starting;
    stopped = false;
    status = { ...status, phase: 'starting', stoppedBy: null };
    starting = (async () => {
      await openDb();
      const meta = await readMeta(['info', 'generation', 'lastSyncAt']);
      definitions = definitionsFrom(meta.info);
      channel?.addEventListener('message', onChannel);
      await refreshCounts();
      setStatus({
        phase: 'idle', ready: definitions.size > 0 || Boolean(meta.info), generation: meta.generation, lastSyncAt: meta.lastSyncAt,
      });
      emit('data');
    })();
    try {
      await starting;
    } catch (err) {
      halt({ phase: 'stopped', lastError: err.message });
      throw err;
    }
    syncNow('open');
    return undefined;
  }

  function clearTimers() {
    if (retryTimer) timers.clearTimeout(retryTimer);
    if (soonTimer) timers.clearTimeout(soonTimer);
    retryTimer = null;
    soonTimer = null;
  }

  function halt(patch) {
    stopped = true;
    clearTimers();
    channel?.removeEventListener('message', onChannel);
    const c = conn;
    conn = null;
    c?.close();
    setStatus(patch);
  }

  /** Stop syncing and close the database (signed out, or the session ended). Keeps the data. */
  function stop() {
    if (stopped) return;
    halt({ phase: 'stopped' });
  }

  /** Stop and delete everything this device holds (see clearLocalData). */
  async function wipe() {
    stop();
    await deleteLocalDb(idbFactory, { name: dbName });
  }

  // ---- reading ----------------------------------------------------------------
  function fieldNames(entity) {
    return Object.keys(definitions.get(entity)?.fields ?? {});
  }

  async function readEntity(entity, id) {
    return tx(['records', 'outbox', 'sent', 'meta'], 'readonly', async (t) => ({
      records: id === undefined
        ? await t.getAllFromIndex('records', 'entity', entity)
        : [await t.get('records', [entity, id])].filter(Boolean),
      outbox: (await t.getAll('outbox')).sort(sortByKey),
      sent: await t.getAll('sent'),
      generation: (await t.get('meta', 'generation')) ?? null,
      seen: (await t.get('meta', 'seen')) ?? null,
    }));
  }

  /**
   * Records of one entity as the person should see them (pulled copy + their pending changes).
   * @param {string} entity
   * @param {{ where?: object | ((rec) => boolean), sort?: string | ((a, b) => number) }} [opts]
   *   where: field equality ({ done: false }) or a function; sort: a field name ('-due' = descending) or a compare function
   */
  async function list(entity, { where, sort } = {}) {
    const data = await readEntity(entity);
    const map = overlay(data.records, changesFor(entity, data), fieldNames(entity));
    return [...map.values()].map((r) => toView(entity, r)).filter((r) => matches(where, r)).sort(sorter(sort));
  }

  /** One record, or null when this device doesn't have it (or it was deleted). */
  async function get(entity, id) {
    const data = await readEntity(entity, id);
    const rec = overlay(data.records, changesFor(entity, data).filter((c) => c.step.recordId === id), fieldNames(entity)).get(id);
    return rec ? toView(entity, rec) : null;
  }

  // ---- writing ----------------------------------------------------------------
  function definition(entity, op) {
    if (!definitions.size) {
      throw new SyncError('not_ready', 'Connect once so this device learns what it can save offline');
    }
    const def = definitions.get(entity);
    if (!def) throw new SyncError('unknown_entity', `${entity} is not a synced record type`);
    if (!def.ops.has(op)) throw new SyncError('op_not_allowed', `${entity} can't be ${op === 'update' ? 'changed' : `${op}d`}`);
    return def;
  }

  function checkFields(def, fields, { create }) {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new SyncError('invalid_step', 'fields must be an object');
    }
    const clean = {};
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const f = def.fields[name];
      if (!f) throw new SyncError('unknown_field', `${def.entity} has no field ${name}`);
      const problem = checkFieldValue(f, value);
      if (problem) throw new SyncError('invalid_value', problem);
      clean[name] = value;
    }
    if (create) {
      for (const f of Object.values(def.fields)) {
        if (f.required && (clean[f.name] === undefined || clean[f.name] === null)) {
          throw new SyncError('invalid_value', `${f.name} is required`);
        }
      }
    }
    return clean;
  }

  /** Stamp a step and put it in the outbox, inside transaction `t` (meta + outbox). */
  async function queueStep(t, { entity, recordId, op, fields }) {
    const clock = createHlc(deviceId, { last: (await t.get('meta', 'hlc')) ?? null, wallClock });
    const seen = (await t.get('meta', 'seen')) ?? null;
    const n = (await t.get('meta', 'nextN')) ?? 1;
    const step = {
      key: newId(), entity, recordId, op,
      ...(op === 'delete' ? {} : { fields }),
      hlc: clock.now(),
      ...(seen ? { seen } : {}),
    };
    if (JSON.stringify(step).length > LIMITS.stepBytes) {
      throw new SyncError('too_large', `This change is too large to sync (over ${LIMITS.stepBytes / 1024} KB)`);
    }
    await t.put('meta', clock.peek(), 'hlc');
    await t.put('meta', n + 1, 'nextN');
    await t.put('outbox', { k: [1, n], n, step, createdAt: new Date(wallClock()).toISOString() });
    return step;
  }

  async function addStep(change) {
    const step = await tx(['meta', 'outbox'], 'readwrite', (t) => queueStep(t, change));
    await dataChanged();
    if (autoSync) syncSoon();
    return step;
  }

  /** Create a record; returns its new id (made here, so it works offline). */
  async function create(entity, fields, { id } = {}) {
    const def = definition(entity, 'create');
    const recordId = id ?? newId();
    if (!isId(recordId)) throw new SyncError('invalid_step', 'id must be a UUIDv7 from newId()');
    const clean = checkFields(def, fields ?? {}, { create: true });
    if (id && (await get(entity, id))) throw new SyncError('already_exists', 'a record with this id already exists');
    await addStep({ entity, recordId, op: 'create', fields: clean });
    return recordId;
  }

  /** Change some fields; only those that differ are sent. Returns false when nothing changed. */
  async function update(entity, id, changes) {
    const def = definition(entity, 'update');
    const current = await get(entity, id);
    if (!current) throw new SyncError('not_found', `This ${entity} is not on this device (deleted?)`);
    const clean = checkFields(def, changes ?? {}, { create: false });
    const diff = {};
    for (const [name, value] of Object.entries(clean)) if (current[name] !== value) diff[name] = value;
    if (!Object.keys(diff).length) return false;
    await addStep({ entity, recordId: id, op: 'update', fields: diff });
    return true;
  }

  /** Delete a record (soft on the server; it disappears here at once). */
  async function remove(entity, id) {
    definition(entity, 'delete');
    if (!(await get(entity, id))) throw new SyncError('not_found', `This ${entity} is not on this device`);
    await addStep({ entity, recordId: id, op: 'delete' });
  }

  // ---- syncing --------------------------------------------------------------------
  function syncSoon(delay = debounceMs) {
    if (stopped) return;
    if (soonTimer) timers.clearTimeout(soonTimer);
    soonTimer = timers.setTimeout(() => {
      soonTimer = null;
      syncNow('change');
    }, delay);
  }

  /**
   * Run a sync cycle now (or join the one running; a change made meanwhile gets another cycle).
   * Never rejects: problems end up in status (phase offline / error / stopped).
   */
  function syncNow(reason = 'manual') {
    if (stopped) return Promise.resolve(status);
    if (running) {
      again = true;
      return running;
    }
    if (soonTimer) {
      timers.clearTimeout(soonTimer);
      soonTimer = null;
    }
    running = (async () => {
      try {
        let ok;
        do {
          again = false;
          ok = await locks.request(LOCK_NAME, () => cycle(reason));
        } while (ok && again && !stopped);
      } finally {
        running = null;
      }
      return status;
    })();
    return running;
  }

  /** One full cycle under the lock. Resolves true when it went through. */
  async function cycle() {
    if (stopped) return false;
    if (!isOnline()) {
      setStatus({ phase: 'offline', nextRetryAt: null });
      return false;
    }
    if (retryTimer) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    setStatus({ phase: 'syncing' });
    try {
      await refreshInfo();
      for (let round = 0; round < LIMITS.maxRounds; round += 1) {
        if ((await pushSteps({ parked: false })).reset) continue;
        if ((await pullAll()).reset) continue;
        // Steps that waited for their record: once more, now that the copy is up to date.
        const retried = await pushSteps({ parked: true });
        if (retried.reset) continue;
        if (retried.accepted && (await pullAll()).reset) continue;
        break;
      }
      await pruneSent();
      attempt = 0;
      const lastSyncAt = new Date(wallClock()).toISOString();
      await tx('meta', 'readwrite', (t) => t.put('meta', lastSyncAt, 'lastSyncAt'));
      await refreshCounts();
      setStatus({ phase: 'idle', lastSyncAt, lastError: null, nextRetryAt: null });
      broadcast('synced');
      return true;
    } catch (err) {
      failed(err);
      return false;
    }
  }

  function failed(err) {
    if (stopped) return; // closed meanwhile (signed out, wiped): nothing to retry
    if (err?.status === 401 && SESSION_CODES.includes(err.code)) {
      // Signed out or the session ended: stop; the sign-in screen takes over. Data stays
      // (device_signed_out: clearLocalData deletes it; session_expired: kept for after sign-in).
      halt({ phase: 'stopped', stoppedBy: err.code, lastError: err.message ?? err.code });
      onSessionLost(err.code);
      return;
    }
    if (err?.status === 409 && err.code === 'device_mismatch') {
      halt({ phase: 'stopped', stoppedBy: err.code, lastError: err.message });
      return;
    }
    const network = isNetworkError(err) || !isOnline();
    attempt += 1;
    let nextRetryAt = null;
    if (autoSync) {
      const base = Math.min(retryMaxMs, retryBaseMs * 2 ** (attempt - 1));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      nextRetryAt = wallClock() + delay;
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        syncNow('retry');
      }, delay);
    }
    setStatus({ phase: network ? 'offline' : 'error', lastError: err?.message ?? String(err), nextRetryAt });
  }

  async function refreshInfo() {
    const info = await transport.get('/api/sync/info');
    const stored = (await readMeta(['generation'])).generation;
    await tx('meta', 'readwrite', async (t) => {
      await t.put('meta', { entities: info.entities, limits: info.limits, fetchedAt: new Date(wallClock()).toISOString() }, 'info');
      if (!stored) await t.put('meta', info.generation, 'generation');
      await receiveHlc(t, info.hlc);
    });
    definitions = definitionsFrom(info);
    if (!status.ready || status.generation !== info.generation) setStatus({ ready: true, generation: stored ?? info.generation });
    if (stored && stored !== info.generation) await resetLocal(info.generation);
  }

  /**
   * The server was restored from a backup (new generation): re-send the kept sent steps first
   * (lane 0, in their original order; they come back duplicate or apply again), then the outbox,
   * then pull from scratch. The pulled copy stays readable offline until the new one is complete.
   */
  async function resetLocal(generation) {
    await tx(['outbox', 'sent', 'meta', 'staging'], 'readwrite', async (t) => {
      const sent = (await t.getAll('sent')).filter((s) => s.generation !== generation).sort((a, b) => a.n - b.n);
      for (const s of sent) {
        await t.put('outbox', { k: [0, s.n], n: s.n, step: s.step, createdAt: s.sentAt, resend: true });
        await t.delete('sent', s.n);
      }
      await t.put('meta', generation, 'generation');
      await t.put('meta', null, 'pull');
      await t.put('meta', false, 'fullPull');
      await t.clear('staging');
    });
    setStatus({ generation });
    await dataChanged();
  }

  /**
   * Push outbox steps in key order, in batches. parked=false: everything not parked;
   * parked=true: only the parked ones (each tried once per call).
   */
  async function pushSteps({ parked }) {
    const tried = new Set();
    let maxSteps = LIMITS.pushSteps;
    let accepted = 0;
    for (;;) {
      if (stopped) return { accepted };
      const all = (await tx('outbox', 'readonly', (t) => t.getAll('outbox'))).sort(sortByKey);
      const entries = all.filter((e) => Boolean(e.parked) === parked && !tried.has(e.n));
      if (!entries.length) return { accepted };
      const batch = [];
      let bytes = 0;
      for (const e of entries) {
        const size = JSON.stringify(e.step).length + 1;
        if (batch.length && (batch.length >= maxSteps || bytes + size > LIMITS.pushBytes)) break;
        batch.push(e);
        bytes += size;
      }
      let body;
      try {
        body = await transport.post('/api/sync/push', {
          steps: batch.map((e) => e.step), deviceTime: new Date(wallClock()).toISOString(),
        });
      } catch (err) {
        if (err?.status === 413 && batch.length > 1) {
          maxSteps = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        throw err;
      }
      for (const e of batch) tried.add(e.n);
      const result = await recordPush(batch, body);
      accepted += result.accepted;
      if (result.reset) {
        await resetLocal(body.generation);
        return { accepted, reset: true };
      }
    }
  }

  /** Apply a push response to the outbox, sent and attention stores (one transaction). */
  async function recordPush(batch, body) {
    const at = new Date(wallClock()).toISOString();
    const outcome = await tx(['outbox', 'sent', 'attention', 'meta'], 'readwrite', async (t) => {
      await receiveHlc(t, body.hlc);
      const generation = (await t.get('meta', 'generation')) ?? null;
      if (!generation) await t.put('meta', body.generation, 'generation');
      let accepted = 0;
      for (let i = 0; i < batch.length; i += 1) {
        const entry = batch[i];
        const r = body.results?.[i];
        if (!r || r.key !== entry.step.key) continue; // no answer for it: stays, sent again next time
        if (r.status === 'applied' || r.status === 'duplicate' || r.status === 'clash') {
          accepted += 1;
          await t.delete('outbox', entry.k);
          await t.put('sent', {
            n: entry.n, step: entry.step, sentAt: at, seq: r.seq, generation: body.generation,
            status: r.status === 'duplicate' ? (r.original ?? 'applied') : r.status,
            applied: r.status === 'duplicate' ? null : (r.applied ?? null),
            kept: Boolean(r.kept),
          });
        } else if (r.status === 'rejected' && r.code === 'not_found') {
          // Its record isn't on the server (yet): keep it, try again after the next pull or reset.
          await t.put('outbox', { ...entry, parked: { code: r.code, reason: r.reason, at } });
        } else if (r.status === 'rejected') {
          await t.delete('outbox', entry.k);
          await t.put('attention', { n: entry.n, step: entry.step, code: r.code, reason: r.reason, at });
        }
      }
      return { accepted, reset: Boolean(generation) && generation !== body.generation };
    });
    if (body.clockWarning !== status.clockWarning) setStatus({ clockWarning: body.clockWarning ?? null });
    await dataChanged();
    return outcome;
  }

  /** Pull every page from the bookmark (or from scratch into `staging`). */
  async function pullAll() {
    for (;;) {
      if (stopped) return {};
      const meta = await readMeta(['pull', 'fullPull', 'generation']);
      const since = meta.pull;
      const qs = new URLSearchParams({ limit: String(LIMITS.pullLimit) });
      if (since) qs.set('since', since);
      const scope = pullScope();
      if (scope) for (const [k, v] of Object.entries(scope)) qs.set(k, v);
      const body = await transport.get(`/api/sync/pull?${qs}`);
      if ((since && body.reset) || (meta.generation && body.generation !== meta.generation)) {
        await resetLocal(body.generation);
        return { reset: true };
      }
      await applyPage(body, { full: !since || Boolean(meta.fullPull), first: !since });
      if (!body.hasMore) return {};
    }
  }

  async function applyPage(body, { full, first }) {
    const at = new Date(wallClock()).toISOString();
    await tx(['records', 'staging', 'meta'], 'readwrite', async (t) => {
      await receiveHlc(t, body.hlc);
      if (first) {
        await t.clear('staging');
        await t.put('meta', true, 'fullPull');
      }
      const target = full ? 'staging' : 'records';
      for (const c of body.changes) {
        if (c.deleted) await t.delete(target, [c.entity, c.id]);
        else await t.put(target, { entity: c.entity, id: c.id, fields: c.fields, flagged: Boolean(c.flagged), clashes: c.clashes ?? [], seq: c.seq });
      }
      await t.put('meta', body.cursor, 'pull');
      if (!body.hasMore) {
        if (full) {
          // The new copy is complete: it replaces the old one in one go.
          const fresh = await t.getAll('staging');
          await t.clear('records');
          for (const r of fresh) await t.put('records', r);
          await t.clear('staging');
          await t.put('meta', false, 'fullPull');
        }
        await t.put('meta', body.cursor, 'seen');
        await t.put('meta', body.generation, 'generation');
        await t.put('meta', ((await t.get('meta', 'pulls')) ?? 0) + 1, 'pulls');
        await t.put('meta', at, 'lastPullAt');
      }
    });
    if (!full || !body.hasMore) await dataChanged();
  }

  async function pruneSent() {
    const cutoff = wallClock() - LIMITS.keepSentMs;
    await tx('sent', 'readwrite', async (t) => {
      for (const s of await t.getAll('sent')) if (Date.parse(s.sentAt) < cutoff) await t.delete('sent', s.n);
    });
  }

  /** Download the whole copy again on the next sync (e.g. so new fields reach old records). */
  async function refetchAll() {
    await tx('meta', 'readwrite', async (t) => {
      await t.put('meta', null, 'pull');
      await t.put('meta', false, 'fullPull');
    });
    return syncNow('refetch');
  }

  // ---- needs attention / waiting ---------------------------------------------------
  /** Steps the server refused (other than not_found), oldest first. */
  async function attentionList() {
    return (await tx('attention', 'readonly', (t) => t.getAll('attention'))).sort((a, b) => a.n - b.n);
  }

  /** Steps parked because their record isn't on the server (yet). */
  async function waitingList() {
    return (await tx('outbox', 'readonly', (t) => t.getAll('outbox'))).filter((e) => e.parked).sort(sortByKey);
  }

  /** Let a refused change go. Discarding a refused create also drops later changes to that record. */
  async function discardAttention(n) {
    const dropped = await tx(['attention', 'outbox'], 'readwrite', async (t) => {
      const entry = await t.get('attention', n);
      if (!entry) return 0;
      await t.delete('attention', n);
      let count = 1;
      if (entry.step.op === 'create') {
        const same = (e) => e.step.entity === entry.step.entity && e.step.recordId === entry.step.recordId;
        for (const e of (await t.getAll('outbox')).filter(same)) {
          await t.delete('outbox', e.k);
          count += 1;
        }
        for (const e of (await t.getAll('attention')).filter(same)) {
          await t.delete('attention', e.n);
          count += 1;
        }
      }
      return count;
    });
    await dataChanged();
    return dropped;
  }

  /** Send a refused change again unchanged (same key: the server never recorded it). */
  async function retryAttention(n) {
    await tx(['attention', 'outbox', 'meta'], 'readwrite', async (t) => {
      const entry = await t.get('attention', n);
      if (!entry) return;
      const m = (await t.get('meta', 'nextN')) ?? 1;
      await t.put('meta', m + 1, 'nextN');
      await t.delete('attention', n);
      await t.put('outbox', { k: [1, m], n: m, step: entry.step, createdAt: new Date(wallClock()).toISOString() });
    });
    await dataChanged();
    if (autoSync) syncSoon(0);
  }

  /** Fix a refused create/update: a NEW step (new key and stamp) with the corrected fields. */
  async function fixAttention(n, fields) {
    const entry = (await tx('attention', 'readonly', (t) => t.get('attention', n)));
    if (!entry) throw new SyncError('not_found', 'Already sorted out');
    const { entity, recordId, op } = entry.step;
    if (op === 'delete') throw new SyncError('invalid_step', 'A delete has nothing to fix: try it again or discard it');
    const def = definition(entity, op);
    const clean = checkFields(def, fields ?? {}, { create: op === 'create' });
    if (op === 'update' && !Object.keys(clean).length) throw new SyncError('invalid_step', 'Change at least one field');
    const step = await tx(['attention', 'outbox', 'meta'], 'readwrite', async (t) => {
      await t.delete('attention', n);
      return queueStep(t, { entity, recordId, op, fields: clean });
    });
    await dataChanged();
    if (autoSync) syncSoon(0);
    return step;
  }

  /** Drop a change that is waiting for its record. */
  async function discardWaiting(n) {
    await tx('outbox', 'readwrite', async (t) => {
      for (const e of await t.getAll('outbox')) if (e.n === n && e.parked) await t.delete('outbox', e.k);
    });
    await dataChanged();
  }

  // ---- clashes (need a connection) ---------------------------------------------------
  async function resolveClash(clashId, resolution) {
    if (!isOnline()) throw new SyncError('offline', 'Settling a clash needs a connection');
    const result = await transport.post(`/api/sync/clashes/${encodeURIComponent(clashId)}/resolve`, { resolution });
    await syncNow('clash');
    return result;
  }

  // ---- facts for pages ----------------------------------------------------------------
  function entities() {
    return [...definitions.values()];
  }

  async function counts() {
    const records = await tx('records', 'readonly', (t) => t.getAll('records'));
    const out = {};
    for (const r of records) out[r.entity] = (out[r.entity] ?? 0) + 1;
    return out;
  }

  async function details() {
    return readMeta(['generation', 'seen', 'pull', 'pulls', 'lastPullAt', 'lastSyncAt', 'hlc', 'fullPull']);
  }

  return {
    deviceId,
    start,
    stop,
    wipe,
    // read
    list,
    get,
    // write
    create,
    update,
    remove,
    // sync
    syncNow,
    syncSoon,
    refetchAll,
    markOffline: () => !stopped && status.phase !== 'syncing' && setStatus({ phase: 'offline' }),
    // problems
    attentionList,
    waitingList,
    discardAttention,
    retryAttention,
    fixAttention,
    discardWaiting,
    resolveClash,
    // facts
    status: () => status,
    entities,
    definition: (entity) => definitions.get(entity) ?? null,
    counts,
    details,
    isStopped: () => stopped,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
