-- Automations (C8). See CLAUDE.md, "Automations (C8)".

-- Each automation's switches (on/off, silent/alert) once someone has changed them; no row = the
-- automation's defaults. Server settings, not synced; kept across restores (restore.js).
CREATE TABLE automations_settings (
  id             TEXT PRIMARY KEY,             -- the automation's id ('friday-review', …)
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  alert          INTEGER NOT NULL CHECK (alert IN (0, 1)),
  changed_at     TEXT NOT NULL,
  changed_by     TEXT NOT NULL,                -- owner | partner
  changed_device TEXT
) WITHOUT ROWID;

-- Who changed which switch, when (never pruned: a few rows a year).
CREATE TABLE automations_changes (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  field         TEXT NOT NULL CHECK (field IN ('enabled', 'alert')),
  value         INTEGER NOT NULL CHECK (value IN (0, 1)),
  at            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  device_id     TEXT
);

-- Every run: scheduled, "Run now" or an event. run_key is set only on a successful scheduled
-- (or event) run — "<automation id>:<period key>" — and is unique: a period never runs twice,
-- whatever restarts, catch-ups or second servers do. Failed runs and Run now leave it NULL.
CREATE TABLE automations_runs (
  id             TEXT PRIMARY KEY,             -- UUIDv7
  automation_id  TEXT NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'event')),
  period_key     TEXT,                         -- '2026-10-08', '2026-W41', an event's key
  run_key        TEXT UNIQUE,
  actor          TEXT,                         -- who pressed Run now (null for the scheduler)
  device_id      TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  summary        TEXT,
  created_count  INTEGER NOT NULL DEFAULT 0,
  created        TEXT,                         -- JSON [{ entity, id }]
  alert_id       TEXT,                         -- the alert it raised, if any
  error          TEXT
);
CREATE INDEX automations_runs_by_automation ON automations_runs (automation_id, started_at);

-- What each automation made, and for what (a week, a relationship…): how a run knows what it
-- already did ("one per relationship while it is open", "this week's review exists").
CREATE TABLE automations_made (
  automation_id TEXT NOT NULL,
  key           TEXT NOT NULL,
  entity        TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  made_at       TEXT NOT NULL,
  PRIMARY KEY (automation_id, key, record_id)
) WITHOUT ROWID;

-- In-app alerts: a synced record type (entity 'alert'), written only through sync steps.
-- Both people see every alert; each marks it read on their own field (booleans: two devices of
-- one person marking it read offline agree, so there is no clash).
CREATE TABLE automations_alerts (
  id               TEXT PRIMARY KEY,
  deleted_at       TEXT,
  source           TEXT,                       -- the automation's id (or another module's source)
  title            TEXT,
  body             TEXT,
  link             TEXT,                       -- an in-app path ('/plan/review')
  at               TEXT,
  read_by_owner    INTEGER,
  read_by_partner  INTEGER,
  created_at       TEXT,
  created_by       TEXT,
  updated_at       TEXT,
  updated_by       TEXT,
  flagged          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX automations_alerts_at ON automations_alerts (at);
