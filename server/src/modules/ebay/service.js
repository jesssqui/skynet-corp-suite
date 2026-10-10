// eBay (D13): Save Point Shop's eBay account — the seller signs in once (OAuth authorization code grant, scope
// sell.fulfillment.readonly), and the suite reads its orders on a schedule: daily sales totals into the sales module
// (source 'ebay'), and the orders waiting to ship (for the ship tasks; no buyer details). Nothing is ever changed on
// eBay (client.js: getOrders GETs and the token endpoint's POST only).
//
//   keyset      App ID, Cert ID and RuName from eBay's developer site (Application Keys, Production; User Tokens →
//               the RuName), entered on System → Connections → eBay. The Cert ID is sealed (AES-256-GCM with the key file
//               config.ebay.keyFile, ../../lib/sealed.js); the App ID and RuName are not secret (they are in the consent
//               page's address) and are kept as they are.
//   sign-in     "Sign in to eBay" → a random `state` (only its SHA-256 kept, 30 minutes, once) → eBay's consent page →
//               eBay sends the browser to the RuName's accept URL with `code` and `state`: either the suite's own page
//               /ebay/accepted (when the accept URL is set to the suite's ts.net address), which posts them here, or —
//               no inbound route needed — the person copies the address eBay showed and pastes it on the card. Either
//               way the state is checked, the code is exchanged at the token endpoint, the refresh token (~18 months) is
//               sealed with its expiry, and the access token (2 hours) is kept in memory only.
//   pulls       hourly (config.ebay.everyMinutes): getOrders created in the last WINDOW_DAYS days + those modified since
//               then (refunds and cancellations of older orders), fieldGroups=TAX_BREAKDOWN, 200 a page; the first pull
//               reads back to the 1st of the month BACKFILL_MONTHS months ago. Days are counted in the shop's zone
//               (time_zone, America/Toronto by default) and written with sales.putDays (upserts: nothing counted twice).
//   ship        orders created in the window that are waiting to ship (NOT_STARTED | IN_PROGRESS, not cancelled, paid)
//               are kept in ebay_ship_orders — order id, items, total, ship-by; never the buyer — for the automations.
//   Connections the 'ebay' row (pausable: no calls at all while off; failures back off 2, 4 … 60 minutes).
import crypto from 'node:crypto';
import { newId } from '@suite/shared/ids';
import { nowIso } from '@suite/shared/time';
import { addDays, monthStart } from '@suite/shared/planner';
import { addMonths, BUSINESS_IDS } from '@suite/shared/crm';
import { localDateIn } from '@suite/shared/sales';
import { HttpError } from '../../lib/httpError.js';
import { loadKey, encryptSecret, decryptSecret } from '../../lib/sealed.js';
import { createEbayClient, parseKeyset, consentUrl, codeFromUrl, EbayError, SCOPES } from './client.js';
import { dayRows, zoneMidnightUtc, waitingToShip, shipView } from './figures.js';
import { registerEbayAutomations, PULLED_EVENT } from './automations.js';

export const CONNECTION_ID = 'ebay';
/** The eBay store's key in the sales tables (and the target of months entered by hand). */
export const STORE = 'ebay';
const SAVE_POINT = BUSINESS_IDS.save_point;
const MINUTE = 60_000;
/** Each pull re-reads the orders created in the last WINDOW_DAYS days (and those modified since then). */
export const WINDOW_DAYS = 90;
/** The first pull reads back to the 1st of the month this many months ago (getOrders goes back two years at most). */
export const BACKFILL_MONTHS = 13;
const PAGE = 200; // getOrders' maximum
const MAX_PAGES = 200;
const STATE_MINUTES = 30;
const ACCESS_MARGIN_MS = 5 * MINUTE;
export const LOOK_EVERY_MS = MINUTE;
export const FIRST_LOOK_MS = 40_000;
export const backoffMs = (failures) => Math.min(2 ** Math.max(1, failures), 60) * MINUTE;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ZONE_OK = (z) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

export function createEbayService(ctx) {
  const { db, config, log, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const { connections, sales, automations, planner } = services;
  if (!connections || !sales) throw new Error('ebay needs the connections and sales modules registered before it');
  const cfg = config.ebay;
  const at = () => nowIso(new Date(clock()));
  const refused = (status, code, message) => new HttpError(status, message, undefined, { code });

  const q = {
    conn: db.prepare('SELECT * FROM ebay_connection WHERE id = 1'),
    putKeyset: db.prepare(`INSERT INTO ebay_connection (id, app_id, cert_enc, ru_name, time_zone, currency, keyset_set_at, keyset_set_by)
      VALUES (1, @app_id, @cert_enc, @ru_name, @time_zone, @currency, @at, @actor)
      ON CONFLICT (id) DO UPDATE SET app_id = excluded.app_id, cert_enc = excluded.cert_enc, ru_name = excluded.ru_name,
      keyset_set_at = excluded.keyset_set_at, keyset_set_by = excluded.keyset_set_by,
      refresh_enc = NULL, refresh_expires_at = NULL, scopes = NULL, signed_in_at = NULL, signed_in_by = NULL, signed_out_at = NULL, signed_out_reason = NULL`),
    signedIn: db.prepare(`UPDATE ebay_connection SET refresh_enc = @enc, refresh_expires_at = @expires, scopes = @scopes, signed_in_at = @at,
      signed_in_by = @actor, signed_out_at = NULL, signed_out_reason = NULL WHERE id = 1`),
    signedOut: db.prepare('UPDATE ebay_connection SET refresh_enc = NULL, signed_out_at = ?, signed_out_reason = ? WHERE id = 1'),
    account: db.prepare('UPDATE ebay_connection SET account = ? WHERE id = 1'),
    settings: db.prepare('UPDATE ebay_connection SET time_zone = ? WHERE id = 1'),
    forget: db.prepare('DELETE FROM ebay_connection'),
    change: db.prepare('INSERT INTO ebay_changes (id, at, actor, device_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)'),
    changes: db.prepare('SELECT at, actor, device_id AS deviceId, action, detail FROM ebay_changes ORDER BY at DESC, id DESC LIMIT 10'),
    putState: db.prepare('INSERT INTO ebay_sign_ins (state_hash, actor, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    state: db.prepare('SELECT * FROM ebay_sign_ins WHERE state_hash = ?'),
    useState: db.prepare('UPDATE ebay_sign_ins SET used_at = ? WHERE state_hash = ? AND used_at IS NULL'),
    pruneStates: db.prepare('DELETE FROM ebay_sign_ins WHERE expires_at < ?'),
    pull: db.prepare('SELECT * FROM ebay_pulls WHERE id = 1'),
    ensurePull: db.prepare('INSERT INTO ebay_pulls (id) VALUES (1) ON CONFLICT (id) DO NOTHING'),
    pullOk: db.prepare(`UPDATE ebay_pulls SET last_success_at = @at, last_attempt_at = @at, failures = 0, next_try_at = NULL, last_error = NULL,
      window_from = @from, window_to = @to, currencies = @currencies, orders_read = @n WHERE id = 1`),
    pullFail: db.prepare(`UPDATE ebay_pulls SET last_attempt_at = @at, last_error_at = @at, last_error = @error, failures = failures + 1,
      next_try_at = @next WHERE id = 1`),
    backfill: db.prepare('UPDATE ebay_pulls SET backfill_from = ?, backfill_done_at = ? WHERE id = 1'),
    resetPull: db.prepare('DELETE FROM ebay_pulls'),
    putShip: db.prepare(`INSERT INTO ebay_ship_orders (order_id, created_at, status, cancel_state, payment_status, ship_by, total, currency, items, waiting, seen_at)
      VALUES (@orderId, @createdAt, @status, @cancelState, @paymentStatus, @shipBy, @total, @currency, @items, @waiting, @seen)
      ON CONFLICT (order_id) DO UPDATE SET status = excluded.status, cancel_state = excluded.cancel_state, payment_status = excluded.payment_status,
      ship_by = excluded.ship_by, total = excluded.total, currency = excluded.currency, items = excluded.items, waiting = excluded.waiting, seen_at = excluded.seen_at`),
    staleShip: db.prepare('UPDATE ebay_ship_orders SET waiting = 0 WHERE waiting = 1 AND seen_at < ?'),
    pruneShip: db.prepare('DELETE FROM ebay_ship_orders WHERE waiting = 0 AND seen_at < ?'),
    waiting: db.prepare('SELECT * FROM ebay_ship_orders WHERE waiting = 1 ORDER BY ship_by, order_id'),
    shipOrder: db.prepare('SELECT * FROM ebay_ship_orders WHERE order_id = ?'),
    clearShip: db.prepare('DELETE FROM ebay_ship_orders'),
  };

  // ---- secrets and tokens --------------------------------------------------------------------------
  const sealedCache = new Map();
  function unseal(enc) {
    if (!enc) return null;
    if (!sealedCache.has(enc)) {
      let v = null;
      try {
        v = decryptSecret(loadKey(cfg.keyFile, { create: false }), enc);
      } catch (err) {
        log?.error?.(`can't read the eBay key file: ${err.message}`);
      }
      sealedCache.set(enc, v);
    }
    return sealedCache.get(enc);
  }
  const seal = (text) => {
    const enc = encryptSecret(loadKey(cfg.keyFile), text);
    sealedCache.set(enc, text);
    return enc;
  };
  let access = null; // { token, expiresAtMs, refreshEnc } — memory only
  const clientFor = (row) => createEbayClient({ apiUrl: cfg.apiUrl, appId: row.app_id, certId: unseal(row.cert_enc), timeoutMs: cfg.timeoutMs, fetchImpl: ctx.fetchImpl });
  const readable = (row) => Boolean(row && unseal(row.cert_enc) && (!row.refresh_enc || unseal(row.refresh_enc)));
  const isPaused = () => connections.isPaused(CONNECTION_ID);
  const timeZone = () => q.conn.get()?.time_zone ?? cfg.timeZone;

  function markSignedOut(reason) {
    const when = at();
    db.transaction(() => {
      q.signedOut.run(when, reason);
      q.change.run(newId(), when, 'system', null, 'signed_out', reason);
    })();
    access = null;
    log?.warn?.(`eBay stopped accepting the sign-in: ${reason}`);
  }

  /** A good access token: the one in memory while it has 5+ minutes, else a new one from the refresh token. */
  async function accessToken(row, { fresh = false } = {}) {
    if (!fresh && access && access.refreshEnc === row.refresh_enc && access.expiresAtMs - clock() > ACCESS_MARGIN_MS) return access.token;
    const refresh = unseal(row.refresh_enc);
    if (!refresh) throw new EbayError('not_signed_in', 'Not signed in to eBay');
    let body;
    try {
      body = await clientFor(row).token({ grant_type: 'refresh_token', refresh_token: refresh, scope: (row.scopes ?? SCOPES.join(' ')) });
    } catch (err) {
      if (err instanceof EbayError && err.code === 'invalid_grant') markSignedOut('eBay refused the sign-in (it lapsed or was taken back)');
      throw err;
    }
    if (!body.access_token) throw new EbayError('bad_answer', 'eBay’s token answer had no access token');
    access = { token: body.access_token, expiresAtMs: clock() + (Number(body.expires_in) || 7200) * 1000, refreshEnc: row.refresh_enc };
    return access.token;
  }

  /** getOrders, every page (a 401 refreshes the access token once). */
  async function readOrders(row, filter) {
    const client = clientFor(row);
    const out = [];
    let offset = 0;
    let retried = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let body;
      try {
        body = await client.orders(await accessToken(row), { filter, limit: PAGE, offset, fieldGroups: 'TAX_BREAKDOWN' });
      } catch (err) {
        if (err instanceof EbayError && err.code === 'unauthorized' && !retried) {
          retried = true;
          access = null;
          page -= 1;
          continue;
        }
        throw err;
      }
      const orders = Array.isArray(body.orders) ? body.orders : [];
      out.push(...orders);
      offset += orders.length;
      const total = Number(body.total);
      if (!orders.length || !(Number.isFinite(total) ? offset < total : Boolean(body.next))) break;
    }
    return out;
  }

  // ---- the keyset and the sign-in -------------------------------------------------------------------
  /** Save the keyset (App ID, Cert ID, RuName). A new keyset ends any sign-in (a refresh token belongs to its App ID). */
  function setKeyset({ appId, certId, ruName }, { actor, deviceId = null }) {
    let ks;
    try {
      ks = parseKeyset({ appId, certId, ruName });
    } catch (err) {
      throw refused(400, err.code, err.message);
    }
    const when = at();
    const before = q.conn.get();
    db.transaction(() => {
      q.putKeyset.run({ app_id: ks.appId, cert_enc: seal(ks.certId), ru_name: ks.ruName, time_zone: before?.time_zone ?? cfg.timeZone, currency: before?.currency ?? 'CAD', at: when, actor });
      q.change.run(newId(), when, actor, deviceId, 'keyset_set', ks.appId);
    })();
    access = null;
    return info();
  }

  /** Start a sign-in: the consent page's address, with a fresh state (30 minutes, once). */
  function startSignIn({ actor, deviceId = null }) {
    const row = q.conn.get();
    if (!row) throw refused(409, 'not_set_up', 'Enter the App ID, Cert ID and RuName first');
    if (isPaused()) throw refused(409, 'paused', 'eBay is switched off on Connections: switch it on to sign in');
    const state = crypto.randomBytes(32).toString('base64url');
    const now = clock();
    q.pruneStates.run(nowIso(new Date(now)));
    q.putState.run(hash(state), actor, deviceId, nowIso(new Date(now)), nowIso(new Date(now + STATE_MINUTES * MINUTE)));
    return { url: consentUrl({ authUrl: cfg.authUrl, appId: row.app_id, ruName: row.ru_name, state }), expiresAt: nowIso(new Date(now + STATE_MINUTES * MINUTE)) };
  }

  /**
   * Finish a sign-in with what eBay sent back — { code, state }, or { url } (the address eBay showed, pasted): the state
   * must be one made here, unused and fresh; the code is exchanged; the refresh token sealed; a first read checks it.
   */
  async function finishSignIn({ code = null, state = null, url = null } = {}, { actor, deviceId = null }) {
    const row = q.conn.get();
    if (!row) throw refused(409, 'not_set_up', 'Enter the App ID, Cert ID and RuName first');
    if (isPaused()) throw refused(409, 'paused', 'eBay is switched off on Connections');
    let got = code && state ? { code: String(code), state: String(state) } : codeFromUrl(url);
    if (!got) {
      if (url && /isAuthSuccessful=false|error=access_denied/i.test(String(url))) throw refused(400, 'declined', 'eBay says the sign-in wasn’t agreed to: nothing changed');
      throw refused(400, 'no_code', 'That address has no code from eBay in it: copy the whole address eBay showed after “I agree”');
    }
    const st = q.state.get(hash(got.state));
    if (!st || st.used_at || Date.parse(st.expires_at) < clock()) {
      throw refused(400, 'bad_state', 'That sign-in didn’t start here, was used already or is too old: start again with “Sign in to eBay”');
    }
    if (q.useState.run(nowIso(new Date(clock())), hash(got.state)).changes !== 1) throw refused(400, 'bad_state', 'That sign-in was used already');
    if (!unseal(row.cert_enc)) throw refused(409, 'unreadable', 'The Cert ID can’t be read on this server (its key file is missing): enter the keyset again');
    let body;
    try {
      body = await clientFor(row).token({ grant_type: 'authorization_code', code: got.code, redirect_uri: row.ru_name });
    } catch (err) {
      if (err instanceof EbayError) {
        if (err.code === 'invalid_grant') throw refused(400, 'code_refused', 'eBay refused the code (it lasts about 5 minutes and works once): sign in again');
        if (err.code === 'bad_keyset') throw refused(400, 'bad_keyset', err.message);
        throw refused(502, err.code, `${err.message}: nothing was saved`);
      }
      throw err;
    }
    if (!body.refresh_token || !body.access_token) throw refused(502, 'bad_answer', 'eBay’s answer had no tokens: nothing was saved');
    const now = clock();
    const enc = seal(body.refresh_token);
    const expires = nowIso(new Date(now + (Number(body.refresh_token_expires_in) || 47_304_000) * 1000));
    db.transaction(() => {
      q.signedIn.run({ enc, expires, scopes: SCOPES.join(' '), at: nowIso(new Date(now)), actor });
      q.change.run(newId(), nowIso(new Date(now)), actor, deviceId, 'signed_in', `until ${expires.slice(0, 10)}`);
    })();
    access = { token: body.access_token, expiresAtMs: now + (Number(body.expires_in) || 7200) * 1000, refreshEnc: enc };
    // A first read: the account's name, and that orders can be read with this sign-in.
    try {
      const first = await clientFor(q.conn.get()).orders(access.token, { limit: 1 });
      const seller = first?.orders?.[0]?.sellerId;
      if (seller) q.account.run(String(seller).slice(0, 80));
    } catch (err) {
      log?.warn?.(`eBay: the first read after signing in failed: ${err.message}`);
    }
    pull({ force: true }).catch((err) => log?.error?.('the first eBay pull failed:', err));
    return info();
  }

  /** Change the zone the shop's days are counted in (the backfill is read again, in the new zone). */
  function updateSettings({ timeZone: zone }, { actor, deviceId = null }) {
    const row = q.conn.get();
    if (!row) throw refused(409, 'not_set_up', 'Set up eBay first');
    if (zone !== undefined) {
      const z = String(zone ?? '').trim();
      if (!z || !ZONE_OK(z)) throw refused(400, 'bad_zone', 'Not a time zone (like America/Toronto)');
      if (z !== row.time_zone) {
        db.transaction(() => {
          q.settings.run(z);
          q.ensurePull.run();
          q.backfill.run(null, null);
          q.change.run(newId(), at(), actor, deviceId, 'settings', `time zone ${z}`);
        })();
      }
    }
    return info();
  }

  /** Forget the eBay connection here (keyset, sign-in, pull state, orders waiting): totals and tasks stay. */
  function forget({ actor, deviceId = null }) {
    db.transaction(() => {
      q.forget.run();
      q.resetPull.run();
      q.clearShip.run();
      q.change.run(newId(), at(), actor, deviceId, 'forgotten', null);
    })();
    access = null;
    return info();
  }

  // ---- pulls ------------------------------------------------------------------------------------------
  /**
   * The store's key in sales_daily (review fix): one constant per connection — 'ebay' for the account's main currency,
   * 'ebay <CUR>' for another — never the seller's username, which eBay lets a seller change (the new name would have
   * started a second set of days beside the first). The username is shown as a label only (`account`). Months entered
   * by hand use the same key ('ebay').
   */
  const storeKey = (row, currency) => (!currency || currency === (row?.currency ?? 'CAD') ? STORE : `${STORE} ${currency}`);
  const cardName = (currency, main) => (currency === main ? 'Save Point Shop (eBay)' : `Save Point Shop (eBay, ${currency})`);
  let running = null;
  function pull(opts = {}) {
    if (running) return running;
    running = doPull(opts).finally(() => { running = null; });
    return running;
  }
  function due(p, nowMs) {
    if (p?.next_try_at && Date.parse(p.next_try_at) > nowMs) return false;
    if (!p?.last_success_at || !p.backfill_done_at) return true;
    return nowMs - Date.parse(p.last_success_at) >= cfg.everyMinutes * MINUTE;
  }
  const signedIn = (row) => Boolean(row?.refresh_enc && !row.signed_out_at);

  async function doPull({ force = false } = {}) {
    let row = q.conn.get();
    if (!row) return { skipped: 'not_set_up' };
    if (!signedIn(row)) return { skipped: 'not_signed_in' };
    if (isPaused()) return { skipped: 'paused' };
    q.ensurePull.run();
    let p = q.pull.get();
    if (!force && !due(p, clock())) return { skipped: 'not_due' };
    if (!readable(row)) {
      recordFailure(new EbayError('unreadable', 'The Cert ID or sign-in can’t be read on this server (its key file is missing): enter the keyset and sign in again'));
      return { failed: true };
    }
    try {
      const tz = row.time_zone;
      const today = localDateIn(tz, new Date(clock()));
      const target = monthStart(addMonths(today, -BACKFILL_MONTHS));
      const windowFrom = addDays(today, -(WINDOW_DAYS - 1));
      // A finished backfill with days missing (a restore of an older backup) is read again.
      if (p.backfill_done_at && p.backfill_from && p.backfill_from < windowFrom) {
        const want = Math.round((Date.parse(`${windowFrom}T00:00:00Z`) - Date.parse(`${p.backfill_from}T00:00:00Z`)) / 86_400_000);
        if (sales.dayCount({ source: 'ebay', store: storeKey(row, row.currency), from: p.backfill_from, to: addDays(windowFrom, -1) }) < want) {
          q.backfill.run(null, null);
          p = q.pull.get();
        }
      }
      const from = p.backfill_done_at ? windowFrom : target;
      const since = zoneMidnightUtc(from, tz).toISOString();
      const created = await readOrders(row, `creationdate:[${since}..]`);
      if (isPaused()) return { skipped: 'paused' };
      const modified = await readOrders(row, `lastmodifieddate:[${since}..]`);
      const byId = new Map();
      for (const o of [...created, ...modified]) {
        const prev = byId.get(o.orderId);
        if (!prev || String(o.lastModifiedDate ?? '') >= String(prev.lastModifiedDate ?? '')) byId.set(o.orderId, o);
      }
      const orders = [...byId.values()];
      row = q.conn.get();
      if (!row || !signedIn(row)) return { skipped: 'gone' };
      const seller = orders.find((o) => o.sellerId)?.sellerId;
      if (seller && seller !== row.account) {
        q.account.run(String(seller).slice(0, 80));
        row = q.conn.get();
      }
      const known = JSON.parse(p.currencies ?? '[]');
      const currencies = [...new Set([row.currency, ...known])];
      const rows = dayRows(orders, { from, to: today, timeZone: tz, currencies });
      const fetchedAt = at();
      for (const [currency, days] of rows) {
        sales.putDays({
          source: 'ebay', store: storeKey(row, currency), name: cardName(currency, row.currency), businessId: SAVE_POINT, currency, timeZone: tz,
          days: [...days].map(([day, f]) => ({ day, ...f })), fetchedAt,
        });
      }
      // The orders waiting to ship (created in the last WINDOW_DAYS days), and those that stopped waiting.
      const shipFrom = zoneMidnightUtc(windowFrom, tz).toISOString();
      db.transaction(() => {
        for (const o of orders) {
          if (!o.orderId || String(o.creationDate ?? '') < shipFrom) continue;
          const v = shipView(o);
          q.putShip.run({ ...v, items: JSON.stringify(v.items), waiting: waitingToShip(o) ? 1 : 0, seen: fetchedAt });
        }
        q.staleShip.run(fetchedAt);
        q.pruneShip.run(nowIso(new Date(clock() - 120 * 86_400_000)));
        q.pullOk.run({ at: fetchedAt, from, to: today, currencies: JSON.stringify([...rows.keys()]), n: orders.length });
        if (!p.backfill_done_at) q.backfill.run(target, fetchedAt);
      })();
      automations?.emit?.(PULLED_EVENT, { key: newId() });
      return { ok: true, window: { from, to: today }, orders: orders.length };
    } catch (err) {
      if (!(err instanceof EbayError)) log?.error?.('eBay: unexpected error', err);
      else log?.warn?.(`eBay: ${err.message}`);
      recordFailure(err);
      return { failed: true, error: err.message };
    }
  }
  function recordFailure(err) {
    q.ensurePull.run();
    const failures = (q.pull.get()?.failures ?? 0) + 1;
    const nowMs = clock();
    q.pullFail.run({ at: nowIso(new Date(nowMs)), error: String(err?.message ?? err).slice(0, 500), next: new Date(nowMs + backoffMs(failures)).toISOString() });
  }

  /** "Pull now" on the card. */
  async function pullNow() {
    const row = q.conn.get();
    if (!row) throw refused(409, 'not_set_up', 'eBay isn’t set up');
    if (!signedIn(row)) throw refused(409, 'not_signed_in', 'Sign in to eBay first');
    if (isPaused()) throw refused(409, 'paused', 'eBay is switched off on Connections: switch it on to read it');
    return { result: await pull({ force: true }), connection: info() };
  }

  /** The pull loop (production): one look a minute; calls only when due. → stop() */
  function startPuller({ everyMs = LOOK_EVERY_MS, firstMs = FIRST_LOOK_MS } = {}) {
    const look = () => pull().catch((err) => log?.error?.('eBay pull failed (tried again later):', err));
    const first = setTimeout(look, firstMs);
    const timer = setInterval(look, everyMs);
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  // ---- what the card, the Connections row and the Sales page show ----------------------------------------------
  function state(row = q.conn.get(), p = q.pull.get()) {
    if (!row) return 'not_set_up';
    if (isPaused()) return 'paused';
    if (row.signed_out_at) return 'signed_out';
    if (!row.refresh_enc) return 'not_signed_in';
    if (!readable(row)) return 'unreadable';
    if (p?.failures) return 'failing';
    return p?.last_success_at ? 'on' : 'not_read';
  }
  function info() {
    const row = q.conn.get();
    const p = q.pull.get() ?? {};
    return {
      set: Boolean(row), state: state(row, p), appId: row?.app_id ?? null, ruName: row?.ru_name ?? null, account: row?.account ?? null,
      timeZone: row?.time_zone ?? cfg.timeZone, currency: row?.currency ?? 'CAD', scopes: SCOPES,
      keysetSetAt: row?.keyset_set_at ?? null, keysetSetBy: row?.keyset_set_by ?? null,
      signedInAt: row?.signed_in_at ?? null, signedInBy: row?.signed_in_by ?? null, refreshExpiresAt: row?.refresh_expires_at ?? null,
      signedOutAt: row?.signed_out_at ?? null, signedOutReason: row?.signed_out_reason ?? null,
      readable: row ? readable(row) : null, paused: isPaused(), acceptPath: '/ebay/accepted',
      lastSuccessAt: p.last_success_at ?? null, lastAttemptAt: p.last_attempt_at ?? null, lastError: p.failures ? p.last_error : null,
      failures: p.failures ?? 0, nextTryAt: p.next_try_at ?? null, window: p.window_from ? { from: p.window_from, to: p.window_to } : null,
      backfill: { from: p.backfill_from ?? null, doneAt: p.backfill_done_at ?? null }, ordersRead: p.orders_read ?? null,
      waiting: q.waiting.all().length, changes: q.changes.all(),
    };
  }

  connections.register({
    id: CONNECTION_ID,
    name: 'eBay (Save Point Shop)',
    module: 'ebay',
    description: 'Save Point Shop’s sales totals and orders waiting to ship, read with the seller’s own eBay sign-in (read-only: orders only). Nothing is changed on eBay; no buyer details are kept.',
    describe: () => {
      const s = info();
      const label = {
        not_set_up: 'Not set up', not_signed_in: 'Sign in to eBay', signed_out: 'Signed out by eBay: sign in again', paused: null, unreadable: 'Keys can’t be read here',
      }[s.state];
      return {
        lastSuccessAt: s.lastSuccessAt, lastErrorAt: s.signedOutAt ?? (s.lastError ? (q.pull.get()?.last_error_at ?? null) : null),
        lastError: s.signedOutAt ? `eBay stopped accepting the sign-in${s.signedOutReason ? `: ${s.signedOutReason}` : ''}` : s.lastError,
        queueSize: s.waiting || null,
        queueLabel: label ?? `${s.waiting} order${s.waiting === 1 ? '' : 's'} to ship${s.window ? ` · totals to ${s.window.to}` : ''}`,
        detail: s.refreshExpiresAt && !s.signedOutAt ? `Sign-in good until ${s.refreshExpiresAt.slice(0, 10)}` : null,
      };
    },
    pause() { log?.info?.('eBay paused: no calls'); },
    resume() { pull({ force: true }).catch((err) => log?.error?.('eBay pull failed:', err)); },
  });

  sales.registerSource({
    source: 'ebay',
    label: 'eBay',
    manualStores: [STORE],
    stores: () => {
      const row = q.conn.get();
      const p = q.pull.get() ?? {};
      const main = row?.currency ?? 'CAD';
      const s = state(row, p);
      const base = {
        businessId: SAVE_POINT, timeZone: row?.time_zone ?? cfg.timeZone, state: s, lastSuccessAt: p.last_success_at ?? null,
        lastError: p.failures ? p.last_error : null, link: '/costs/sales/ebay', account: row?.account ?? null,
        // Is the connection reading eBay now? When not (signed out, off, not set up), a month it didn't finish reading
        // may be entered by hand and counts (review fix; see sales.months).
        delivering: ['on', 'not_read', 'failing'].includes(s),
      };
      const currencies = [...new Set([main, ...JSON.parse(p.currencies ?? '[]')])];
      return currencies.map((c) => ({ ...base, store: storeKey(row, c), name: cardName(c, main), currency: c, ...(c === main ? { manualStore: STORE } : {}) }));
    },
  });

  const store = {
    connection: () => q.conn.get(),
    connected: () => signedIn(q.conn.get()),
    timeZone,
    waiting: () => q.waiting.all().map((r) => ({ ...r, items: JSON.parse(r.items) })),
    shipOrder: (id) => q.shipOrder.get(id) ?? null,
  };
  if (automations && planner) registerEbayAutomations({ automations, planner, store, clock });

  return { setKeyset, startSignIn, finishSignIn, updateSettings, forget, pull, pullNow, startPuller, info, store };
}
