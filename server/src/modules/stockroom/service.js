// Stock tasks from Stockroom (D16): the suite's read-only connection to Stockroom (the Inventory Hub
// on Fly, its package B5) and the pulls that feed the four stock automations (automations.js).
//
//   connection   Stockroom's address + a reader key and secret, pasted once as Stockroom's
//                connection code (SLR1.…). The secret is kept AES-256-GCM-encrypted with the key file
//                config.stockroom.keyFile (../../lib/sealed.js) — never in the database or the backups
//                in usable form — and checked with a signed GET /v1/suite before it is saved.
//   pulls        signed GETs (client.js — the only kind of call there is) on a schedule:
//                  deliveries, differences, counts   hourly (small answers; If-None-Match → 304)
//                  order-soon                        once a day after 6:30 a.m., again when the
//                                                    deliveries changed (a purchase order confirmed or
//                                                    received changes what is on order), and whenever
//                                                    the last answer is over a day old
//                one round at a time; a failure backs off 2, 4, 8, 16, 32, then 60 minutes; a network,
//                time-out or sign-in problem stops the round (the others would fail the same way);
//                401 `revoked` stops every call until a new code is pasted. Every answer is kept in
//                stockroom_pulls (not synced) with its ETag.
//   events       after a round that got at least one answer: automations.emit('stockroom.pulled')
//                — the automations then decide on the stored answers. A failing pull, emit or
//                automation never breaks anything else (each is caught and logged).
//   Connections  the 'stockroom' row (in the placeholder's slot): last success, last error, what
//                Stockroom lists now; pausable — paused = no calls at all.
//
// Read only by construction: nothing in this module can ask Stockroom to change anything (client.js
// only signs GETs, with no body); everything it writes is its own tables and, through the
// automations, planner tasks via sync. It reads and writes only its own tables.
import { newId } from '@suite/shared/ids';
import { nowIso, localDate } from '@suite/shared/time';
import { HttpError } from '../../lib/httpError.js';
import { loadKey, encryptSecret, decryptSecret } from '../../lib/sealed.js';
import { atLocal, clockText } from '../automations/schedule.js';
import { createStockroomClient, parseConnection, StockroomError } from './client.js';
import { registerStockroomAutomations, PULLED_EVENT } from './automations.js';
import { reorderGroups, overLimit } from './plans.js';

export const CONNECTION_ID = 'stockroom';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** What is pulled and how often (see the top of this file for why). Order = the order of a round. */
export const READS = Object.freeze([
  { endpoint: 'deliveries', path: '/v1/suite/deliveries', label: 'Deliveries', everyMs: HOUR },
  { endpoint: 'differences', path: '/v1/suite/differences', label: 'Differences', everyMs: HOUR },
  { endpoint: 'counts', path: '/v1/suite/counts', label: 'Counts', everyMs: HOUR },
  { endpoint: 'order-soon', path: '/v1/suite/order-soon', label: 'Order soon', dailyAt: '06:30' },
]);
const READ = new Map(READS.map((r) => [r.endpoint, r]));
/** The pull loop's look (calls are made only when an answer is due). */
export const LOOK_EVERY_MS = MINUTE;
/** The first look after start. */
export const FIRST_LOOK_MS = 20_000;
/** After n failures in a row: wait min(2^n, 60) minutes. */
export const backoffMs = (failures) => Math.min(2 ** Math.max(1, failures), 60) * MINUTE;
/** Errors that say nothing else would get through now either: the round stops. */
const ROUND_STOPPERS = new Set(['network', 'timeout', 'unauthorized']);

export function cadenceText() {
  return `Deliveries, differences and counts hourly; the order-soon list daily after ${clockText('06:30')} (and when deliveries change)`;
}

export function createStockroomService(ctx) {
  const { db, config, log, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const { connections, automations, planner } = services;
  if (!connections) throw new Error('stockroom needs the connections module registered before it');

  const q = {
    connection: db.prepare('SELECT * FROM stockroom_connection WHERE id = 1'),
    setConnection: db.prepare(`INSERT INTO stockroom_connection (id, hub_url, reader_key, secret_enc, set_at, set_by, set_device, revoked_at)
      VALUES (1, @url, @key, @enc, @at, @actor, @device, NULL) ON CONFLICT (id) DO UPDATE SET hub_url = excluded.hub_url,
      reader_key = excluded.reader_key, secret_enc = excluded.secret_enc, set_at = excluded.set_at, set_by = excluded.set_by,
      set_device = excluded.set_device, revoked_at = NULL`),
    revoke: db.prepare('UPDATE stockroom_connection SET revoked_at = ? WHERE id = 1 AND revoked_at IS NULL'),
    forget: db.prepare('DELETE FROM stockroom_connection WHERE id = 1'),
    change: db.prepare(`INSERT INTO stockroom_connection_changes (id, at, actor, device_id, action, hub_url, reader_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    changes: db.prepare('SELECT at, actor, device_id AS deviceId, action, hub_url AS hubUrl, reader_key AS readerKey FROM stockroom_connection_changes ORDER BY at DESC, id DESC LIMIT ?'),
    pull: db.prepare('SELECT * FROM stockroom_pulls WHERE endpoint = ?'),
    pulls: db.prepare('SELECT * FROM stockroom_pulls'),
    clearPulls: db.prepare('DELETE FROM stockroom_pulls'),
    ok: db.prepare(`INSERT INTO stockroom_pulls (endpoint, hub_url, etag, body, as_of, fetched_at, changed_at, last_attempt_at, failures, next_try_at)
      VALUES (@endpoint, @hub, @etag, @body, @asOf, @at, @at, @at, 0, NULL)
      ON CONFLICT (endpoint) DO UPDATE SET hub_url = excluded.hub_url, etag = excluded.etag, body = excluded.body, as_of = excluded.as_of,
      fetched_at = excluded.fetched_at, changed_at = CASE WHEN @changed = 1 THEN excluded.changed_at ELSE stockroom_pulls.changed_at END,
      last_attempt_at = excluded.last_attempt_at, failures = 0, next_try_at = NULL, wanted = 0`),
    same: db.prepare(`UPDATE stockroom_pulls SET fetched_at = @at, last_attempt_at = @at, failures = 0, next_try_at = NULL, wanted = 0,
      etag = COALESCE(@etag, etag) WHERE endpoint = @endpoint`),
    want: db.prepare('UPDATE stockroom_pulls SET wanted = 1 WHERE endpoint = ?'),
    fail: db.prepare(`INSERT INTO stockroom_pulls (endpoint, last_attempt_at, last_error_at, last_error, failures, next_try_at)
      VALUES (@endpoint, @at, @at, @error, 1, @next)
      ON CONFLICT (endpoint) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error_at = excluded.last_error_at,
      last_error = excluded.last_error, failures = stockroom_pulls.failures + 1, next_try_at = excluded.next_try_at`),
    episodes: db.prepare('SELECT * FROM stockroom_reorder_episodes ORDER BY supplier_key, episode'),
    openEpisode: db.prepare('INSERT INTO stockroom_reorder_episodes (supplier_key, episode, opened_at) VALUES (?, ?, ?)'),
    closeEpisode: db.prepare(`UPDATE stockroom_reorder_episodes SET closed_at = ?, closed_why = ?, closed_note = ?
      WHERE supplier_key = ? AND episode = ? AND closed_at IS NULL`),
  };
  const at = () => nowIso(new Date(clock()));

  // ---- the connection ---------------------------------------------------------------------------
  let secretCache = { enc: null, secret: null };
  function currentSecret(row = q.connection.get()) {
    if (!row) return null;
    if (secretCache.enc !== row.secret_enc) {
      let secret = null;
      try {
        secret = decryptSecret(loadKey(config.stockroom.keyFile, { create: false }), row.secret_enc);
      } catch (err) {
        log?.error?.(`can't read the Stockroom key file: ${err.message}`);
      }
      secretCache = { enc: row.secret_enc, secret };
    }
    return secretCache.secret;
  }

  /** The connection for the Connections card (never the secret). */
  function connectionInfo() {
    const row = q.connection.get();
    const paused = handle?.isPaused() ?? false;
    const pulls = new Map(q.pulls.all().map((p) => [p.endpoint, p]));
    return {
      connected: Boolean(row),
      hubUrl: row?.hub_url ?? null,
      readerKey: row?.reader_key ?? null,
      setAt: row?.set_at ?? null,
      setBy: row?.set_by ?? null,
      revokedAt: row?.revoked_at ?? null,
      readable: row ? currentSecret(row) !== null : false,
      paused,
      cadence: cadenceText(),
      reads: READS.map((r) => {
        const p = pulls.get(r.endpoint);
        return {
          endpoint: r.endpoint, label: r.label, fetchedAt: p?.fetched_at ?? null, changedAt: p?.changed_at ?? null, asOf: p?.as_of ?? null,
          lastErrorAt: p?.last_error_at ?? null, lastError: p?.last_error ?? null, failures: p?.failures ?? 0, nextTryAt: p?.next_try_at ?? null,
        };
      }),
      lists: lists(),
      changes: q.changes.all(10),
    };
  }

  const refused = (status, code, message) => new HttpError(status, message, undefined, { code });

  /**
   * Paste Stockroom's connection code ({ code }) — or its three parts ({ url, key, secret }). It is
   * checked with a signed GET /v1/suite first and saved only when Stockroom accepts it. Replaces any
   * connection; answers from another Stockroom address are forgotten. → connectionInfo()
   */
  async function connect(input, { actor, deviceId = null }) {
    if (handle.isPaused()) throw refused(409, 'paused', 'Stockroom is switched off on this page: switch it on, then paste the code');
    let parts;
    try {
      parts = parseConnection(input ?? {});
    } catch (err) {
      if (err instanceof StockroomError) throw refused(400, err.code, err.message);
      throw err;
    }
    try {
      const client = createStockroomClient({ ...parts, timeoutMs: config.stockroom.timeoutMs, now: clock });
      await client.get('/v1/suite');
    } catch (err) {
      if (!(err instanceof StockroomError)) throw err;
      if (err.code === 'unauthorized' || err.code === 'revoked') throw refused(400, 'refused', err.message);
      if (err.code === 'network' || err.code === 'timeout') throw refused(502, 'unreachable', `${err.message}: nothing was saved`);
      throw refused(502, err.code, `${err.message}: nothing was saved`);
    }
    const enc = encryptSecret(loadKey(config.stockroom.keyFile), parts.secret);
    const before = q.connection.get();
    const when = at();
    db.transaction(() => {
      q.setConnection.run({ url: parts.url, key: parts.key, enc, at: when, actor, device: deviceId });
      if (before && before.hub_url !== parts.url) q.clearPulls.run();
      q.change.run(newId(), when, actor, deviceId, before ? 'replaced' : 'connected', parts.url, parts.key);
    })();
    secretCache = { enc, secret: parts.secret };
    log?.info?.(`Stockroom connection ${before ? 'replaced' : 'made'} by ${actor} (${parts.url}, ${parts.key})`);
    // The first pull right away, in the background (its failures show on the card).
    pullRound({ force: true }).catch((err) => log?.error?.('the first Stockroom pull failed:', err));
    return connectionInfo();
  }

  /** Forget the connection here (Stockroom keeps its credential: disconnect it there too). Tasks stay. */
  function forget({ actor, deviceId = null }) {
    const before = q.connection.get();
    if (!before) return connectionInfo();
    db.transaction(() => {
      q.forget.run();
      q.clearPulls.run();
      q.change.run(newId(), at(), actor, deviceId, 'forgotten', before.hub_url, before.reader_key);
    })();
    secretCache = { enc: null, secret: null };
    log?.info?.(`Stockroom connection forgotten by ${actor}`);
    return connectionInfo();
  }

  // ---- pulls ------------------------------------------------------------------------------------
  /**
   * Is this read due now? `wanted` (order-soon after the deliveries changed) is a flag on its row, kept until a read
   * succeeds — a backoff or a restart in between doesn't lose it; the backoff still applies to it.
   */
  function due(r, row, nowMs, { force = false } = {}) {
    if (row?.next_try_at && Date.parse(row.next_try_at) > nowMs && !force) return false;
    if (force || row?.wanted === 1 || !row?.fetched_at) return true;
    const fetched = Date.parse(row.fetched_at);
    if (r.everyMs) return nowMs - fetched >= r.everyMs;
    if (nowMs - fetched >= 24 * HOUR) return true;
    const today = localDate(new Date(nowMs));
    const dueAt = atLocal(today, r.dailyAt).getTime();
    return nowMs >= dueAt && fetched < dueAt;
  }

  function recordFailure(endpoint, err, nowMs) {
    const row = q.pull.get(endpoint);
    const failures = (row?.failures ?? 0) + 1;
    const next = new Date(nowMs + backoffMs(failures)).toISOString();
    const when = nowIso(new Date(nowMs));
    q.fail.run({ endpoint, at: when, error: String(err?.message ?? err).slice(0, 500), next });
  }

  let running = null;
  let forcedNext = null;
  /**
   * One pull round: every read that is due (all with `force`), in order. Never throws for Stockroom's
   * problems (they are recorded on the reads). → { skipped? , got: [endpoints], changed: [endpoints], failed: [endpoints] }
   * One round at a time: a plain request while one runs gets that round; a forced one (Pull now, a new code) gets
   * ONE forced round chained after it — several such requests meanwhile share it (review fix: the force was dropped).
   */
  function pullRound(opts = {}) {
    if (!running) {
      running = doRound(opts).finally(() => { running = null; });
      return running;
    }
    if (!opts.force) return running;
    forcedNext ??= running.catch(() => {}).then(() => {
      forcedNext = null;
      return pullRound({ force: true });
    });
    return forcedNext;
  }

  /**
   * An answer's contents, for "did it change?": without `as_of` (every answer has a new one) and, for deliveries,
   * without what moves with the calendar alone (`today`, `counts`, each order's `overdue`) and with `ended` reduced to
   * its ids — so a new day isn't a change, but an order that ended is.
   */
  function stable(endpoint, body) {
    if (!body || typeof body !== 'object') return JSON.stringify(body);
    const { as_of: _asOf, ...rest } = body;
    if (endpoint !== 'deliveries') return JSON.stringify(rest);
    // `ended` (B10) as the sorted ids only: an order confirmed and received between two reads never shows in `items`,
    // but it does appear in `ended` — that must count as a change (review fix). Its other fields and ended_truncated
    // are left out. (An order only ageing out of the 30 days still counts: rare, and harmless — one extra read.)
    const { today: _t, counts: _c, items, ended, ended_truncated: _et, ...more } = rest;
    const endedIds = Array.isArray(ended) ? ended.map((e) => e?.po_id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : null;
    return JSON.stringify({ ...more, items: Array.isArray(items) ? items.map(({ overdue: _o, ...i }) => i) : items, endedIds });
  }

  async function doRound({ force = false } = {}) {
    const row = q.connection.get();
    if (!row) return { skipped: 'not_set_up', got: [], changed: [], failed: [] };
    if (row.revoked_at) return { skipped: 'revoked', got: [], changed: [], failed: [] };
    if (handle.isPaused()) return { skipped: 'paused', got: [], changed: [], failed: [] };
    const secret = currentSecret(row);
    if (!secret) return { skipped: 'unreadable', got: [], changed: [], failed: [] };
    const client = createStockroomClient({ url: row.hub_url, key: row.reader_key, secret, timeoutMs: config.stockroom.timeoutMs, now: clock });
    const got = [];
    const changed = [];
    const failed = [];
    for (let i = 0; i < READS.length; i += 1) {
      const r = READS[i];
      const nowMs = clock();
      const prev = q.pull.get(r.endpoint);
      if (!due(r, prev, nowMs, { force })) continue;
      // Switched off (or another code pasted) while the round ran: stop before the next call.
      if (handle.isPaused() || q.connection.get()?.secret_enc !== row.secret_enc) break;
      try {
        const sameHub = prev?.hub_url === row.hub_url && prev?.body;
        const res = await client.get(r.path, { etag: sameHub ? prev.etag : null });
        const when = nowIso(new Date(clock()));
        if (res.status === 304) {
          q.same.run({ endpoint: r.endpoint, at: when, etag: res.etag ?? null });
        } else {
          const body = JSON.stringify(res.body);
          let before = null;
          try { before = sameHub ? stable(r.endpoint, JSON.parse(prev.body)) : null; } catch { before = null; }
          const isChange = before !== stable(r.endpoint, res.body);
          db.transaction(() => {
            q.ok.run({ endpoint: r.endpoint, hub: row.hub_url, etag: res.etag ?? null, body, asOf: typeof res.body.as_of === 'string' ? res.body.as_of : null, at: when, changed: isChange ? 1 : 0 });
            // The deliveries changed (an order confirmed, received, cancelled): what is on order changed, so the
            // order-soon list is read again — this round, or after its backoff, or after a restart.
            if (isChange && r.endpoint === 'deliveries' && before !== null) q.want.run('order-soon');
          })();
          if (isChange) changed.push(r.endpoint);
        }
        got.push(r.endpoint);
      } catch (err) {
        if (!(err instanceof StockroomError)) {
          log?.error?.(`Stockroom ${r.endpoint}: unexpected error`, err);
          recordFailure(r.endpoint, err, clock());
          failed.push(r.endpoint);
          continue;
        }
        if (err.code === 'revoked') {
          const when = at();
          db.transaction(() => {
            if (q.revoke.run(when).changes) q.change.run(newId(), when, 'system', null, 'revoked', row.hub_url, row.reader_key);
          })();
          log?.warn?.('Stockroom says this connection was disconnected there: no more calls until a new code is pasted');
          recordFailure(r.endpoint, err, clock());
          failed.push(r.endpoint);
          break;
        }
        recordFailure(r.endpoint, err, clock());
        failed.push(r.endpoint);
        const stop = ROUND_STOPPERS.has(err.code) || (err.code === 'http' && (err.status >= 500 || err.status === 429));
        if (stop) {
          // The others due this round would fail the same way: they wait with it (same backoff).
          for (const rest of READS.slice(i + 1)) {
            if (due(rest, q.pull.get(rest.endpoint), clock(), { force })) {
              recordFailure(rest.endpoint, new Error(`Not tried: ${err.message}`), clock());
              failed.push(rest.endpoint);
            }
          }
          log?.warn?.(`Stockroom pull stopped: ${err.message}`);
          break;
        }
        log?.warn?.(`Stockroom ${r.endpoint}: ${err.message}`);
      }
    }
    if (got.length) announce({ got, changed });
    return { got, changed, failed };
  }

  /** Tell the automations (they decide on the stored answers). Never lets their problems out. */
  function announce({ got, changed }) {
    if (!automations) return [];
    try {
      return automations.emit(PULLED_EVENT, { key: newId(), got, changed });
    } catch (err) {
      log?.error?.('the Stockroom automations failed (tried again after the next pull):', err);
      return [];
    }
  }

  /** The pull loop (production): a look every minute; calls only when something is due. → stop() */
  function startPuller({ everyMs = LOOK_EVERY_MS, firstMs = FIRST_LOOK_MS } = {}) {
    const look = () => pullRound().catch((err) => log?.error?.('Stockroom pull failed (tried again later):', err));
    const first = setTimeout(look, firstMs);
    const timer = setInterval(look, everyMs);
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  /** "Pull now" (the card): every read, now. 409 when it can't call. → { round, connection } */
  async function pullNow() {
    const row = q.connection.get();
    if (!row) throw refused(409, 'not_set_up', 'Stockroom isn’t connected yet: paste its connection code first');
    if (row.revoked_at) throw refused(409, 'revoked', 'Disconnected in Stockroom: make a new connection there and paste its code here');
    if (handle.isPaused()) throw refused(409, 'paused', 'Stockroom is switched off on this page: switch it on to pull');
    const round = await pullRound({ force: true });
    return { round, connection: connectionInfo() };
  }

  // ---- the stored answers (for the automations and the card) ------------------------------------
  /** The last good answer of one read: { body, fetchedAt, changedAt, asOf } — or null (never read, or from another Stockroom). */
  function snapshot(endpoint) {
    if (!READ.has(endpoint)) throw new Error(`stockroom: no read "${endpoint}"`);
    const row = q.pull.get(endpoint);
    const conn = q.connection.get();
    if (!row?.body || !conn || row.hub_url !== conn.hub_url) return null;
    try {
      return { body: JSON.parse(row.body), fetchedAt: row.fetched_at, changedAt: row.changed_at, asOf: row.as_of };
    } catch {
      return null;
    }
  }

  /** What Stockroom lists now, in numbers (the card's line): null for what wasn't read. */
  function lists() {
    const d = snapshot('deliveries');
    const f = snapshot('differences');
    const o = snapshot('order-soon');
    const c = snapshot('counts');
    const threshold = Number.isFinite(f?.body?.threshold_tins) ? f.body.threshold_tins : 1;
    return {
      deliveries: d ? (d.body.items ?? []).length : null,
      differences: f ? (f.body.items ?? []).filter((x) => overLimit(x, threshold)).length : null,
      reorderSuppliers: o ? reorderGroups(o.body).size : null,
      reorderProducts: o ? [...reorderGroups(o.body).values()].reduce((a, g) => a + g.items.length, 0) : null,
      lastSpotCheckAt: c ? c.body.last_spot_check?.applied_at ?? null : null,
    };
  }

  /**
   * D11 (the overview's "low stock"): the products Stockroom's last order-soon answer says to reorder (a suggested
   * quantity above 0), most urgent first — the same list the reorder tasks are made from. → { state, asOf, fetchedAt,
   * items: [{ sku, name, brand, supplier, suggestedQty, daysLeft, runsOutOn, available, onOrder, status }] };
   * state: not_connected | revoked | not_read (nothing read yet) | paused (the last answer, not read again while paused) | ok.
   */
  function lowStock() {
    const row = q.connection.get();
    if (!row) return { state: 'not_connected', asOf: null, fetchedAt: null, items: [] };
    const o = snapshot('order-soon');
    const paused = handle?.isPaused() ?? false;
    const state = row.revoked_at ? 'revoked' : !o ? 'not_read' : paused ? 'paused' : 'ok';
    if (!o) return { state, asOf: null, fetchedAt: null, items: [] };
    const num = (v) => (Number.isFinite(v) ? v : null);
    const items = [...reorderGroups(o.body).values()].flatMap((g) => g.items.map((i) => ({
      sku: i.sku ?? null, name: i.name ?? null, brand: i.brand ?? null, supplier: g.supplier, suggestedQty: i.suggested_qty,
      daysLeft: num(i.days_left), runsOutOn: typeof i.runs_out_on === 'string' ? i.runs_out_on : null,
      available: num(i.available), onOrder: num(i.on_order), status: i.status ?? null,
    })));
    const days = (i) => (i.daysLeft === null ? Infinity : i.daysLeft);
    items.sort((a, b) => days(a) - days(b) || String(a.name ?? a.sku).localeCompare(String(b.name ?? b.sku)));
    return { state, asOf: o.asOf ?? null, fetchedAt: o.fetchedAt ?? null, items };
  }

  // ---- the Connections row ----------------------------------------------------------------------
  function describe() {
    const row = q.connection.get();
    const pulls = q.pulls.all();
    const latest = (k) => pulls.reduce((a, p) => (p[k] && (!a || p[k] > a[k]) ? p : a), null);
    const ok = latest('fetched_at');
    const bad = latest('last_error_at');
    const base = {
      lastSuccessAt: ok?.fetched_at ?? null,
      lastErrorAt: bad?.last_error_at ?? null,
      lastError: bad ? `${READ.get(bad.endpoint)?.label ?? bad.endpoint}: ${bad.last_error}` : null,
      queueSize: null,
    };
    if (!row) return { ...base, queueLabel: 'Not set up', detail: 'Paste the connection code from Stockroom (Settings → Connections → Connect the suite) below.' };
    if (row.revoked_at) {
      return {
        ...base, lastErrorAt: row.revoked_at, lastError: 'Disconnected in Stockroom: make a new connection there and paste its code here',
        queueLabel: 'Disconnected', detail: `${row.hub_url} · key ${row.reader_key}`,
      };
    }
    if (!currentSecret(row)) {
      return { ...base, lastError: 'The secret can’t be read on this machine (its key file is missing): paste the code again', lastErrorAt: base.lastErrorAt ?? row.set_at, queueLabel: 'Not readable', detail: row.hub_url };
    }
    const l = lists();
    const parts = [];
    if (l.reorderSuppliers !== null) parts.push(l.reorderProducts ? `${l.reorderProducts} to reorder` : 'nothing to reorder');
    if (l.deliveries !== null) parts.push(`${l.deliveries} deliver${l.deliveries === 1 ? 'y' : 'ies'} expected`);
    if (l.differences !== null) parts.push(`${l.differences} difference${l.differences === 1 ? '' : 's'} open`);
    return {
      ...base,
      queueLabel: parts.length ? parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) : 'Nothing read yet',
      // (The address, key and each read's state are on the card's own panel.)
      detail: 'Read only: the suite never changes stock',
    };
  }

  const handle = connections.register({
    id: CONNECTION_ID,
    name: 'Stockroom (Inventory Hub)',
    module: 'stockroom',
    description: 'What to reorder, expected deliveries, count differences and the weekly spot check, read from Stockroom on a schedule '
      + 'and turned into tasks. Read only: the suite never changes stock.',
    describe: () => describe(),
    // Paused: no calls to Stockroom at all (the loop and Pull now check the switch before every call).
    pause() { log?.info?.('paused: no calls to Stockroom until it is switched on'); },
    resume() {
      log?.info?.('on again: reading Stockroom');
      pullRound().catch((err) => log?.error?.('Stockroom pull failed (tried again later):', err));
    },
  });

  const store = {
    snapshot,
    episodes: () => q.episodes.all(),
    openEpisode: (key, episode, { at: when }) => q.openEpisode.run(key, episode, when),
    closeEpisode: (key, episode, { at: when, why, note }) => q.closeEpisode.run(when, why, note, key, episode),
  };
  if (automations && planner) registerStockroomAutomations({ automations, planner, store, clock });

  return { connect, forget, connectionInfo, pullRound, pullNow, startPuller, snapshot, lists, lowStock, describe, store };
}
