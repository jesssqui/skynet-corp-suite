-- eBay (D13): Save Point Shop's eBay account, read with the seller's own sign-in (OAuth, sell.fulfillment.readonly).
-- The keyset (App ID, Cert ID — encrypted —, RuName), the refresh token (encrypted, with its expiry), the account name
-- seen on its orders, the zone its days are counted in; who changed what; sign-ins in progress; the pull state; and
-- the orders waiting to ship (no buyer details). Daily totals live in the sales module (sales_daily, source 'ebay').
-- See CLAUDE.md, "eBay (D13)".

-- ---- the connection (server settings, kept across restores: keepOnRestore) -------------------------
CREATE TABLE ebay_connection (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),   -- one row
  app_id              TEXT NOT NULL,     -- Client ID (public: it is in the consent page's address anyway)
  cert_enc            TEXT NOT NULL,     -- Cert ID (Client Secret), AES-256-GCM with the key file (lib/sealed.js)
  ru_name             TEXT NOT NULL,     -- the RuName (eBay Redirect URL name; public, also in the consent address)
  refresh_enc         TEXT,              -- the refresh token, encrypted (null = not signed in)
  refresh_expires_at  TEXT,              -- when eBay says it lapses (~18 months after the sign-in)
  scopes              TEXT,              -- the scopes it was granted for
  account             TEXT,              -- the seller's eBay user ID, from its orders' sellerId (null until one is seen)
  time_zone           TEXT NOT NULL,     -- the shop's days are counted in this zone (America/Toronto by default)
  currency            TEXT NOT NULL DEFAULT 'CAD',  -- the account's main currency (ebay.ca)
  keyset_set_at       TEXT NOT NULL,
  keyset_set_by       TEXT NOT NULL,
  signed_in_at        TEXT,
  signed_in_by        TEXT,
  signed_out_at       TEXT,              -- eBay refused the refresh token (expired, revoked): sign in again
  signed_out_reason   TEXT
);
-- Every change: keyset_set / signed_in / signed_out / forgotten / settings (never a secret or token).
CREATE TABLE ebay_changes (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  device_id  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT
);

-- ---- sign-ins in progress: the `state` sent to eBay (only its SHA-256), 30 minutes, used once ----------
CREATE TABLE ebay_sign_ins (
  state_hash  TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  device_id   TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
) WITHOUT ROWID;

-- ---- the pull (not kept across restores: the next pull re-reads the window, and the backfill when needed) -----
CREATE TABLE ebay_pulls (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  last_success_at  TEXT,
  last_attempt_at  TEXT,
  last_error_at    TEXT,
  last_error       TEXT,
  failures         INTEGER NOT NULL DEFAULT 0,
  next_try_at      TEXT,
  window_from      TEXT,
  window_to        TEXT,
  backfill_from    TEXT,              -- the first day the backfill read (the 1st of a month, 13 months back)
  backfill_done_at TEXT,
  currencies       TEXT,              -- JSON list of the currencies its days were written in
  orders_read      INTEGER
);

-- ---- orders waiting to ship, and those that stopped waiting (for their task) — no buyer details ----------
CREATE TABLE ebay_ship_orders (
  order_id       TEXT PRIMARY KEY,
  created_at     TEXT,
  status         TEXT,      -- orderFulfillmentStatus
  cancel_state   TEXT,
  payment_status TEXT,
  ship_by        TEXT,      -- ISO time (UTC) from eBay
  total          INTEGER,   -- cents
  currency       TEXT,
  items          TEXT NOT NULL,   -- JSON [{ title, sku, quantity }]
  waiting        INTEGER NOT NULL,  -- 1 = waiting to ship now
  seen_at        TEXT NOT NULL
) WITHOUT ROWID;
