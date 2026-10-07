-- Test-only: code is UNIQUE, which only the server can check.
CREATE TABLE chk_things (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  code       TEXT UNIQUE,
  n          INTEGER,
  created_at TEXT,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  flagged    INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
) WITHOUT ROWID;
