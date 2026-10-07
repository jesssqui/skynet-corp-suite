// React access to the offline store. SyncProvider (./SyncProvider.jsx) puts the signed-in
// device's engine in context; these hooks re-read whenever local data changes (a write here,
// a pull, another tab).
import { createContext, useContext, useEffect, useRef, useState } from 'react';

export const SyncContext = createContext(null);

/** The engine (null for a moment while it opens). */
export function useSyncEngine() {
  return useContext(SyncContext);
}

/** Sync status: { phase, waiting, parked, attention, lastSyncAt, lastError, nextRetryAt, ready, … }. */
export function useSyncStatus() {
  const engine = useSyncEngine();
  const [status, setStatus] = useState(() => engine?.status() ?? null);
  useEffect(() => {
    if (!engine) {
      setStatus(null);
      return undefined;
    }
    setStatus(engine.status());
    return engine.subscribe((e) => setStatus(e.status));
  }, [engine]);
  return status;
}

/**
 * Run `load(engine)` now and again after local data changes. `entities` limits that to changes of
 * those record types (data events name them; a list, or a function returning one); null = any change. When the engine stops (signed
 * out, data deleted from another tab) the data is dropped at once.
 * @returns {{ data: any, loading: boolean, error: Error|null }}
 */
export function useSyncData(load, deps = [], { entities = null } = {}) {
  const engine = useSyncEngine();
  const loader = useRef(load);
  loader.current = load;
  const watched = useRef(entities);
  watched.current = entities;
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  useEffect(() => {
    if (!engine) return undefined;
    let alive = true;
    let pending = false;
    const drop = () => setState({ data: undefined, loading: false, error: null });
    const run = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (!alive) return;
        if (engine.isStopped() && engine.status().phase === 'stopped') {
          drop();
          return;
        }
        Promise.resolve()
          .then(() => loader.current(engine))
          .then(
            (data) => alive && setState({ data, loading: false, error: null }),
            (error) => alive && setState((s) => ({ ...s, loading: false, error })),
          );
      });
    };
    run();
    const off = engine.subscribe((e) => {
      if (e.type === 'status') {
        if (e.status.phase === 'stopped' && alive) drop();
        return;
      }
      const want = typeof watched.current === 'function' ? watched.current() : watched.current;
      if (!e.entities || !want || e.entities.some((x) => want.includes(x))) run();
    });
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, ...deps]);
  return state;
}

/**
 * The record types whose changes can change what a list of `entity` shows: itself and every type
 * it belongs to (a contact disappears when its client is deleted). A function, so it follows the
 * engine's definitions once they arrive.
 */
function watchedFor(engine, entity) {
  return () => [entity, ...(engine?.ancestorsOf(entity) ?? [])];
}

/**
 * Records of one entity, live. `where`/`sort`/`orphans` as in engine.list (records under a deleted
 * parent are left out unless `orphans`); when where/sort depend on state, list that state in
 * `deps` so the list is re-read when it changes.
 */
export function useRecords(entity, { where, sort, orphans = false } = {}, deps = []) {
  const engine = useSyncEngine();
  const { data, loading, error } = useSyncData(
    (e) => e.list(entity, { where, sort, orphans }),
    [entity, orphans, ...deps],
    { entities: watchedFor(engine, entity) },
  );
  return { records: data ?? [], loading, error };
}

/** One record, live (null when this device doesn't have it, or something it belongs to is gone). */
export function useRecord(entity, id) {
  const engine = useSyncEngine();
  const { data, loading, error } = useSyncData((e) => (id ? e.get(entity, id) : null), [entity, id], { entities: watchedFor(engine, entity) });
  return { record: data ?? null, loading, error };
}
