// Starts the suite server: open the database, run migrations, listen, keep the
// heartbeat file fresh, schedule the nightly backup, shut down cleanly.
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { createLogger } from './lib/log.js';
import { openDb } from './db/open.js';
import { createApp } from './app.js';
import { startHeartbeat } from './lib/serverLock.js';
import { lockPathFor } from './backup/restore.js';
import { runBackup, readStatus } from './backup/backup.js';
import { startBackupSchedule } from './backup/schedule.js';

const config = loadConfig();
const log = createLogger('suite');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(config.dbPath);
const { app } = await createApp({ config, db, log });
const stopHeartbeat = startHeartbeat(lockPathFor(config.dbPath));

const server = app.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port} (db ${config.dbPath})`);
});

let stopBackups = () => {};
if (config.backup.enabled) {
  const backupLog = log.child('backup');
  if (!config.backup.offsiteDir) backupLog.warn('BACKUP_OFFSITE_DIR is not set — backups will stay on this machine');
  stopBackups = startBackupSchedule({
    time: config.backup.time,
    lastSuccessAt: readStatus(config.backup.dir)?.lastSuccessAt ?? null,
    log: backupLog,
    run: () => runBackup({
      db,
      dir: config.backup.dir,
      offsiteDir: config.backup.offsiteDir,
      keepDays: config.backup.keepDays,
      now: new Date(),
      log: (m) => backupLog.info(m),
    }),
  });
} else {
  log.info('nightly backup schedule is off (BACKUP_ENABLED); `npm run backup` still works');
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received, shutting down`);
  stopBackups();
  server.close(() => {
    db.close(); // checkpoints the WAL into the main file
    stopHeartbeat();
    log.info('stopped');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
