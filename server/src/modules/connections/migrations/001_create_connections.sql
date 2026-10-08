-- Connections (C8): each connection's on/off switch, and who changed it when.
-- Server settings, not synced records: changing one needs a connection to the suite.
-- A row exists only once someone has switched that connection; no row = on.
-- Kept across restores (restore.js copies this table from the database being replaced):
-- a restore must never quietly switch a paused connection back on.
CREATE TABLE connections_switches (
  id         TEXT PRIMARY KEY,               -- the connection's id ('wom', 'calendar', …)
  paused     INTEGER NOT NULL CHECK (paused IN (0, 1)),
  changed_at TEXT NOT NULL,                  -- nowIso()
  changed_by TEXT NOT NULL,                  -- owner | partner | system
  changed_device TEXT                        -- the device it was switched from (auth device id)
) WITHOUT ROWID;

-- Every change of a switch, for "who paused this?" (never pruned: a handful of rows a year).
CREATE TABLE connections_changes (
  id            TEXT PRIMARY KEY,            -- UUIDv7
  connection_id TEXT NOT NULL,
  paused        INTEGER NOT NULL CHECK (paused IN (0, 1)),
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  device_id     TEXT
);
CREATE INDEX connections_changes_by_connection ON connections_changes (connection_id, at);
