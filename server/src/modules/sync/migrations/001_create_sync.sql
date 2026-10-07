-- Offline sync (C2a). How it works: CLAUDE.md, "Offline sync".

-- Facts about this database's sync state.
--   generation   UUIDv7, replaced whenever the database is restored from a backup
--                (devices holding a cursor from another generation must resync)
--   restore_pending  written into a backup copy by restore.js; consumed at start (new generation)
--   last_restore_at  when the last restore was taken in
--   seq          last server sequence number handed out (one per applied change)
--   hlc          the server clock's last stamp
--   server_device_id  the device id used for changes made by the server itself
CREATE TABLE sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Every device that has pushed or pulled. A device belongs to one actor ('system' = the server itself).
-- last_pull_cursor is the device's bookmark (the cursor we last handed it).
-- last_device_hlc: newest stamp applied from it (its steps must arrive in order).
-- clock_skew_ms: device clock minus server clock at its last push (diagnostics).
CREATE TABLE sync_devices (
  device_id        TEXT PRIMARY KEY,
  actor            TEXT NOT NULL,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  last_push_at     TEXT,
  last_pull_at     TEXT,
  last_pull_cursor TEXT,
  last_device_hlc  TEXT,
  clock_skew_ms    INTEGER
) WITHOUT ROWID;

-- The change-step log: every step that was applied (or kept as a clash), exactly once.
-- `key` is the step's own UUIDv7 made on the device; a repeat is answered from here.
--   device_hlc  the stamp the device sent;  hlc  the stamp used (clamped if the device clock ran ahead)
--   seen        the server seq the device had pulled up to when it made the change (0 = unknown)
--   status      applied | clash
CREATE TABLE sync_steps (
  key         TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL UNIQUE,
  device_id   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  entity      TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('create', 'update', 'delete')),
  fields      TEXT,
  device_hlc  TEXT NOT NULL,
  hlc         TEXT NOT NULL,
  seen        INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('applied', 'clash')),
  received_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX sync_steps_record ON sync_steps (entity, record_id);

-- One row per synced record: lifecycle and when it last changed (for pulls).
CREATE TABLE sync_records (
  entity       TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  created_seq  INTEGER NOT NULL,
  created_hlc  TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  deleted_seq  INTEGER,
  deleted_hlc  TEXT,
  deleted_by   TEXT,
  deleted_device TEXT,
  deleted_step TEXT,
  flagged      INTEGER NOT NULL DEFAULT 0,
  changed_seq  INTEGER NOT NULL,
  PRIMARY KEY (entity, record_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX sync_records_changed ON sync_records (changed_seq);

-- Per-field version info for last-writer-wins.
CREATE TABLE sync_field_versions (
  entity    TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field     TEXT NOT NULL,
  hlc       TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  actor     TEXT NOT NULL,
  step_key  TEXT NOT NULL,
  PRIMARY KEY (entity, record_id, field)
) WITHOUT ROWID;

-- Concurrent changes that lost, kept for review.
--   kind 'field'  : two edits of the same field; winner is in the record, loser_value is the other one
--   kind 'delete' : a delete raced an edit; the record was kept and flagged; the loser is the delete
-- resolution 'superseded': the record was deleted afterwards on purpose, so the question no longer applies.
CREATE TABLE sync_clashes (
  id            TEXT PRIMARY KEY,
  entity        TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('field', 'delete')),
  field         TEXT,
  winner_value  TEXT,
  winner_actor  TEXT NOT NULL,
  winner_device TEXT NOT NULL,
  winner_hlc    TEXT NOT NULL,
  winner_step   TEXT NOT NULL,
  loser_value   TEXT,
  loser_actor   TEXT NOT NULL,
  loser_device  TEXT NOT NULL,
  loser_hlc     TEXT NOT NULL,
  loser_step    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_at   TEXT,
  resolved_by   TEXT,
  resolution    TEXT CHECK (resolution IN ('keep_winner', 'keep_loser', 'superseded'))
) WITHOUT ROWID;
CREATE INDEX sync_clashes_record ON sync_clashes (entity, record_id, resolved);
CREATE INDEX sync_clashes_open ON sync_clashes (resolved, created_at);
