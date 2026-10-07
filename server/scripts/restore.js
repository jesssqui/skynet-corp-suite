#!/usr/bin/env node
// Restore a backup over the live database. Stop the server first.
//   npm run restore -- --list                 list backups (local and off-machine)
//   npm run restore -- <file>                 restore that file into DB_PATH
//   npm run restore -- <file> --to <path>     restore into another path (drills, inspection)
//   npm run restore -- <file> --force         skip the "server running" / safety-copy guards
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { listBackups } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';

const config = loadConfig();
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--list') || args.length === 0) {
  for (const [label, dir] of [['local', config.backup.dir], ['off-machine', config.backup.offsiteDir]]) {
    if (!dir) {
      console.log(`${label}: (not configured)`);
      continue;
    }
    const list = listBackups(dir);
    console.log(`${label}: ${dir} — ${list.length} backup(s)`);
    for (const b of list) console.log(`  ${b.path}   ${b.time.toISOString()}`);
  }
  if (args.length === 0) console.log('\nUsage: npm run restore -- <backup file> [--to <db path>] [--force]');
  process.exit(0);
}

const from = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--to'));
const dbPath = path.resolve(option('--to') || config.dbPath);
try {
  const result = await restoreBackup({
    from,
    dbPath,
    backupDir: config.backup.dir,
    force: flag('--force'),
    log: (m) => console.log(m),
  });
  if (result.safetyCopy) console.log(`The database you replaced is saved at ${result.safetyCopy}`);
  console.log('Restore complete. Start the server again.');
} catch (err) {
  console.error(`RESTORE FAILED: ${err.message}`);
  process.exit(1);
}
