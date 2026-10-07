// A few promise helpers around IndexedDB (no library). Runs in the browser and,
// for tests, in Node with fake-indexeddb.
//
// Transactions: `transact(db, stores, mode, fn)` runs `fn(tx)` and resolves with its
// result once the transaction has committed (rejects if it aborts). Inside `fn`, only
// await IndexedDB requests (tx.get/put/…): awaiting anything else (fetch, timers) lets
// the transaction auto-commit early. Readwrite transactions over the same stores run one
// after another, across tabs too, which is what makes read-modify-write (the HLC, the
// outbox counter) safe without a lock.

/** Promise for one IDBRequest. */
export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Open (and create or upgrade) a database.
 * @param {IDBFactory} factory
 * @param {string} name
 * @param {number} version
 * @param {(db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void} upgrade
 */
export function openDatabase(factory, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = factory.open(name, version);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion, req.transaction);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Another tab holds an older version open and won't close it: wait (it closes on versionchange).
    req.onblocked = () => {};
  });
}

/** Delete a database. Resolves once it is gone (other connections are asked to close first). */
export function deleteDatabase(factory, name) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = factory.deleteDatabase(name);
    } catch (err) {
      reject(err);
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {}; // fires while other tabs still have it open; success follows once they close
  });
}

/** A transaction with promise-returning shortcuts per store. */
function wrap(tx) {
  const store = (name) => tx.objectStore(name);
  return {
    raw: tx,
    get: (s, key) => request(store(s).get(key)),
    getAll: (s, query) => request(query === undefined ? store(s).getAll() : store(s).getAll(query)),
    getAllFromIndex: (s, index, query) => request(store(s).index(index).getAll(query)),
    count: (s, query) => request(query === undefined ? store(s).count() : store(s).count(query)),
    put: (s, value, key) => request(key === undefined ? store(s).put(value) : store(s).put(value, key)),
    delete: (s, key) => request(store(s).delete(key)),
    clear: (s) => request(store(s).clear()),
  };
}

/**
 * Run fn inside one transaction; resolves with fn's result after commit.
 * @template T
 * @param {IDBDatabase} db
 * @param {string|string[]} stores
 * @param {'readonly'|'readwrite'} mode
 * @param {(tx: ReturnType<typeof wrap>) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export function transact(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    let failed = null;
    tx.oncomplete = () => (failed ? reject(failed) : resolve(result));
    tx.onerror = () => {
      failed = failed ?? tx.error;
    };
    tx.onabort = () => reject(failed ?? tx.error ?? new Error('IndexedDB transaction aborted'));
    Promise.resolve()
      .then(() => fn(wrap(tx)))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        failed = err;
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
      });
  });
}
