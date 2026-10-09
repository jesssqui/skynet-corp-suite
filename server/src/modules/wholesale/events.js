// The Order Manager's events (A10, its CLAUDE.md "CRM outbox"): the envelope and each event's data,
// checked before anything is applied. Pure functions — no database. A problem is a `refused` answer
// with a plain-English reason (the Order Manager parks the event and shows the reason), never a 500.
import { isId } from '@suite/shared/ids';
import { NOTE_TYPES } from './entities.js';

export const EVENT_NAMES = Object.freeze([
  'customer.created', 'customer.updated',
  'order.placed', 'order.changed', 'order.packed', 'order.shipped', 'order.cancelled', 'order.deleted', 'order.restored',
  'payment.recorded', 'return.received', 'refund.issued', 'credit_note.issued',
  // D5 (the Order Manager's A11, sent only while its "Send CRM notes to the suite" switch is on)
  'note.added', 'note.deleted', 'followup.changed',
]);
/** D5: why a note was deleted there (none = deleted by hand). */
export const NOTE_DELETE_REASONS = Object.freeze(['customer_deleted', 'gone', 'gone_after_restore']);
/** Events that carry a whole order snapshot (an upsert of the order). */
export const ORDER_SNAPSHOT_EVENTS = Object.freeze(['order.placed', 'order.changed', 'order.packed', 'order.shipped', 'order.cancelled', 'order.restored']);
/** Creation events (A10): a record the suite marked gone is live again after one of these. */
export const ORDER_CREATION_EVENTS = Object.freeze(['order.placed', 'order.restored']);

export const MAX_EVENTS = 50;
const REFUND_KINDS = ['refund', 'store_credit', 'store_credit_applied'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const optUid = (v) => v === null || v === undefined || isId(v);

/** An ISO time from the Order Manager → our stored form ("…sssZ"), or null. */
export function isoTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const optText = (v) => v === null || v === undefined || typeof v === 'string';
const optInt = (v) => v === null || v === undefined || isInt(v);

/** D5: note.added's note snapshot (A11: { note_uid, number, customer_uid, type, body, at, written_by }). */
function noteProblem(n) {
  if (!isObj(n)) return 'data.note is missing';
  if (!isId(n.note_uid)) return 'data.note.note_uid is not a permanent id (UUIDv7)';
  if (!isId(n.customer_uid)) return 'data.note.customer_uid is not a permanent id (UUIDv7)';
  if (!NOTE_TYPES.includes(n.type)) return `data.note.type must be one of ${NOTE_TYPES.join(', ')}`;
  if (typeof n.body !== 'string') return 'data.note.body must be text';
  // null allowed: the Order Manager sends isoOf(created_at), null for a note whose time a backup import lost.
  if (n.at !== null && n.at !== undefined && !isoTime(n.at)) return 'data.note.at must be an ISO date-time (or null)';
  if (!optInt(n.number)) return 'data.note.number must be a whole number';
  if (!optText(n.written_by)) return 'data.note.written_by must be text';
  return null;
}

/** null when the request body is usable, else why not (answered 400: nothing applied). */
export function bodyProblem(body) {
  if (!isObj(body)) return 'The body must be a JSON object';
  if (body.source !== undefined && body.source !== 'wom') return 'source must be "wom"';
  if (!Array.isArray(body.events)) return 'events must be a list';
  if (!body.events.length) return 'events is empty';
  if (body.events.length > MAX_EVENTS) return `At most ${MAX_EVENTS} events per request`;
  return null;
}

function customerProblem(c, { cut = false } = {}) {
  if (!isObj(c)) return 'data.customer is missing';
  if (!isId(c.customer_uid)) return 'data.customer.customer_uid is not a permanent id (UUIDv7)';
  if (cut) return null;
  if (c.business_name !== undefined && c.business_name !== null && typeof c.business_name !== 'string') return 'data.customer.business_name must be text';
  return null;
}

function orderProblem(o) {
  if (!isObj(o)) return 'data.order is missing';
  if (!isId(o.order_uid)) return 'data.order.order_uid is not a permanent id (UUIDv7)';
  if (!optUid(o.customer_uid)) return 'data.order.customer_uid is not a permanent id';
  if (!['active', 'cancelled'].includes(o.status)) return 'data.order.status must be active or cancelled';
  if (o.order_date !== null && o.order_date !== undefined && !isDate(o.order_date)) return 'data.order.order_date must be YYYY-MM-DD';
  if (!isObj(o.totals) || !isInt(o.totals.total_cents)) return 'data.order.totals.total_cents must be whole cents';
  for (const k of ['subtotal_cents', 'discount_cents', 'shipping_cents', 'tax_cents']) {
    if (o.totals[k] !== undefined && o.totals[k] !== null && !isInt(o.totals[k])) return `data.order.totals.${k} must be whole cents`;
  }
  if (o.lines !== undefined && !Array.isArray(o.lines)) return 'data.order.lines must be a list';
  return null;
}

/**
 * Check one envelope. → { ok: true } or { ok: false, reason }.
 * Exactly the A10 envelope: { name, version: 1, key, source: 'wom', time, data }.
 */
export function eventProblem(e) {
  if (!isObj(e)) return 'Not an event object';
  if (!isId(e.key)) return 'key must be a UUIDv7';
  if (!EVENT_NAMES.includes(e.name)) return `Unknown event "${String(e.name).slice(0, 60)}"`;
  if (e.version !== 1) return `Version ${String(e.version).slice(0, 10)} of ${e.name} isn’t understood here (only 1)`;
  if (e.source !== 'wom') return 'source must be "wom"';
  if (!isoTime(e.time)) return 'time must be an ISO date-time';
  const d = e.data;
  if (!isObj(d)) return 'data is missing';
  const removed = d.removed === true;
  switch (e.name) {
    case 'customer.created':
    case 'customer.updated':
      return customerProblem(d.customer, { cut: d.deleted === true });
    case 'order.deleted':
      if (!isId(d.order_uid)) return 'data.order_uid is not a permanent id (UUIDv7)';
      if (d.order !== null && d.order !== undefined) {
        const p = orderProblem(d.order);
        if (p) return p;
        if (d.order.order_uid !== d.order_uid) return 'data.order is another order than data.order_uid';
      }
      return optUid(d.customer_uid) ? null : 'data.customer_uid is not a permanent id';
    case 'payment.recorded': {
      const p = d.payment;
      if (!isObj(p) || !isId(p.payment_uid)) return 'data.payment.payment_uid is not a permanent id (UUIDv7)';
      if (!optUid(p.customer_uid) || !optUid(p.order_uid)) return 'data.payment names its customer or order wrongly';
      if (!removed && !isInt(p.amount_cents)) return 'data.payment.amount_cents must be whole cents';
      if (!['recorded', 'edited', 'removed'].includes(d.change ?? 'recorded')) return 'data.change must be recorded, edited or removed';
      return null;
    }
    case 'refund.issued': {
      const r = d.refund;
      if (!isObj(r) || !isId(r.refund_uid)) return 'data.refund.refund_uid is not a permanent id (UUIDv7)';
      if (!optUid(r.customer_uid) || !optUid(r.order_uid)) return 'data.refund names its customer or order wrongly';
      if (removed) return null;
      if (!REFUND_KINDS.includes(r.kind)) return 'data.refund.kind must be refund, store_credit or store_credit_applied';
      return isInt(r.amount_cents) ? null : 'data.refund.amount_cents must be whole cents';
    }
    case 'return.received': {
      const r = d.return;
      if (!isObj(r) || !isId(r.return_uid)) return 'data.return.return_uid is not a permanent id (UUIDv7)';
      if (!optUid(r.customer_uid) || !optUid(r.order_uid)) return 'data.return names its customer or order wrongly';
      if (removed) return null;
      if (r.items !== undefined && !Array.isArray(r.items)) return 'data.return.items must be a list';
      return r.amount_cents === undefined || r.amount_cents === null || isInt(r.amount_cents) ? null : 'data.return.amount_cents must be whole cents';
    }
    case 'credit_note.issued': {
      const n = d.credit_note;
      if (!isObj(n) || !isId(n.credit_note_uid)) return 'data.credit_note.credit_note_uid is not a permanent id (UUIDv7)';
      if (!optUid(n.customer_uid) || !optUid(n.order_uid)) return 'data.credit_note names its customer or order wrongly';
      if (removed) return null;
      if (!isInt(n.amount_cents)) return 'data.credit_note.amount_cents must be whole cents';
      for (const k of ['subtotal_cents', 'tax_cents', 'shipping_cents']) {
        if (n[k] !== undefined && n[k] !== null && !isInt(n[k])) return `data.credit_note.${k} must be whole cents`;
      }
      return null;
    }
    case 'note.added':
      return noteProblem(d.note);
    case 'note.deleted': {
      const n = d.note;
      if (!isObj(n) || !isId(n.note_uid)) return 'data.note.note_uid is not a permanent id (UUIDv7)';
      if (!optUid(n.customer_uid)) return 'data.note.customer_uid is not a permanent id';
      if (!optInt(n.number)) return 'data.note.number must be a whole number';
      if (d.reason !== undefined && d.reason !== null && !NOTE_DELETE_REASONS.includes(d.reason)) {
        return `data.reason must be one of ${NOTE_DELETE_REASONS.join(', ')} (or left out: deleted by hand)`;
      }
      return null;
    }
    case 'followup.changed':
      if (!isId(d.customer_uid)) return 'data.customer_uid is not a permanent id (UUIDv7)';
      if (d.follow_up_date !== null && !isDate(d.follow_up_date)) return 'data.follow_up_date must be YYYY-MM-DD or null';
      if (typeof d.done !== 'boolean') return 'data.done must be true or false';
      if (d.done && d.follow_up_date !== null) return 'data.done can only be true when follow_up_date is null (the follow-up was marked done)';
      return null;
    default: // the order events with a snapshot
      return orderProblem(d.order);
  }
}

/** The figures kept beside an order snapshot (cents). goods = subtotal − discounts (no tax, no shipping). */
export function orderFigures(o) {
  const t = o.totals ?? {};
  const subtotal = isInt(t.subtotal_cents) ? t.subtotal_cents : 0;
  const discount = isInt(t.discount_cents) ? t.discount_cents : 0;
  return {
    goods: subtotal - discount,
    tax: isInt(t.tax_cents) ? t.tax_cents : 0,
    shipping: isInt(t.shipping_cents) ? t.shipping_cents : 0,
    total: t.total_cents,
  };
}

/** "5 × Zyn Cool Mint 6mg, 2 × ALP Mango" (one per product name, in line order), and the units. */
export function itemsSummary(lines = [], max = 2000) {
  const byName = new Map();
  let units = 0;
  for (const l of Array.isArray(lines) ? lines : []) {
    const q = Number.isFinite(l?.quantity) ? l.quantity : 0;
    units += q;
    const name = String(l?.name ?? l?.sku ?? 'Item');
    byName.set(name, (byName.get(name) ?? 0) + q);
  }
  let text = [...byName].map(([name, q]) => `${q} × ${name}`).join(', ');
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return { text, units };
}
