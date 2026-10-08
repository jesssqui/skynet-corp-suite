-- The wholesale connection (D1): the Order Manager's events, the holding area they are kept in, and the
-- synced records devices see for linked customers. See CLAUDE.md, "Wholesale (D1)".

-- ---- the connection (server settings, not synced; kept across restores: restore.js) -------------
-- One row: the shared secret the Order Manager signs with, encrypted with the key file in the data
-- folder (config.wholesale.keyFile — never in the database, so backups hold no usable secret).
CREATE TABLE wholesale_connection (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  secret_enc  TEXT NOT NULL,               -- v1:<iv>:<tag>:<ciphertext>, AES-256-GCM, base64url
  set_at      TEXT NOT NULL,
  set_by      TEXT NOT NULL,               -- owner | partner
  set_device  TEXT
);
-- Every new secret: who and when (never the secret).
CREATE TABLE wholesale_connection_changes (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  device_id  TEXT,
  action     TEXT NOT NULL                -- new_secret
);

-- Receiver state for the Connections row: last good request, last refused one (no secrets), counts.
CREATE TABLE wholesale_status (
  key   TEXT PRIMARY KEY,
  value TEXT
) WITHOUT ROWID;

-- Every event applied, by its request key: a key seen again is answered `duplicate` and changes
-- nothing. Refused events are not kept (the Order Manager may send them again with a new key).
-- Grows with every event (one row each); prune later (keys older than the Order Manager's retry window).
CREATE TABLE wholesale_events (
  key          TEXT PRIMARY KEY,           -- the envelope's key (UUIDv7)
  name         TEXT NOT NULL,
  time         TEXT,                       -- the envelope's time (when it happened there)
  received_at  TEXT NOT NULL,
  subject      TEXT,                       -- '<kind>:<uid>' it was about
  customer_uid TEXT,
  backfill     INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX wholesale_events_received ON wholesale_events (received_at);

-- ---- the holding area (not synced): the latest snapshot of everything the Order Manager sent ------
-- The source of truth for applying changes in order and for attaching records when a link appears.
-- `dirty` = its synced record may be out of step (projected after each request, and by reconcile).
CREATE TABLE wholesale_held_customers (
  uid           TEXT PRIMARY KEY,          -- customer_uid
  number        INTEGER,
  business_name TEXT,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  snapshot      TEXT,                      -- latest customer snapshot (JSON); null while known only from an order
  gone          INTEGER NOT NULL DEFAULT 0, -- deleted in the Order Manager
  gone_reason   TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- attachment: the account its records are under (from its live 'wom' link), or null
  account_id    TEXT,
  client_id     TEXT,
  attached_at   TEXT,
  link_problem  TEXT,                      -- 'several_links' when more than one live account link names it
  record_id     TEXT,                      -- its synced wholesale_customer record (null when none)
  dirty         INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
CREATE INDEX wholesale_held_customers_account ON wholesale_held_customers (account_id);
CREATE INDEX wholesale_held_customers_dirty ON wholesale_held_customers (dirty) WHERE dirty = 1;

CREATE TABLE wholesale_held_orders (
  uid           TEXT PRIMARY KEY,          -- order_uid
  customer_uid  TEXT,                      -- null: a guest sale (never attached)
  number        INTEGER,
  order_date    TEXT,
  status        TEXT,                      -- active | cancelled (the Order Manager's)
  deleted       INTEGER NOT NULL DEFAULT 0, -- order.deleted (in its bin, or gone): kept here, shown as deleted
  deleted_reason TEXT,
  goods_cents   INTEGER NOT NULL DEFAULT 0, -- subtotal − discounts (before tax and shipping)
  tax_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  snapshot      TEXT,                      -- latest order snapshot (JSON); null for a delete of one never seen
  placed_at     TEXT,                      -- its created_at (ISO)
  updated_at    TEXT NOT NULL,
  record_id     TEXT,                      -- its synced wholesale_order record
  dirty         INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
CREATE INDEX wholesale_held_orders_customer ON wholesale_held_orders (customer_uid);
CREATE INDEX wholesale_held_orders_dirty ON wholesale_held_orders (dirty) WHERE dirty = 1;

-- Payments, refunds (money back, store credit, store credit used), returns and credit notes.
CREATE TABLE wholesale_held_money (
  uid           TEXT PRIMARY KEY,          -- payment_uid / refund_uid / return_uid / credit_note_uid
  kind          TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'return', 'credit_note')),
  sub_kind      TEXT,                      -- refunds: refund | store_credit | store_credit_applied
  customer_uid  TEXT,
  order_uid     TEXT,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  subtotal_cents INTEGER,                  -- credit notes: before tax and shipping
  removed       INTEGER NOT NULL DEFAULT 0,
  removed_reason TEXT,
  moved_to      TEXT,                      -- 'store_credit': a payment of a deleted order kept as credit (A7)
  at            TEXT,                      -- when it happened there (ISO)
  snapshot      TEXT,
  updated_at    TEXT NOT NULL,
  record_id     TEXT,                      -- its synced wholesale_entry record
  dirty         INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
CREATE INDEX wholesale_held_money_customer ON wholesale_held_money (customer_uid);
CREATE INDEX wholesale_held_money_order ON wholesale_held_money (order_uid);
CREATE INDEX wholesale_held_money_dirty ON wholesale_held_money (dirty) WHERE dirty = 1;

-- ---- what devices see (synced; written by the server only — the check hook refuses devices) ------
-- One card per linked Order Manager customer: its figures (spend, last order…), worked out here.
CREATE TABLE wholesale_customers (
  id               TEXT PRIMARY KEY,
  account_id       TEXT,                   -- parent: the account it is linked to
  client_id        TEXT,                   -- that account's client (for the client's page and list)
  customer_uid     TEXT,
  number           INTEGER,
  name             TEXT,
  contact_name     TEXT,
  gone             INTEGER,
  order_count      INTEGER,
  first_order_date TEXT,
  last_order_date  TEXT,
  sales_cents      INTEGER,
  given_back_cents INTEGER,
  spend_cents      INTEGER,
  paid_cents       INTEGER,
  credit_cents     INTEGER,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
  flagged          INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);
CREATE INDEX wholesale_customers_account ON wholesale_customers (account_id);
CREATE INDEX wholesale_customers_client ON wholesale_customers (client_id);

-- One per order of a linked customer, kept up to date (status, totals, packing). Never removed for a
-- cancel or a delete in the Order Manager: those show as its status.
CREATE TABLE wholesale_orders (
  id             TEXT PRIMARY KEY,
  account_id     TEXT,
  client_id      TEXT,
  customer_uid   TEXT,
  order_uid      TEXT,
  number         INTEGER,
  reference      TEXT,
  order_date     TEXT,
  at             TEXT,
  status         TEXT,                     -- active | cancelled | deleted
  history_only   INTEGER,
  goods_cents    INTEGER,
  tax_cents      INTEGER,
  shipping_cents INTEGER,
  total_cents    INTEGER,
  paid_cents     INTEGER,
  returned_cents INTEGER,
  item_count     INTEGER,
  items          TEXT,
  packing        TEXT,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
  flagged        INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT
);
CREATE INDEX wholesale_orders_account ON wholesale_orders (account_id);
CREATE INDEX wholesale_orders_client ON wholesale_orders (client_id);

-- One per payment, refund, store credit, credit used, return or credit note of a linked customer.
CREATE TABLE wholesale_entries (
  id             TEXT PRIMARY KEY,
  account_id     TEXT,
  client_id      TEXT,
  customer_uid   TEXT,
  uid            TEXT,
  kind           TEXT,                     -- payment | refund | store_credit | credit_applied | return | credit_note
  order_uid      TEXT,
  order_number   INTEGER,
  number         TEXT,
  amount_cents   INTEGER,
  method         TEXT,
  at             TEXT,
  status         TEXT,                     -- live | removed
  removed_reason TEXT,
  moved_to       TEXT,
  detail         TEXT,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
  flagged        INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT
);
CREATE INDEX wholesale_entries_account ON wholesale_entries (account_id);
CREATE INDEX wholesale_entries_client ON wholesale_entries (client_id);
