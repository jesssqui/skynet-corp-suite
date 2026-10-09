-- D5 (notes from the Order Manager): its CRM notes (note.added / note.deleted) and each customer's
-- follow-up date (followup.changed), sent by the Order Manager's outbox since A11. New tables and
-- nullable columns only; no rows of a synced table are written here (sync rule 6). See CLAUDE.md,
-- "Wholesale notes and follow-ups (D5)".

-- ---- the holding area (not synced; kept across restores like the rest of it) ------------------
-- The latest snapshot of every note, by its note_uid. A delete only marks it (deleted = 1, the
-- snapshot kept); a delete of a note never seen is held as a tombstone (snapshot null), so a stale
-- add arriving after it can't bring it back. Only a backfill note.added (the Order Manager's catch-up,
-- which sends notes that exist there now) makes a deleted note live again.
CREATE TABLE wholesale_held_notes (
  uid            TEXT PRIMARY KEY,          -- note_uid
  customer_uid   TEXT,
  number         INTEGER,                   -- its integer id there (a label only)
  type           TEXT,                      -- note | call | email | meeting | follow_up
  body           TEXT,
  at             TEXT,                      -- when it was written there (ISO)
  written_by     TEXT,                      -- who wrote it there (a username)
  snapshot       TEXT,                      -- latest note snapshot (JSON); null for a tombstone
  deleted        INTEGER NOT NULL DEFAULT 0,
  deleted_reason TEXT,                      -- deleted (by hand) | customer_deleted | gone | gone_after_restore
  updated_at     TEXT NOT NULL,
  record_id      TEXT,                      -- its synced wholesale_note record
  dirty          INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;
CREATE INDEX wholesale_held_notes_customer ON wholesale_held_notes (customer_uid);
CREATE INDEX wholesale_held_notes_dirty ON wholesale_held_notes (dirty) WHERE dirty = 1;

-- The customer's follow-up date as the Order Manager last said (followup.changed is a state).
-- follow_up_done: the last change cleared it through "done" (else cleared or moved by hand).
-- follow_up_episode: counts the times a date was set where there was none, so a new follow-up after a
-- done one is a new task even on the same date (the follow-up automation's keys).
ALTER TABLE wholesale_held_customers ADD COLUMN follow_up_date TEXT;
ALTER TABLE wholesale_held_customers ADD COLUMN follow_up_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wholesale_held_customers ADD COLUMN follow_up_at TEXT;
ALTER TABLE wholesale_held_customers ADD COLUMN follow_up_episode INTEGER NOT NULL DEFAULT 0;

-- ---- what devices see (synced; written by the server only) --------------------------------------
-- One per note of a linked customer, on its client's timeline. Deleted on devices when the note is
-- deleted there, or its customer is unlinked or deleted (the holding area keeps it all).
CREATE TABLE wholesale_notes (
  id           TEXT PRIMARY KEY,
  account_id   TEXT,                        -- parent: the account its customer is linked to
  client_id    TEXT,
  customer_uid TEXT,
  note_uid     TEXT,
  number       INTEGER,
  type         TEXT,                        -- note | call | email | meeting | follow_up
  body         TEXT,
  at           TEXT,
  written_by   TEXT,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
  flagged      INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX wholesale_notes_account ON wholesale_notes (account_id);
CREATE INDEX wholesale_notes_client_at ON wholesale_notes (client_id, at);
CREATE INDEX wholesale_notes_uid ON wholesale_notes (note_uid);

-- The card shows the customer's next follow-up (null when none, or the customer was deleted there).
ALTER TABLE wholesale_customers ADD COLUMN follow_up_date TEXT;
