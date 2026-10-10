// WooCommerce stores (D12): each retail store's REST API, read with its own READ key — daily sales totals for the
// sales module, and live order lookups that are never stored.
//
//   stores      added on System → Connections → WooCommerce stores: address, consumer key + secret (made in the store
//               with permission "Read"), our business (retail by default). The key is checked with real reads before
//               anything is saved; the secret is kept AES-256-GCM-encrypted with the key file config.woocommerce.keyFile
//               (../../lib/sealed.js, like D16's) and never sent back.
//   totals      Analytics → Revenue (wc-analytics `reports/revenue/stats`, interval=day) — the report the owner sees in
//               WooCommerce, so the store's own settings (excluded statuses, date type) and time zone are applied by
//               WooCommerce itself. Each pull re-reads a rolling window (the last WINDOW_DAYS days: late refunds and
//               status changes land), and the first pulls backfill BACKFILL_MONTHS months in BACKFILL_CHUNK_DAYS-day
//               reads; every day is an upsert (sales.putDays), so nothing is ever counted twice.
//   lookups     an order by number or email, live, shown in the session — status, items, totals, dates, shipping and
//               tracking, and the customer's FIRST NAME only. Never stored, never logged (the query either).
//   Connections a row per store ("woo-<id>": pausable, last success, last error) after the "woocommerce" row (where
//               stores are added). Paused = no calls to that store at all. One store's failures never touch another's:
//               each pull is its own, with its own backoff (2, 4 … 60 minutes).
//
// Read only by construction (client.js: GET only, allowlisted paths, no body). No customer data is kept: the stores
// sell age-restricted products, so nothing from them may ever feed a marketing list (CLAUDE.md's age rule).
// It reads and writes only its own tables; totals go through ctx.services.sales.
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';
import { addMonths, BUSINESS_IDS } from '@suite/shared/crm';
import { localDateIn, toCents, zeroFigures, offsetZone } from '@suite/shared/sales';
import { HttpError } from '../../lib/httpError.js';
import { loadKey, encryptSecret, decryptSecret } from '../../lib/sealed.js';
import { createWooClient, cleanStoreUrl, storeKey, parseKeys, WooError } from './client.js';

export const HUB_ID = 'woocommerce';
export const connectionId = (storeId) => `woo-${storeId.replace(/-/g, '')}`;
const MINUTE = 60_000;
/** The rolling window each pull re-reads (late refunds and status changes land in it). */
export const WINDOW_DAYS = 60;
/** How far the one-time backfill reaches, and how much one read covers. */
export const BACKFILL_MONTHS = 13;
export const BACKFILL_CHUNK_DAYS = 90;
/** After a time-out the backfill reads half as many days at a time, down to this (review fix). */
export const MIN_CHUNK_DAYS = 7;
/** Analytics answers at most 100 intervals a page. */
const PER_PAGE = 100;
export const LOOK_EVERY_MS = MINUTE;
export const FIRST_LOOK_MS = 30_000;
export const backoffMs = (failures) => Math.min(2 ** Math.max(1, failures), 60) * MINUTE;
const LOOKUP_LIMIT = 10;

/**
 * The site's zone from its REST index: timezone_string, else its gmt_offset — a whole hour as Etc/GMT±N, a fraction
 * (5.5, −3.5, 5.75) as a fixed offset "+05:30" counted in minutes (review fix: it used to fall back to the Mac's zone)
 * — else null.
 */
export function siteTimeZone(index) {
  const named = String(index?.timezone_string ?? '').trim();
  if (named) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: named });
      return named;
    } catch { /* not a zone this machine knows */ }
  }
  const raw = index?.gmt_offset;
  const off = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(off) || Math.abs(off) > 14) return null;
  if (off === 0) return 'UTC';
  if (Number.isInteger(off)) return `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`; // Etc signs are reversed
  return offsetZone(off);
}

/** Analytics → Revenue's subtotals for one interval → a sales row's figures (integer cents). */
export function figuresFrom(subtotals = {}) {
  return {
    orders: Number.parseInt(subtotals.orders_count, 10) || 0,
    items: Number.parseInt(subtotals.num_items_sold, 10) || 0,
    gross: toCents(subtotals.gross_sales),
    discounts: toCents(subtotals.coupons),
    refunds: toCents(subtotals.refunds),
    net: toCents(subtotals.net_revenue),
    tax: toCents(subtotals.taxes),
    shipping: toCents(subtotals.shipping),
    total: toCents(subtotals.total_sales),
  };
}

/** Days from…to as "YYYY-MM-DD", in order. */
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** An order as the suite shows it: no address, email, phone or last name — the customer's first name only. */
export function orderView(o, tracking = []) {
  const money = (v) => toCents(v);
  const gmt = (v) => (v ? (/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`) : null);
  const metaTracking = (o.meta_data ?? []).filter((m) => typeof m?.key === 'string' && /tracking/i.test(m.key) && !m.key.startsWith('_')
    && (typeof m.value === 'string' || typeof m.value === 'number') && String(m.value).trim())
    .map((m) => ({ provider: null, number: String(m.value).slice(0, 80), url: null, shippedOn: null }));
  return {
    id: o.id,
    number: String(o.number ?? o.id),
    status: o.status ?? null,
    currency: o.currency ?? null,
    createdAt: gmt(o.date_created_gmt) ?? o.date_created ?? null,
    paidAt: gmt(o.date_paid_gmt) ?? null,
    completedAt: gmt(o.date_completed_gmt) ?? null,
    total: money(o.total),
    discount: money(o.discount_total),
    shipping: money(o.shipping_total),
    tax: money(o.total_tax),
    refunded: (o.refunds ?? []).reduce((a, r) => a + Math.abs(money(r.total)), 0),
    items: (o.line_items ?? []).map((li) => ({ name: String(li.name ?? '').slice(0, 200), sku: li.sku || null, quantity: Number(li.quantity) || 0, total: money(li.total) })),
    shippingMethods: (o.shipping_lines ?? []).map((s) => s.method_title).filter(Boolean),
    tracking: [...tracking, ...metaTracking],
    customerFirstName: String(o.billing?.first_name ?? '').trim().split(/\s+/)[0] || null,
  };
}

export function createWooService(ctx) {
  const { db, config, log, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const { connections, sales, crm } = services;
  if (!connections || !sales) throw new Error('woocommerce needs the connections and sales modules registered before it');
  const cfg = config.woocommerce;

  const q = {
    stores: db.prepare('SELECT * FROM woocommerce_stores ORDER BY position, added_at'),
    store: db.prepare('SELECT * FROM woocommerce_stores WHERE id = ?'),
    byUrl: db.prepare('SELECT * FROM woocommerce_stores WHERE url = ? OR store_key = ?'),
    maxPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM woocommerce_stores'),
    insert: db.prepare(`INSERT INTO woocommerce_stores (id, name, url, store_key, consumer_key, secret_enc, business_id, currency, time_zone,
      read_only_confirmed, position, added_at, added_by, added_device, key_set_at)
      VALUES (@id, @name, @url, @store_key, @consumer_key, @secret_enc, @business_id, @currency, @time_zone, 1, @position, @at, @actor, @device, @at)`),
    setKey: db.prepare('UPDATE woocommerce_stores SET consumer_key = ?, secret_enc = ?, key_set_at = ?, read_only_confirmed = 1 WHERE id = ?'),
    setSite: db.prepare('UPDATE woocommerce_stores SET currency = ?, time_zone = ? WHERE id = ?'),
    setName: db.prepare('UPDATE woocommerce_stores SET name = ? WHERE id = ?'),
    setBusiness: db.prepare('UPDATE woocommerce_stores SET business_id = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM woocommerce_stores WHERE id = ?'),
    change: db.prepare('INSERT INTO woocommerce_changes (id, at, actor, device_id, store_id, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    changes: db.prepare('SELECT at, actor, device_id AS deviceId, action, detail FROM woocommerce_changes WHERE store_id = ? ORDER BY at DESC, id DESC LIMIT 10'),
    pull: db.prepare('SELECT * FROM woocommerce_pulls WHERE store_id = ?'),
    ensurePull: db.prepare('INSERT INTO woocommerce_pulls (store_id) VALUES (?) ON CONFLICT (store_id) DO NOTHING'),
    pullOk: db.prepare(`UPDATE woocommerce_pulls SET last_success_at = @at, last_attempt_at = @at, failures = 0, next_try_at = NULL,
      window_from = @from, window_to = @to WHERE store_id = @id`),
    pullFail: db.prepare(`UPDATE woocommerce_pulls SET last_attempt_at = @at, last_error_at = @at, last_error = @error,
      failures = failures + 1, next_try_at = @next WHERE store_id = @id`),
    backfill: db.prepare('UPDATE woocommerce_pulls SET backfill_before = ?, backfill_target = ?, backfill_done_at = ? WHERE store_id = ?'),
    dropPull: db.prepare('DELETE FROM woocommerce_pulls WHERE store_id = ?'),
    backfillOk: db.prepare('UPDATE woocommerce_pulls SET backfill_error = NULL, backfill_error_at = NULL, backfill_failures = 0, backfill_next_try_at = NULL WHERE store_id = ?'),
    backfillFail: db.prepare(`UPDATE woocommerce_pulls SET backfill_error = @error, backfill_error_at = @at, backfill_failures = backfill_failures + 1,
      backfill_next_try_at = @next, backfill_chunk_days = @chunk WHERE store_id = @id`),
    backfillReset: db.prepare(`UPDATE woocommerce_pulls SET backfill_before = NULL, backfill_target = NULL, backfill_done_at = NULL, backfill_error = NULL,
      backfill_error_at = NULL, backfill_failures = 0, backfill_next_try_at = NULL WHERE store_id = ?`),
  };
  const at = () => nowIso(new Date(clock()));
  const refused = (status, code, message) => new HttpError(status, message, undefined, { code });

  // ---- secrets --------------------------------------------------------------------------------------
  const secretCache = new Map(); // secret_enc → secret
  function secretOf(row) {
    if (!row) return null;
    if (!secretCache.has(row.secret_enc)) {
      let s = null;
      try {
        s = decryptSecret(loadKey(cfg.keyFile, { create: false }), row.secret_enc);
      } catch (err) {
        log?.error?.(`can't read the WooCommerce key file: ${err.message}`);
      }
      secretCache.set(row.secret_enc, s);
    }
    return secretCache.get(row.secret_enc);
  }
  const clientFor = (row) => createWooClient({ url: row.url, key: row.consumer_key, secret: secretOf(row), timeoutMs: cfg.timeoutMs, fetchImpl: ctx.fetchImpl });

  // ---- the store's own day ---------------------------------------------------------------------------
  const storeToday = (row, nowMs = clock()) => localDateIn(row?.time_zone ?? null, new Date(nowMs));

  // ---- checking a key ---------------------------------------------------------------------------------
  /**
   * Read the site the way the pulls and lookups will: its index (name, zone; is WooCommerce Analytics there?), its
   * currency, one day of Analytics → Revenue and one order id — so a key that can't do all of that is refused before
   * anything is saved. → { name, timeZone, currency }
   */
  async function verify({ url, key, secret }) {
    const client = createWooClient({ url, key, secret, timeoutMs: cfg.timeoutMs, fetchImpl: ctx.fetchImpl });
    const index = (await client.get('/wp-json/')).body;
    const ns = Array.isArray(index?.namespaces) ? index.namespaces : [];
    if (!ns.includes('wc/v3')) throw new WooError('not_woo', 'This site doesn’t answer like a WooCommerce store (no wc/v3 REST API): check the address');
    if (!ns.includes('wc-analytics')) throw new WooError('no_analytics', 'WooCommerce Analytics is off in this store: switch it on (WooCommerce → Settings → Advanced → Features), then try again');
    const currency = String((await client.get('/wp-json/wc/v3/data/currencies/current')).body?.code ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new WooError('bad_answer', 'The store didn’t say its currency');
    const timeZone = siteTimeZone(index);
    const yesterday = addDays(localDateIn(timeZone, new Date(clock())), -1);
    await client.get('/wp-json/wc-analytics/reports/revenue/stats', { interval: 'day', after: `${yesterday}T00:00:00`, before: `${yesterday}T23:59:59`, per_page: 1 });
    await client.get('/wp-json/wc/v3/orders', { per_page: 1, _fields: 'id' });
    return { name: String(index?.name ?? '').trim().slice(0, 120) || storeKey(url), timeZone, currency };
  }
  const asHttp = (err) => {
    if (!(err instanceof WooError)) return err;
    if (['bad_url', 'bad_key', 'bad_secret'].includes(err.code)) return refused(400, err.code, err.message);
    if (err.code === 'unauthorized') return refused(400, 'refused', `${err.message}: nothing was saved`);
    if (err.code === 'network' || err.code === 'timeout') return refused(502, 'unreachable', `${err.message}: nothing was saved`);
    return refused(502, err.code, `${err.message}: nothing was saved`);
  };

  // ---- the stores ---------------------------------------------------------------------------------------
  const businessOk = (id) => Boolean(id && crm?.getBusiness?.(id));

  /** Add a store: checked with real reads first; saved only when they all work. → storeInfo */
  async function addStore({ url, key, secret, businessId = BUSINESS_IDS.retail, name = null, readOnlyConfirmed = false }, { actor, deviceId = null }) {
    if (readOnlyConfirmed !== true) throw refused(400, 'confirm_read', 'Confirm that the key was made with permission “Read”: WooCommerce doesn’t tell the suite');
    let clean;
    let keys;
    try {
      clean = cleanStoreUrl(url);
      keys = parseKeys({ key, secret });
    } catch (err) {
      throw asHttp(err);
    }
    if (q.byUrl.get(clean, storeKey(clean))) throw refused(409, 'exists', 'This store is already connected: replace its key on its card instead');
    if (!businessOk(businessId)) throw refused(400, 'bad_business', 'Pick one of our businesses');
    let site;
    try {
      site = await verify({ url: clean, ...keys });
    } catch (err) {
      throw asHttp(err);
    }
    const id = newId();
    const when = at();
    const enc = encryptSecret(loadKey(cfg.keyFile), keys.secret);
    const row = {
      id, name: String(name ?? '').trim().slice(0, 120) || site.name, url: clean, store_key: storeKey(clean), consumer_key: keys.key, secret_enc: enc,
      business_id: businessId, currency: site.currency, time_zone: site.timeZone, position: q.maxPos.get().p + 1, at: when, actor, device: deviceId,
    };
    db.transaction(() => {
      q.insert.run(row);
      q.ensurePull.run(id);
      q.change.run(newId(), when, actor, deviceId, id, 'added', clean);
    })();
    secretCache.set(enc, keys.secret);
    sales.setStore({ source: 'woo', store: row.store_key, name: row.name, businessId, currency: site.currency, timeZone: site.timeZone });
    registerStore(q.store.get(id));
    log?.info?.(`WooCommerce store added by ${actor}: ${clean}`);
    pullStore(id, { force: true }).catch((err) => log?.error?.('the first WooCommerce pull failed:', err));
    return storeInfo(q.store.get(id));
  }

  /** A new key for a store (checked first). */
  async function replaceKey(id, { key, secret, readOnlyConfirmed = false }, { actor, deviceId = null }) {
    const row = mustStore(id);
    if (isPaused(row)) throw refused(409, 'paused', 'This store is switched off: switch it on, then replace the key');
    if (readOnlyConfirmed !== true) throw refused(400, 'confirm_read', 'Confirm that the key was made with permission “Read”');
    let keys;
    try {
      keys = parseKeys({ key, secret });
    } catch (err) {
      throw asHttp(err);
    }
    let site;
    try {
      site = await verify({ url: row.url, ...keys });
    } catch (err) {
      throw asHttp(err);
    }
    const enc = encryptSecret(loadKey(cfg.keyFile), keys.secret);
    db.transaction(() => {
      q.setKey.run(keys.key, enc, at(), id);
      q.setSite.run(site.currency, site.timeZone, id);
      q.change.run(newId(), at(), actor, deviceId, id, 'key_replaced', keys.key.slice(-7));
    })();
    secretCache.set(enc, keys.secret);
    pullStore(id, { force: true }).catch((err) => log?.error?.('WooCommerce pull failed:', err));
    return storeInfo(q.store.get(id));
  }

  /** Rename a store, or move it to another of our businesses (its totals follow). */
  function updateStore(id, { name, businessId } = {}, { actor, deviceId = null }) {
    const row = mustStore(id);
    db.transaction(() => {
      if (name !== undefined) {
        const n = String(name ?? '').trim().slice(0, 120);
        if (!n) throw refused(400, 'bad_name', 'Give the store a name');
        if (n !== row.name) {
          q.setName.run(n, id);
          q.change.run(newId(), at(), actor, deviceId, id, 'renamed', n);
        }
      }
      if (businessId !== undefined && businessId !== row.business_id) {
        if (!businessOk(businessId)) throw refused(400, 'bad_business', 'Pick one of our businesses');
        q.setBusiness.run(businessId, id);
        q.change.run(newId(), at(), actor, deviceId, id, 'business_changed', businessId);
      }
    })();
    const next = q.store.get(id);
    sales.setStore({ source: 'woo', store: next.store_key, name: next.name, businessId: next.business_id, currency: next.currency, timeZone: next.time_zone });
    return storeInfo(next);
  }

  /** Forget a store here (its totals stay in sales; adding it again carries on). Revoke the key in WooCommerce too. */
  function removeStore(id, { actor, deviceId = null }) {
    const row = mustStore(id);
    db.transaction(() => {
      q.remove.run(id);
      q.dropPull.run(id);
      q.change.run(newId(), at(), actor, deviceId, id, 'removed', row.url);
    })();
    connections.unregister(connectionId(id));
    handles.delete(id);
    log?.info?.(`WooCommerce store removed by ${actor}: ${row.url}`);
    return { removed: true, stores: listStores() };
  }

  function mustStore(id) {
    const row = typeof id === 'string' ? q.store.get(id) : null;
    if (!row) throw refused(404, 'not_found', 'No such store');
    return row;
  }

  // ---- pulls ---------------------------------------------------------------------------------------------
  /** Analytics → Revenue per day, from…to (store-local), every page. → Map<day, figures>, complete: true when all pages came. */
  async function readDays(client, from, to, { fresh = true } = {}) {
    const days = new Map();
    let page = 1;
    let pages = 1;
    do {
      const res = await client.get('/wp-json/wc-analytics/reports/revenue/stats', {
        interval: 'day', after: `${from}T00:00:00`, before: `${to}T23:59:59`, per_page: PER_PAGE, page, order: 'asc', orderby: 'date',
        // Analytics keeps answers in a cache for a while; the window wants today's refunds and status changes now.
        // Not for backfill chunks (review fix): those days don't change, and a cached answer is cheaper for the store.
        ...(fresh ? { force_cache_refresh: 'true' } : {}),
      });
      const intervals = Array.isArray(res.body?.intervals) ? res.body.intervals : null;
      if (!intervals) throw new WooError('bad_answer', 'The store’s Analytics answer had no days in it', { status: 200 });
      for (const iv of intervals) {
        const day = String(iv.interval ?? iv.date_start ?? '').slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= from && day <= to) days.set(day, figuresFrom(iv.subtotals));
      }
      pages = Number.parseInt(res.headers.totalPages, 10) || 1;
      page += 1;
    } while (page <= pages && page <= 50);
    // Every page came: a day Analytics left out had nothing in it.
    for (const d of daysBetween(from, to)) if (!days.has(d)) days.set(d, zeroFigures());
    return days;
  }

  const running = new Map(); // store id → promise (one pull per store at a time)
  /** One store's pull (never throws for the store's problems: they are recorded on its row). */
  function pullStore(id, opts = {}) {
    if (running.has(id)) return running.get(id);
    const p = doPull(id, opts).finally(() => running.delete(id));
    running.set(id, p);
    return p;
  }

  function due(row, pull, nowMs) {
    if (pull?.next_try_at && Date.parse(pull.next_try_at) > nowMs) return false;
    if (!pull?.last_success_at) return true;
    if (nowMs - Date.parse(pull.last_success_at) >= cfg.everyMinutes * MINUTE) return true;
    // A backfill that stopped part way: after its own backoff (the window doesn't wait for it, nor it for the window).
    return !pull.backfill_done_at && !(pull.backfill_next_try_at && Date.parse(pull.backfill_next_try_at) > nowMs);
  }

  async function doPull(id, { force = false } = {}) {
    const row = q.store.get(id);
    if (!row) return { skipped: 'gone' };
    if (isPaused(row)) return { skipped: 'paused' };
    q.ensurePull.run(id);
    const pull = q.pull.get(id);
    if (!force && !due(row, pull, clock())) return { skipped: 'not_due' };
    if (!secretOf(row)) {
      recordFailure(id, new WooError('unreadable', 'The key’s secret can’t be read on this machine (its key file is missing): replace the key'));
      return { failed: true };
    }
    const client = clientFor(row);
    try {
      // The currency and zone as the store says now (they rarely change; a change shows on the next pull).
      const index = (await client.get('/wp-json/')).body;
      const currency = String((await client.get('/wp-json/wc/v3/data/currencies/current')).body?.code ?? '').toUpperCase() || row.currency;
      const timeZone = siteTimeZone(index) ?? row.time_zone;
      if (currency !== row.currency || timeZone !== row.time_zone) q.setSite.run(currency, timeZone, id);
      const today = localDateIn(timeZone, new Date(clock()));
      const from = addDays(today, -(WINDOW_DAYS - 1));
      if (isPaused(row)) return { skipped: 'paused' };
      const days = await readDays(client, from, today);
      const live = q.store.get(id);
      if (!live) return { skipped: 'gone' };
      const put = (dayMap) => sales.putDays({
        source: 'woo', store: live.store_key, name: live.name, businessId: live.business_id, currency, timeZone,
        days: [...dayMap].map(([day, f]) => ({ day, ...f })), fetchedAt: at(),
      });
      put(days);
      q.pullOk.run({ id, at: at(), from, to: today });
      // The one-time backfill: BACKFILL_MONTHS back from the window, BACKFILL_CHUNK_DAYS at a time, newest first;
      // its progress is saved per chunk, so a failure (or a restart) carries on where it stopped.
      let p = q.pull.get(id);
      // A finished backfill with days missing (a restore from a backup older than the window, or totals removed by
      // hand) is read again: every day from the target to the window must have its row.
      if (p.backfill_done_at && p.backfill_target && p.backfill_target < from) {
        const want = daysBetween(p.backfill_target, addDays(from, -1)).length;
        if (sales.dayCount({ source: 'woo', store: live.store_key, from: p.backfill_target, to: addDays(from, -1) }) < want) {
          q.backfillReset.run(id);
          p = q.pull.get(id);
        }
      }
      const target = p.backfill_target ?? addMonths(today, -BACKFILL_MONTHS);
      // Fixed at the first pull (review fix): a backfill that waits a day for a slow store still reads the same days.
      if (!p.backfill_done_at && !p.backfill_target) {
        q.backfill.run(p.backfill_before ?? from, target, null, id);
        p = q.pull.get(id);
      }
      let before = p.backfill_before ?? from;
      let chunks = 0;
      let backfillError = null;
      const backfillWaits = p.backfill_next_try_at && Date.parse(p.backfill_next_try_at) > clock();
      let chunkDays = p.backfill_chunk_days ?? BACKFILL_CHUNK_DAYS;
      while (!p.backfill_done_at && before > target && !backfillWaits) {
        if (isPaused(row)) break;
        const chunkFrom = [addDays(before, -chunkDays), target].sort().at(-1);
        const chunkTo = addDays(before, -1);
        // The backfill's failures are its own (review fix): recorded apart, with their own backoff, and a time-out
        // halves the chunk (down to MIN_CHUNK_DAYS) — the window read above has succeeded and stays the store's state.
        try {
          put(await readDays(client, chunkFrom, chunkTo, { fresh: false }));
        } catch (err) {
          if (!(err instanceof WooError)) throw err;
          if (err.code === 'timeout') chunkDays = Math.max(MIN_CHUNK_DAYS, Math.floor(chunkDays / 2));
          const failures = (q.pull.get(id)?.backfill_failures ?? 0) + 1;
          q.backfillFail.run({ id, error: String(err.message).slice(0, 500), at: at(), next: new Date(clock() + backoffMs(failures)).toISOString(), chunk: chunkDays });
          log?.warn?.(`WooCommerce ${row.url}: backfill ${chunkFrom}…${chunkTo}: ${err.message}`);
          backfillError = err.message;
          break;
        }
        before = chunkFrom;
        chunks += 1;
        q.backfillOk.run(id);
        q.backfill.run(before, target, before <= target ? at() : null, id);
        p = q.pull.get(id);
      }
      if (!backfillError && !p.backfill_done_at && before <= target) q.backfill.run(before, target, at(), id);
      if (backfillError) return { ok: true, window: { from, to: today }, backfillChunks: chunks, backfillError };
      return { ok: true, window: { from, to: today }, backfillChunks: chunks };
    } catch (err) {
      if (!(err instanceof WooError)) log?.error?.(`WooCommerce ${row.url}: unexpected error`, err);
      else log?.warn?.(`WooCommerce ${row.url}: ${err.message}`);
      recordFailure(id, err);
      return { failed: true, error: err.message };
    }
  }

  function recordFailure(id, err) {
    q.ensurePull.run(id);
    const failures = (q.pull.get(id)?.failures ?? 0) + 1;
    const nowMs = clock();
    q.pullFail.run({ id, at: nowIso(new Date(nowMs)), error: String(err?.message ?? err).slice(0, 500), next: new Date(nowMs + backoffMs(failures)).toISOString() });
  }

  /** Every store that is due, side by side: one store's failures (or slowness) never hold up another's. */
  async function pullRound({ force = false } = {}) {
    const stores = q.stores.all();
    const results = await Promise.allSettled(stores.map((s) => pullStore(s.id, { force })));
    return Object.fromEntries(stores.map((s, i) => [s.id, results[i].status === 'fulfilled' ? results[i].value : { failed: true }]));
  }

  /** The pull loop (production): one look a minute; calls only when a store is due. → stop() */
  function startPuller({ everyMs = LOOK_EVERY_MS, firstMs = FIRST_LOOK_MS } = {}) {
    const look = () => pullRound().catch((err) => log?.error?.('WooCommerce pulls failed (tried again later):', err));
    const first = setTimeout(look, firstMs);
    const timer = setInterval(look, everyMs);
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  /** "Pull now" on a store's card. */
  async function pullNow(id) {
    const row = mustStore(id);
    if (isPaused(row)) throw refused(409, 'paused', 'This store is switched off: switch it on to read it');
    const result = await pullStore(id, { force: true });
    return { result, store: storeInfo(q.store.get(id)) };
  }

  // ---- order lookups (live; never stored, never logged) ------------------------------------------------
  /**
   * Find orders by number or by the customer's email, in the store, now. Only orders whose number (or email) is exactly
   * the one asked for come back (a search's other hits are dropped), at most LOOKUP_LIMIT, each as orderView (first
   * name only). Nothing is kept or logged. → { orders }
   */
  async function lookup(id, { number = null, email = null } = {}) {
    const row = mustStore(id);
    if (isPaused(row)) throw refused(409, 'paused', 'This store is switched off: switch it on to look up orders');
    const n = String(number ?? '').trim().replace(/^#/, '');
    const e = String(email ?? '').trim().toLowerCase();
    if (!n && !e) throw refused(400, 'bad_query', 'Give an order number or an email');
    if (n && !/^[A-Za-z0-9-]{1,30}$/.test(n)) throw refused(400, 'bad_query', 'An order number is letters, digits and dashes');
    if (!n && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw refused(400, 'bad_query', 'That isn’t an email');
    if (!secretOf(row)) throw refused(409, 'unreadable', 'The key’s secret can’t be read on this machine: replace the key');
    const client = clientFor(row);
    try {
      let found = [];
      if (n) {
        if (/^\d+$/.test(n)) {
          try {
            const one = (await client.get(`/wp-json/wc/v3/orders/${n}`)).body;
            if (one && String(one.number ?? one.id) === n) found = [one];
          } catch (err) {
            if (!(err instanceof WooError) || err.status !== 404) throw err;
          }
        }
        if (!found.length) {
          const list = (await client.get('/wp-json/wc/v3/orders', { search: n, per_page: 20 })).body;
          found = (Array.isArray(list) ? list : []).filter((o) => String(o.number ?? o.id) === n);
        }
      } else {
        const list = (await client.get('/wp-json/wc/v3/orders', { search: e, per_page: 20, orderby: 'date', order: 'desc' })).body;
        found = (Array.isArray(list) ? list : []).filter((o) => String(o.billing?.email ?? '').trim().toLowerCase() === e);
      }
      const orders = [];
      for (const o of found.slice(0, LOOKUP_LIMIT)) {
        let tracking = [];
        try {
          const shipments = (await client.get(`/wp-json/wc-shipment-tracking/v3/orders/${Number(o.id)}/shipments`)).body;
          tracking = (Array.isArray(shipments) ? shipments : []).map((s) => ({
            provider: s.tracking_provider || s.custom_tracking_provider || null, number: s.tracking_number ? String(s.tracking_number).slice(0, 80) : null,
            url: /^https:\/\//.test(s.tracking_link ?? '') ? s.tracking_link : null, shippedOn: s.date_shipped || null,
          })).filter((t) => t.number);
        } catch {
          tracking = []; // no tracking plugin (404), or it failed: the order still shows
        }
        orders.push(orderView(o, tracking));
      }
      return { orders, more: found.length > LOOKUP_LIMIT };
    } catch (err) {
      if (err instanceof WooError) throw refused(err.code === 'unauthorized' ? 400 : 502, err.code, err.message);
      throw err;
    }
  }

  // ---- what the page and the Connections rows show ------------------------------------------------------
  const isPaused = (row) => connections.isPaused(connectionId(row.id));
  function storeInfo(row) {
    const p = q.pull.get(row.id) ?? {};
    return {
      id: row.id, connectionId: connectionId(row.id), name: row.name, url: row.url, storeKey: row.store_key,
      keyEnd: row.consumer_key.slice(-7), businessId: row.business_id, currency: row.currency, timeZone: row.time_zone,
      readOnlyConfirmed: row.read_only_confirmed === 1, addedAt: row.added_at, addedBy: row.added_by, keySetAt: row.key_set_at,
      readable: secretOf(row) !== null, paused: isPaused(row), today: storeToday(row),
      lastSuccessAt: p.last_success_at ?? null, lastAttemptAt: p.last_attempt_at ?? null, lastErrorAt: p.last_error_at ?? null,
      lastError: p.last_error ?? null, failures: p.failures ?? 0, nextTryAt: p.next_try_at ?? null,
      window: p.window_from ? { from: p.window_from, to: p.window_to } : null,
      backfill: {
        before: p.backfill_before ?? null, target: p.backfill_target ?? null, doneAt: p.backfill_done_at ?? null,
        error: p.backfill_error ?? null, errorAt: p.backfill_error_at ?? null, failures: p.backfill_failures ?? 0,
        nextTryAt: p.backfill_next_try_at ?? null, chunkDays: p.backfill_chunk_days ?? BACKFILL_CHUNK_DAYS,
      },
      changes: q.changes.all(row.id),
    };
  }
  const listStores = () => q.stores.all().map(storeInfo);

  function describeStore(id) {
    const row = q.store.get(id);
    if (!row) return { queueLabel: 'Removed' };
    const s = storeInfo(row);
    const backfill = s.backfill.doneAt ? `${BACKFILL_MONTHS} months read` : s.backfill.before ? `reading back to ${s.backfill.target}` : 'Not read yet';
    return {
      lastSuccessAt: s.lastSuccessAt, lastErrorAt: s.failures ? s.lastErrorAt : null, lastError: s.failures ? s.lastError : null,
      queueSize: null,
      queueLabel: s.lastSuccessAt ? `Totals to ${s.window?.to ?? '—'} · ${backfill}` : backfill,
      // The card's panel shows the address, key and zone; a backfill problem shows here, apart from the window's state.
      detail: s.backfill.error && !s.backfill.doneAt ? `Backfill: ${s.backfill.error} (tried again ${s.backfill.nextTryAt ? `after ${s.backfill.nextTryAt.slice(11, 16)} UTC` : 'later'}, ${s.backfill.chunkDays} days at a time)` : null,
    };
  }

  const handles = new Map();
  function registerStore(row) {
    const cid = connectionId(row.id);
    handles.set(row.id, connections.register({
      id: cid,
      name: `${row.name} (WooCommerce)`,
      module: 'woocommerce',
      description: 'Daily sales totals (Analytics → Revenue) and order lookups, read with this store’s read-only key. Nothing is changed in the store.',
      after: HUB_ID,
      describe: () => describeStore(row.id),
      pause() { log?.info?.(`paused: no calls to ${row.url}`); },
      resume() { pullStore(row.id, { force: true }).catch((err) => log?.error?.('WooCommerce pull failed:', err)); },
    }));
  }

  connections.register({
    id: HUB_ID,
    name: 'WooCommerce stores',
    module: 'woocommerce',
    description: 'The retail stores’ sales totals and order lookups, each read with its own read-only REST key. Add a store here; each store then has its own row and switch.',
    pausable: false,
    alwaysOnReason: 'This row only adds stores: each store below has its own switch.',
    describe: () => {
      const n = q.stores.all().length;
      return { queueLabel: n ? `${n} store${n === 1 ? '' : 's'}` : 'No stores yet', detail: null };
    },
  });
  for (const row of q.stores.all()) registerStore(row);

  sales.registerSource({
    source: 'woo',
    label: 'WooCommerce',
    stores: () => q.stores.all().map((row) => {
      const s = storeInfo(row);
      return {
        store: row.store_key, name: row.name, businessId: row.business_id, currency: row.currency, timeZone: row.time_zone,
        state: s.paused ? 'paused' : !s.readable ? 'unreadable' : s.failures ? 'failing' : s.lastSuccessAt ? 'on' : 'not_read',
        lastSuccessAt: s.lastSuccessAt, lastError: s.failures ? s.lastError : null, link: `/costs/sales/woo/${row.id}`,
      };
    }),
  });

  return { addStore, replaceKey, updateStore, removeStore, listStores, store: (id) => storeInfo(mustStore(id)), pullStore, pullRound, pullNow, startPuller, lookup, verify };
}
