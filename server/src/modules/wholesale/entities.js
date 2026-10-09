// What devices see of the Order Manager (D1): synced record types written by the server only.
// The holding area (wholesale_held_*) is the source of truth; these are its projection for linked
// customers, made and kept up to date through sync.applyLocal (actor 'system'), so devices pull
// them like any CRM record and show them offline. A device can't create, change or delete one: the
// check hook refuses every device step (as C8's alerts do), whatever its fields.
//
// Each belongs to (parent) the account its customer is linked to; `client_id` is that account's
// client (a plain ref, kept in step when an account moves), so the client page and list find them.
// Deleted only when a link goes away (detached): a cancel or delete in the Order Manager is a status.

export const ENTRY_KINDS = Object.freeze(['payment', 'refund', 'store_credit', 'credit_applied', 'return', 'credit_note']);
export const ORDER_STATUSES = Object.freeze(['active', 'cancelled', 'deleted']);
export const ENTRY_STATUSES = Object.freeze(['live', 'removed']);
/** D5: the Order Manager's CRM note types (A11's note.added). */
export const NOTE_TYPES = Object.freeze(['note', 'call', 'email', 'meeting', 'follow_up']);

const ACCOUNT = { type: 'id', ref: 'account', parent: true, required: true };
const CLIENT = { type: 'id', ref: 'client', required: true };
const UID = { type: 'text', max: 64, required: true };
const CENTS = { type: 'integer' };

export const WHOLESALE_ENTITIES = [
  {
    entity: 'wholesale_customer',
    table: 'wholesale_customers',
    fields: {
      account_id: ACCOUNT,
      client_id: CLIENT,
      customer_uid: UID,
      number: { type: 'integer' },
      name: { type: 'text', max: 300 },
      contact_name: { type: 'text', max: 300 },
      gone: { type: 'boolean' },
      order_count: { type: 'integer' },
      first_order_date: { type: 'date' },
      last_order_date: { type: 'date' },
      sales_cents: CENTS,
      given_back_cents: CENTS,
      spend_cents: CENTS,
      paid_cents: CENTS,
      credit_cents: CENTS,
      // D3: a regular's ordering rhythm (figures.js orderRhythm), null when not a regular. The card
      // shows "Quiet regular" from quiet_from on — a date, so each device sees it on the right day
      // without the card changing; a new order moves it (the card is projected again).
      usual_gap_days: { type: 'integer' },
      quiet_from: { type: 'date' },
      // D5: the customer's follow-up date in the Order Manager (null: none, or deleted there).
      follow_up_date: { type: 'date' },
    },
  },
  {
    entity: 'wholesale_order',
    table: 'wholesale_orders',
    fields: {
      account_id: ACCOUNT,
      client_id: CLIENT,
      customer_uid: UID,
      order_uid: UID,
      number: { type: 'integer' },
      reference: { type: 'text', max: 200 },
      order_date: { type: 'date' },
      at: { type: 'datetime', required: true },
      status: { type: 'enum', values: ORDER_STATUSES, required: true },
      history_only: { type: 'boolean' },
      goods_cents: CENTS,
      tax_cents: CENTS,
      shipping_cents: CENTS,
      total_cents: CENTS,
      paid_cents: CENTS,
      returned_cents: CENTS,
      item_count: { type: 'integer' },
      items: { type: 'text', max: 2000 },
      packing: { type: 'text', max: 40 },
    },
  },
  {
    entity: 'wholesale_entry',
    table: 'wholesale_entries',
    fields: {
      account_id: ACCOUNT,
      client_id: CLIENT,
      customer_uid: UID,
      uid: UID,
      kind: { type: 'enum', values: ENTRY_KINDS, required: true },
      order_uid: { type: 'text', max: 64 },
      order_number: { type: 'integer' },
      number: { type: 'text', max: 40 },
      amount_cents: CENTS,
      method: { type: 'text', max: 40 },
      at: { type: 'datetime', required: true },
      status: { type: 'enum', values: ENTRY_STATUSES, required: true },
      removed_reason: { type: 'text', max: 60 },
      moved_to: { type: 'text', max: 40 },
      detail: { type: 'text', max: 2000 },
    },
  },
  // D5: one per CRM note of a linked customer (A11's note.added): a call, an email, a meeting, a note
  // or a follow-up marked done there. Deleted here when the note is deleted there, or its customer is
  // unlinked or deleted — the holding area keeps it, so linking again brings it back.
  {
    entity: 'wholesale_note',
    table: 'wholesale_notes',
    fields: {
      account_id: ACCOUNT,
      client_id: CLIENT,
      customer_uid: UID,
      note_uid: UID,
      number: { type: 'integer' },
      type: { type: 'enum', values: NOTE_TYPES, required: true },
      body: { type: 'text', max: 20_000 },
      at: { type: 'datetime', required: true },
      written_by: { type: 'text', max: 100 },
    },
  },
];

/** Devices may not write these records at all; only the server (sync.applyLocal) does. */
export function checkServerOnly({ server }) {
  if (server) return null;
  return { code: 'op_not_allowed', reason: 'Order Manager records come from the Order Manager: they can’t be changed here' };
}
