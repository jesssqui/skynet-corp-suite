-- The WooCommerce stores (D12): each store's address, its read key (the secret encrypted with a key file, like D16's)
-- and our business; who changed what; and each store's pull state. Nothing here is synced; no order, item or customer
-- is ever stored (order lookups are live). The daily totals live in the sales module (sales_daily). See CLAUDE.md,
-- "WooCommerce stores (D12)".

-- ---- the stores (server settings, kept across restores: keepOnRestore) ---------------------------
CREATE TABLE woocommerce_stores (
  id                  TEXT PRIMARY KEY,          -- UUIDv7; its Connections row is "woo-<id without dashes>"
  name                TEXT NOT NULL,             -- the site's own name (editable)
  url                 TEXT NOT NULL UNIQUE,      -- https://tinsxpress.com (a WordPress in a folder keeps its path)
  store_key           TEXT NOT NULL UNIQUE,      -- tinsxpress.com: the store's key in sales_daily
  consumer_key        TEXT NOT NULL,             -- ck_… (names the key; useless without the secret)
  secret_enc          TEXT NOT NULL,             -- cs_… encrypted: v1:<iv>:<tag>:<ciphertext> (AES-256-GCM, lib/sealed.js)
  business_id         TEXT,                      -- one of our businesses (retail by default)
  currency            TEXT,                      -- the store's currency (read from it)
  time_zone           TEXT,                      -- the site's zone (IANA), or Etc/GMT±N from a whole-hour offset
  read_only_confirmed INTEGER NOT NULL DEFAULT 0, -- the person confirmed the key was made with permission "Read"
  position            INTEGER NOT NULL,
  added_at            TEXT NOT NULL,
  added_by            TEXT NOT NULL,
  added_device        TEXT,
  key_set_at          TEXT NOT NULL
);
-- Every change: added / key_replaced / renamed / business_changed / removed (never the secret).
CREATE TABLE woocommerce_changes (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  device_id  TEXT,
  store_id   TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);

-- ---- pull state (not kept across restores: a restore rolls sales_daily back, so the backfill runs again) ----
CREATE TABLE woocommerce_pulls (
  store_id         TEXT PRIMARY KEY,
  last_success_at  TEXT,
  last_attempt_at  TEXT,
  last_error_at    TEXT,
  last_error       TEXT,
  failures         INTEGER NOT NULL DEFAULT 0,  -- in a row (0 after a good pull)
  next_try_at      TEXT,                        -- after a failure: not before this
  window_from      TEXT,                        -- the last rolling window read
  window_to        TEXT,
  backfill_before  TEXT,                        -- days before this are still to read (null: not started)
  backfill_target  TEXT,                        -- the earliest day the backfill reads
  backfill_done_at TEXT
) WITHOUT ROWID;
