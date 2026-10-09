// The wholesale connection (D1): receives the Order Manager's events, keeps everything it is told in
// a holding area, and shows linked customers' orders, payments, returns and refunds to devices as
// synced records. See CLAUDE.md, "Wholesale (D1)".
//
//  receive   POST /api/wom/events (routes.js): HMAC-signed, each request key applied once, answers per
//            event in order (applied | duplicate | refused + reason). Paused → 503 (the Order Manager
//            holds its line and catches up when switched on).
//  hold      every event upserts the latest snapshot of its record by uid in wholesale_held_* (latest
//            arrival wins; deletes and removals only mark it gone) and marks it dirty.
//  attach    a customer whose uid has exactly one live 'wom' account link (crm_links) is attached to
//            that account; `reconcile()` compares the links with what is attached (after each request,
//            after a link here, at start and every minute — so a link made by D2 or a device is picked up).
//            A new attachment marks the account age-restricted and gives it an active wholesale
//            relationship, each only when it has none (never overwriting anything else).
//  project   `project()` turns dirty held rows into synced records through sync.applyLocal (actor
//            'system'): created, updated (only what changed) or — when the customer is no longer
//            attached — deleted (detached). The holding area keeps everything, so linking again
//            attaches it all again: detaching is reversible.
import { isId, newId } from '@suite/shared/ids';
import { nowIso, localDate } from '@suite/shared/time';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { FORMATS, normalizeEmail, normalizePhone } from '@suite/shared/normalize';
import { HttpError } from '../../lib/httpError.js';
import { WHOLESALE_ENTITIES, NOTE_TYPES, checkServerOnly } from './entities.js';
import {
  eventProblem, bodyProblem, isoTime, isDate, orderFigures, itemsSummary, ORDER_SNAPSHOT_EVENTS, ORDER_CREATION_EVENTS,
} from './events.js';
import { customerFigures, orderMoney, orderRhythm, owingByOrder } from './figures.js';
import { registerWholesaleAutomations } from './automations.js';
import { registerFollowUpAutomation } from './followUps.js';
import { createLinkChanges } from './linkChanges.js';
import { createMatchService } from './matchService.js';
import { loadKey, encryptSecret, decryptSecret, newSecret, signatureProblem, headerProblem } from './secret.js';

export const RECEIVER_PATH = '/api/wom/events';
export const CONNECTION_ID = 'wom';
/** D5: emitted to the automations when a held customer is linked, unlinked or moved (not an Order Manager event). */
export const ATTACHMENT_EVENT = 'wholesale.attachment';
/** D5: emitted at start: every customer's follow-up task checked against the held state (after a restore too). */
export const CHECK_EVENT = 'wholesale.check';
const APP = 'wom';
const RECONCILE_EVERY_MS = 60 * 1000;
const PROJECT_CHUNK = 200;
const RECONCILE_CHUNK = 50; // customers per transaction in reconcileAll (it yields between them)
const REFUSAL_THROTTLE_MS = 60 * 1000;
/**
 * The shape of the wholesale_customer card. Raised when a package adds card fields (D3: 2 =
 * usual_gap_days + quiet_from): at start every held customer is marked dirty once, so the
 * projection writes the new fields to every card through sync and devices pull them (sync rule 7).
 */
export const CARD_VERSION = 3; // D5: + follow_up_date
const MONEY_KEY = { payment: 'payment_uid', refund: 'refund_uid', return: 'return_uid', credit_note: 'credit_note_uid' };
const MONEY_EVENT = { 'payment.recorded': ['payment', 'payment'], 'refund.issued': ['refund', 'refund'], 'return.received': ['return', 'return'], 'credit_note.issued': ['credit_note', 'credit_note'] };

const yieldNow = () => new Promise((r) => setImmediate(r));
const clip = (s, max) => (s === null || s === undefined ? null : (String(s).length > max ? `${String(s).slice(0, max - 1)}…` : String(s)));
const json = (v) => (v === undefined ? null : JSON.stringify(v));
const parse = (s) => {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
};
const isInt = (v) => Number.isSafeInteger(v);
const NOTE_TYPE_SET = new Set(NOTE_TYPES);

export function createWholesaleService(ctx) {
  const { db, config, log, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const { sync, crm, connections } = services;
  if (!sync || !crm || !connections) throw new Error('wholesale needs sync, connections and crm registered before it (modules/index.js)');
  const now = () => nowIso(new Date(clock()));

  // readOnly: devices get no add/edit/delete for them (/info) and the sync module refuses their steps;
  // checkServerOnly says the same in plain English should the option ever be dropped.
  for (const def of WHOLESALE_ENTITIES) sync.registerEntity({ module: 'wholesale', ...def, readOnly: true, check: checkServerOnly });
  const ENTITY = Object.fromEntries(WHOLESALE_ENTITIES.map((d) => [d.entity, d]));

  const q = {
    status: db.prepare('SELECT key, value FROM wholesale_status'),
    setStatus: db.prepare('INSERT INTO wholesale_status (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    eventSeen: db.prepare('SELECT 1 FROM wholesale_events WHERE key = ?'),
    insertEvent: db.prepare(`INSERT INTO wholesale_events (key, name, time, received_at, subject, customer_uid, backfill)
      VALUES (@key, @name, @time, @received_at, @subject, @customer_uid, @backfill)`),
    connection: db.prepare('SELECT * FROM wholesale_connection WHERE id = 1'),
    setConnection: db.prepare(`INSERT INTO wholesale_connection (id, secret_enc, set_at, set_by, set_device) VALUES (1, @enc, @at, @actor, @device)
      ON CONFLICT (id) DO UPDATE SET secret_enc = excluded.secret_enc, set_at = excluded.set_at, set_by = excluded.set_by, set_device = excluded.set_device`),
    logConnection: db.prepare('INSERT INTO wholesale_connection_changes (id, at, actor, device_id, action) VALUES (?, ?, ?, ?, ?)'),
    connectionChanges: db.prepare('SELECT at, actor, action FROM wholesale_connection_changes ORDER BY at DESC, id DESC LIMIT 10'),

    customer: db.prepare('SELECT * FROM wholesale_held_customers WHERE uid = ?'),
    insertCustomer: db.prepare(`INSERT INTO wholesale_held_customers (uid, number, business_name, contact_name, email, phone, snapshot,
        gone, gone_reason, first_seen_at, updated_at, dirty)
      VALUES (@uid, @number, @business_name, @contact_name, @email, @phone, @snapshot, @gone, @gone_reason, @at, @at, 1)`),
    updateCustomer: db.prepare(`UPDATE wholesale_held_customers SET number = @number, business_name = @business_name,
      contact_name = @contact_name, email = @email, phone = @phone, snapshot = @snapshot, gone = @gone, gone_reason = @gone_reason,
      updated_at = @at, dirty = 1 WHERE uid = @uid`),
    dirtyCustomer: db.prepare('UPDATE wholesale_held_customers SET dirty = 1 WHERE uid = ?'),
    attach: db.prepare(`UPDATE wholesale_held_customers SET account_id = @account_id, client_id = @client_id, attached_at = @at,
      link_problem = @problem, dirty = 1 WHERE uid = @uid`),
    dirtyItemsOf: [
      db.prepare('UPDATE wholesale_held_orders SET dirty = 1 WHERE customer_uid = ?'),
      db.prepare('UPDATE wholesale_held_money SET dirty = 1 WHERE customer_uid = ?'),
      db.prepare('UPDATE wholesale_held_notes SET dirty = 1 WHERE customer_uid = ?'),
    ],
    dirtyNotesOf: db.prepare('UPDATE wholesale_held_notes SET dirty = 1 WHERE customer_uid = ?'),
    allCustomers: db.prepare('SELECT uid, account_id, client_id, link_problem FROM wholesale_held_customers'),
    customerDone: db.prepare('UPDATE wholesale_held_customers SET record_id = ?, dirty = 0 WHERE uid = ?'),

    order: db.prepare('SELECT * FROM wholesale_held_orders WHERE uid = ?'),
    upsertOrder: db.prepare(`INSERT INTO wholesale_held_orders (uid, customer_uid, number, order_date, status, deleted, deleted_reason,
        goods_cents, tax_cents, total_cents, snapshot, placed_at, updated_at, dirty)
      VALUES (@uid, @customer_uid, @number, @order_date, @status, @deleted, @deleted_reason, @goods, @tax, @total, @snapshot, @placed_at, @at, 1)
      ON CONFLICT (uid) DO UPDATE SET customer_uid = excluded.customer_uid, number = excluded.number, order_date = excluded.order_date,
        status = excluded.status, deleted = excluded.deleted, deleted_reason = excluded.deleted_reason, goods_cents = excluded.goods_cents,
        tax_cents = excluded.tax_cents, total_cents = excluded.total_cents, snapshot = excluded.snapshot, placed_at = excluded.placed_at,
        updated_at = excluded.updated_at, dirty = 1`),
    dirtyOrder: db.prepare('UPDATE wholesale_held_orders SET dirty = 1 WHERE uid = ?'),
    ordersOf: db.prepare(`SELECT uid, status, deleted, goods_cents, tax_cents, order_date, snapshot IS NOT NULL AS has_snapshot
      FROM wholesale_held_orders WHERE customer_uid = ?`),
    orderDone: db.prepare('UPDATE wholesale_held_orders SET record_id = ?, dirty = 0 WHERE uid = ?'),
    // D3: an order's rhythm and balance fields (figures.js orderRhythm / owingByOrder).
    ordersFull: db.prepare(`SELECT uid, number, status, deleted, order_date, placed_at, total_cents, goods_cents, tax_cents,
        snapshot IS NOT NULL AS has_snapshot FROM wholesale_held_orders WHERE customer_uid = ?`),
    attached: db.prepare(`SELECT * FROM wholesale_held_customers WHERE account_id IS NOT NULL ORDER BY uid`),
    attachedOn: db.prepare('SELECT count(*) AS n FROM wholesale_held_customers WHERE account_id = ?'),

    money: db.prepare('SELECT * FROM wholesale_held_money WHERE uid = ?'),
    upsertMoney: db.prepare(`INSERT INTO wholesale_held_money (uid, kind, sub_kind, customer_uid, order_uid, amount_cents, subtotal_cents,
        removed, removed_reason, moved_to, at, snapshot, updated_at, dirty, return_uid)
      VALUES (@uid, @kind, @sub_kind, @customer_uid, @order_uid, @amount, @subtotal, @removed, @removed_reason, @moved_to, @at_event, @snapshot, @at, 1, @return_uid)
      ON CONFLICT (uid) DO UPDATE SET kind = excluded.kind, sub_kind = excluded.sub_kind, customer_uid = excluded.customer_uid, return_uid = excluded.return_uid,
        order_uid = excluded.order_uid, amount_cents = excluded.amount_cents, subtotal_cents = excluded.subtotal_cents,
        removed = excluded.removed, removed_reason = excluded.removed_reason, moved_to = excluded.moved_to, at = excluded.at,
        snapshot = excluded.snapshot, updated_at = excluded.updated_at, dirty = 1`),
    moneyOf: db.prepare('SELECT uid, kind, sub_kind, amount_cents, subtotal_cents, removed, moved_to, order_uid, return_uid FROM wholesale_held_money WHERE customer_uid = ?'),
    moneyOnOrder: db.prepare('SELECT kind, sub_kind, amount_cents, subtotal_cents, removed, moved_to FROM wholesale_held_money WHERE order_uid = ?'),
    moneyDone: db.prepare('UPDATE wholesale_held_money SET record_id = ?, dirty = 0 WHERE uid = ?'),

    // D5: notes and follow-up dates (A11).
    note: db.prepare('SELECT * FROM wholesale_held_notes WHERE uid = ?'),
    upsertNote: db.prepare(`INSERT INTO wholesale_held_notes (uid, customer_uid, number, type, body, at, written_by, snapshot,
        deleted, deleted_reason, updated_at, dirty)
      VALUES (@uid, @customer_uid, @number, @type, @body, @at_note, @written_by, @snapshot, @deleted, @deleted_reason, @at, 1)
      ON CONFLICT (uid) DO UPDATE SET customer_uid = excluded.customer_uid, number = excluded.number, type = excluded.type,
        body = excluded.body, at = excluded.at, written_by = excluded.written_by, snapshot = excluded.snapshot,
        deleted = excluded.deleted, deleted_reason = excluded.deleted_reason, updated_at = excluded.updated_at, dirty = 1`),
    noteDone: db.prepare('UPDATE wholesale_held_notes SET record_id = ?, dirty = 0 WHERE uid = ?'),
    setFollowUp: db.prepare(`UPDATE wholesale_held_customers SET follow_up_date = @date, follow_up_done = @done, follow_up_at = @at,
      follow_up_episode = follow_up_episode + @new_episode, dirty = 1 WHERE uid = @uid`),
    withFollowUp: db.prepare('SELECT uid FROM wholesale_held_customers WHERE follow_up_date IS NOT NULL ORDER BY uid'),
    // The Order Manager forgets a deleted customer's follow-up (it sends the date again if the customer comes back).
    clearFollowUp: db.prepare('UPDATE wholesale_held_customers SET follow_up_date = NULL, follow_up_done = 0 WHERE uid = ?'),
    notesWaitingOf: db.prepare(`SELECT count(*) AS n FROM wholesale_held_notes
      WHERE customer_uid = ? AND deleted = 0 AND snapshot IS NOT NULL`),

    // Keyset pages (uid > the last one seen), so rows that fail and stay dirty never hide the rest.
    dirtyOrders: db.prepare(`SELECT * FROM wholesale_held_orders WHERE dirty = 1 AND uid > ? ORDER BY uid LIMIT ${PROJECT_CHUNK}`),
    dirtyMoney: db.prepare(`SELECT * FROM wholesale_held_money WHERE dirty = 1 AND uid > ? ORDER BY uid LIMIT ${PROJECT_CHUNK}`),
    dirtyCustomers: db.prepare(`SELECT * FROM wholesale_held_customers WHERE dirty = 1 AND uid > ? ORDER BY uid LIMIT ${PROJECT_CHUNK}`),
    dirtyNotes: db.prepare(`SELECT * FROM wholesale_held_notes WHERE dirty = 1 AND uid > ? ORDER BY uid LIMIT ${PROJECT_CHUNK}`),

    waitingCount: db.prepare(`SELECT
        (SELECT count(*) FROM wholesale_held_customers WHERE account_id IS NULL AND gone = 0) AS customers,
        (SELECT count(*) FROM wholesale_held_orders o JOIN wholesale_held_customers c ON c.uid = o.customer_uid
          WHERE c.account_id IS NULL AND c.gone = 0 AND o.snapshot IS NOT NULL) AS orders,
        (SELECT count(*) FROM wholesale_held_money m JOIN wholesale_held_customers c ON c.uid = m.customer_uid
          WHERE c.account_id IS NULL AND c.gone = 0) AS money,
        (SELECT count(*) FROM wholesale_held_notes n JOIN wholesale_held_customers c ON c.uid = n.customer_uid
          WHERE c.account_id IS NULL AND c.gone = 0 AND n.deleted = 0 AND n.snapshot IS NOT NULL) AS notes,
        (SELECT count(*) FROM wholesale_held_customers WHERE account_id IS NOT NULL) AS linked,
        (SELECT count(*) FROM wholesale_held_customers WHERE link_problem IS NOT NULL) AS problems`),
  };
  // D2: what each link changed (for Undo), recorded in the same transaction as each change.
  const linkChanges = createLinkChanges({ db, crm, planner: services.planner ?? null, sync, clock });
  const recordRow = Object.fromEntries(WHOLESALE_ENTITIES.map((d) => [d.entity, db.prepare(`SELECT * FROM ${d.table} WHERE id = ?`)]));
  // Each synced record names its Order Manager record by uid: the one to adopt (and any extras) after a restore.
  const UID_FIELD = { wholesale_order: 'order_uid', wholesale_entry: 'uid', wholesale_customer: 'customer_uid', wholesale_note: 'note_uid' };
  const liveByUid = Object.fromEntries(WHOLESALE_ENTITIES.map((d) => [d.entity,
    db.prepare(`SELECT * FROM ${d.table} WHERE ${UID_FIELD[d.entity]} = ? AND deleted_at IS NULL ORDER BY id`)]));
  const markCustomersDirty = db.prepare('UPDATE wholesale_held_customers SET dirty = 1');
  const markAllDirty = [
    db.prepare('UPDATE wholesale_held_customers SET dirty = 1'),
    db.prepare('UPDATE wholesale_held_orders SET dirty = 1'),
    db.prepare('UPDATE wholesale_held_money SET dirty = 1'),
    db.prepare('UPDATE wholesale_held_notes SET dirty = 1'),
  ];
  const lastOrders = db.prepare(`SELECT client_id, max(at) AS at FROM wholesale_orders
    WHERE deleted_at IS NULL AND client_id IS NOT NULL GROUP BY client_id`);
  // D5: the latest Order Manager order or note per client ("last activity": a call logged there counts).
  const lastOrdersAndNotes = db.prepare(`SELECT client_id, max(at) AS at FROM (
      SELECT client_id, at FROM wholesale_orders WHERE deleted_at IS NULL AND client_id IS NOT NULL
      UNION ALL SELECT client_id, at FROM wholesale_notes WHERE deleted_at IS NULL AND client_id IS NOT NULL)
    GROUP BY client_id`);

  // ---- receiver status (for the Connections row) ------------------------------------------------
  function status() {
    return Object.fromEntries(q.status.all().map((r) => [r.key, r.value]));
  }
  const setStatus = (values) => {
    for (const [k, v] of Object.entries(values)) q.setStatus.run(k, v === null || v === undefined ? null : String(v));
  };

  /**
   * A request turned away (bad signature, stale, malformed, not set up): counted and shown, never the secret.
   * Throttled: the route has no session, so anyone on the tailnet could send bad requests — they are
   * counted in memory, written to wholesale_status and logged at most once a minute.
   */
  const refusals = { count: 0, message: null, at: null, savedAt: 0, loggedAt: 0, sinceLog: 0 };
  function noteRefusedRequest(message) {
    const at = clock();
    refusals.count += 1;
    refusals.sinceLog += 1;
    refusals.message = message;
    refusals.at = nowIso(new Date(at));
    if (at - refusals.savedAt >= REFUSAL_THROTTLE_MS) {
      refusals.savedAt = at;
      setStatus({ last_error: message, last_error_at: refusals.at, refused_requests: refusals.count });
    }
    if (at - refusals.loggedAt >= REFUSAL_THROTTLE_MS) {
      log?.warn?.(`refused ${refusals.sinceLog} request${refusals.sinceLog === 1 ? '' : 's'} to ${RECEIVER_PATH} (latest: ${message})`);
      refusals.loggedAt = at;
      refusals.sinceLog = 0;
    }
  }

  // ---- the shared secret ------------------------------------------------------------------------
  let secretCache = { enc: null, secret: null };
  function currentSecret() {
    const row = q.connection.get();
    if (!row) return null;
    if (secretCache.enc !== row.secret_enc) {
      secretCache = { enc: row.secret_enc, secret: decryptSecret(loadKey(config.wholesale.keyFile, { create: false }), row.secret_enc) };
    }
    return secretCache.secret;
  }
  function secretState() {
    const row = q.connection.get();
    return {
      set: Boolean(row),
      readable: row ? currentSecret() !== null : false,
      setAt: row?.set_at ?? null,
      setBy: row?.set_by ?? null,
    };
  }
  /** Make a new shared secret (replacing any): returned once, never readable over the API again. */
  function makeSecret({ actor, deviceId = null }) {
    const secret = newSecret();
    const enc = encryptSecret(loadKey(config.wholesale.keyFile), secret);
    const at = now();
    db.transaction(() => {
      q.setConnection.run({ enc, at, actor, device: deviceId });
      q.logConnection.run(newId(), at, actor, deviceId, 'new_secret');
    })();
    secretCache = { enc, secret };
    log?.info?.(`new Order Manager secret made by ${actor}`);
    return secret;
  }

  // ---- the Connections row ----------------------------------------------------------------------
  const handle = connections.register({
    id: CONNECTION_ID,
    name: 'Wholesale Order Manager',
    module: 'wholesale',
    description: 'Customers, orders, payments, returns and refunds from the Order Manager, through its outbox. '
      + 'Linked customers show on their client’s timeline; the others wait for a client.',
    describe: () => describe(),
    // Paused: the receiver answers 503 to every request (nothing applied, nothing logged as a failure);
    // the Order Manager keeps its events queued and sends them again — in order — once it is on.
    pause() { log?.info?.('paused: the Order Manager’s events wait in its outbox'); },
    resume() { log?.info?.('on again: the Order Manager sends what waited (within its retry wait, at most 5 minutes)'); },
  });

  function waitingCounts() {
    return q.waitingCount.get();
  }

  /** "3 records and 2 notes from 2 customers waiting for a client" (D5: notes counted apart). */
  function waitingLabel(w) {
    const records = w.orders + w.money;
    const parts = [`${records} record${records === 1 ? '' : 's'}`];
    if (w.notes) parts.push(`${w.notes} note${w.notes === 1 ? '' : 's'}`);
    return `${parts.join(' and ')} from ${w.customers} customer${w.customers === 1 ? '' : 's'} waiting for a client`;
  }

  function describe() {
    const st = status();
    const w = waitingCounts();
    const sec = secretState();
    const queueSize = w.orders + w.money + w.notes;
    const parts = [];
    if (!sec.set) parts.push('No shared secret yet: make one below and enter it in the Order Manager');
    else if (!sec.readable) parts.push('The shared secret can’t be read on this machine (its key file is missing): make a new one');
    parts.push(`${w.linked} customer${w.linked === 1 ? '' : 's'} linked`);
    if (st.refused_events) parts.push(`${st.refused_events} event${st.refused_events === '1' ? '' : 's'} refused (shown in the Order Manager’s Settings)`);
    if (w.problems) parts.push(`${w.problems} linked to more than one account: undo one link`);
    // The latest refusal: from memory when newer than what was last written (writes are throttled).
    const fresh = refusals.at && !(st.last_error_at > refusals.at);
    const lastError = fresh ? refusals.message : st.last_error;
    const since = fresh ? refusals.count : Number(st.refused_requests ?? 0);
    if (st.stuck_key && Number(st.stuck_tries) > 1) {
      parts.unshift(`Stuck since ${st.stuck_since}: the same event has failed ${st.stuck_tries} times — the Order Manager’s line waits behind it (see the server log)`);
    }
    const refusal = lastError ? `${lastError}${since ? ` (${since} refused since the last good request)` : ''}` : null;
    // An event that couldn't be applied comes first: it holds up everything behind it.
    const applyFirst = st.stuck_key && !(fresh && refusals.at > st.apply_error_at);
    return {
      lastSuccessAt: st.last_ok_at ?? null,
      lastErrorAt: (applyFirst ? st.apply_error_at : (fresh ? refusals.at : st.last_error_at)) ?? null,
      lastError: applyFirst ? st.apply_error : refusal,
      queueSize,
      queueLabel: queueSize || w.customers ? waitingLabel(w) : 'Nothing waiting for a client',
      detail: parts.join(' · '),
    };
  }

  // ---- the holding area ------------------------------------------------------------------------
  /** Customer events: the latest snapshot wins; a delete keeps what was known and marks it gone. */
  function holdCustomer(c, { deleted, reason, creation, at }) {
    const prev = q.customer.get(c.customer_uid);
    const full = !deleted || typeof c.business_name === 'string';
    const snap = full ? c : parse(prev?.snapshot) ?? c;
    const values = {
      uid: c.customer_uid,
      number: isInt(snap.number) ? snap.number : (prev?.number ?? null),
      business_name: clip(snap.business_name ?? prev?.business_name ?? null, 300),
      contact_name: clip(snap.contact_name ?? (full ? null : prev?.contact_name) ?? null, 300),
      email: snap.email ?? (full ? null : prev?.email ?? null),
      phone: snap.phone ?? (full ? null : prev?.phone ?? null),
      snapshot: json(snap),
      gone: deleted ? 1 : (creation ? 0 : (prev?.gone ?? 0)),
      gone_reason: deleted ? (reason ?? 'deleted') : (creation ? null : (prev?.gone_reason ?? null)),
      at,
    };
    if (prev) q.updateCustomer.run(values);
    else q.insertCustomer.run(values);
    // D5: a customer's notes are shown only while it isn't deleted there: deleted or back, they follow.
    if (prev && Boolean(prev.gone) !== Boolean(values.gone)) q.dirtyNotesOf.run(c.customer_uid);
    if (deleted) q.clearFollowUp.run(c.customer_uid);
    return c.customer_uid;
  }

  /** D5: a customer named only by a note or a follow-up (the Order Manager sends customer.created first; just in case). */
  function holdCustomerStub(uid, at) {
    if (!isId(uid) || q.customer.get(uid)) return;
    q.insertCustomer.run({ uid, number: null, business_name: null, contact_name: null, email: null, phone: null, snapshot: null, gone: 0, gone_reason: null, at });
  }

  /**
   * D5 note.added: upsert the note's snapshot by note_uid (latest arrival wins). A note held as deleted
   * (a delete, or a tombstone for a delete that came first) stays deleted unless this add is a backfill
   * one: the Order Manager's catch-up sends only notes that exist there now (e.g. brought back by a
   * backup import), while a live add for a deleted note can only be an old one sent again (a refused
   * event "sent again" after the delete) — its snapshot is kept, the note stays deleted.
   */
  function holdNote(n, { backfill, at, eventTime }) {
    const prev = q.note.get(n.note_uid);
    const stayDeleted = Boolean(prev?.deleted) && !backfill;
    q.upsertNote.run({
      uid: n.note_uid,
      customer_uid: n.customer_uid,
      number: isInt(n.number) ? n.number : null,
      type: n.type,
      body: n.body,
      // No time there (a backup import lost it): the one we had, else the event's.
      at_note: isoTime(n.at) ?? prev?.at ?? eventTime,
      written_by: clip(n.written_by ?? null, 100),
      snapshot: json(n),
      deleted: stayDeleted ? 1 : 0,
      deleted_reason: stayDeleted ? prev.deleted_reason : null,
      at,
    });
    holdCustomerStub(n.customer_uid, at);
    return { customerUids: [...new Set([n.customer_uid, prev?.customer_uid].filter(Boolean))], orderUid: null, noteUid: n.note_uid };
  }

  /** D5 note.deleted: marks the note deleted (kept); a note never seen is held as a tombstone. */
  function holdNoteDeleted(d, { at }) {
    const n = d.note;
    const prev = q.note.get(n.note_uid);
    const customerUid = prev?.customer_uid ?? n.customer_uid ?? null;
    q.upsertNote.run({
      uid: n.note_uid,
      customer_uid: customerUid,
      number: prev?.number ?? (isInt(n.number) ? n.number : null),
      type: prev?.type ?? null,
      body: prev?.body ?? null,
      at_note: prev?.at ?? null,
      written_by: prev?.written_by ?? null,
      snapshot: prev?.snapshot ?? null,
      deleted: 1,
      deleted_reason: d.reason ?? 'deleted',
      at,
    });
    return { customerUids: customerUid ? [customerUid] : [], orderUid: null, noteUid: n.note_uid };
  }

  /**
   * D5 followup.changed: the customer's follow-up date as it is now (a state: the latest arrival
   * wins). A date where there was none starts a new follow-up (follow_up_episode + 1).
   */
  function holdFollowUp(d, { at, eventTime }) {
    holdCustomerStub(d.customer_uid, at);
    const prev = q.customer.get(d.customer_uid);
    q.setFollowUp.run({
      uid: d.customer_uid,
      date: d.follow_up_date,
      done: d.done ? 1 : 0,
      at: eventTime,
      new_episode: d.follow_up_date && !prev.follow_up_date ? 1 : 0,
    });
    return { customerUids: [d.customer_uid], orderUid: null };
  }

  /** The customer an order names, from the order's own summary, when nothing else is known of it yet. */
  function holdCustomerFromOrder(summary, at) {
    if (!summary || !isId(summary.customer_uid)) return;
    const prev = q.customer.get(summary.customer_uid);
    if (prev && prev.snapshot) return;
    const values = {
      uid: summary.customer_uid,
      number: isInt(summary.number) ? summary.number : (prev?.number ?? null),
      business_name: clip(summary.business_name ?? prev?.business_name ?? null, 300),
      contact_name: clip(summary.contact_name ?? null, 300),
      email: summary.email ?? null,
      phone: summary.phone ?? null,
      snapshot: null,
      gone: prev?.gone ?? 0,
      gone_reason: prev?.gone_reason ?? null,
      at,
    };
    if (prev) q.updateCustomer.run(values);
    else q.insertCustomer.run(values);
  }

  function holdOrder(o, { deleted, reason, creation, at, eventTime }) {
    const prev = q.order.get(o.order_uid);
    const f = orderFigures(o);
    const customerUid = o.customer_uid ?? null;
    if (customerUid) holdCustomerFromOrder(o.customer ?? { customer_uid: customerUid }, at);
    q.upsertOrder.run({
      uid: o.order_uid,
      customer_uid: customerUid,
      number: isInt(o.number) ? o.number : null,
      order_date: isDate(o.order_date) ? o.order_date : null,
      status: o.status,
      deleted: deleted ? 1 : (creation ? 0 : (prev?.deleted ?? 0)),
      deleted_reason: deleted ? (reason ?? 'deleted') : (creation ? null : (prev?.deleted_reason ?? null)),
      goods: f.goods, tax: f.tax, total: f.total,
      snapshot: json(o),
      placed_at: isoTime(o.created_at) ?? (isDate(o.order_date) ? `${o.order_date}T12:00:00.000Z` : null) ?? prev?.placed_at ?? eventTime,
      at,
    });
    const touched = new Set([customerUid, prev?.customer_uid].filter(Boolean));
    for (const uid of touched) q.dirtyCustomer.run(uid);
    return { customerUids: [...touched], orderUid: o.order_uid };
  }

  /** order.deleted: marks it deleted (gone); keeps the last snapshot (or takes the one sent). */
  function holdOrderDeleted(d, { at, eventTime }) {
    const prev = q.order.get(d.order_uid);
    if (d.order) return holdOrder(d.order, { deleted: true, reason: d.reason, creation: false, at, eventTime });
    const customerUid = prev?.customer_uid ?? d.customer_uid ?? null;
    q.upsertOrder.run({
      uid: d.order_uid,
      customer_uid: customerUid,
      number: prev?.number ?? (isInt(d.number) ? d.number : null),
      order_date: prev?.order_date ?? null,
      status: prev?.status ?? 'active',
      deleted: 1,
      deleted_reason: d.reason ?? 'deleted',
      goods: prev?.goods_cents ?? 0, tax: prev?.tax_cents ?? 0, total: prev?.total_cents ?? 0,
      snapshot: prev?.snapshot ?? null,
      placed_at: prev?.placed_at ?? null,
      at,
    });
    if (customerUid) q.dirtyCustomer.run(customerUid);
    return { customerUids: customerUid ? [customerUid] : [], orderUid: d.order_uid };
  }

  /** A payment, refund, return or credit note: upsert by uid; a removal marks it removed (kept). */
  function holdMoney(kind, s, d, { at, eventTime }) {
    const uid = s[MONEY_KEY[kind]];
    const prev = q.money.get(uid);
    const removed = d.removed === true || d.change === 'removed';
    // A removal sent by the backfill carries a cut-down snapshot: keep the full one we had.
    const cut = removed && !isInt(s.amount_cents);
    const snap = cut && prev?.snapshot ? { ...parse(prev.snapshot), ...s } : s;
    const amount = isInt(snap.amount_cents) ? snap.amount_cents : (prev?.amount_cents ?? 0);
    let subtotal = null;
    // A10 (Order Manager change): a return carries its own subtotal/tax/shipping; older ones don't (null).
    if (kind === 'return') subtotal = isInt(snap.subtotal_cents) ? snap.subtotal_cents : null;
    if (kind === 'credit_note') {
      subtotal = isInt(snap.subtotal_cents) ? snap.subtotal_cents
        : amount - (isInt(snap.tax_cents) ? snap.tax_cents : 0) - (isInt(snap.shipping_cents) ? snap.shipping_cents : 0);
    }
    const when = isoTime(snap.created_at) ?? isoTime(snap.received_at) ?? isoTime(snap.issued_at) ?? prev?.at ?? eventTime;
    const customerUid = snap.customer_uid ?? prev?.customer_uid ?? null;
    const orderUid = snap.order_uid ?? prev?.order_uid ?? null;
    q.upsertMoney.run({
      uid, kind,
      sub_kind: kind === 'refund' ? (snap.kind ?? prev?.sub_kind ?? null) : null,
      customer_uid: customerUid,
      order_uid: orderUid,
      amount, subtotal,
      removed: removed ? 1 : 0,
      removed_reason: removed ? (d.reason ?? 'removed') : null,
      moved_to: removed && d.moved_to === 'store_credit' ? 'store_credit' : null,
      at_event: when,
      return_uid: kind === 'refund' || kind === 'credit_note' ? (snap.return_uid ?? prev?.return_uid ?? null) : null,
      snapshot: json(snap),
      at,
    });
    const customers = new Set([customerUid, prev?.customer_uid].filter(Boolean));
    for (const c of customers) q.dirtyCustomer.run(c);
    for (const o of new Set([orderUid, prev?.order_uid].filter(Boolean))) q.dirtyOrder.run(o);
    return { customerUids: [...customers], orderUid };
  }

  /** Apply one checked event to the holding area (in the caller's transaction). */
  function hold(e) {
    const at = now();
    const eventTime = isoTime(e.time);
    const d = e.data;
    let info;
    let subject;
    if (e.name === 'customer.created' || e.name === 'customer.updated') {
      const uid = holdCustomer(d.customer, { deleted: d.deleted === true, reason: d.reason, creation: e.name === 'customer.created', at });
      info = { customerUids: [uid], orderUid: null };
      subject = `customer:${uid}`;
    } else if (ORDER_SNAPSHOT_EVENTS.includes(e.name)) {
      info = holdOrder(d.order, { deleted: false, creation: ORDER_CREATION_EVENTS.includes(e.name), at, eventTime });
      subject = `order:${d.order.order_uid}`;
    } else if (e.name === 'order.deleted') {
      info = holdOrderDeleted(d, { at, eventTime });
      subject = `order:${d.order_uid}`;
    } else if (e.name === 'note.added') {
      info = holdNote(d.note, { backfill: d.backfill === true, at, eventTime });
      subject = `note:${d.note.note_uid}`;
    } else if (e.name === 'note.deleted') {
      info = holdNoteDeleted(d, { at });
      subject = `note:${d.note.note_uid}`;
    } else if (e.name === 'followup.changed') {
      info = holdFollowUp(d, { at, eventTime });
      subject = `follow_up:${d.customer_uid}`;
    } else {
      const [kind, field] = MONEY_EVENT[e.name];
      info = holdMoney(kind, d[field], d, { at, eventTime });
      subject = `${kind}:${d[field][MONEY_KEY[kind]]}`;
    }
    q.insertEvent.run({
      key: e.key, name: e.name, time: eventTime, received_at: at, subject,
      customer_uid: info.customerUids[0] ?? null, backfill: d.backfill === true ? 1 : 0,
    });
    return info;
  }

  // ---- receiving ---------------------------------------------------------------------------------
  /**
   * Apply a request's events in the order sent. → results, one per event: applied | duplicate |
   * refused + reason. Each event is its own transaction (its holding rows and its key together),
   * so a key is applied exactly once. Then: links checked for the customers touched, synced records
   * brought up to date, and each applied event emitted for automations (D3).
   */
  function applyEvents(events) {
    const results = [];
    const applied = [];
    const touched = new Set();
    let refused = 0;
    let backfill = false;
    let failure = null; // an unexpected error: the batch is cut short there
    for (const e of events) {
      const key = typeof e?.key === 'string' ? e.key.slice(0, 64) : null;
      const problem = eventProblem(e);
      if (problem) {
        results.push({ key, status: 'refused', reason: problem });
        refused += 1;
        continue;
      }
      if (q.eventSeen.get(e.key)) {
        results.push({ key, status: 'duplicate' });
        continue;
      }
      try {
        const info = db.transaction(() => hold(e))();
        info.customerUids.forEach((u) => touched.add(u));
        if (e.data.backfill === true) backfill = true;
        applied.push({ e, info });
        results.push({ key, status: 'applied' });
      } catch (err) {
        // Not the event's fault (SQLITE_BUSY, a full disk, a bug): answer only what was applied so far.
        // The Order Manager sends this event and the rest again, in order; `refused` is only for events
        // that are themselves wrong (it would park them for good).
        log?.error?.(`couldn't apply ${e.name} ${e.key} (answering the ${results.length} before it; the rest are sent again):`, err);
        failure = { key: e.key, name: e.name, message: String(err?.message ?? err).slice(0, 300) };
        break;
      }
    }
    const at = now();
    const st = status();
    refusals.count = 0;
    refusals.at = null;
    refusals.message = null;
    // A batch cut short by an error is no success: the line is stuck at that event until it applies. The
    // row shows the error, and how long the same event has been failing ("stuck since").
    const stuck = failure ? {
      apply_error: `Couldn’t apply event ${failure.name} (${failure.key}): ${failure.message}`,
      apply_error_at: at,
      stuck_key: failure.key,
      stuck_since: st.stuck_key === failure.key ? (st.stuck_since ?? at) : at,
      stuck_tries: st.stuck_key === failure.key ? Number(st.stuck_tries ?? 1) + 1 : 1,
    } : { apply_error: null, apply_error_at: null, stuck_key: null, stuck_since: null, stuck_tries: null };
    setStatus({
      ...(failure ? {} : { last_ok_at: at }),
      refused_requests: 0, last_error: null, last_error_at: null,
      ...stuck,
      ...(applied.length ? { last_event_at: at, events_applied: Number(st.events_applied ?? 0) + applied.length } : {}),
      ...(refused ? { refused_events: Number(st.refused_events ?? 0) + refused, last_refused_event: results.find((r) => r.status === 'refused')?.reason } : {}),
      ...(backfill ? { last_backfill_at: at } : {}),
    });
    if (touched.size) {
      try {
        reconcile({ only: touched });
      } catch (err) {
        log?.error?.('reconcile after events failed (retried within a minute):', err);
      }
      // D2: a customer that arrived (or changed) waiting for a client with the same email or phone as
      // one client's contact is linked now — before its events go to the automations, so they see it linked.
      try {
        matching.pass({ only: touched });
      } catch (err) {
        log?.error?.('matching after events failed (tried again within a minute):', err);
      }
    }
    for (const { e, info } of applied) emit(e, info);
    return results;
  }

  function emit(e, info) {
    const automations = services.automations;
    if (!automations?.emit) return;
    const customerUid = info.customerUids[0] ?? null;
    const c = customerUid ? q.customer.get(customerUid) : null;
    try {
      automations.emit(e.name, {
        key: e.key, name: e.name, time: isoTime(e.time), backfill: e.data.backfill === true, by: e.data.by ?? null,
        customerUid, orderUid: info.orderUid ?? null, noteUid: info.noteUid ?? null,
        accountId: c?.account_id ?? null, clientId: c?.client_id ?? null, linked: Boolean(c?.account_id),
        data: e.data,
      });
    } catch (err) {
      log?.error?.(`automations for ${e.name} failed:`, err);
    }
  }

  /**
   * What can be answered from the headers alone, before the body is read (routes.js calls it first, so
   * an unsigned caller can't make the server read a body): paused → 503 (nothing read, nothing logged
   * as a failure); a malformed timestamp / signature header → 401; no secret here → 401. → null when
   * the body should be read.
   */
  function precheck({ timestamp, signature }) {
    if (handle.isPaused()) {
      return { status: 503, body: { error: 'Paused in the suite (System → Connections): events wait in the Order Manager until it is switched on', code: 'paused' } };
    }
    const bad = headerProblem({ timestamp, signature });
    if (bad) {
      noteRefusedRequest(bad.message);
      return { status: 401, body: { error: bad.message, code: bad.code } };
    }
    if (!currentSecret()) {
      const message = secretState().set
        ? 'The suite can’t read its shared secret on this machine: make a new one (System → Connections)'
        : 'No shared secret has been made in the suite yet (System → Connections)';
      noteRefusedRequest(message);
      return { status: 401, body: { error: message, code: 'not_set_up' } };
    }
    return null;
  }

  /**
   * The receiver (POST /api/wom/events; routes.js gives it the raw body after precheck). → { status, body }.
   * Order of checks: precheck again (the switch may have moved meanwhile) → signature and timestamp
   * (401) → the body (400) → the events (200 with a result each, or a prefix of them).
   */
  function receive({ rawBody, timestamp, signature, path, method = 'POST' }) {
    const early = precheck({ timestamp, signature });
    if (early) return early;
    const secret = currentSecret();
    const problem = signatureProblem({ secret, timestamp, signature, method, path, rawBody, nowMs: clock() });
    if (problem) {
      noteRefusedRequest(problem.message);
      return { status: 401, body: { error: problem.message, code: problem.code } };
    }
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      noteRefusedRequest('A signed request whose body isn’t JSON');
      return { status: 400, body: { error: 'The body isn’t JSON', code: 'bad_body' } };
    }
    const bad = bodyProblem(body);
    if (bad) {
      noteRefusedRequest(`A signed request the suite couldn’t read: ${bad}`);
      return { status: 400, body: { error: bad, code: 'bad_body' } };
    }
    return { status: 200, body: { results: applyEvents(body.events) } };
  }

  // ---- attaching ---------------------------------------------------------------------------------
  /**
   * Compare the live 'wom' account links with what each held customer is attached to, and change
   * what differs: attach (new link), move (the link now names another account, or the account moved
   * to another client), detach (no live link, or more than one: never picked silently). Then
   * project(). `only`: the customer uids to look at (default: all). `actor`: who caused it (the
   * person linking; 'system' for a link found by the minute check).
   */
  function linksByUid() {
    const byUid = new Map();
    for (const l of crm.liveAccountLinks(APP)) {
      const list = byUid.get(l.external_id);
      if (list) list.push(l);
      else byUid.set(l.external_id, [l]);
    }
    return byUid;
  }

  /**
   * D5: attachments that changed (linked, unlinked, moved to another account or client), emitted to the
   * automations as 'wholesale.attachment' once they are committed — the follow-up automation makes,
   * moves or finishes a customer's follow-up task with them. Collected while a transaction is open (a
   * person's link is one transaction with its reconcile) and emitted by flushAttachments() after it.
   */
  const attachmentChanges = [];
  function flushAttachments() {
    if (db.inTransaction || !attachmentChanges.length) return;
    const changes = attachmentChanges.splice(0);
    const automations = services.automations;
    if (!automations?.emit) return;
    for (const c of changes) {
      try {
        automations.emit(ATTACHMENT_EVENT, {
          key: newId(), name: ATTACHMENT_EVENT, time: now(), backfill: false, by: null,
          customerUid: c.customerUid, orderUid: null, accountId: c.accountId, clientId: c.clientId, linked: Boolean(c.accountId),
          previousAccountId: c.previousAccountId, data: null,
        });
      } catch (err) {
        log?.error?.(`automations for ${ATTACHMENT_EVENT} failed:`, err);
      }
    }
  }

  /** Attach / move / detach `rows` (held customers) to match the links, in one transaction. → how many changed. */
  function reconcileRows(rows, byUid, actor) {
    const at = now();
    let changed = 0;
    db.transaction(() => {
      for (const row of rows) {
        const links = byUid.get(row.uid) ?? [];
        const target = links.length === 1 ? links[0] : null;
        const problem = links.length > 1 ? 'several_links' : null;
        const accountId = target?.account_id ?? null;
        const clientId = target?.client_id ?? null;
        if (accountId === row.account_id && clientId === row.client_id && problem === row.link_problem) continue;
        q.attach.run({ uid: row.uid, account_id: accountId, client_id: clientId, at: accountId ? at : null, problem });
        for (const s of q.dirtyItemsOf) s.run(row.uid);
        if (accountId && accountId !== row.account_id) attachRules(row.uid, accountId, actor, target.id);
        if (accountId !== row.account_id || clientId !== row.client_id) {
          attachmentChanges.push({ customerUid: row.uid, accountId, clientId, previousAccountId: row.account_id ?? null });
        }
        changed += 1;
      }
    })();
    return changed;
  }

  /**
   * For a few customers (`only`: after a request, a link here), synchronously. Without `only` it does
   * them all in one go — tests and small databases; the server's own full passes use reconcileAll.
   */
  function reconcile({ only = null, actor = 'system' } = {}) {
    const rows = only ? [...only].map((uid) => q.customer.get(uid)).filter(Boolean) : q.allCustomers.all();
    const changed = reconcileRows(rows, linksByUid(), actor);
    project();
    flushAttachments(); // not inside a person's link transaction: they flush after it commits
    return { changed };
  }

  /**
   * Every customer, RECONCILE_CHUNK at a time (one small transaction each), projecting what changed
   * and giving the event loop a turn in between — so a thousand customers linked at once (D2's
   * auto-links, a restore) never holds the server up. One pass at a time; a call meanwhile waits for it.
   */
  let running = null;
  function reconcileAll({ actor = 'system' } = {}) {
    if (running) return running;
    running = (async () => {
      try {
        const byUid = linksByUid();
        const rows = q.allCustomers.all();
        let changed = 0;
        for (let i = 0; i < rows.length; i += RECONCILE_CHUNK) {
          // Read each row afresh: a request may have changed it while this pass waited.
          const chunk = rows.slice(i, i + RECONCILE_CHUNK).map((r) => q.customer.get(r.uid)).filter(Boolean);
          changed += reconcileRows(chunk, byUid, actor);
          await projectAsync();
          flushAttachments();
          await yieldNow();
        }
        await projectAsync(); // anything still dirty (a crash, a restore)
        return { changed };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /**
   * At start: a restore (the sync generation changed since this module last looked) brings back the
   * synced records as they were in the backup, while the holding area (kept across restores, like the
   * secret) is as the Order Manager last said. So every held row is marked dirty: projecting adopts each
   * record by its uid, puts it right (a status, a deletion), deletes extras and re-creates the missing.
   */
  function checkRestore() {
    const generation = sync.info().generation;
    const seen = status().sync_generation ?? null;
    if (seen && seen !== generation) {
      db.transaction(() => { for (const s of markAllDirty) s.run(); })();
      log?.info?.('the suite was restored: Order Manager records are being put back as it last said (from the holding area)');
    }
    if (seen !== generation) setStatus({ sync_generation: generation });
    return seen !== null && seen !== generation;
  }

  /**
   * At start: when the card has new fields since this database last looked (CARD_VERSION), mark
   * every held customer dirty once, so the projection writes them to every card (through sync,
   * so devices pull them). → true when it did.
   */
  function checkCardVersion() {
    const seen = Number(status().card_version ?? 1);
    if (seen >= CARD_VERSION) return false;
    db.transaction(() => {
      markCustomersDirty.run();
      setStatus({ card_version: CARD_VERSION });
    })();
    log?.info?.(`customer cards: new fields (version ${CARD_VERSION}); every card is brought up to date`);
    return true;
  }

  /**
   * A customer attached to an account for the first time: the account is marked age-restricted
   * (wholesale is nicotine) when it isn't already, and gets an active wholesale relationship when
   * it has no relationship with our wholesale business. Nothing else is ever changed. (D2) Each
   * change is recorded for its link (wholesale_link_changes), with an 'attached' row for the
   * attachment itself, so undoing the link can put them back.
   */
  function attachRules(uid, accountId, actor, linkId = null) {
    const account = crm.liveAccount(accountId);
    if (!account) return;
    const write = (args) => {
      const r = sync.applyLocal({ actor, ...args });
      if (!['applied', 'clash'].includes(r.status)) throw new Error(`${args.entity} ${args.op}: ${r.code} ${r.reason}`);
      return r;
    };
    const note = (change) => linkChanges.record({ customerUid: uid, linkId, accountId, actor, ...change });
    note({ change: 'attached', entity: 'link', recordId: linkId ?? accountId });
    if (account.age_restricted !== true) {
      write({ entity: 'account', op: 'update', recordId: accountId, fields: { age_restricted: true } });
      note({ change: 'age_restricted', entity: 'account', recordId: accountId, before: { age_restricted: account.age_restricted ?? null }, after: { age_restricted: true } });
    }
    if (!crm.accountRelationships(accountId).some((r) => r.business_id === BUSINESS_IDS.wholesale)) {
      const first = customerFigures(q.ordersOf.all(uid), []).first_order_date;
      const made = write({
        entity: 'relationship', op: 'create',
        fields: { account_id: accountId, business_id: BUSINESS_IDS.wholesale, kind: 'wholesale', status: 'active', start_date: first ?? localDate(new Date(clock())) },
      });
      note({ change: 'relationship_created', entity: 'relationship', recordId: made.recordId });
    }
  }

  // ---- projecting (holding area -> synced records) ----------------------------------------------
  const attachmentOf = (customerUid) => {
    if (!customerUid) return null;
    const c = q.customer.get(customerUid);
    return c?.account_id ? { account_id: c.account_id, client_id: c.client_id } : null;
  };

  /** A synced row as field values (booleans as true/false), to compare with what it should be. */
  function current(entity, row) {
    const out = {};
    for (const [name, f] of Object.entries(ENTITY[entity].fields)) {
      const v = row[name];
      out[name] = v === null || v === undefined ? null : (f.type === 'boolean' ? v === 1 : v);
    }
    return out;
  }

  /**
   * Make the synced record match `desired` (field values, or null = it shouldn't exist): create,
   * update only what differs, or delete (detach). → the record id to remember (null when none).
   */
  function syncRecord(entity, recordId, desired, uid) {
    // The record to keep: the one remembered, else (after a restore, or a crash between the write and
    // its bookkeeping) the oldest live one naming the same uid. Any other live one naming it is an extra.
    const byUid = uid ? liveByUid[entity].all(uid) : [];
    const mine = recordId ? recordRow[entity].get(recordId) : null;
    const row = mine && mine.deleted_at === null ? mine : (byUid[0] ?? null);
    const live = Boolean(row);
    const remove = (id) => {
      const r = sync.applyLocal({ entity, op: 'delete', recordId: id });
      if (r.status === 'rejected') throw new Error(`${entity} delete: ${r.code} ${r.reason}`);
    };
    for (const extra of byUid) if (extra.id !== row?.id) remove(extra.id);
    if (!desired) {
      if (live) remove(row.id);
      return null;
    }
    recordId = row?.id ?? null; // eslint-disable-line no-param-reassign
    if (live) {
      const have = current(entity, row);
      const fields = {};
      for (const [k, v] of Object.entries(desired)) if (have[k] !== v) fields[k] = v;
      if (!Object.keys(fields).length) return recordId;
      const r = sync.applyLocal({ entity, op: 'update', recordId, fields });
      if (r.status === 'applied' || r.status === 'clash') return recordId;
      // e.g. its account was deleted meanwhile and it now belongs elsewhere: make it afresh.
      log?.warn?.(`${entity} ${recordId} couldn't be updated (${r.code}: ${r.reason}); making a new one`);
    }
    const r = sync.applyLocal({ entity, op: 'create', fields: desired });
    if (r.status !== 'applied') throw new Error(`${entity} create: ${r.code} ${r.reason}`);
    return r.recordId;
  }

  function desiredOrder(o) {
    const target = attachmentOf(o.customer_uid);
    const snap = parse(o.snapshot);
    if (!target || !snap) return null;
    const f = orderFigures(snap);
    const items = itemsSummary(snap.lines);
    return {
      ...target,
      customer_uid: o.customer_uid,
      order_uid: o.uid,
      number: o.number,
      reference: clip(snap.reference_number ?? null, 200),
      order_date: o.order_date,
      at: o.placed_at ?? `${o.order_date ?? '2000-01-01'}T12:00:00.000Z`,
      status: o.deleted ? 'deleted' : o.status,
      history_only: snap.history_only === true,
      goods_cents: f.goods,
      tax_cents: f.tax,
      shipping_cents: f.shipping,
      total_cents: f.total,
      ...orderMoney(q.moneyOnOrder.all(o.uid)),
      item_count: items.units,
      items: items.text || null,
      packing: clip(snap.packing?.state ?? null, 40),
    };
  }

  const ENTRY_KIND = { payment: 'payment', return: 'return', credit_note: 'credit_note' };
  const REFUND_KIND = { refund: 'refund', store_credit: 'store_credit', store_credit_applied: 'credit_applied' };
  const itemsText = (items = []) => (Array.isArray(items) ? items : [])
    .map((i) => `${i.quantity ?? 0} × ${i.name ?? i.sku ?? 'Item'}${i.restocked === false ? ' (damaged)' : ''}`).join(', ');

  function desiredEntry(m) {
    const target = attachmentOf(m.customer_uid);
    if (!target) return null;
    const s = parse(m.snapshot) ?? {};
    const kind = m.kind === 'refund' ? (REFUND_KIND[m.sub_kind] ?? 'refund') : ENTRY_KIND[m.kind];
    let detail;
    let method = null;
    let number = s.number === null || s.number === undefined ? null : String(s.number);
    if (m.kind === 'payment') {
      method = s.method ?? null;
      detail = [s.reference_number && `Ref ${s.reference_number}`, s.notes, s.history_entry && 'Recorded with a past order'].filter(Boolean).join(' · ');
    } else if (m.kind === 'refund') {
      method = s.method ?? null;
      detail = [s.reason, itemsText(s.items)].filter(Boolean).join(' · ');
    } else if (m.kind === 'return') {
      method = s.refund_method ?? null;
      const outcome = { refund: 'Refunded', credit_note: 'Credit note', none: 'Nothing given back' }[s.outcome];
      detail = [itemsText(s.items), outcome, s.reason].filter(Boolean).join(' · ');
    } else {
      detail = [s.reason, itemsText(s.lines)].filter(Boolean).join(' · ');
    }
    if (m.kind === 'credit_note' && number && !number.startsWith('CN')) number = `CN-${number}`;
    return {
      ...target,
      customer_uid: m.customer_uid,
      uid: m.uid,
      kind,
      order_uid: m.order_uid,
      order_number: isInt(s.order_number) ? s.order_number : null,
      number: clip(number, 40),
      amount_cents: m.amount_cents,
      method: clip(method, 40),
      at: m.at ?? now(),
      status: m.removed ? 'removed' : 'live',
      removed_reason: m.removed ? clip(m.removed_reason, 60) : null,
      moved_to: m.moved_to,
      detail: clip(detail || null, 2000),
    };
  }

  function desiredCustomer(c) {
    if (!c.account_id) return null;
    return {
      account_id: c.account_id,
      client_id: c.client_id,
      customer_uid: c.uid,
      number: c.number,
      name: c.business_name ?? (c.number ? `Customer #${c.number}` : 'Order Manager customer'),
      contact_name: c.contact_name,
      gone: c.gone === 1,
      ...customerFigures(q.ordersOf.all(c.uid), q.moneyOf.all(c.uid)),
      ...cardRhythm(c),
      follow_up_date: c.gone === 1 ? null : (c.follow_up_date ?? null), // D5
    };
  }

  /**
   * D5: a note of a linked customer, while the note is live and its customer isn't deleted there (the
   * Order Manager deletes a customer's notes with it; they come back if the customer does).
   */
  function desiredNote(n) {
    const target = attachmentOf(n.customer_uid);
    if (!target || n.deleted || !n.snapshot || !NOTE_TYPE_SET.has(n.type)) return null;
    if (q.customer.get(n.customer_uid)?.gone) return null;
    return {
      ...target,
      customer_uid: n.customer_uid,
      note_uid: n.uid,
      number: n.number,
      type: n.type,
      body: clip(n.body ?? '', 20_000),
      at: n.at ?? now(),
      written_by: n.written_by,
    };
  }

  /** D3: the card's rhythm fields — the same rule as the check-in automation; none for a deleted customer. */
  function cardRhythm(c) {
    const r = c.gone === 1 ? null : orderRhythm(q.ordersFull.all(c.uid));
    return { usual_gap_days: r?.regular ? r.usual_gap_days : null, quiet_from: r?.regular ? r.quiet_from : null };
  }

  /** One dirty row → its synced record. A failure is logged and left dirty (tried again next time). */
  function projectOne(entity, row, desired, done, key) {
    try {
      db.transaction(() => done.run(syncRecord(entity, row.record_id, desired, key), key))();
      return true;
    } catch (err) {
      log?.error?.(`couldn't bring ${entity} ${key} up to date (tried again later):`, err);
      return false;
    }
  }

  /** The projection in chunks of PROJECT_CHUNK rows, one transaction each; yields after each chunk. */
  function* projectChunks(state) {
    const kinds = [
      [q.dirtyOrders, 'wholesale_order', desiredOrder, q.orderDone],
      [q.dirtyMoney, 'wholesale_entry', desiredEntry, q.moneyDone],
      [q.dirtyCustomers, 'wholesale_customer', desiredCustomer, q.customerDone],
      [q.dirtyNotes, 'wholesale_note', desiredNote, q.noteDone], // D5
    ];
    for (const [select, entity, desired, done] of kinds) {
      let after = '';
      for (;;) {
        const rows = select.all(after);
        if (!rows.length) break;
        db.transaction(() => {
          for (const r of rows) if (!projectOne(entity, r, desired(r), done, r.uid)) state.failed += 1;
        })();
        after = rows[rows.length - 1].uid;
        yield;
      }
    }
  }

  /** Bring every dirty held row's synced record up to date (in chunks; failures stay dirty). */
  function project() {
    const state = { failed: 0 };
    for (const _ of projectChunks(state)); // eslint-disable-line no-unused-vars, no-empty
    return state;
  }

  /** The same, giving the event loop a turn between chunks (big reconciles, the start after a restore). */
  async function projectAsync() {
    const state = { failed: 0 };
    for (const _ of projectChunks(state)) await yieldNow(); // eslint-disable-line no-unused-vars
    return state;
  }

  // ---- people's actions (the Wholesale page) ---------------------------------------------------
  function heldOr404(uid) {
    const c = isId(uid) ? q.customer.get(uid) : null;
    if (!c) throw new HttpError(404, 'No such Order Manager customer here', undefined, { code: 'not_found' });
    return c;
  }
  const writeAs = (actor) => (args) => {
    const r = sync.applyLocal({ actor, ...args });
    if (!['applied', 'clash'].includes(r.status)) {
      throw new HttpError(r.code === 'already_linked' ? 409 : 400, r.reason ?? `${args.entity}: ${r.code}`, undefined, { code: r.code });
    }
    return r;
  };
  /** D2: why a person's link was made, as given by the review page ("similar name"), or none. */
  const reasonText = (r) => (typeof r === 'string' && r.trim() ? clip(r.trim(), 200) : null);
  function refuseIfLinked(c) {
    const links = crm.liveLinks(APP, c.uid).filter((l) => l.account_id);
    if (links.length) {
      throw new HttpError(409, 'This customer is already linked to an account: undo that link first', undefined, { code: 'already_linked' });
    }
  }

  /** The customer's snapshot as CRM fields: account (address), contact, and what can't be stored (notes). */
  function crmFieldsOf(c) {
    const s = parse(c.snapshot) ?? {};
    const a = s.address ?? {};
    const notes = [];
    const postal = a.postal_code ? FORMATS.postal.normalize(String(a.postal_code)) : null;
    const postalOk = postal && FORMATS.postal.valid(postal);
    if (a.postal_code && !postalOk) notes.push(`Postal code as typed: ${a.postal_code}`);
    const email = c.email ? normalizeEmail(c.email) : null;
    const phone = c.phone ? normalizePhone(c.phone) : null;
    for (const p of s.contact_problems ?? []) notes.push(`${p.field === 'email' ? 'Email' : 'Phone'} as typed in the Order Manager: ${p.as_typed}`);
    const name = c.business_name || c.contact_name || `Order Manager customer #${c.number ?? '?'}`;
    return {
      name: clip(name, 200),
      account: {
        name: clip(name, 200),
        street: clip([a.line1, a.line2].filter(Boolean).join(', ') || null, 300),
        city: clip(a.city ?? null, 100),
        region: clip(a.province ?? null, 100),
        postal_code: postalOk ? postal : null,
        country: clip(a.country ?? null, 60),
        notes: clip([s.notes, ...notes].filter(Boolean).join('\n') || null, 20_000),
      },
      contact: c.contact_name || (email && FORMATS.email.valid(email)) || (phone && FORMATS.phone.valid(phone)) ? {
        name: clip(c.contact_name || name, 200),
        email: email && FORMATS.email.valid(email) ? email : null,
        phone: phone && FORMATS.phone.valid(phone) ? phone : null,
      } : null,
    };
  }

  /**
   * Link a waiting customer to an existing client: to one of its accounts (accountId), or to a new
   * account under it named after the customer (no accountId). Makes the CRM link (approved; D2:
   * `reason` = the suggestion's, e.g. "similar name"), then attaches everything held. One
   * transaction: all of it or nothing. (D2) A new account is recorded for Undo.
   */
  function linkToClient(uid, { clientId, accountId = null, reason = null }, { actor }) {
    const c = heldOr404(uid);
    if (!isId(clientId) || !crm.clientNames([clientId]).has(clientId)) throw new HttpError(400, 'Pick a client that is still here', undefined, { code: 'no_client' });
    if (accountId !== null && accountId !== undefined) {
      const account = crm.liveAccount(accountId);
      if (!account || account.client_id !== clientId) throw new HttpError(400, 'That account isn’t one of this client’s', undefined, { code: 'no_account' });
    }
    const write = writeAs(actor);
    db.transaction(() => {
      refuseIfLinked(c);
      let account = accountId;
      if (!account) {
        const f = crmFieldsOf(c);
        account = write({ entity: 'account', op: 'create', fields: { client_id: clientId, ...f.account } }).recordId;
        linkChanges.record({ customerUid: uid, accountId: account, change: 'account_created', entity: 'account', recordId: account, actor });
      }
      const link = write({ entity: 'link', op: 'create', fields: { account_id: account, app: APP, external_id: uid, matched_by: 'approved', match_reason: reasonText(reason) } });
      linkChanges.setLink(uid, link.recordId);
      reconcile({ only: [uid], actor });
    })();
    flushAttachments();
    return linkedView(q.customer.get(uid));
  }

  /** Make a client (with its account, contact and the link) from a waiting customer. */
  function createClient(uid, { actor }) {
    const c = heldOr404(uid);
    const f = crmFieldsOf(c);
    const write = writeAs(actor);
    db.transaction(() => {
      refuseIfLinked(c);
      const made = (change, entity, recordId) => linkChanges.record({ customerUid: uid, accountId, change, entity, recordId, actor });
      const clientId = write({ entity: 'client', op: 'create', fields: { name: f.name, status: 'active' } }).recordId;
      const accountId = write({ entity: 'account', op: 'create', fields: { client_id: clientId, ...f.account } }).recordId;
      made('client_created', 'client', clientId);
      made('account_created', 'account', accountId);
      if (f.contact) made('contact_created', 'contact', write({ entity: 'contact', op: 'create', fields: { client_id: clientId, account_id: accountId, ...f.contact } }).recordId);
      const link = write({ entity: 'link', op: 'create', fields: { account_id: accountId, app: APP, external_id: uid, matched_by: 'approved' } });
      linkChanges.setLink(uid, link.recordId);
      reconcile({ only: [uid], actor });
    })();
    flushAttachments();
    return linkedView(q.customer.get(uid));
  }

  /**
   * D2: what undoing a customer's link(s) would put back and what would stay (nothing is changed):
   * { restore: [text], keep: [text], tracked } — for the confirm sheet.
   */
  function undoPreview(uid) {
    heldOr404(uid);
    const links = crm.liveLinks(APP, uid).filter((l) => l.account_id);
    if (!links.length) throw new HttpError(409, 'This customer isn’t linked', undefined, { code: 'not_linked' });
    const p = linkChanges.plan(uid, links);
    return { restore: p.restore, keep: p.keep, tracked: p.tracked, links: links.map((l) => ({ id: l.id, matchedBy: l.matched_by, reason: l.match_reason ?? null })) };
  }

  /**
   * Undo a customer's account link(s) (D1's unlink; D2: a full undo). In one transaction: the links
   * are deleted, the customer is detached (its records leave the timeline; the holding area keeps
   * them, so linking again brings them all back), and what linking changed is put back — the
   * age-restricted mark, the wholesale relationship, an account or client it made — when still as
   * the link left it and nothing else uses it (linkChanges.plan says what stays and why). The pair is
   * remembered (never linked automatically again; still suggested). → the customer, and what was done.
   */
  function unlink(uid, { actor }) {
    const c = heldOr404(uid);
    const links = crm.liveLinks(APP, uid).filter((l) => l.account_id);
    if (!links.length && !c.account_id) throw new HttpError(409, 'This customer isn’t linked', undefined, { code: 'not_linked' });
    const write = writeAs(actor);
    const clientIds = new Set(links.map((l) => crm.liveAccount(l.account_id)?.client_id).filter(Boolean));
    let planned = null;
    db.transaction(() => {
      planned = linkChanges.plan(uid, links);
      for (const l of links) write({ entity: 'link', op: 'delete', recordId: l.id });
      reconcile({ only: [uid], actor });
      linkChanges.apply(planned, { actor });
      for (const clientId of clientIds) matching.markUndone(uid, clientId, actor);
    })();
    flushAttachments();
    return { ...waitingView(q.customer.get(uid)), undone: { restore: planned.restore, keep: planned.keep, tracked: planned.tracked } };
  }

  // ---- lists for the Wholesale page ---------------------------------------------------------------
  function figuresOf(uid) {
    return customerFigures(q.ordersOf.all(uid), q.moneyOf.all(uid));
  }
  function base(c) {
    const s = parse(c.snapshot);
    return {
      uid: c.uid, number: c.number, businessName: c.business_name, contactName: c.contact_name, email: c.email, phone: c.phone,
      city: s?.address?.city ?? null, contactProblems: s?.contact_problems ?? [], gone: c.gone === 1, linkProblem: c.link_problem,
      firstSeenAt: c.first_seen_at,
    };
  }
  function waitingView(c) {
    const f = figuresOf(c.uid);
    return {
      ...base(c), orders: f.order_count, lastOrderDate: f.last_order_date, spendCents: f.spend_cents,
      notes: q.notesWaitingOf.get(c.uid).n, followUpDate: c.gone ? null : (c.follow_up_date ?? null), // D5
    };
  }
  function linkedView(c, linkOf = null) {
    const f = figuresOf(c.uid);
    const account = c.account_id ? crm.liveAccount(c.account_id) : null;
    // D2: how it was linked — "Linked automatically (same email)", or by whom.
    const l = linkOf ? linkOf(c.uid) : crm.liveLinks(APP, c.uid).find((x) => x.account_id === c.account_id);
    return {
      ...base(c), orders: f.order_count, lastOrderDate: f.last_order_date, spendCents: f.spend_cents,
      accountId: c.account_id, clientId: c.client_id, accountName: account?.name ?? null, clientName: account?.client_name ?? null,
      link: l ? { id: l.id, matchedBy: l.matched_by, reason: l.match_reason ?? null, at: l.created_at ?? null, by: l.created_by ?? null } : null,
    };
  }

  const LIST_SQL = (where) => `SELECT c.* FROM wholesale_held_customers c
    LEFT JOIN (SELECT customer_uid, max(order_date) AS last FROM wholesale_held_orders
      WHERE deleted = 0 AND status = 'active' AND snapshot IS NOT NULL GROUP BY customer_uid) o ON o.customer_uid = c.uid
    WHERE ${where} AND (@like IS NULL OR c.business_name LIKE @like ESCAPE '\\' OR c.contact_name LIKE @like ESCAPE '\\'
      OR c.email LIKE @like ESCAPE '\\' OR c.phone LIKE @phone ESCAPE '\\')
    ORDER BY o.last IS NULL, o.last DESC, c.business_name COLLATE NOCASE, c.uid LIMIT @limit OFFSET @offset`;
  const COUNT_SQL = (where) => `SELECT count(*) AS n FROM wholesale_held_customers c WHERE ${where}
    AND (@like IS NULL OR c.business_name LIKE @like ESCAPE '\\' OR c.contact_name LIKE @like ESCAPE '\\'
      OR c.email LIKE @like ESCAPE '\\' OR c.phone LIKE @phone ESCAPE '\\')`;
  const lists = {
    waiting: { rows: db.prepare(LIST_SQL('c.account_id IS NULL AND c.gone = 0')), count: db.prepare(COUNT_SQL('c.account_id IS NULL AND c.gone = 0')) },
    linked: { rows: db.prepare(LIST_SQL('c.account_id IS NOT NULL')), count: db.prepare(COUNT_SQL('c.account_id IS NOT NULL')) },
  };
  const escapeLike = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

  /** Customers waiting for a client (or linked ones): newest last order first, 50 a page, searchable. */
  function list(which, { q: text = '', limit = 50, offset = 0 } = {}) {
    const term = String(text ?? '').trim();
    const digits = term.replace(/\D/g, '');
    const params = {
      like: term ? `%${escapeLike(term)}%` : null,
      phone: digits.length >= 3 ? `%${digits}%` : '\u0000',
      limit, offset,
    };
    const { limit: _l, offset: _o, ...countParams } = params;
    let view = waitingView;
    if (which === 'linked') {
      const links = new Map(crm.liveAccountLinks(APP).map((l) => [l.external_id, l]));
      view = (c) => linkedView(c, (uid) => links.get(uid) ?? null);
    }
    return { customers: lists[which].rows.all(params).map(view), total: lists[which].count.get(countParams).n, limit, offset };
  }

  function connectionInfo() {
    return {
      url: config.wholesale.connectUrl,
      path: RECEIVER_PATH,
      secret: secretState(),
      changes: q.connectionChanges.all(),
      waiting: waitingCounts(),
      paused: handle.isPaused(),
    };
  }

  /**
   * Every minute (production, src/index.js): pick up links made elsewhere (a device), then (D2) a
   * matching pass — clients and contacts changed on devices may now match a waiting customer (it does
   * nothing when nothing changed since the last pass). → stop().
   */
  function startReconciler({ everyMs = RECONCILE_EVERY_MS } = {}) {
    const timer = setInterval(() => {
      reconcileAll()
        .then(() => matching.pass())
        .catch((err) => log?.error?.('reconcile failed (tried again in a minute):', err));
    }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // ---- D3: reads for the wholesale automations (automations.js) ------------------------------
  const reads = {
    /** Held customers attached to an account (linked), with their attachment. */
    attachedCustomers: () => q.attached.all(),
    customer: (uid) => q.customer.get(uid) ?? null,
    /** A held order as it is now (after the whole request: a batch can bring "packed" and "shipped" together). */
    order: (uid) => {
      const o = q.order.get(uid);
      return o ? { ...o, snap: parse(o.snapshot) } : null;
    },
    /** A customer's held orders with what the rhythm and balance rules need. */
    ordersOf: (uid) => q.ordersFull.all(uid),
    /** A customer's held payments, refunds, returns and credit notes. */
    moneyOf: (uid) => q.moneyOf.all(uid),
    /** How many held customers are attached to an account (two Order Manager customers on one account). */
    attachedOn: (accountId) => q.attachedOn.get(accountId).n,
    figuresOf,
    /** D5: uids of held customers with a follow-up date. */
    customersWithFollowUp: () => q.withFollowUp.all().map((r) => r.uid),
  };
  if (services.automations && services.planner) {
    registerWholesaleAutomations({ automations: services.automations, planner: services.planner, crm, reads, log });
    registerFollowUpAutomation({ automations: services.automations, planner: services.planner, crm, reads });
  }
  // D2: matching (the automatic links, suggestions, "Not the same"). See matchService.js.
  const matching = createMatchService({ db, log, clock, crm, sync, services, figuresOf, reconcile, reconcileAll });

  /**
   * D5, at start (after the start's reconcile): every customer's follow-up task checked against the
   * held state — after a restore (tasks rolled back, the holding area not) and after a run that failed.
   * One 'wholesale.check' event: it runs (one run row) only when some task would change.
   */
  function checkFollowUps() {
    if (!services.automations?.emit) return [];
    return services.automations.emit(CHECK_EVENT, {
      key: newId(), name: CHECK_EVENT, time: now(), backfill: false, by: null,
      customerUid: null, orderUid: null, accountId: null, clientId: null, linked: false, data: null,
    });
  }

  return {
    receive, precheck, applyEvents, reconcile, reconcileAll, checkRestore, checkCardVersion, project, describe, status, startReconciler,
    /** D3: a customer's money owing as the Order Manager's Balances page works it out (figures.js owingByOrder). */
    owingOf: (uid) => owingByOrder(q.ordersFull.all(uid), q.moneyOf.all(uid)),
    /** Latest Order Manager order time per client (Map client_id -> at), for "last activity" elsewhere (planner). */
    lastOrderAtByClient: () => new Map(lastOrders.all().map((r) => [r.client_id, r.at])),
    /** D5: latest Order Manager order or note time per client (Map client_id -> at): "last activity" elsewhere. */
    lastActivityAtByClient: () => new Map(lastOrdersAndNotes.all().map((r) => [r.client_id, r.at])),
    checkFollowUps,
    makeSecret, secretState, connectionInfo,
    linkToClient, createClient, unlink, undoPreview, list, waitingCounts,
    /** D2: matching — pass(), suggestions(), duplicates(), counts(), dismissed(), notSame(), clearNotSame(). */
    matching,
    isPaused: () => handle.isPaused(),
  };
}
