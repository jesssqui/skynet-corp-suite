-- C7: the accounting CSV import. Not synced (devices never see these tables): the server's own
-- memory of what it imported, so importing the same file again creates nothing new. The records
-- an import makes are written through sync.applyLocal like any other server write.

-- One import: who, when, which file, what came of it.
CREATE TABLE crm_import_batches (
  id               TEXT PRIMARY KEY,  -- UUIDv7 made by the page (a retried commit finds its batch)
  file_name        TEXT,
  source           TEXT,              -- the program the file looks like it came from (QuickBooks, Wave, Xero, FreshBooks)
  actor            TEXT NOT NULL,     -- owner | partner: who imported (also created_by on every record)
  business_id      TEXT,              -- our business the new clients work with (null = none)
  kind             TEXT,              -- that relationship's kind
  status           TEXT NOT NULL,     -- running | done | failed | interrupted
  total_rows       INTEGER NOT NULL DEFAULT 0,
  processed        INTEGER NOT NULL DEFAULT 0,
  created_clients  INTEGER NOT NULL DEFAULT 0,  -- rows that made a new client
  added_to         INTEGER NOT NULL DEFAULT 0,  -- rows that added what was missing to an existing client
  skipped          INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  records          INTEGER NOT NULL DEFAULT 0,  -- records created (clients, accounts, contacts, relationships, notes)
  problems         TEXT,              -- JSON [{ line, reason }] of failed rows (first 100)
  error            TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE INDEX crm_import_batches_started ON crm_import_batches (started_at);

-- Every imported row, by fingerprint (SHA-256 of its clean values: @suite/shared/intake
-- fingerprintText) -> what it created. `row_key` (the customer's name key) tells a row that
-- changed since it was imported from a new one.
CREATE TABLE crm_import_rows (
  fingerprint TEXT PRIMARY KEY,
  row_key     TEXT NOT NULL,
  batch_id    TEXT NOT NULL REFERENCES crm_import_batches (id),
  row_number  INTEGER NOT NULL,       -- its row in that file, as a spreadsheet numbers it (the header is row 1)
  action      TEXT NOT NULL,          -- create | add
  client_id   TEXT NOT NULL,          -- the client it made, or added to
  record_ids  TEXT NOT NULL,          -- JSON [{ entity, id }] created
  created_at  TEXT NOT NULL
);
CREATE INDEX crm_import_rows_key ON crm_import_rows (row_key);
CREATE INDEX crm_import_rows_batch ON crm_import_rows (batch_id);
