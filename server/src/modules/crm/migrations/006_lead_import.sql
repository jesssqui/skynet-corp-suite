-- D8b: importing leads from a research / outreach export. Not synced (devices never see these
-- tables): the server's own memory of what it imported, so importing the same file again — or a newer
-- export that still lists the same leads — creates nothing twice. The records an import makes are
-- written through sync.applyLocal like any other server write. New tables only.

-- One import: who, when, which file, what came of it.
CREATE TABLE crm_lead_import_batches (
  id           TEXT PRIMARY KEY,   -- UUIDv7 made by the page (a retried commit finds its batch)
  file_name    TEXT,
  actor        TEXT NOT NULL,      -- owner | partner: who imported (also created_by on every record)
  request_hash TEXT NOT NULL,      -- SHA-256 of the file's text + name: the same id with another file is refused
  total_rows   INTEGER NOT NULL DEFAULT 0,
  imported     INTEGER NOT NULL DEFAULT 0,  -- leads made
  lost         INTEGER NOT NULL DEFAULT 0,  -- of those, made as lost (excluded in the file)
  skipped      INTEGER NOT NULL DEFAULT 0,  -- imported before, already here, repeated, can't import
  failed       INTEGER NOT NULL DEFAULT 0,
  tasks        INTEGER NOT NULL DEFAULT 0,  -- next-step tasks made
  records      INTEGER NOT NULL DEFAULT 0,  -- records created (leads, timeline entries, tasks)
  problems     TEXT,               -- JSON [{ row, reason }] of failed rows (first 100)
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX crm_lead_import_batches_started ON crm_lead_import_batches (started_at);

-- Every imported row, by its source key (the file's lead_id; else a hash of name, email and town)
-- -> the lead it made. The same key again is "imported before" and skipped; nothing existing is
-- ever updated by a later import.
CREATE TABLE crm_lead_import_rows (
  source_key  TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES crm_lead_import_batches (id),
  row_number  INTEGER NOT NULL,    -- its row in that file, as a spreadsheet numbers it (the header is row 1)
  lead_id     TEXT NOT NULL,       -- the lead it made
  record_ids  TEXT NOT NULL,       -- JSON [{ entity, id }] created
  created_at  TEXT NOT NULL
);
CREATE INDEX crm_lead_import_rows_batch ON crm_lead_import_rows (batch_id);
