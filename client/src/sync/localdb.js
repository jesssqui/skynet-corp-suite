// The on-device database (IndexedDB) that holds this device's offline copy and outbox.
// One database per browser profile / home-screen app; it belongs to the device id
// stored in it (meta.deviceId) and is deleted when the device is signed out.
//
// Stores
//   records  { entity, id, fields, flagged, clashes, seq }   key [entity, id]; index 'entity'
//            the server's truth as last pulled (pending changes are replayed over it when shown)
//   staging  same shape: a pull from scratch fills this, then replaces `records` in one go
//            (the old copy stays usable offline until the new one is complete)
//   outbox   { k: [lane, n], n, step, createdAt, parked?, resend? }   changes not yet accepted,
//            pushed in key order; lane 0 = kept steps re-sent after a restore, lane 1 = normal.
//            parked = { code: 'not_found', reason, atPull, at }: retried after the next complete pull
//   sent     { n, step, sentAt, seq, generation, status, applied, kept }   accepted steps, kept 30 days
//            so they can be re-sent after the server is restored from a backup
//   attention { n, step, code, reason, at }   rejected steps the person fixes or discards
//   meta     key -> value: deviceId, hlc, generation, pull (bookmark), seen (cursor of the last
//            complete pull), pulls (complete pulls so far), nextN, info (entity definitions),
//            lastSyncAt, lastPullAt, fullPull (a pull from scratch is in progress)
import { openDatabase, deleteDatabase } from './idb.js';

export const DB_NAME = 'suite-offline';
export const DB_VERSION = 1;
export const STORES = ['records', 'staging', 'outbox', 'sent', 'attention', 'meta'];

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const records = db.createObjectStore('records', { keyPath: ['entity', 'id'] });
    records.createIndex('entity', 'entity');
    const staging = db.createObjectStore('staging', { keyPath: ['entity', 'id'] });
    staging.createIndex('entity', 'entity');
    db.createObjectStore('outbox', { keyPath: 'k' });
    db.createObjectStore('sent', { keyPath: 'n' });
    db.createObjectStore('attention', { keyPath: 'n' });
    db.createObjectStore('meta');
  }
}

// Open connections in this page, so clearing can close them before deleting.
const open = new Set();

/**
 * Open the offline database. The connection closes itself when another tab (or
 * clearLocalData) wants to delete or upgrade it; `onClosed` is then called (not on close()).
 */
export async function openLocalDb(factory = globalThis.indexedDB, { name = DB_NAME, onClosed } = {}) {
  if (!factory) throw new Error('This browser has no IndexedDB: the suite can’t keep an offline copy here');
  const db = await openDatabase(factory, name, DB_VERSION, upgrade);
  const entry = { db, onClosed, factory, name };
  open.add(entry);
  const shut = (notify) => {
    if (!open.has(entry)) return;
    open.delete(entry);
    db.close();
    if (notify) entry.onClosed?.();
  };
  const close = () => shut(false);
  db.onversionchange = () => shut(true); // another tab or clearLocalData wants to delete it
  db.onclose = () => shut(true); // the browser closed it (storage cleared, disk trouble)
  return {
    db,
    close,
    /** Who to tell when the connection closes for a reason other than close(). */
    setOnClosed(fn) {
      entry.onClosed = fn;
    },
  };
}

/** Close every connection this page has to the offline database, then delete it. */
export async function deleteLocalDb(factory = globalThis.indexedDB, { name = DB_NAME } = {}) {
  if (!factory) return;
  for (const entry of [...open]) {
    if (entry.factory !== factory || entry.name !== name) continue;
    open.delete(entry);
    entry.db.close();
    entry.onClosed?.();
  }
  await deleteDatabase(factory, name);
}
