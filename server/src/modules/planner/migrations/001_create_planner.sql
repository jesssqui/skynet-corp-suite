-- The planner (C4a): tasks and the capture inbox. Both are synced record types (registered in
-- ../entities.js): written only through sync steps (devices) or sync.applyLocal (server code); a
-- direct write fails on the app's connection. Column types follow the field types (CLAUDE.md, "How
-- a module syncs a record type"). created_* / updated_* / flagged are filled by sync.
--
-- References are soft (no SQL FOREIGN KEY), checked by sync. A task belongs to one of our
-- businesses (`parent`, never deleted); its client / account / relationship are plain refs: a task
-- stays when its client is deleted (shown with the client as "deleted").
-- No CHECK lists on enum columns: sync checks the values.

CREATE TABLE planner_tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  notes            TEXT,
  owner            TEXT NOT NULL,     -- owner | partner | shared (the shared list)
  business_id      TEXT NOT NULL,     -- one of our businesses, or Personal
  client_id        TEXT,              -- optional: which client it is about
  account_id       TEXT,              -- optional: which of their businesses
  relationship_id  TEXT,              -- optional: the relationship it is the next step for
  due_date         TEXT,              -- "YYYY-MM-DD", local calendar
  due_time         TEXT,              -- "HH:MM", local, only with a due date
  estimate_minutes INTEGER,           -- rough time estimate
  done_at          TEXT,              -- when it was finished (null = open)
  top_on           TEXT,              -- "YYYY-MM-DD": one of that day's three most important (morning plan)
  created_at       TEXT,
  created_by       TEXT,
  updated_at       TEXT,
  updated_by       TEXT,
  flagged          INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);
CREATE INDEX planner_tasks_open ON planner_tasks (owner, due_date) WHERE deleted_at IS NULL AND done_at IS NULL;
CREATE INDEX planner_tasks_business ON planner_tasks (business_id);
CREATE INDEX planner_tasks_client ON planner_tasks (client_id);
CREATE INDEX planner_tasks_relationship ON planner_tasks (relationship_id);

-- The capture inbox: anything that comes up, sorted later into a task, a note or nothing.
CREATE TABLE planner_inbox_items (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  source        TEXT,                 -- typed | phone | siri | share
  captured_at   TEXT NOT NULL,        -- when it was captured (nowIso)
  cleared_at    TEXT,                 -- when it was sorted (null = still in the inbox)
  became_entity TEXT,                 -- what it became: task | activity (null = dismissed)
  became_id     TEXT,                 -- that record's id (no ref: it may be deleted later)
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX planner_inbox_open ON planner_inbox_items (captured_at) WHERE deleted_at IS NULL AND cleared_at IS NULL;
