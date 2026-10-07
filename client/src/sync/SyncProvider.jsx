import { useEffect, useState } from 'react';
import { useAuth } from '../auth/session.jsx';
import { acquireSync, releaseSync } from './index.js';
import { SyncContext } from './hooks.js';

/**
 * Opens this device's offline copy and keeps it syncing while someone is signed in
 * (rendered inside AuthGate). Signing out or an ended session unmounts it, which stops
 * syncing; the data stays unless clearLocalData() deletes it (device_signed_out, Sign out).
 */
export default function SyncProvider({ children }) {
  const { session, recheck } = useAuth();
  const deviceId = session?.device?.id ?? null;
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    if (!deviceId) return undefined;
    const e = acquireSync(deviceId);
    setEngine(e);
    // The offline copy was deleted under us — another tab signed out, was told this device was
    // signed out, or someone else signed in there: ask the server who (if anyone) is signed in now.
    const off = e.subscribe((ev) => {
      if (ev.type === 'status' && ev.status.phase === 'stopped' && ev.status.stoppedBy === 'closed') recheck();
    });
    return () => {
      off();
      releaseSync(e);
      setEngine(null);
    };
  }, [deviceId, recheck]);

  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>;
}
