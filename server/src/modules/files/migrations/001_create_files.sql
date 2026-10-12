-- Files (D10): what is kept on a client's, an account's or a task's Files tab.
--
-- files_items is a synced record type (../entities.js `file`): written only through sync steps
-- (devices: links and password pointers, renames, notes, deletes) or sync.applyLocal (the upload
-- route, which writes the record in the same transaction as the bytes). Exactly one of client_id,
-- account_id, task_id is set (checked by the module's sync check, so a refusal says why).
CREATE TABLE files_items (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,      -- upload | link | password
  name          TEXT NOT NULL,
  client_id     TEXT,               -- the owner: a client …
  account_id    TEXT,               -- … or one of their accounts …
  task_id       TEXT,               -- … or a task (listed on its client's / account's tab too)
  notes         TEXT,
  url           TEXT,               -- link: the address; password: where to sign in (optional)
  vault         TEXT,               -- password: which password manager / vault
  vault_item    TEXT,               -- password: the item's name there (never the secret)
  blob_id       TEXT,               -- upload: files_blobs.id (set by the server only)
  size          INTEGER,            -- upload: bytes
  content_type  TEXT,               -- upload: the type it is stored and sent as (from its extension)
  sha256        TEXT,               -- upload: hex
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX files_items_client ON files_items (client_id);
CREATE INDEX files_items_account ON files_items (account_id);
CREATE INDEX files_items_task ON files_items (task_id);
CREATE INDEX files_items_blob ON files_items (blob_id);

-- The bytes of uploaded files, in the database itself (decision, CLAUDE.md "Files (D10)"): so the
-- nightly backup — one SQLite snapshot — holds them consistently with their records, and a restore
-- brings both back together. Not synced (devices fetch bytes online), not kept across restores.
-- A blob is purged FILES_PURGE_DAYS after its record was deleted.
CREATE TABLE files_blobs (
  id          TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  chunks      INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);
-- In pieces of at most 512 KB, so a download is sent piece by piece instead of reading a 25 MB value at once.
CREATE TABLE files_chunks (
  blob_id  TEXT NOT NULL REFERENCES files_blobs(id) ON DELETE CASCADE,
  n        INTEGER NOT NULL,
  data     BLOB NOT NULL,
  PRIMARY KEY (blob_id, n)
);
