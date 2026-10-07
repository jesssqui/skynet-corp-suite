// Nightly backup: a consistent snapshot of the live database, checked, copied to
// a folder that lives off this machine, and old copies pruned.
//
//  1. better-sqlite3's backup API copies the database page by page from a read
//     transaction, so the snapshot is exactly the last committed state even
//     while the app keeps writing (WAL included). Never copy the .db file by hand.
//  2. The snapshot is switched to a single self-contained file (journal_mode
//     DELETE — no -wal/-shm needed) and must pass PRAGMA integrity_check.
//  3. It is copied to BACKUP_OFFSITE_DIR, flushed to disk and its SHA-256 compared
//     with the original before it gets its final name.
//  4. Copies older than BACKUP_KEEP_DAYS are deleted in both folders; the newest
//     copy is always kept, whatever its age.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb } from '../db/open.js';

export const OFFSITE_MARKER = '.suite-backup-target';
const NAME_RE = /^suite-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z\.db$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "suite-2026-10-06T031500.123Z.db" — UTC, sorts by time, no colons (safe on every filesystem). */
export function backupFileName(date) {
  const iso = date.toISOString(); // 2026-10-06T03:15:00.123Z
  return `suite-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 23)}Z.db`;
}

/** The time encoded in a backup file name, or null if the name is not a backup. */
export function backupFileTime(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
}

/** Backups in a folder, newest first: [{ name, path, time }]. */
export function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => ({ name, path: path.join(dir, name), time: backupFileTime(name) }))
    .filter((b) => b.time)
    .sort((a, b) => b.time - a.time);
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Throws with a helpful message unless the off-machine folder looks mounted. */
export function checkOffsiteDir(offsiteDir) {
  if (!fs.existsSync(offsiteDir)) {
    throw new Error(`Off-machine backup folder ${offsiteDir} does not exist — is the drive or share mounted?`);
  }
  if (!fs.existsSync(path.join(offsiteDir, OFFSITE_MARKER))) {
    throw new Error(
      `Off-machine backup folder ${offsiteDir} has no ${OFFSITE_MARKER} file. Either the drive/share is not ` +
      `mounted (and this is an empty stand-in folder), or the marker was never created — see DEPLOY.md.`,
    );
  }
}

/**
 * Delete backups older than keepDays in `dir` (never the newest one) and
 * leftover partial copies older than a day. Other files are never touched.
 * @returns {string[]} names deleted
 */
export function pruneBackups(dir, keepDays, now = new Date()) {
  const deleted = [];
  const backups = listBackups(dir);
  for (const b of backups.slice(1)) {
    if (now - b.time > keepDays * DAY_MS) {
      fs.unlinkSync(b.path);
      deleted.push(b.name);
    }
  }
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.partial')) continue;
    const full = path.join(dir, name);
    if (now - fs.statSync(full).mtimeMs > DAY_MS) {
      fs.unlinkSync(full);
      deleted.push(name);
    }
  }
  return deleted;
}

// ---- status file: what the health page and the owner look at ----

export function statusPath(dir) {
  return path.join(dir, 'status.json');
}

export function readStatus(dir) {
  try {
    return JSON.parse(fs.readFileSync(statusPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(dir, patch) {
  const next = { ...(readStatus(dir) || {}), ...patch };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statusPath(dir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, statusPath(dir));
  return next;
}

/**
 * Make one backup.
 * @param {object} opts
 * @param {import('better-sqlite3').Database} [opts.db] live connection to copy from (the server passes its own)
 * @param {string} [opts.dbPath] or the database file to open (scripts)
 * @param {string} opts.dir local backup folder
 * @param {string|null} opts.offsiteDir off-machine folder; null = local only (reported as a problem)
 * @param {number} opts.keepDays
 * @returns {Promise<{ file: string, offsiteFile: string|null, sha256: string, bytes: number, pruned: string[] }>}
 */
export async function runBackup({ db, dbPath, dir, offsiteDir, keepDays, now = new Date(), log = () => {} }) {
  const startedAt = now.toISOString();
  writeStatus(dir, { lastAttemptAt: startedAt });
  let localFile = null;
  try {
    let source = db;
    if (!source) {
      if (!fs.existsSync(dbPath)) throw new Error(`Database ${dbPath} does not exist`);
      source = openDb(dbPath);
    }
    const name = backupFileName(now);
    const partial = path.join(dir, `${name}.partial`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      await source.backup(partial);
    } finally {
      if (!db) source.close();
    }

    // Make the snapshot one standalone file and check it.
    const snap = new Database(partial);
    try {
      snap.pragma('journal_mode = DELETE');
      const check = snap.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`Backup failed integrity_check: ${check}`);
    } finally {
      snap.close();
    }
    fsyncFile(partial);
    localFile = path.join(dir, name);
    fs.renameSync(partial, localFile);
    const sha256 = await sha256File(localFile);
    const bytes = fs.statSync(localFile).size;
    log(`backup written ${localFile} (${bytes} bytes)`);

    let offsiteFile = null;
    const pruned = pruneBackups(dir, keepDays, now);
    if (offsiteDir) {
      checkOffsiteDir(offsiteDir);
      const offPartial = path.join(offsiteDir, `${name}.partial`);
      fs.copyFileSync(localFile, offPartial);
      fsyncFile(offPartial);
      const offSha = await sha256File(offPartial);
      if (offSha !== sha256) {
        fs.unlinkSync(offPartial);
        throw new Error(`Off-machine copy did not match (sha256 ${offSha} vs ${sha256})`);
      }
      offsiteFile = path.join(offsiteDir, name);
      fs.renameSync(offPartial, offsiteFile);
      pruned.push(...pruneBackups(offsiteDir, keepDays, now).map((n) => `offsite/${n}`));
      log(`backup copied off-machine ${offsiteFile}`);
    }

    writeStatus(dir, {
      lastSuccessAt: now.toISOString(),
      lastFile: name,
      sha256,
      bytes,
      offsite: offsiteDir ? 'ok' : 'not configured',
      lastError: offsiteDir ? null : 'BACKUP_OFFSITE_DIR is not set — backups stay on this machine only',
    });
    return { file: localFile, offsiteFile, sha256, bytes, pruned };
  } catch (err) {
    writeStatus(dir, {
      lastError: err.message,
      lastErrorAt: new Date().toISOString(),
      ...(localFile ? { lastLocalOnlyAt: startedAt, lastLocalOnlyFile: path.basename(localFile), offsite: 'failed' } : {}),
    });
    throw err;
  }
}
