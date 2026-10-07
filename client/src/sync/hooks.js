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
 * Run `load(engine)` now and again after every local data change.
 * @returns {{ data: any, loading: boolean, error: Error|null }}
 */
export function useSyncData(load, deps = []) {
  const engine = useSyncEngine();
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState({ data: undefined, loading: true, error: null });
  useEffect(() => {
    if (!engine) return undefined;
    let alive = true;
    let pending = false;
    const run = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        Promise.resolve()
          .then(() => loader.current(engine))
          .then(
            (data) => alive && setState({ data, loading: false, error: null }),
            (error) => alive && setState((s) => ({ ...s, loading: false, error })),
          );
      });
    };
    run();
    const off = engine.subscribe((e) => e.type === 'data' && run());
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, ...deps]);
  return state;
}

/**
 * Records of one entity, live. `where`/`sort` as in engine.list; when they depend on state,
 * list that state in `deps` so the list is re-read when it changes.
 */
export function useRecords(entity, { where, sort } = {}, deps = []) {
  const { data, loading, error } = useSyncData((engine) => engine.list(entity, { where, sort }), [entity, ...deps]);
  return { records: data ?? [], loading, error };
}

/** One record, live (null when this device doesn't have it). */
export function useRecord(entity, id) {
  const { data, loading, error } = useSyncData((engine) => (id ? engine.get(entity, id) : null), [entity, id]);
  return { record: data ?? null, loading, error };
}
