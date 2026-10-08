-- C8 review: a weekly automation whose whole period passed without a run (the server was off from
-- Friday to Sunday) gets a visible 'missed' run, so the page says so. SQLite can't change a CHECK
-- in place: rebuild the (unsynced, FK-free) runs table with 'missed' allowed.
CREATE TABLE automations_runs_new (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL,
  trigger        TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'event')),
  period_key     TEXT,
  run_key        TEXT UNIQUE,
  actor          TEXT,
  device_id      TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('ok', 'error', 'missed')),
  summary        TEXT,
  created_count  INTEGER NOT NULL DEFAULT 0,
  created        TEXT,
  alert_id       TEXT,
  error          TEXT
);
INSERT INTO automations_runs_new SELECT id, automation_id, trigger, period_key, run_key, actor, device_id, started_at,
  finished_at, status, summary, created_count, created, alert_id, error FROM automations_runs;
DROP TABLE automations_runs;
ALTER TABLE automations_runs_new RENAME TO automations_runs;
CREATE INDEX automations_runs_by_automation ON automations_runs (automation_id, started_at);
