// Nightly backup: a consistent snapshot of the live database, checked, copied to
// a folder that lives off this machine, and old copies pruned.
//
//  1. better-sqlite3's backup API copies the database page by page from a read
//     transaction (D10 review: in a worker thread with its own connection), so the snapshot is exactly the last committed state even
//     while the app keeps writing (WAL included). Never copy the .db file by hand.
//  2. The snapshot is switched to a single self-contained file (journal_mode
//     DELETE — no -wal/-shm needed) and must pass PRAGMA integrity_check. (D10 review: in a worker thread, and the copies below are async — so the server keeps answering while a
//     database with files in it is backed up)
//  3. It is copied to BACKUP_OFFSITE_DIR, flushed to disk and its SHA-256 compared
//     with the original before it gets its final name.
//  4. Copies older than BACKUP_KEEP_DAYS are deleted off-machine, older than BACKUP_LOCAL_KEEP_DAYS
//     (D10 review, default 7) locally; the newest
//     copy is always kept, whatever its age.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';

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

async function fsyncFile(file) {
  const fh = await fs.promises.open(file, 'r+');
  try { await fh.sync(); } finally { await fh.close(); }
}

/**
 * The snapshot, in a worker thread (D10 review): copied from `source` (the live database's path) with the
 * backup API — skipped when `source` is null, to check a copy made already —, made one self-contained file
 * (journal_mode DELETE) and integrity-checked. With files in the database each step takes seconds; on the
 * main thread they froze the server. Resolves to integrity_check's answer ('ok' when sound).
 */
export function checkSnapshot(file, source = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./checkWorker.js', import.meta.url), { workerData: { file, source } });
    let done = false;
    worker.once('message', (m) => {
      done = true;
      if (m.error) reject(new Error(m.error));
      else resolve(m.check);
    });
    worker.once('error', (err) => { done = true; reject(err); });
    worker.once('exit', (code) => { if (!done) reject(new Error(`the backup check stopped (exit ${code})`)); });
  });
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
 * @param {import('better-sqlite3').Database} [opts.db] the server's live connection: its file is copied (by a worker
 *   thread's own read connection, so the server keeps answering)
 * @param {string} [opts.dbPath] or the database file to open (scripts)
 * @param {string} opts.dir local backup folder
 * @param {string|null} opts.offsiteDir off-machine folder; null = local only (reported as a problem)
 * @param {number} opts.keepDays days of backups kept off-machine
 * @param {number} [opts.localKeepDays] days kept in the local folder (BACKUP_LOCAL_KEEP_DAYS; default keepDays)
 * @returns {Promise<{ file: string, offsiteFile: string|null, sha256: string, bytes: number, pruned: string[] }>}
 */
export async function runBackup({ db, dbPath, dir, offsiteDir, keepDays, localKeepDays = keepDays, now = new Date(), log = () => {} }) {
  const startedAt = now.toISOString();
  writeStatus(dir, { lastAttemptAt: startedAt });
  let localFile = null;
  try {
    // The live database's file: the copy is made from it by a worker thread's own connection.
    const source = db ? db.name : dbPath;
    if (!source || !fs.existsSync(source)) throw new Error(`Database ${source} does not exist`);
    const name = backupFileName(now);
    const partial = path.join(dir, `${name}.partial`);
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(partial, { force: true });
    const check = await checkSnapshot(partial, source);
    if (check !== 'ok') throw new Error(`Backup failed integrity_check: ${check}`);
    await fsyncFile(partial);
    localFile = path.join(dir, name);
    fs.renameSync(partial, localFile);
    const sha256 = await sha256File(localFile);
    const bytes = fs.statSync(localFile).size;
    log(`backup written ${localFile} (${bytes} bytes)`);

    let offsiteFile = null;
    const pruned = pruneBackups(dir, localKeepDays, now);
    if (offsiteDir) {
      checkOffsiteDir(offsiteDir);
      const offPartial = path.join(offsiteDir, `${name}.partial`);
      // Async (D10 review): a copy of a database holding files to a network share can take a minute.
      await fs.promises.copyFile(localFile, offPartial);
      await fsyncFile(offPartial);
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
