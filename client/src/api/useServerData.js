// For pages that show the server's own settings and state (Connections, Automations, System):
// they are not synced records, so they need a connection to the suite. Loads `url` now, again
// when the app comes back to the foreground or online, and every `everyMs` while visible.
// `offline` is true when the server can't be reached (no network, or no answer): show the last
// answer (if any), say so, and disable the switches.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './client.js';

/** How long "Checking…" shows at least after a tap on Check again. */
export const MIN_CHECK_MS = 600;

export function useServerData(url, { everyMs = 30_000 } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true, offline: false });
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState((s) => ({ ...s, loading: false, offline: true }));
      return;
    }
    try {
      const data = await api.get(url);
      if (alive.current) setState({ data, error: null, loading: false, offline: false });
    } catch (err) {
      if (alive.current) setState((s) => ({ ...s, error: err, loading: false, offline: err.status === 0 }));
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    load();
    const onVisible = () => document.visibilityState === 'visible' && load();
    const onOnline = () => load();
    const onOffline = () => setState((s) => ({ ...s, offline: true }));
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = everyMs ? setInterval(() => document.visibilityState === 'visible' && load(), everyMs) : null;
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (timer) clearInterval(timer);
    };
  }, [load, everyMs]);

  /** Put a fresh answer in place (after a change the server answered with). */
  const replace = useCallback((fn) => setState((s) => ({ ...s, data: fn(s.data) })), []);

  // "Check again" (a person's tap): shown as "Checking…" for at least a moment, so a fast answer that changes nothing
  // still visibly did something; `checkedAt` = when that check finished.
  const [check, setCheck] = useState({ checking: false, checkedAt: null });
  const checkAgain = useCallback(async () => {
    setCheck((c) => ({ ...c, checking: true }));
    await Promise.all([load(), new Promise((r) => setTimeout(r, MIN_CHECK_MS))]);
    if (alive.current) setCheck({ checking: false, checkedAt: Date.now() });
  }, [load]);
  return { ...state, ...check, reload: load, checkAgain, replace };
}
