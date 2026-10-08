// Restore a backup over the live database. The server must be stopped.
//
//  1. Refuse if the server's heartbeat file is fresh (it is still running).
//  2. Copy the backup next to the database as <db>.restoring and check it:
//     integrity_check must pass and it must be a suite database. Mark the copy
//     as restored so sync starts a new generation (devices resync).
//     Tables modules list in `keepOnRestore` (C8: the connections' and automations' switches)
//     are copied from the database being replaced into the copy: a restore must never quietly
//     switch a paused connection or automation back on.
//  3. Take a safety copy of the current database (backup API, so WAL content is
//     included) into the backup folder as pre-restore-<time>.db.
//  4. Remove the old -wal/-shm files and rename the checked copy into place.
// The next start opens it in WAL mode and runs any newer migrations.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../db/open.js';
import { runningServer } from '../lib/serverLock.js';
import { markRestoredCopy } from '../modules/sync/restoreMarker.js';
import { modules as registeredModules } from '../modules/index.js';

/** Tables whose current rows survive a restore (each module's `keepOnRestore`). */
export const KEPT_TABLES = registeredModules.flatMap((m) => m.keepOnRestore ?? []);

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * Copy the kept tables' rows from the database being replaced into the restored copy (replacing
 * the copy's rows). A table missing on either side is skipped: a backup from before the module
 * existed gets its rows from the module's defaults, as it did then. Returns the tables copied.
 */
export function carryKeptTables(currentPath, copy, tables = KEPT_TABLES) {
  if (!tables.length || !fs.existsSync(currentPath)) return [];
  const current = openDb(currentPath);
  try {
    const carried = [];
    copy.transaction(() => {
      for (const table of tables) {
        if (!hasTable(current, table) || !hasTable(copy, table)) continue;
        const cols = copy.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table);
        const have = new Set(current.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table));
        const shared = cols.filter((c) => have.has(c));
        copy.prepare(`DELETE FROM "${table}"`).run();
        const insert = copy.prepare(`INSERT INTO "${table}" (${shared.map((c) => `"${c}"`).join(', ')})
          VALUES (${shared.map(() => '?').join(', ')})`);
        for (const row of current.prepare(`SELECT ${shared.map((c) => `"${c}"`).join(', ')} FROM "${table}"`).raw().all()) insert.run(row);
        carried.push(table);
      }
    })();
    return carried;
  } finally {
    current.close();
  }
}

export function lockPathFor(dbPath) {
  return `${dbPath}.server-lock`;
}

function stamp(date) {
  return date.toISOString().replace(/[:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Check a candidate backup file; returns { tables, migrations }. Throws if unusable. */
export function verifyBackupFile(file) {
  const db = new Database(file);
  try {
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`${file} failed integrity_check: ${check}`);
    const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!hasMigrations) throw new Error(`${file} is not a suite database (no schema_migrations table)`);
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
    const migrations = db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n;
    return { tables, migrations };
  } finally {
    db.close();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.from backup file to restore
 * @param {string} opts.dbPath live database path to replace
 * @param {string} opts.backupDir where the pre-restore safety copy goes
 * @param {boolean} [opts.force] skip the "server running" and "safety copy failed" guards
 */
export async function restoreBackup({ from, dbPath, backupDir, force = false, now = new Date(), log = () => {} }) {
  if (!fs.existsSync(from)) throw new Error(`Backup file ${from} does not exist`);
  if (path.resolve(from) === path.resolve(dbPath)) throw new Error('The backup file is the live database');

  const running = runningServer(lockPathFor(dbPath));
  if (running && !force) {
    throw new Error(
      `The suite server looks like it is running (pid ${running.pid} on ${running.host}, last heartbeat ` +
      `${running.heartbeatAt}). Stop it first: docker compose stop suite`,
    );
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const staging = `${dbPath}.restoring`;
  fs.copyFileSync(from, staging);
  let info;
  try {
    info = verifyBackupFile(staging);
    // Tell the sync module this database went back in time (new generation on next start).
    const copy = new Database(staging);
    try {
      copy.pragma('journal_mode = DELETE'); // keep the write in this one file (no -wal left behind)
      markRestoredCopy(copy, now.toISOString());
      // The current database may be the broken one being replaced: carrying its switches is best
      // effort and must never stop the restore (with or without --force).
      try {
        const carried = carryKeptTables(dbPath, copy);
        if (carried.length) log(`kept the current ${carried.join(', ')}`);
      } catch (err) {
        log(`warning: couldn't read the current settings (${err.message}) — switches reset to the backup's (defaults where it has none)`);
      }
      const check = copy.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`the restored copy failed integrity_check after preparing it: ${check}`);
    } finally {
      copy.close();
    }
  } catch (err) {
    fs.rmSync(staging, { force: true });
    throw err;
  }

  let safetyCopy = null;
  if (fs.existsSync(dbPath)) {
    fs.mkdirSync(backupDir, { recursive: true });
    safetyCopy = path.join(backupDir, `pre-restore-${stamp(now)}.db`);
    try {
      const current = openDb(dbPath);
      try {
        await current.backup(safetyCopy);
      } finally {
        current.close(); // also checkpoints and removes -wal/-shm
      }
      log(`current database saved to ${safetyCopy}`);
    } catch (err) {
      if (!force) {
        fs.rmSync(staging, { force: true });
        throw new Error(`Could not save the current database before restoring (${err.message}); use --force to restore anyway`);
      }
      log(`could not save the current database (${err.message}); continuing because of --force`);
      safetyCopy = null;
    }
  }

  for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.renameSync(staging, dbPath);
  log(`restored ${from} -> ${dbPath} (${info.tables} tables, ${info.migrations} migrations)`);
  return { restoredFrom: from, dbPath, safetyCopy, ...info };
}
