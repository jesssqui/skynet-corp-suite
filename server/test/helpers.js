import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/lib/log.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { modules as registeredModules } from '../src/modules/index.js';
import { newTotpSecret } from '../src/modules/auth/crypto.js';

export function tmpDir(t, prefix = 'suite-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function testConfig(dir, env = {}) {
  return loadConfig({
    DATA_DIR: path.join(dir, 'data'),
    BACKUP_OFFSITE_DIR: path.join(dir, 'offsite'),
    CLIENT_DIST: path.join(dir, 'no-client-build'),
    AUTH_SCRYPT_N: '1024', // fast hashing in tests only
    ...env,
  });
}

export const quietLog = createLogger('test', 'silent');

/** A clock tests can move: now() is real time plus `offsetMs`. */
export function testClock() {
  const clock = { offsetMs: 0, now: () => Date.now() + clock.offsetMs, advance: (ms) => { clock.offsetMs += ms; } };
  return clock;
}

/**
 * createApp on a real temporary database, listening on an ephemeral port.
 * Closed when the test ends (or earlier with close()).
 */
export async function startApp(t, config, { modules = registeredModules, now } = {}) {
  const db = openDb(config.dbPath);
  const { app, ctx } = await createApp({ config, db, log: quietLog, modules, ...(now ? { now } : {}) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    server.close(() => { db.close(); resolve(); });
  });
  t.after(close);
  return { db, ctx, app, close, base: `http://127.0.0.1:${server.address().port}` };
}

export const TEST_PASSWORD = 'correct horse battery staple';

/**
 * The two accounts (owner, partner) with two-factor on, made once per database the way the CLI does.
 * Each user row comes back with `totpSecret` (to make codes in tests).
 */
export async function ensureTestUsers(ctx) {
  const accounts = ctx.services.auth.accounts;
  const users = {};
  for (const [actor, username] of [['owner', 'jessy'], ['partner', 'sam']]) {
    let user = accounts.getUserByUsername(username);
    if (!user) {
      ({ user } = await accounts.createUserWithTwoFactor(
        { actor, username, displayName: username === 'jessy' ? 'Jessy' : 'Sam', password: TEST_PASSWORD },
        { secret: newTotpSecret(), step: 0 },
      ));
    }
    users[actor] = { ...user, totpSecret: accounts.getTotp(user.id).secret };
  }
  return users;
}

/**
 * A signed-in session made directly through the auth service (as after both factors),
 * for tests that are about something else (sync). Returns the cookie and device id.
 */
export function sessionFor(ctx, user, { deviceHint = null, userAgent = 'node-test' } = {}) {
  const s = ctx.services.auth.startSession({ user, deviceHint, userAgent, secondFactor: 'totp' });
  return { cookie: `suite_session=${s.token}`, deviceId: s.device.id, session: s };
}

/**
 * Every table's schema and rows, for comparing two databases. Leaves out the
 * sync module's restore mark (restore.js adds it on purpose; see sync tests).
 */
export function dumpDb(file) {
  const db = new Database(file, { readonly: true });
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
    const out = { schema: tables, rows: {}, userVersion: db.pragma('user_version', { simple: true }) };
    for (const { name } of tables.filter((t) => t.sql?.startsWith('CREATE TABLE'))) {
      out.rows[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all();
    }
    if (out.rows.sync_meta) out.rows.sync_meta = out.rows.sync_meta.filter((r) => r.key !== 'restore_pending');
    return out;
  } finally {
    db.close();
  }
}
