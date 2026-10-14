// The billing module's synced record types (D17/D18): quotes, invoices and credit notes with their lines, and payments
// on invoices. Registered with the sync module at start-up; devices learn them from GET /api/sync/info, so drafts are
// written offline like any record. New fields are nullable and never renamed (CLAUDE.md, rule 5).
//
// A document belongs to one of our businesses (`parent`; businesses are never deleted) — a credit note to its invoice;
// clients, accounts, relationships, services and leads are plain refs (deleting a client never hides its invoices).
// Fields marked "server" are written only by the server when a person approves a draft (number, PDF, totals); the
// module's check refuses them in a device's step (service.js).
import { QUOTE_STATUSES, INVOICE_STATUSES, CREDIT_NOTE_STATUSES, PAYMENT_METHODS, LINE_TEXT_MAX } from '@suite/shared/billing';
import { LOST_REASONS } from '@suite/shared/leads';
import { ACTORS } from '@suite/shared/actors';

const printed = {
  to_name: { type: 'text', max: 200 },
  to_lines: { type: 'text', max: 1000 },
  notes: { type: 'text', max: 5000 },
  tax_rate_bp: { type: 'integer' },
};
const totals = {
  subtotal_cents: { type: 'integer' }, // server
  tax_cents: { type: 'integer' }, // server
  total_cents: { type: 'integer' }, // server
};
const issued = {
  number: { type: 'text', max: 40 }, // server
  issue_date: { type: 'date' }, // server
  issued_at: { type: 'datetime' }, // server
  issued_by: { type: 'enum', values: ACTORS }, // server
};

export const QUOTE_ENTITY = {
  entity: 'quote',
  table: 'billing_quotes',
  ops: ['create', 'update', 'delete'], // delete: drafts only (checked)
  fields: {
    business_id: { type: 'id', ref: 'business', parent: true, required: true },
    client_id: { type: 'id', ref: 'client' },
    account_id: { type: 'id', ref: 'account' },
    relationship_id: { type: 'id', ref: 'relationship' },
    lead_id: { type: 'id', ref: 'lead' },
    status: { type: 'enum', values: QUOTE_STATUSES, required: true },
    ...printed,
    title: { type: 'text', max: 300 },
    terms: { type: 'text', max: 5000 },
    valid_until: { type: 'date' },
    number: { type: 'text', max: 40 }, // server
    sent_on: { type: 'date' }, // server
    sent_at: { type: 'datetime' }, // server
    sent_by: { type: 'enum', values: ACTORS }, // server
    ...totals,
    decided_on: { type: 'date' },
    declined_reason: { type: 'enum', values: LOST_REASONS },
    decided_note: { type: 'text', max: 2000 },
  },
};

export const INVOICE_ENTITY = {
  entity: 'invoice',
  table: 'billing_invoices',
  ops: ['create', 'update', 'delete'], // delete: drafts only (checked)
  fields: {
    business_id: { type: 'id', ref: 'business', parent: true, required: true },
    client_id: { type: 'id', ref: 'client', required: true },
    account_id: { type: 'id', ref: 'account' },
    relationship_id: { type: 'id', ref: 'relationship' },
    service_id: { type: 'id', ref: 'service' },
    quote_id: { type: 'id', ref: 'quote' },
    status: { type: 'enum', values: INVOICE_STATUSES, required: true },
    ...printed,
    title: { type: 'text', max: 300 },
    terms: { type: 'text', max: 5000 },
    due_days: { type: 'integer' },
    ...issued,
    due_date: { type: 'date' }, // server
    ...totals,
    void_on: { type: 'date' }, // server
    void_reason: { type: 'text', max: 500 }, // server
  },
};

export const CREDIT_NOTE_ENTITY = {
  entity: 'credit_note',
  table: 'billing_credit_notes',
  ops: ['create', 'update', 'delete'], // delete: drafts only (checked)
  fields: {
    invoice_id: { type: 'id', ref: 'invoice', parent: true, required: true },
    business_id: { type: 'id', ref: 'business', required: true },
    status: { type: 'enum', values: CREDIT_NOTE_STATUSES, required: true },
    reason: { type: 'text', max: 500 },
    ...printed,
    ...issued,
    ...totals,
  },
};

const lineEntity = (entity, table, parentField, parentEntity) => ({
  entity,
  table,
  ops: ['create', 'update', 'delete'], // only while the document is a draft (checked)
  fields: {
    [parentField]: { type: 'id', ref: parentEntity, parent: true, required: true },
    position: { type: 'integer' },
    description: { type: 'text', max: LINE_TEXT_MAX, required: true },
    quantity: { type: 'number' }, // null = 1
    unit_cents: { type: 'integer', required: true },
    tax_exempt: { type: 'boolean' },
  },
});
export const QUOTE_LINE_ENTITY = lineEntity('quote_line', 'billing_quote_lines', 'quote_id', 'quote');
export const INVOICE_LINE_ENTITY = lineEntity('invoice_line', 'billing_invoice_lines', 'invoice_id', 'invoice');
export const CREDIT_NOTE_LINE_ENTITY = lineEntity('credit_note_line', 'billing_credit_note_lines', 'credit_note_id', 'credit_note');

export const PAYMENT_ENTITY = {
  entity: 'invoice_payment',
  table: 'billing_payments',
  ops: ['create', 'delete'], // a correction is a delete and a new one
  fields: {
    invoice_id: { type: 'id', ref: 'invoice', parent: true, required: true },
    amount_cents: { type: 'integer', required: true },
    paid_on: { type: 'date', required: true },
    method: { type: 'enum', values: PAYMENT_METHODS },
    note: { type: 'text', max: 500 },
  },
};

export const BILLING_ENTITIES = [
  QUOTE_ENTITY, QUOTE_LINE_ENTITY, INVOICE_ENTITY, INVOICE_LINE_ENTITY, PAYMENT_ENTITY, CREDIT_NOTE_ENTITY, CREDIT_NOTE_LINE_ENTITY,
];
export const BILLING_ENTITY_NAMES = BILLING_ENTITIES.map((e) => e.entity);

/** Fields only the server writes (a device's step naming one is refused). */
export const SERVER_FIELDS = Object.freeze({
  quote: ['number', 'sent_on', 'sent_at', 'sent_by', 'subtotal_cents', 'tax_cents', 'total_cents'],
  invoice: ['number', 'issue_date', 'issued_at', 'issued_by', 'due_date', 'subtotal_cents', 'tax_cents', 'total_cents', 'void_on', 'void_reason'],
  credit_note: ['number', 'issue_date', 'issued_at', 'issued_by', 'subtotal_cents', 'tax_cents', 'total_cents'],
});
/** Printed fields: changed only while the document is a draft (what was sent or issued never changes). */
export const CONTENT_FIELDS = Object.freeze({
  quote: ['business_id', 'to_name', 'to_lines', 'title', 'notes', 'terms', 'valid_until', 'tax_rate_bp'],
  invoice: ['business_id', 'to_name', 'to_lines', 'title', 'notes', 'terms', 'due_days', 'tax_rate_bp', 'quote_id'],
  credit_note: ['invoice_id', 'business_id', 'reason', 'to_name', 'to_lines', 'notes', 'tax_rate_bp'],
});
