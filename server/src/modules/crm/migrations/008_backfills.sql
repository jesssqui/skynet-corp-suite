-- D8d: one-time data fixes run after start through applyLocal; this remembers which have run.
CREATE TABLE crm_backfills (
  name     TEXT PRIMARY KEY,
  done_at  TEXT NOT NULL
);
