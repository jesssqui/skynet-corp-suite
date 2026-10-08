import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { PageHeader, Card, Button, Badge, KeyValue, Segmented, Icon, useTheme } from '../../ui/index.js';
import SystemTabs from './SystemTabs.jsx';

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function BackupBadge({ backup }) {
  if (backup.ok) return <Badge tone="ok">Backed up</Badge>;
  if (!backup.lastSuccessAt && !backup.lastError) return <Badge tone="warn">No backup yet</Badge>;
  return <Badge tone="danger">Needs attention</Badge>;
}

export default function SystemPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const { mode, setMode } = useTheme();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.get('/api/health'));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <SystemTabs />
      <PageHeader
        title="System"
        subtitle="Server, database and backups"
        actions={<Button onClick={load} disabled={loading}>{loading ? 'Checking…' : 'Check again'}</Button>}
      />

      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <Card title="Server">
          {error ? (
            <Badge tone="danger">{error}</Badge>
          ) : !status ? (
            <span style={{ color: 'var(--text-muted)' }}>Loading…</span>
          ) : (
            <KeyValue
              rows={[
                ['Status', status.ok ? <Badge tone="ok">Running</Badge> : <Badge tone="danger">Database problem</Badge>],
                ['Version', `${status.version}${status.commit ? ` (${status.commit.slice(0, 7)})` : ''}`],
                ['Database', status.db.ok ? `${status.db.migrations} migration${status.db.migrations === 1 ? '' : 's'} · ${status.db.journalMode}` : status.db.error],
                ['Database ID', <code key="id" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{status.db.instanceId}</code>],
                ['Checked', when(status.time)],
              ]}
            />
          )}
        </Card>

        <Card title="Backups">
          {status ? (
            <KeyValue
              rows={[
                ['Status', <BackupBadge key="b" backup={status.backup} />],
                ['Last good', when(status.backup.lastSuccessAt)],
                ['Off-machine', status.backup.offsiteConfigured ? (status.backup.offsite ?? '—') : 'not configured'],
                ['Schedule', status.backup.scheduled ? `nightly at ${status.backup.time}, keep ${status.backup.keepDays} days` : 'off (development)'],
                ...(status.backup.lastError ? [['Problem', <span key="e" style={{ color: 'var(--danger)' }}>{status.backup.lastError}</span>]] : []),
              ]}
            />
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>—</span>
          )}
        </Card>

        <Card title="This device">
          <p style={{ margin: '0 0 var(--space-3)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            The copy of your records kept here for working offline, and changes waiting to be sent.
          </p>
          <Link to="/sync">Offline data</Link>
        </Card>

        <Card title="Appearance">
          <Segmented
            label="Theme"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'system', label: 'Auto', icon: <Icon name="monitor" size={16} /> },
              { value: 'light', label: 'Light', icon: <Icon name="sun" size={16} /> },
              { value: 'dark', label: 'Dark', icon: <Icon name="moon" size={16} /> },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
