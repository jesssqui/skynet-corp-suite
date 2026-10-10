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

/** The suite's own address as people open it (C6a: the calendar feed's links), e.g. https://mac-mini.tail1234.ts.net:8443. */
function publicUrl(value) {
  if (!value || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`SUITE_URL: "${value}" is not a URL like https://mac-mini.tail1234.ts.net:8443`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`SUITE_URL: "${value}" must be just scheme://host[:port]`);
  }
  return url.origin;
}

/**
 * The time zone tasks' "HH:MM" times are in (C6a: timed events in the calendar feed): CALENDAR_TIME_ZONE,
 * else TZ (the container's, America/Toronto), else this machine's. Must be an IANA name Intl knows.
 */
function timeZone(env) {
  const candidates = [env.CALENDAR_TIME_ZONE, env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Toronto'];
  for (const [i, zone] of candidates.entries()) {
    if (!zone || !zone.trim()) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() });
      return zone.trim();
    } catch {
      if (i === 0) throw new Error(`CALENDAR_TIME_ZONE: "${zone}" is not a time zone like America/Toronto`);
    }
  }
  return 'America/Toronto';
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
    wholesale: {
      // D1: the key that encrypts the Order Manager connection's shared secret in the database. A file
      // in the data folder (the Docker volume), never in the database — so backup files (and their
      // off-machine copies) hold the secret only encrypted, without the key. Made on first use.
      keyFile: path.resolve(env.WOM_KEY_FILE || path.join(dataDir, 'wom-secret.key')),
      // The address the Order Manager should be given (shown on the Connections page). The Order
      // Manager runs in its own container on the same Mac; Docker Desktop's host.docker.internal
      // reaches the suite's port published on the Mac's 127.0.0.1 (DEPLOY.md, "Order Manager connection").
      connectUrl: env.WOM_CONNECT_URL || `http://host.docker.internal:${env.SUITE_PORT || 3100}`,
    },
    calendar: {
      // C6a: the address the task calendar feed's links point back to (the ts.net address from Tailscale
      // Serve). Empty: the address the calendar app used to fetch the feed (and, on the Account page,
      // the address the page is open at).
      publicUrl: publicUrl(env.SUITE_URL),
      // The zone of tasks' due times; timed events are written in it (with a VTIMEZONE).
      timeZone: timeZone(env),
    },
    stockroom: {
      // D16: the key that encrypts Stockroom's read key (its secret) in the database — a file in the
      // data folder, like D1's (never in the database or the backups). Made on first use.
      keyFile: path.resolve(env.STOCKROOM_KEY_FILE || path.join(dataDir, 'stockroom-secret.key')),
      // Each call to Stockroom (on Fly) gives up after this long.
      timeoutMs: int(env.STOCKROOM_TIMEOUT_MS, 15_000, 'STOCKROOM_TIMEOUT_MS'),
      // The pull loop (one look a minute, calls only when an answer is due): on by default in production,
      // like the automation scheduler; "Pull now" on the Connections card works either way.
      scheduled: bool(env.STOCKROOM_PULL_ENABLED, production),
    },
    woocommerce: {
      // D12: the key that encrypts each store's REST consumer secret in the database — a file in the data
      // folder, like D16's (never in the database or the backups). Made on first use.
      keyFile: path.resolve(env.WOO_KEY_FILE || path.join(dataDir, 'woocommerce-secret.key')),
      // Each call to a store gives up after this long (Analytics over 90 days can take a few seconds on a busy shop).
      timeoutMs: int(env.WOO_TIMEOUT_MS, 20_000, 'WOO_TIMEOUT_MS'),
      // How often each store's rolling window (the last 60 days) is read again.
      everyMinutes: int(env.WOO_PULL_EVERY_MIN, 60, 'WOO_PULL_EVERY_MIN'),
      // The pull loop: on by default in production; "Pull now" on a store's card works either way.
      scheduled: bool(env.WOO_PULL_ENABLED, production),
    },
    ebay: {
      // D13: the key that encrypts the eBay Cert ID and refresh token in the database — a file in the data folder,
      // like D12's (never in the database or the backups). Made on first use.
      keyFile: path.resolve(env.EBAY_KEY_FILE || path.join(dataDir, 'ebay-secret.key')),
      // eBay's hosts (production). Replaceable for tests only: https, or http just for this machine.
      apiUrl: env.EBAY_API_URL || 'https://api.ebay.com',
      authUrl: env.EBAY_AUTH_URL || 'https://auth.ebay.com',
      timeoutMs: int(env.EBAY_TIMEOUT_MS, 20_000, 'EBAY_TIMEOUT_MS'),
      // How often the last 90 days of orders are read again.
      everyMinutes: int(env.EBAY_PULL_EVERY_MIN, 60, 'EBAY_PULL_EVERY_MIN'),
      // The zone Save Point Shop's days are counted in until changed on its card.
      timeZone: env.EBAY_TIME_ZONE || timeZone(env) || 'America/Toronto',
      // The pull loop: on by default in production; "Pull now" on the card works either way.
      scheduled: bool(env.EBAY_PULL_ENABLED, production),
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
