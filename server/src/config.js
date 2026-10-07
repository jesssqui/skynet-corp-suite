// All settings come from environment variables (see .env.example). Read once at
// start-up; tests build their own config with loadConfig({ ...overrides }).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
export const APP_VERSION = rootPkg.version;

function int(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got "${value}"`);
  return n;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(REPO_ROOT, 'data'));

  const backupTime = env.BACKUP_TIME || '03:15';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupTime)) {
    throw new Error(`BACKUP_TIME must be HH:MM (24-hour), got "${backupTime}"`);
  }

  return {
    production,
    // No sign-in exists until C1, so the server only listens on this machine by
    // default. In Docker the container listens on 0.0.0.0 but the port is
    // published on the Mac's 127.0.0.1 only (see docker-compose.yml).
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3100, 'PORT'),
    dataDir,
    dbPath: path.resolve(env.DB_PATH || path.join(dataDir, 'suite.db')),
    clientDist: path.resolve(env.CLIENT_DIST || path.join(REPO_ROOT, 'client', 'dist')),
    commit: env.APP_COMMIT || null,
    backup: {
      // Scheduler on by default in production only; `npm run backup` works either way.
      enabled: bool(env.BACKUP_ENABLED, production),
      time: backupTime, // local time of the container (TZ)
      dir: path.resolve(env.BACKUP_DIR || path.join(dataDir, 'backups')),
      offsiteDir: env.BACKUP_OFFSITE_DIR ? path.resolve(env.BACKUP_OFFSITE_DIR) : null,
      keepDays: int(env.BACKUP_KEEP_DAYS, 30, 'BACKUP_KEEP_DAYS'),
    },
  };
}
