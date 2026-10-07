// The offline store for the whole app: one sync engine per signed-in device, shared by every
// page. Modules (C3a clients, C4a tasks, notes…) read and write synced records ONLY through
// this — `store` for one-off calls, the hooks in ./hooks.js inside components:
//
//   import { store, useRecords, useRecord } from '../../sync/index.js';
//   const id = await store.create('task', { title: 'Call Lefty’s', done: false });
//   await store.update('task', id, { done: true });       // only changed fields are sent
//   await store.remove('task', id);
//   const { records } = useRecords('task', { where: { done: false }, sort: 'due' });
//   const { record } = useRecord('client', clientId);      // record._sync: { pending, flagged, clashes }
//
// A write stores its change as a step in the IndexedDB outbox (one transaction); reads replay the
// outbox over the pulled copy, so it shows at once, online or not, and the engine sends it when
// it can. See CLAUDE.md "Offline sync (C2b)".
import { api } from '../api/client.js';
import { createSyncEngine, SyncError } from './engine.js';

export { SyncError } from './engine.js';
export { SyncContext, useSyncEngine, useSyncStatus, useSyncData, useRecords, useRecord } from './hooks.js';

const PERIODIC_MS = 60 * 1000; // look for the other person's changes while the app is open

let current = null; // { deviceId, engine, refs, detach }

function attach(engine) {
  const syncIfVisible = (reason) => document.visibilityState === 'visible' && engine.syncNow(reason);
  const onOnline = () => engine.syncNow('online');
  const onOffline = () => engine.markOffline();
  const onVisible = () => syncIfVisible('foreground');
  const onShow = (e) => e.persisted && engine.syncNow('foreground'); // back from the page cache (iOS)
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('pageshow', onShow);
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(() => syncIfVisible('periodic'), PERIODIC_MS);
  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('pageshow', onShow);
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}

/**
 * The engine for this device, started on first use (SyncProvider calls this once signed in).
 * Pair every call with releaseSync().
 */
export function acquireSync(deviceId) {
  if (current && current.deviceId === deviceId && !current.engine.isStopped()) {
    current.refs += 1;
    return current.engine;
  }
  if (current) shutdown();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('suite-sync') : null;
  const engine = createSyncEngine({
    deviceId,
    transport: { get: (path) => api.get(path), post: (path, body) => api.post(path, body) },
    channel,
    // 401s are handled by api/client.js (SESSION_LOST_EVENT -> auth/session.jsx), not here.
  });
  current = { deviceId, engine, refs: 1, channel, detach: attach(engine) };
  engine.start().catch((err) => {
    if (err?.code !== 'stopped') console.warn('Offline copy unavailable:', err);
  });
  // Ask the browser not to evict the offline copy under storage pressure (best effort).
  navigator.storage?.persist?.().catch(() => {});
  return engine;
}

function shutdown() {
  const c = current;
  current = null;
  c.detach();
  c.engine.stop();
  c.channel?.close();
}

export function releaseSync(engine) {
  if (!current || current.engine !== engine) {
    engine.stop();
    return;
  }
  current.refs -= 1;
  if (current.refs <= 0) shutdown();
}

function need() {
  if (!current || current.engine.isStopped()) throw new SyncError('stopped', 'Not signed in on this device');
  return current.engine;
}

/** Synced records, for code outside components (event handlers, helpers). Same API as the engine. */
export const store = {
  list: (entity, opts) => need().list(entity, opts),
  get: (entity, id) => need().get(entity, id),
  create: (entity, fields, opts) => need().create(entity, fields, opts),
  update: (entity, id, changes) => need().update(entity, id, changes),
  remove: (entity, id) => need().remove(entity, id),
  /** fn({ type: 'data' | 'status', status }) after any change; returns unsubscribe. */
  subscribe: (fn) => need().subscribe(fn),
  syncNow: () => need().syncNow('manual'),
};
