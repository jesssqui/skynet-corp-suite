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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Express 'trust proxy': '' → loopback (Tailscale Serve on this machine); 'false' → trust nobody. */
function trustProxy(value) {
  if (value === undefined || value.trim() === '') return 'loopback';
  if (['false', 'off', 'no', '0'].includes(value.trim().toLowerCase())) return false;
  return value.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
}

function origins(value) {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean).map((o) => {
    let url;
    try {
      url = new URL(o);
    } catch {
      throw new Error(`ALLOWED_ORIGINS: "${o}" is not a URL like https://mac.tailnet.ts.net:8443`);
    }
    if (url.origin === 'null' || url.pathname !== '/' || url.search) {
      throw new Error(`ALLOWED_ORIGINS: "${o}" must be just scheme://host[:port]`);
    }
    return url.origin;
  });
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function days(value, fallback, name) {
  const n = int(value, fallback, name);
  if (n < 1) throw new Error(`${name} must be at least 1`);
  return n * DAY_MS;
}

function scryptN(value) {
  const n = int(value, 2 ** 16, 'AUTH_SCRYPT_N');
  if (n < 2 ** 10 || (n & (n - 1)) !== 0) throw new Error('AUTH_SCRYPT_N must be a power of two, at least 1024');
  return n;
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
    // The server only listens on this machine by default, sign-in or not: Tailscale
    // Serve is the way in. In Docker the container listens on 0.0.0.0 but the port is
    // published on the Mac's 127.0.0.1 only (see docker-compose.yml).
    host: env.HOST || '127.0.0.1',
    port: int(env.PORT, 3100, 'PORT'),
    dataDir,
    dbPath: path.resolve(env.DB_PATH || path.join(dataDir, 'suite.db')),
    clientDist: path.resolve(env.CLIENT_DIST || path.join(REPO_ROOT, 'client', 'dist')),
    commit: env.APP_COMMIT || null,
    auth: {
      trustProxy: trustProxy(env.TRUST_PROXY),
      // Extra origins allowed to make changes (the server's own origin always is).
      allowedOrigins: origins(env.ALLOWED_ORIGINS),
      // A session ends after this many days without use, and in any case this many days after sign-in.
      sessionIdleMs: days(env.SESSION_IDLE_DAYS, 30, 'SESSION_IDLE_DAYS'),
      sessionMaxMs: days(env.SESSION_MAX_DAYS, 90, 'SESSION_MAX_DAYS'),
      // scrypt cost (a power of two). Stored with each hash, so raising it later only affects new passwords.
      scryptN: scryptN(env.AUTH_SCRYPT_N),
    },
    automations: {
      // The minute scheduler (C8): on by default in production only, like the backup schedule.
      // "Run now" on the Automations page works either way.
      scheduled: bool(env.AUTOMATIONS_ENABLED, production),
    },
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
