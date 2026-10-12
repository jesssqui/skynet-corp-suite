-- D10 review fixes.
-- An upload's pieces are written in a few transactions (yielding in between) before the one that makes its
-- record: until then its blob is not complete (0). Incomplete blobs left by a crash are purged after an hour.
ALTER TABLE files_blobs ADD COLUMN complete INTEGER NOT NULL DEFAULT 1;
-- When the server first saw a file's record deleted. The 30-day purge counts from the later of that and the
-- record's deleted_at (the device's clock, which may be wrong or the delete may arrive late from offline).
CREATE TABLE files_purge_marks (
  blob_id   TEXT PRIMARY KEY,
  seen_at   TEXT NOT NULL
);
