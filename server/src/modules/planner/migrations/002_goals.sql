-- Planning (C4b): week goals and month priorities, each task's goal, and each person's day length.
-- Synced record types (../entities.js): written only through sync steps or sync.applyLocal.
-- Schema only — a migration never changes rows of a synced table (CLAUDE.md, "How a module syncs a
-- record type", rule 6): the new task column starts empty on every existing task, and old devices'
-- steps without it still apply (a create may leave out an optional field).

-- A week goal (period = the Monday of its week) or a month priority (period = the 1st of its month),
-- for one of our businesses or Personal. Tasks hang off it through planner_tasks.goal_id.
CREATE TABLE planner_goals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,      -- week | month
  period        TEXT NOT NULL,      -- "YYYY-MM-DD": the week's Monday or the month's 1st (checked by the module)
  business_id   TEXT NOT NULL,      -- one of our businesses, or Personal
  title         TEXT NOT NULL,
  target        REAL,               -- optional number to reach ("follow up 5 quiet customers" -> 5)
  progress      REAL,               -- how far along, set by hand
  owner         TEXT,               -- owner | partner | shared (default: whoever made it)
  notes         TEXT,
  done_at       TEXT,               -- when it was marked done (null = not done)
  position      INTEGER,            -- order among the business's goals of the period
  carried_from  TEXT,               -- the unfinished goal of the period before it was copied from (no ref)
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX planner_goals_period ON planner_goals (kind, period) WHERE deleted_at IS NULL;
CREATE INDEX planner_goals_business ON planner_goals (business_id);

-- A task may hang off a goal (a plain ref, not a parent: deleting a goal never hides its tasks).
ALTER TABLE planner_tasks ADD COLUMN goal_id TEXT;
CREATE INDEX planner_tasks_goal ON planner_tasks (goal_id);

-- One row per person (fixed ids, made at start by the server): the day length the overbooking
-- warning measures a day's estimates against (null = the default, 8 h).
CREATE TABLE planner_workdays (
  id            TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,      -- owner | partner
  day_minutes   INTEGER,
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
