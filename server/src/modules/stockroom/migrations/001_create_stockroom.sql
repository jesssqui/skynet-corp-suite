-- Stock tasks from Stockroom (D16): the read-only connection to Stockroom (the Inventory Hub on Fly),
-- what the last pulls brought, and the reorder "episodes" its automations keep. Nothing here is synced:
-- devices see only the tasks the automations make (planner tasks, through sync). See CLAUDE.md,
-- "Stock tasks from Stockroom (D16)".

-- ---- the connection (server settings, not synced; kept across restores: keepOnRestore) ----------
-- One row: Stockroom's address, the reader key and its secret — the secret encrypted with the key
-- file in the data folder (config.stockroom.keyFile, never in the database: backups hold no usable
-- secret; a hash can't work, signing needs the secret itself).
CREATE TABLE stockroom_connection (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  hub_url        TEXT NOT NULL,             -- https://stockroom-hub.fly.dev
  reader_key     TEXT NOT NULL,             -- suite.<12 hex> (not secret: it names the credential)
  secret_enc     TEXT NOT NULL,             -- v1:<iv>:<tag>:<ciphertext>, AES-256-GCM, base64url
  set_at         TEXT NOT NULL,
  set_by         TEXT NOT NULL,             -- owner | partner
  set_device     TEXT,
  revoked_at     TEXT                       -- Stockroom answered 401 revoked: no more calls until a new code
);
-- Every change: connected / replaced / forgotten / revoked (never the secret).
CREATE TABLE stockroom_connection_changes (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,                 -- owner | partner | system (revoked)
  device_id  TEXT,
  action     TEXT NOT NULL,
  hub_url    TEXT,
  reader_key TEXT
);

-- ---- what the pulls brought (not kept across restores: the next pull refreshes it) -------------
-- One row per read (deliveries, differences, counts, order-soon): the last good answer, its ETag
-- (If-None-Match → 304 when nothing changed) and the last error, with a backoff.
CREATE TABLE stockroom_pulls (
  endpoint        TEXT PRIMARY KEY,
  hub_url         TEXT,                     -- the answer is from this Stockroom
  etag            TEXT,
  body            TEXT,                     -- the JSON answer (null until the first good one)
  as_of           TEXT,                     -- Stockroom's as_of
  fetched_at      TEXT,                     -- last good answer (200 or 304)
  changed_at      TEXT,                     -- last answer with different contents
  last_attempt_at TEXT,
  last_error_at   TEXT,
  last_error      TEXT,
  failures        INTEGER NOT NULL DEFAULT 0, -- in a row (0 after a good answer)
  next_try_at     TEXT                      -- after a failure: not before this
) WITHOUT ROWID;

-- ---- reorder episodes (the reorder automation's own bookkeeping; rolls back with the tasks) -----
-- One "need to reorder from a supplier" from the day something from it needs ordering until nothing
-- does or a purchase order to it is confirmed in Stockroom. One task per episode (key
-- "<supplier key>:<episode>"): a person finishing it is final for that episode; the next need is a
-- new episode and a new task.
CREATE TABLE stockroom_reorder_episodes (
  supplier_key TEXT NOT NULL,               -- sup:<supplier id> | sup:none
  episode      INTEGER NOT NULL,
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  closed_why   TEXT,                        -- empty | ordered (a PO confirmed) | gone (left Stockroom's list)
  closed_note  TEXT,
  PRIMARY KEY (supplier_key, episode)
) WITHOUT ROWID;
