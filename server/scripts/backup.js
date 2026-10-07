#!/usr/bin/env node
// Make a backup now, with the same settings as the nightly one.
//   npm run backup                         (from the repo root)
//   docker compose exec suite npm run backup
// Safe while the server is running. Exits non-zero if anything failed,
// including the off-machine copy (the local copy is kept in that case).
import { loadConfig } from '../src/config.js';
import { runBackup } from '../src/backup/backup.js';

const config = loadConfig();
try {
  const result = await runBackup({
    dbPath: config.dbPath,
    dir: config.backup.dir,
    offsiteDir: config.backup.offsiteDir,
    keepDays: config.backup.keepDays,
    log: (m) => console.log(m),
  });
  if (!result.offsiteFile) console.warn('WARNING: BACKUP_OFFSITE_DIR is not set — this backup is on this machine only.');
  if (result.pruned.length) console.log(`pruned: ${result.pruned.join(', ')}`);
  console.log(`sha256 ${result.sha256}`);
} catch (err) {
  console.error(`BACKUP FAILED: ${err.message}`);
  process.exit(1);
}
