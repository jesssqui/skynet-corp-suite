-- Test-only module proving the sync rules. Not registered in the app.
-- items: every op; uses all the optional standard columns.
CREATE TABLE syncdemo_items (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  phone      TEXT,
  qty        INTEGER,
  done       INTEGER,
  due        TEXT,
  status     TEXT,
  created_at TEXT,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  flagged    INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
) WITHOUT ROWID;

-- notes: append-only, only the required columns plus who/when.
CREATE TABLE syncdemo_notes (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES syncdemo_items (id),
  body       TEXT NOT NULL,
  created_at TEXT,
  created_by TEXT,
  deleted_at TEXT
) WITHOUT ROWID;
