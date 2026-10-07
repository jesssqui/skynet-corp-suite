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
  const { session } = useAuth();
  const deviceId = session?.device?.id ?? null;
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    if (!deviceId) return undefined;
    const e = acquireSync(deviceId);
    setEngine(e);
    return () => {
      releaseSync(e);
      setEngine(null);
    };
  }, [deviceId]);

  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>;
}
