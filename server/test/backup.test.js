import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { newId } from '@suite/shared/ids';
import { openDb } from '../src/db/open.js';
import { runMigrations } from '../src/db/migrate.js';
import { modules } from '../src/modules/index.js';
import {
  runBackup, listBackups, pruneBackups, backupFileName, backupFileTime, readStatus, sha256File, OFFSITE_MARKER,
} from '../src/backup/backup.js';
import { restoreBackup, lockPathFor } from '../src/backup/restore.js';
import { startHeartbeat } from '../src/lib/serverLock.js';
import { nextRunAt, needsCatchUp } from '../src/backup/schedule.js';
import { tmpDir, dumpDb } from './helpers.js';

const run = promisify(execFile);
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A live database with the real migrations plus a table of awkward data. */
async function liveDb(dir) {
  const dbPath = path.join(dir, 'data', 'suite.db');
  const db = openDb(dbPath);
  await runMigrations(db, modules);
  db.exec(`CREATE TABLE things (
    id TEXT PRIMARY KEY, name TEXT, qty INTEGER, price REAL, blob BLOB, note TEXT,
    parent_id TEXT REFERENCES things(id)
  )`);
  const insert = db.prepare('INSERT INTO things VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    let prev = null;
    for (let i = 0; i < 3000; i++) {
      const id = newId();
      insert.run(id, `Thing ${i} — café ✓`, i, i / 7, Buffer.from([i % 256, 0, 255]), i % 3 ? null : 'x'.repeat(500), prev);
      prev = id;
    }
  })();
  return { db, dbPath };
}

function prepareOffsite(dir) {
  const offsite = path.join(dir, 'offsite');
  fs.mkdirSync(offsite, { recursive: true });
  fs.writeFileSync(path.join(offsite, OFFSITE_MARKER), '');
  return offsite;
}

test('backup -> restore onto a fresh copy gives identical data', async (t) => {
  const dir = tmpDir(t);
  const { db, dbPath } = await liveDb(dir);
  t.after(() => db.close());
  const offsite = prepareOffsite(dir);
  const backupDir = path.join(dir, 'data', 'backups');

  const result = await runBackup({ db, dir: backupDir, offsiteDir: offsite, keepDays: 30 });
  assert.ok(fs.existsSync(result.file));
  assert.ok(result.offsiteFile.startsWith(offsite));
  assert.equal(await sha256File(result.offsiteFile), result.sha256);
  assert.ok(!fs.existsSync(`${result.file}-wal`), 'backup is a single self-contained file');

  // Restore the off-machine copy onto a brand-new location, as if on a new machine.
  const fresh = path.join(dir, 'new-machine', 'suite.db');
  const restored = await restoreBackup({ from: result.offsiteFile, dbPath: fresh, backupDir: path.join(dir, 'new-machine', 'backups') });
  assert.equal(restored.safetyCopy, null); // nothing to replace

  assert.deepEqual(dumpDb(fresh), dumpDb(dbPath));
  const reopened = openDb(fresh);
  assert.equal(reopened.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(reopened.prepare('SELECT count(*) AS n FROM things').get().n, 3000);
  reopened.close();

  const status = readStatus(backupDir);
  assert.equal(status.offsite, 'ok');
  assert.equal(status.lastFile, path.basename(result.file));
  assert.equal(status.lastError, null);
});

test('the snapshot is consistent: committed WAL data in, uncommitted writes out', async (t) => {
  const dir = tmpDir(t);
  const { db, dbPath } = await liveDb(dir);
  t.after(() => db.close());
  db.pragma('wal_autocheckpoint = 0'); // keep recent commits in the -wal file only
  db.prepare("INSERT INTO things (id, name) VALUES (?, 'committed, still in WAL')").run(newId());

  // Another connection (another "request") is half-way through a write.
  const writer = openDb(dbPath);
  writer.exec('BEGIN IMMEDIATE');
  writer.prepare("INSERT INTO things (id, name) VALUES (?, 'not committed')").run(newId());

  const { file } = await runBackup({ db, dir: path.join(dir, 'b'), offsiteDir: null, keepDays: 30 });
  writer.exec('ROLLBACK');
  writer.close();

  const snap = openDb(file, { readonly: true });
  const names = snap.prepare("SELECT name FROM things WHERE name NOT LIKE 'Thing %'").all().map((r) => r.name);
  snap.close();
  assert.deepEqual(names, ['committed, still in WAL']);
});

test('a missing off-machine folder marker fails loudly but keeps the local copy', async (t) => {
  const dir = tmpDir(t);
  const { db } = await liveDb(dir);
  t.after(() => db.close());
  const notMounted = path.join(dir, 'unmounted-share');
  fs.mkdirSync(notMounted);
  const backupDir = path.join(dir, 'b');

  await assert.rejects(runBackup({ db, dir: backupDir, offsiteDir: notMounted, keepDays: 30 }), /\.suite-backup-target/);
  assert.equal(listBackups(backupDir).length, 1);
  assert.equal(fs.readdirSync(notMounted).length, 0, 'nothing written to the stand-in folder');
  const status = readStatus(backupDir);
  assert.equal(status.offsite, 'failed');
  assert.equal(status.lastSuccessAt, undefined);
  assert.match(status.lastError, /mounted/);
});

test('keeps BACKUP_KEEP_DAYS of backups in both folders and never the newest', async (t) => {
  const dir = tmpDir(t);
  const { db } = await liveDb(dir);
  t.after(() => db.close());
  const offsite = prepareOffsite(dir);
  const backupDir = path.join(dir, 'b');
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-06T07:15:00.000Z');

  for (const age of [40, 31, 29, 10]) {
    await runBackup({ db, dir: backupDir, offsiteDir: offsite, keepDays: 999, now: new Date(now - age * day) });
  }
  fs.writeFileSync(path.join(offsite, 'notes.txt'), 'not a backup');
  const result = await runBackup({ db, dir: backupDir, offsiteDir: offsite, keepDays: 30, now });

  for (const folder of [backupDir, offsite]) {
    const ages = listBackups(folder).map((b) => Math.round((now - b.time) / day));
    assert.deepEqual(ages, [0, 10, 29], folder);
  }
  assert.equal(result.pruned.length, 4);
  assert.ok(fs.existsSync(path.join(offsite, 'notes.txt')), 'other files untouched');
  assert.ok(fs.existsSync(path.join(offsite, OFFSITE_MARKER)));

  // keepDays = 0 still leaves the newest one.
  assert.deepEqual(pruneBackups(offsite, 0, new Date(now.getTime() + 365 * day)).length, 2);
  assert.equal(listBackups(offsite).length, 1);
});

test('backup file names round-trip and sort by time', () => {
  const d = new Date('2026-10-06T03:15:00.123Z');
  assert.equal(backupFileName(d), 'suite-2026-10-06T031500.123Z.db');
  assert.equal(backupFileTime(backupFileName(d)).getTime(), d.getTime());
  assert.equal(backupFileTime('pre-restore-2026.db'), null);
});

test('restore refuses while the server runs, then replaces the database and keeps a safety copy', async (t) => {
  const dir = tmpDir(t);
  const { db, dbPath } = await liveDb(dir);
  const backupDir = path.join(dir, 'data', 'backups');
  const { file } = await runBackup({ db, dir: backupDir, offsiteDir: null, keepDays: 30 });
  const before = dumpDb(dbPath);

  // Changes after the backup that the restore should undo.
  db.exec("DELETE FROM things WHERE qty > 100; INSERT INTO things (id, name) VALUES ('late', 'after backup')");
  const changed = dumpDb(dbPath);

  const stopHeartbeat = startHeartbeat(lockPathFor(dbPath));
  await assert.rejects(restoreBackup({ from: file, dbPath, backupDir }), /running/);
  stopHeartbeat();
  db.close(); // server stopped

  const result = await restoreBackup({ from: file, dbPath, backupDir });
  assert.deepEqual(dumpDb(dbPath), before);
  assert.ok(result.safetyCopy && fs.existsSync(result.safetyCopy));
  assert.deepEqual(dumpDb(result.safetyCopy), changed);
  assert.ok(!fs.existsSync(`${dbPath}.restoring`));
});

test('restore rejects files that are not good suite databases', async (t) => {
  const dir = tmpDir(t);
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'this is not sqlite');
  const target = path.join(dir, 'suite.db');
  await assert.rejects(restoreBackup({ from: junk, dbPath: target, backupDir: dir }), /not a database|integrity/i);

  const other = openDb(path.join(dir, 'other.db'));
  other.exec('CREATE TABLE x (a)');
  other.close();
  await assert.rejects(restoreBackup({ from: path.join(dir, 'other.db'), dbPath: target, backupDir: dir }), /not a suite database/);
  assert.ok(!fs.existsSync(target));
});

test('npm run backup / restore scripts work end to end', async (t) => {
  const dir = tmpDir(t);
  const { db, dbPath } = await liveDb(dir);
  db.close();
  const offsite = prepareOffsite(dir);
  const env = { ...process.env, DATA_DIR: path.join(dir, 'data'), BACKUP_OFFSITE_DIR: offsite, BACKUP_KEEP_DAYS: '7' };

  const out = await run(process.execPath, ['scripts/backup.js'], { cwd: serverDir, env });
  assert.match(out.stdout, /copied off-machine/);
  const [latest] = listBackups(offsite);

  const target = path.join(dir, 'drill', 'suite.db');
  const listed = await run(process.execPath, ['scripts/restore.js', '--list'], { cwd: serverDir, env });
  assert.ok(listed.stdout.includes(latest.path));
  const restored = await run(process.execPath, ['scripts/restore.js', latest.path, '--to', target], { cwd: serverDir, env });
  assert.match(restored.stdout, /Restore complete/);
  assert.deepEqual(dumpDb(target), dumpDb(dbPath));
});

test('schedule: next run time and catch-up rule', () => {
  const evening = new Date(2026, 9, 6, 22, 0);
  assert.deepEqual(nextRunAt('03:15', evening), new Date(2026, 9, 7, 3, 15));
  const early = new Date(2026, 9, 6, 1, 0);
  assert.deepEqual(nextRunAt('03:15', early), new Date(2026, 9, 6, 3, 15));
  assert.deepEqual(nextRunAt('03:15', new Date(2026, 9, 6, 3, 15)), new Date(2026, 9, 7, 3, 15));

  const now = new Date('2026-10-06T12:00:00Z');
  assert.equal(needsCatchUp(null, now), true);
  assert.equal(needsCatchUp('2026-10-06T07:15:00Z', now), false);
  assert.equal(needsCatchUp('2026-10-04T07:15:00Z', now), true);
});
