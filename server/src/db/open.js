import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Open (or create) a SQLite database with the suite's standard settings.
 * Every connection — the app, backup and restore scripts, tests — goes through here.
 */
export function openDb(dbPath, { readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly, fileMustExist: readonly });
  if (!readonly) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // wait instead of failing if the backup or another connection holds a lock
  if (!readonly) db.pragma('synchronous = NORMAL'); // safe with WAL; a power cut can lose the last commit, never corrupt
  return db;
}
