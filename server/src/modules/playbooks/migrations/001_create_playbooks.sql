-- Projects and playbooks (D9): playbooks (a named list of steps for one of our businesses), their steps,
-- runs (a project, a job, an onboarding or a retainer: one use of a playbook, with its client) and each
-- run's own copy of the steps (taken when it starts, so editing the playbook changes only future runs).
-- All synced record types (../entities.js): written only through sync steps (devices) or sync.applyLocal.
CREATE TABLE playbooks_playbooks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  business_id  TEXT NOT NULL,      -- one of ours
  repeat       TEXT,               -- once | monthly (null = once)
  for_client   INTEGER,            -- 0/1: a run asks for a client
  kind         TEXT,               -- the relationship kind a run works on (website, social, …)
  description  TEXT,
  archived     INTEGER,            -- 0/1
  created_at   TEXT,
  created_by   TEXT,
  updated_at   TEXT,
  updated_by   TEXT,
  flagged      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX playbooks_playbooks_business ON playbooks_playbooks (business_id);

CREATE TABLE playbooks_steps (
  id                     TEXT PRIMARY KEY,
  playbook_id            TEXT NOT NULL,
  position               INTEGER,
  title                  TEXT NOT NULL,
  stage                  TEXT,
  action                 TEXT,          -- task | renewal (null = task)
  offset_amount          INTEGER,       -- after the start (negative = before); null = 0
  offset_unit            TEXT,          -- days | weeks | months | years (null = days)
  owner                  TEXT,          -- runner | business | owner | partner | shared (null = runner)
  estimate_minutes       INTEGER,
  notes                  TEXT,
  links                  TEXT,          -- one per line: a web address, "file:<id>" (D10) or words
  service_name           TEXT,          -- renewal: the client's service it sets the date of
  service_period         TEXT,
  service_amount_cents   INTEGER,
  only_if_lacks_business TEXT,          -- an offer: only when the client lacks this business…
  only_if_lacks_kind     TEXT,          -- …with this kind of relationship
  created_at             TEXT,
  created_by             TEXT,
  updated_at             TEXT,
  updated_by             TEXT,
  flagged                INTEGER NOT NULL DEFAULT 0,
  deleted_at             TEXT
);
CREATE INDEX playbooks_steps_playbook ON playbooks_steps (playbook_id);

CREATE TABLE playbooks_runs (
  id               TEXT PRIMARY KEY,
  playbook_id      TEXT,
  name             TEXT NOT NULL,
  business_id      TEXT NOT NULL,
  repeat           TEXT,
  client_id        TEXT,
  account_id       TEXT,
  relationship_id  TEXT,
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  owner            TEXT,               -- everything to one person / the shared list (null = as each step says)
  runner           TEXT NOT NULL,      -- who ran it (a step's "whoever runs it", later months too)
  status           TEXT,               -- active | done | stopped (null = active)
  playbook_as_of   TEXT,               -- the playbook's last change when the run copied it
  notes            TEXT,
  created_at       TEXT,
  created_by       TEXT,
  updated_at       TEXT,
  updated_by       TEXT,
  flagged          INTEGER NOT NULL DEFAULT 0,
  deleted_at       TEXT
);
CREATE INDEX playbooks_runs_playbook ON playbooks_runs (playbook_id);
CREATE INDEX playbooks_runs_client ON playbooks_runs (client_id);

CREATE TABLE playbooks_run_steps (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL,
  step_id                TEXT,          -- the playbook step it was copied from (no ref)
  position               INTEGER,
  title                  TEXT NOT NULL,
  stage                  TEXT,
  action                 TEXT,
  offset_amount          INTEGER,
  offset_unit            TEXT,
  owner                  TEXT,
  estimate_minutes       INTEGER,
  notes                  TEXT,
  links                  TEXT,
  service_name           TEXT,
  service_period         TEXT,
  service_amount_cents   INTEGER,
  only_if_lacks_business TEXT,
  only_if_lacks_kind     TEXT,
  outcome                TEXT,          -- task | skipped | renewal: what it did when the run started
  outcome_note           TEXT,          -- why skipped, what date it set
  created_at             TEXT,
  created_by             TEXT,
  updated_at             TEXT,
  updated_by             TEXT,
  flagged                INTEGER NOT NULL DEFAULT 0,
  deleted_at             TEXT
);
CREATE INDEX playbooks_run_steps_run ON playbooks_run_steps (run_id);
