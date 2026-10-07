// Restore a backup over the live database. The server must be stopped.
//
//  1. Refuse if the server's heartbeat file is fresh (it is still running).
//  2. Copy the backup next to the database as <db>.restoring and check it:
//     integrity_check must pass and it must be a suite database.
//  3. Take a safety copy of the current database (backup API, so WAL content is
//     included) into the backup folder as pre-restore-<time>.db.
//  4. Remove the old -wal/-shm files and rename the checked copy into place.
// The next start opens it in WAL mode and runs any newer migrations.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../db/open.js';
import { runningServer } from '../lib/serverLock.js';

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
