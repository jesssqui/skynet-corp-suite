// Test kit for the Order Manager connection (D1): builds A10 events exactly as the Order Manager's
// crmOutbox.js does (wholesale-order-manager/server/src/services/crmOutbox.js — the snapshot builders
// customerSnapshot / orderSnapshot / paymentSnapshot / refundSnapshot / returnSnapshot /
// creditNoteSnapshot and the envelope), and signs requests the way its post() does.
//
//   const om = womKit();                       // a pretend Order Manager: records + events
//   const c = om.customer({ business_name: 'Corner Store', email: 'owner@corner.ca' });
//   const events = [om.customerCreated(c), om.orderPlaced(om.order(c, [{ name: 'Zyn Mint', quantity: 5, unit_price_cents: 650 }]))];
//   await postEvents(base, secret, events)     // → { status, body }
import crypto from 'node:crypto';
import { newId } from '@suite/shared/ids';

export const EVENTS_PATH = '/api/wom/events';

export function sign(secret, ts, method, path, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', secret).update(`${ts}\n${method.toUpperCase()}\n${path}\n${bodyHash}`).digest('hex');
}

/**
 * POST events the way the Order Manager does: { source, sent_at, events }, signed. Options to break
 * it: ts (unix seconds), secret override, signature override, path (what is signed), url path.
 */
export async function postEvents(base, secret, events, { ts = Math.floor(Date.now() / 1000), sigSecret = secret, signature, signPath = EVENTS_PATH, urlPath = EVENTS_PATH, body, headers = {} } = {}) {
  const raw = body ?? JSON.stringify({ source: 'wom', sent_at: new Date().toISOString(), events });
  const res = await fetch(`${base}${urlPath}`, {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'x-wom-source': 'wom',
      'x-wom-timestamp': String(ts),
      'x-wom-signature': signature ?? sign(sigSecret, ts, 'POST', signPath, raw),
      ...headers,
    },
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}

/** A pretend Order Manager: numbers its records, builds snapshots and events (A10 shapes). */
export function womKit({ by = 'admin' } = {}) {
  let n = { customer: 0, order: 0, payment: 0, refund: 0, return: 0, credit_note: 0 };
  const next = (k) => (n[k] += 1);
  const iso = (d = new Date()) => d.toISOString();
  const env = (name, data, time = iso()) => ({ name, version: 1, key: newId(), source: 'wom', time, data });

  const kit = {
    customer(over = {}) {
      return {
        customer_uid: newId(), number: next('customer'), business_name: 'Corner Store', contact_name: 'Pat Lee',
        email: null, phone: null, contact_problems: [],
        address: { line1: '12 Main St', line2: null, city: 'Simcoe', province: 'ON', postal_code: 'N3Y 4K3', country: 'Canada' },
        notes: null, tax_exempt: false, group: null, created_at: iso(), ...over,
      };
    },
    /** lines: [{ name, sku?, brand?, quantity, unit_price_cents, discount_cents? }]; tax 13 % on goods unless taxRate. */
    order(customer, lines, { order_date = '2026-10-01', shipping_cents = 0, taxRate = 0.13, status = 'active', history_only = false, order_discount_cents = 0, reference_number = null, packing = 'to_pack', ...over } = {}) {
      const ls = lines.map((l) => {
        const subtotal = l.quantity * l.unit_price_cents;
        const discount = l.discount_cents ?? 0;
        return {
          sku: l.sku ?? null, name: l.name, brand: l.brand ?? null, quantity: l.quantity,
          unit_price_cents: l.unit_price_cents, subtotal_cents: subtotal,
          discount: discount ? { type: '$', value: discount / 100 } : null, discount_cents: discount, total_cents: subtotal - discount,
        };
      });
      const subtotal = ls.reduce((s, l) => s + l.subtotal_cents, 0);
      const lineDiscounts = ls.reduce((s, l) => s + l.discount_cents, 0);
      const discount = lineDiscounts + order_discount_cents;
      const tax = Math.round((subtotal - discount) * taxRate);
      const number = next('order');
      return {
        order_uid: newId(), number, reference_number,
        customer_uid: customer ? customer.customer_uid : null,
        customer: customer ? { customer_uid: customer.customer_uid, number: customer.number, business_name: customer.business_name, contact_name: customer.contact_name, email: customer.email, phone: customer.phone } : null,
        order_date, status, cancelled_at: status === 'cancelled' ? iso() : null, history_only, created_at: iso(),
        lines: ls,
        discount: order_discount_cents ? { type: '$', value: order_discount_cents / 100 } : null,
        totals: {
          subtotal_cents: subtotal, line_discounts_cents: lineDiscounts, order_discount_cents, other_discount_cents: 0,
          discount_cents: discount, shipping_cents, tax_cents: tax, tax_rate: taxRate * 100, tax_province: 'ON',
          total_cents: subtotal - discount + shipping_cents + tax,
        },
        packing: { state: history_only ? 'history' : packing, packed_at: null, packed_by: null, shipped_at: null, shipped_by: null, shipped_via: null, tracking_number: null, carrier_service: null },
        notes: null, tags: [], ...over,
      };
    },
    payment(order, amount_cents, over = {}) {
      return {
        payment_uid: newId(), number: next('payment'), customer_uid: order.customer_uid, order_uid: order.order_uid, order_number: order.number,
        amount_cents, method: 'etransfer', payment_date: order.order_date, reference_number: null, notes: null,
        history_entry: false, recorded_by: by, created_at: iso(), ...over,
      };
    },
    refund(order, amount_cents, { kind = 'refund', method = kind === 'refund' ? 'etransfer' : null, return_uid = null, items = [], ...over } = {}) {
      return {
        refund_uid: newId(), number: next('refund'), order_uid: order.order_uid, order_number: order.number, customer_uid: order.customer_uid,
        kind, amount_cents, items, reason: 'Customer asked', issued_by: by, created_at: iso(), method, return_uid, ...over,
      };
    },
    return(order, items, { outcome = 'refund', amount_cents = 0, refund_method, credit_note_uid, reason = 'Damaged in transit' } = {}) {
      return {
        return_uid: newId(), number: next('return'), order_uid: order.order_uid, order_number: order.number, customer_uid: order.customer_uid,
        received_at: iso(), items, note: reason, reason, outcome, amount_cents,
        ...(refund_method ? { refund_method } : {}), ...(credit_note_uid ? { credit_note_uid } : {}),
      };
    },
    creditNote(order, { subtotal_cents, tax_cents, shipping_cents = 0, return_uid = null, lines = [], reason = 'Returned' }) {
      const number = next('credit_note');
      return {
        credit_note_uid: newId(), number: `CN-${String(number).padStart(4, '0')}`, order_uid: order.order_uid, order_number: order.number,
        customer_uid: order.customer_uid, amount_cents: subtotal_cents + tax_cents + shipping_cents, lines, reason, issued_at: iso(),
        return_uid, subtotal_cents, tax_cents, shipping_cents,
      };
    },

    // ---- events (data beyond `by` / `backfill`, as the A10 table) ----
    customerCreated: (customer, extra = {}) => env('customer.created', { by, ...extra, customer }),
    customerUpdated: (customer, extra = {}) => env('customer.updated', { by, change: 'edited', ...extra, customer }),
    customerDeleted: (customer) => env('customer.updated', { by, change: 'deleted', deleted: true, customer }),
    orderPlaced: (order, extra = {}) => env('order.placed', { by, source: 'order', ...extra, order }),
    orderChanged: (order, extra = {}) => env('order.changed', { by, change: 'edited', changes: [], change_uid: newId(), ...extra, order }),
    orderPacked: (order, extra = {}) => env('order.packed', { by, change: 'packed', ...extra, order }),
    orderShipped: (order, extra = {}) => env('order.shipped', { by, change: 'shipped', via: 'delivered', ...extra, order }),
    orderCancelled: (order) => env('order.cancelled', { by, changes: [], change_uid: newId(), order }),
    orderDeleted: (order, extra = {}) => env('order.deleted', { by, order_uid: order.order_uid, order, ...extra }),
    orderGone: (order, reason = 'gone') => env('order.deleted', { by, backfill: true, reason, order_uid: order.order_uid, order: null, number: order.number, customer_uid: order.customer_uid }),
    orderRestored: (order) => env('order.restored', { by, order }),
    paymentRecorded: (payment, extra = {}) => env('payment.recorded', { by, change: 'recorded', ...extra, payment }),
    paymentEdited: (payment) => env('payment.recorded', { by, change: 'edited', payment }),
    paymentRemoved: (payment, { reason = 'deleted', moved_to } = {}) => env('payment.recorded', { by, change: 'removed', removed: true, reason, ...(moved_to ? { moved_to } : {}), payment }),
    refundIssued: (refund) => env('refund.issued', { by, change: 'issued', refund }),
    refundGone: (refund) => env('refund.issued', { by, backfill: true, change: 'removed', removed: true, reason: 'gone', refund: { refund_uid: refund.refund_uid, number: refund.number, order_uid: refund.order_uid, customer_uid: refund.customer_uid } }),
    returnReceived: (ret) => env('return.received', { by, return: ret }),
    creditNoteIssued: (note) => env('credit_note.issued', { by, credit_note: note }),
  };
  return kit;
}

/**
 * A10's sample stream: a customer and everything that happens to its orders, every event kind once
 * at least (the Done-when check replays it twice). → { events, customer, orders, expected }
 */
export function sampleStream(om = womKit()) {
  const customer = om.customer({ business_name: 'Lefty’s Vape Shop', contact_name: 'Lefty', email: 'lefty@leftys.ca', phone: '5195550100' });
  const o1 = om.order(customer, [{ name: 'Zyn Cool Mint 6mg', sku: 'ZYN-CM6', brand: 'Zyn', quantity: 10, unit_price_cents: 650 }, { name: 'ALP Mango', sku: 'ALP-M', quantity: 5, unit_price_cents: 700 }], { order_date: '2026-09-28' });
  // 6500 + 3500 = 10000 goods, 1300 tax → 11300
  const p1 = om.payment(o1, 11300);
  const o1edit = { ...o1, notes: 'Leave at back door' };
  const o1packed = { ...o1edit, packing: { ...o1.packing, state: 'packed', packed_at: new Date().toISOString(), packed_by: 'sam' } };
  const o1shipped = { ...o1packed, packing: { ...o1packed.packing, state: 'shipped', shipped_at: new Date().toISOString(), shipped_by: 'sam', shipped_via: 'delivered' } };
  const ret = om.return(o1, [{ sku: 'ALP-M', name: 'ALP Mango', quantity: 1, restocked: false }], { outcome: 'refund', amount_cents: 791, refund_method: 'etransfer' });
  const r1 = om.refund(o1, 791, { return_uid: ret.return_uid });
  const o2 = om.order(customer, [{ name: 'Velo Freeze 10mg', quantity: 4, unit_price_cents: 500 }], { order_date: '2026-10-02' }); // 2000 + 260 = 2260
  const ret2 = om.return(o2, [{ name: 'Velo Freeze 10mg', quantity: 2, restocked: true }], { outcome: 'credit_note', amount_cents: 1130 });
  const cn = om.creditNote(o2, { subtotal_cents: 1000, tax_cents: 130, return_uid: ret2.return_uid });
  const o3 = om.order(customer, [{ name: 'Zyn Cool Mint 6mg', quantity: 2, unit_price_cents: 650 }], { order_date: '2026-10-03' }); // 1300 + 169
  const o3cancelled = { ...o3, status: 'cancelled', cancelled_at: new Date().toISOString() };
  const o4 = om.order(customer, [{ name: 'ALP Mango', quantity: 3, unit_price_cents: 700 }], { order_date: '2026-10-04' }); // 2100 + 273 = 2373
  const p4 = om.payment(o4, 2373);
  const o5 = om.order(customer, [{ name: 'Velo Freeze 10mg', quantity: 1, unit_price_cents: 500 }], { order_date: '2026-10-05' }); // 500 + 65
  const sc = om.refund(o4, 500, { kind: 'store_credit' });
  const used = om.refund(o5, -500, { kind: 'store_credit_applied' });
  const events = [
    om.customerCreated(customer),
    om.orderPlaced(o1), om.paymentRecorded(p1),
    om.orderChanged(o1edit), om.orderPacked(o1packed), om.orderShipped(o1shipped),
    om.returnReceived(ret), om.refundIssued(r1),
    om.orderPlaced(o2), om.returnReceived(ret2), om.creditNoteIssued(cn),
    om.orderPlaced(o3), om.orderCancelled(o3cancelled),
    om.orderPlaced(o4), om.paymentRecorded(p4),
    // A7: o4 deleted, its payment kept as store credit; then restored with its payment.
    om.paymentRemoved(p4, { reason: 'order_deleted', moved_to: 'store_credit' }), om.orderDeleted(o4),
    om.orderRestored(o4), om.paymentRecorded(p4, { reason: 'order_restored' }),
    om.refundIssued(sc),
    om.orderPlaced(o5), om.refundIssued(used),
    om.customerUpdated({ ...customer, phone: '5195550199' }),
  ];
  return { events, customer, orders: { o1, o2, o3, o4, o5 }, money: { p1, p4, r1, sc, used, ret, ret2, cn } };
}
