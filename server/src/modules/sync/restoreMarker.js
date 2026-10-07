// Called by backup/restore.js on the checked copy before it is swapped in: marks
// the database as "just restored". On the next start the sync service sees the
// mark, gives the database a new generation and removes the mark, so every device
// knows the server went back in time (its cursor is from another generation) and
// re-sends the steps it still keeps. Kept here so restore.js needs no sync details.
export function markRestoredCopy(db, at) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_meta'").get();
  if (!has) return false; // a backup from before sync existed: its first start makes a fresh generation anyway
  db.prepare(`INSERT INTO sync_meta (key, value) VALUES ('restore_pending', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(at);
  return true;
}
