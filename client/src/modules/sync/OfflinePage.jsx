import { Link } from 'react-router-dom';
import { PageHeader, Card, Button, Badge, KeyValue, EmptyState, Notice, Icon } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { useSyncEngine, useSyncStatus, useSyncData } from '../../sync/index.js';
import { describeStatus } from '../../sync/components.jsx';

function when(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const statusTone = { quiet: 'ok', offline: 'neutral', syncing: 'accent', warn: 'warn' };

/** What this device keeps for working offline, and how syncing is going. */
export default function OfflinePage() {
  const engine = useSyncEngine();
  const status = useSyncStatus();
  const { session } = useAuth();
  const { data } = useSyncData(async (e) => ({ counts: await e.counts(), details: await e.details(), entities: e.entities() }));
  const d = describeStatus(status);
  const busy = !engine || status?.phase === 'syncing' || status?.phase === 'stopped';

  return (
    <>
      <PageHeader
        title="Offline data"
        subtitle="What this device keeps so the suite works without a connection"
        actions={<Button onClick={() => engine.syncNow('manual')} disabled={busy}>Sync now</Button>}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <Card title="Sync">
          {status ? (
            <KeyValue
              rows={[
                ['Status', <Badge key="s" tone={statusTone[d?.tone] ?? 'neutral'}>{d?.text ?? (status.phase === 'stopped' ? 'Stopped' : 'Opening…')}</Badge>],
                ['Changes waiting', status.waiting ? `${status.waiting}${status.parked ? ` (${status.parked} for records not here yet)` : ''}` : 'none'],
                ['Need attention', status.attention ? <Link key="a" to="/sync/attention">{status.attention}</Link> : 'none'],
                ['Last synced', when(status.lastSyncAt)],
                ['This device', session?.device?.name ?? '—'],
                ...(status.lastError && status.phase !== 'idle' ? [['Last problem', status.lastError]] : []),
              ]}
            />
          ) : <span style={{ color: 'var(--text-muted)' }}>Opening…</span>}
          {status?.clockWarning ? <Notice tone="warn" style={{ marginTop: 'var(--space-3)' }}>{status.clockWarning}: check the date and time settings.</Notice> : null}
        </Card>

        <Card title="On this device">
          {data?.entities?.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
              {data.entities.map((def) => (
                <li key={def.entity} style={{ borderTop: '1px solid var(--border)' }}>
                  <Link
                    to={`/sync/data/${def.entity}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 'var(--tap)', color: 'inherit', textDecoration: 'none' }}
                  >
                    <Icon name="database" size={18} style={{ color: 'var(--text-muted)' }} />
                    <span style={{ flex: 1 }}>{def.entity}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{data.counts[def.entity] ?? 0}</span>
                    <Icon name="chevron" size={16} style={{ color: 'var(--text-muted)' }} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing syncs yet">
              {status?.ready === false ? 'Connect once so this device can set up its offline copy.' : 'Clients, tasks and notes will be kept here once the CRM arrives.'}
            </EmptyState>
          )}
        </Card>

        <Card title="Good to know">
          <div style={{ display: 'grid', gap: 'var(--space-3)', fontSize: 'var(--text-sm)' }}>
            <p style={{ margin: 0 }}>
              Changes made without a connection are saved on this device and sent when the suite can reach the Mac mini again.
              On an iPhone the app can’t sync in the background: open it once you’re back online so your changes go out.
            </p>
            <p style={{ margin: 0, color: 'var(--text-muted)' }}>
              Downloaded {when(data?.details?.lastPullAt)}. If something looks out of date, download everything again.
            </p>
            <div>
              <Button onClick={() => engine.refetchAll()} disabled={busy}>Download everything again</Button>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
