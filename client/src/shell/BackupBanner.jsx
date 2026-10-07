import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';

const POLL_MS = 5 * 60 * 1000;

// Asks the server about backups on load, every 5 minutes and whenever the app
// comes back to the foreground. Returns the health payload's `backup` part.
function useBackupStatus() {
  const [backup, setBackup] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const status = await api.get('/api/health');
        if (!cancelled) setBackup(status.backup);
      } catch {
        /* server unreachable: not a backup problem; leave the last answer */
      }
    };
    check();
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return backup;
}

/** Banner across every page while backups need attention. Hidden when the
 *  nightly schedule is off (development), where "no backup" is expected. */
export default function BackupBanner() {
  const backup = useBackupStatus();
  if (!backup || backup.ok || !backup.scheduled) return null;

  const message = backup.lastError
    ? `Backups need attention: ${backup.lastError}`
    : backup.lastSuccessAt
      ? 'Backups need attention: the last good backup is more than a day old.'
      : 'No backup has been made yet.';

  return (
    <div
      role="alert"
      style={{
        background: 'var(--danger-soft)',
        color: 'var(--danger)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--radius)',
        padding: 'var(--space-3) var(--space-4)',
        marginBottom: 'var(--space-5)',
        fontSize: 'var(--text-sm)',
        fontWeight: 550,
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{message}</span>
      <Link to="/system" style={{ color: 'inherit', whiteSpace: 'nowrap' }}>
        Details
      </Link>
    </div>
  );
}
