-- Facts about this database itself, written once when it is created.
-- instance_id: a UUIDv7 naming this database; a restore keeps it (it is the same data).
CREATE TABLE health_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
