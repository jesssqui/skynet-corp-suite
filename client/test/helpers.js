// Test helpers for the browser sync engine: a real suite server (with the test-only
// syncdemo module, as in server/test/sync.test.js) and pretend devices, each with its own
// IndexedDB (fake-indexeddb), signed-in session and an on/off switch for the connection.
import { IDBFactory } from 'fake-indexeddb';
import { modules } from '../../server/src/modules/index.js';
import syncdemo from '../../server/test/fixtures/syncdemo/index.js';
import chk from './fixtures/chk/index.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from '../../server/test/helpers.js';
import { createSyncEngine, createLocalLocks } from '../src/sync/engine.js';

export { tmpDir, testConfig };

/** A suite server with the test-only syncdemo and chk modules registered and both accounts made. */
export async function startServer(t, config) {
  const env = await startApp(t, config ?? testConfig(tmpDir(t)), { modules: [...modules, syncdemo, chk] });
  const users = await ensureTestUsers(env.ctx);
  return { ...env, config: config ?? env.ctx.config, users };
}

/** What the browser's api client does: JSON over fetch, errors carry status (0 = no connection) and code. */
export function transportFor(dev) {
  async function call(method, path, body) {
    dev.calls.push(`${method} ${path.split('?')[0]}`);
    if (!dev.online) throw Object.assign(new Error('Can’t reach the suite server'), { status: 0 });
    const fail = dev.failNext.shift();
    if (fail) throw Object.assign(new Error(fail.message ?? 'injected failure'), { status: fail.status, code: fail.code });
    let res;
    try {
      res = await fetch(`${dev.server.base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          cookie: dev.cookie,
          origin: dev.server.base,
          'x-suite-device': dev.id,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: 0 });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, code: data?.code, body: data });
    return data;
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
  };
}

/**
 * A phone or Mac: signed in as `actor`, with its own offline database.
 * dev.engine is a started engine that has synced once (autoSync off: tests call syncNow themselves).
 */
export async function makeDevice(t, server, actor, { idbFactory = new IDBFactory(), deviceHint = null, engine = {}, start = true } = {}) {
  const s = sessionFor(server.ctx, server.users[actor], { deviceHint });
  const dev = {
    id: s.deviceId,
    actor,
    server,
    cookie: s.cookie,
    online: true,
    idbFactory,
    calls: [],
    failNext: [],
    lost: [],
    engines: [],
  };
  dev.transport = transportFor(dev);
  dev.newEngine = (opts = {}) => {
    const e = createSyncEngine({
      deviceId: dev.id,
      transport: dev.transport,
      idbFactory,
      locks: createLocalLocks(),
      isOnline: () => dev.online,
      autoSync: false,
      onSessionLost: (code) => dev.lost.push(code),
      ...engine,
      ...opts,
    });
    dev.engines.push(e);
    return e;
  };
  /** Sign in again on (maybe another process of) the server, as the same device. */
  dev.signInAgain = (srv = dev.server) => {
    const again = sessionFor(srv.ctx, srv.users[actor], { deviceHint: dev.id });
    if (again.deviceId !== dev.id) throw new Error('signing in again should keep the device id');
    dev.server = srv;
    dev.cookie = again.cookie;
  };
  dev.engine = dev.newEngine();
  t.after(() => dev.engines.forEach((e) => e.stop()));
  if (start) {
    await dev.engine.start();
    await dev.engine.syncNow('test'); // the first sync (start() doesn't wait for it)
  }
  return dev;
}

/** Wait until no sync cycle is running (start() kicks one off without waiting). */
export const settle = (engine) => engine.syncNow('test');

export const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
export const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
