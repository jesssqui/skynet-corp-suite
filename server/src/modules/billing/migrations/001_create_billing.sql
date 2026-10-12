-- Quotes, invoices and credit notes (D17, D18). See CLAUDE.md, "Quotes, invoices and credit notes (D17, D18)".
--
-- Synced record types (../entities.js): written only through sync steps (devices: drafts, decisions, payments) or
-- sync.applyLocal (the server: numbers, PDFs, sent / issued / void). Money is integer cents, Canadian dollars.
-- Columns a device may never set (number, sent_*, issue_*, due_date, totals, void_*) are written by the server when a
-- person approves a draft (billing/service.js); the module's checks refuse them in a device's step.
CREATE TABLE billing_quotes (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL,      -- one of ours (never Wholesale, Save Point Shop or Personal)
  client_id       TEXT,               -- plain refs: who it is for (a client, or a lead with no client yet)
  account_id      TEXT,
  relationship_id TEXT,
  lead_id         TEXT,
  status          TEXT NOT NULL,      -- draft | sent | accepted | declined
  to_name         TEXT,               -- printed: who it is for
  to_lines        TEXT,               -- printed: their address / email, one per line
  title           TEXT,
  notes           TEXT,
  terms           TEXT,               -- null = the business's default terms
  valid_until     TEXT,               -- "YYYY-MM-DD"; null = the business's valid days after sending
  tax_rate_bp     INTEGER,            -- basis points; null = HST 13 % (1300)
  number          TEXT,               -- server: GWND-Q-0007, given when sent
  sent_on         TEXT,               -- server: the day it was sent (the device's day)
  sent_at         TEXT,
  sent_by         TEXT,               -- owner | partner
  subtotal_cents  INTEGER,            -- server: totals as sent
  tax_cents       INTEGER,
  total_cents     INTEGER,
  decided_on      TEXT,               -- device: the day it was accepted or declined
  declined_reason TEXT,               -- a lead's lost reason (LOST_REASONS)
  decided_note    TEXT,
  created_at      TEXT,
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  flagged         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);
CREATE INDEX billing_quotes_lead ON billing_quotes (lead_id);
CREATE INDEX billing_quotes_client ON billing_quotes (client_id);
CREATE INDEX billing_quotes_status ON billing_quotes (status) WHERE deleted_at IS NULL;

CREATE TABLE billing_invoices (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL,
  client_id       TEXT NOT NULL,      -- plain refs
  account_id      TEXT,
  relationship_id TEXT,
  service_id      TEXT,               -- the CRM service it bills (an engagement), if any
  quote_id        TEXT,               -- the accepted quote it bills, if any
  status          TEXT NOT NULL,      -- draft | issued | void (paid is worked out from payments)
  to_name         TEXT,
  to_lines        TEXT,
  title           TEXT,
  notes           TEXT,
  terms           TEXT,
  due_days        INTEGER,            -- payment terms in days; null = the business's (30); 0 = due on receipt
  tax_rate_bp     INTEGER,
  number          TEXT,               -- server: GWND-INV-0012, given when issued
  issue_date      TEXT,
  issued_at       TEXT,
  issued_by       TEXT,
  due_date        TEXT,               -- server: issue_date + its terms
  subtotal_cents  INTEGER,
  tax_cents       INTEGER,
  total_cents     INTEGER,
  void_on         TEXT,
  void_reason     TEXT,
  created_at      TEXT,
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  flagged         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);
CREATE INDEX billing_invoices_client ON billing_invoices (client_id);
CREATE INDEX billing_invoices_quote ON billing_invoices (quote_id);
CREATE INDEX billing_invoices_status ON billing_invoices (status) WHERE deleted_at IS NULL;

CREATE TABLE billing_credit_notes (
  id              TEXT PRIMARY KEY,
  invoice_id      TEXT NOT NULL,      -- the issued invoice it takes money off (parent)
  business_id     TEXT NOT NULL,      -- the invoice's
  status          TEXT NOT NULL,      -- draft | issued
  reason          TEXT,
  to_name         TEXT,
  to_lines        TEXT,
  notes           TEXT,
  tax_rate_bp     INTEGER,
  number          TEXT,               -- server: GWND-CN-0002
  issue_date      TEXT,
  issued_at       TEXT,
  issued_by       TEXT,
  subtotal_cents  INTEGER,
  tax_cents       INTEGER,
  total_cents     INTEGER,
  created_at      TEXT,
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  flagged         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);
CREATE INDEX billing_credit_notes_invoice ON billing_credit_notes (invoice_id);

-- A document's lines (one table per kind, the same columns): what is billed, how many, the price of one, HST or not.
CREATE TABLE billing_quote_lines (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, position INTEGER, description TEXT NOT NULL, quantity REAL,
  unit_cents INTEGER NOT NULL, tax_exempt INTEGER,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT, flagged INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
);
CREATE INDEX billing_quote_lines_doc ON billing_quote_lines (quote_id);
CREATE TABLE billing_invoice_lines (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, position INTEGER, description TEXT NOT NULL, quantity REAL,
  unit_cents INTEGER NOT NULL, tax_exempt INTEGER,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT, flagged INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
);
CREATE INDEX billing_invoice_lines_doc ON billing_invoice_lines (invoice_id);
CREATE TABLE billing_credit_note_lines (
  id TEXT PRIMARY KEY, credit_note_id TEXT NOT NULL, position INTEGER, description TEXT NOT NULL, quantity REAL,
  unit_cents INTEGER NOT NULL, tax_exempt INTEGER,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT, flagged INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
);
CREATE INDEX billing_credit_note_lines_doc ON billing_credit_note_lines (credit_note_id);

-- A payment received on an issued invoice (create / delete: a correction is a delete and a new one). Counted in sales
-- on its day (paid_on).
CREATE TABLE billing_payments (
  id           TEXT PRIMARY KEY,
  invoice_id   TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_on      TEXT NOT NULL,
  method       TEXT,
  note         TEXT,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT, flagged INTEGER NOT NULL DEFAULT 0, deleted_at TEXT
);
CREATE INDEX billing_payments_invoice ON billing_payments (invoice_id);

-- Not synced (server only) ------------------------------------------------------------------------------------------

-- What prints on a business's documents, and its defaults. Server settings (edited on Money → Billing → Business
-- details, online), kept across restores like the switches.
CREATE TABLE billing_settings (
  business_id          TEXT PRIMARY KEY,
  legal_name           TEXT,
  address              TEXT,
  hst_number           TEXT,
  email                TEXT,
  phone                TEXT,
  website              TEXT,
  payment_instructions TEXT,
  prefix               TEXT,          -- null = the default (GWND, BC, RS, else initials)
  quote_valid_days     INTEGER,
  invoice_due_days     INTEGER,
  quote_terms          TEXT,
  invoice_terms        TEXT,
  updated_at           TEXT NOT NULL,
  updated_by           TEXT
);

-- The last number given per business and kind. Moved on only in the transaction that issues a document (with its PDF
-- and its record), so numbers have no gaps; kept across restores so a number is never given twice.
CREATE TABLE billing_counters (
  business_id TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- quote | invoice | credit_note
  last_seq    INTEGER NOT NULL,
  PRIMARY KEY (business_id, kind)
) WITHOUT ROWID;

-- Every document as it was sent or issued: its PDF, never changed (a trigger refuses updates). Kept across restores
-- (with the counters): a document a client has must stay findable even when the database is rolled back.
CREATE TABLE billing_pdfs (
  kind        TEXT NOT NULL,
  doc_id      TEXT NOT NULL,
  business_id TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  number      TEXT NOT NULL,
  to_name     TEXT,
  total_cents INTEGER,
  made_on     TEXT NOT NULL,          -- the day on the document
  made_at     TEXT NOT NULL,
  made_by     TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  pdf         BLOB NOT NULL,
  PRIMARY KEY (kind, doc_id),
  UNIQUE (business_id, kind, seq)
);
CREATE TRIGGER billing_pdfs_never_change BEFORE UPDATE ON billing_pdfs
BEGIN
  SELECT RAISE(ABORT, 'an issued document never changes');
END;
