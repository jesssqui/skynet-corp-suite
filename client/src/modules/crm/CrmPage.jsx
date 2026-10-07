import { Link } from 'react-router-dom';
import { CRM_ENTITY_NAMES } from '@suite/shared/crm';
import { SHARED } from '@suite/shared/actors';
import { PageHeader, Card, Badge, EmptyState, Icon } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { useRecords, useSyncData } from '../../sync/index.js';

// A plain doorway to the CRM's records until the client screens arrive (C3b): our businesses,
// and each record type in the generic offline view (/sync/data/:entity). Everything here reads
// the device's offline copy, so it works with no connection.

/** Who a business's new tasks go to, said from the signed-in person's side (there are two of you). */
function ownerLabel(owner, me) {
  if (owner === SHARED) return 'Shared list';
  if (!me) return owner;
  return owner === me ? 'You' : 'Your partner';
}

const rowLink = {
  display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 'var(--tap)', color: 'inherit', textDecoration: 'none',
};

export default function CrmPage() {
  const { records: businesses, loading } = useRecords('business', { sort: 'position' });
  // As people see them: records under a deleted client (and so on) aren't counted.
  const { data: counts } = useSyncData((engine) => engine.liveCounts(CRM_ENTITY_NAMES));
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  return (
    <>
      <PageHeader title="Clients" subtitle="CRM records on this device · the client screens come next" />
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <Card title="Our businesses">
          {loading ? (
            <span style={{ color: 'var(--text-muted)' }}>Loading…</span>
          ) : businesses.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
              {businesses.map((b) => (
                <li key={b.id} style={{ borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 'var(--tap)' }}>
                  <span
                    aria-hidden="true"
                    style={{ width: 12, height: 12, borderRadius: 999, background: b.color || 'var(--border)', flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{b.name}</span>
                  <Badge tone="neutral">{ownerLabel(b.default_owner, me)}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Not downloaded yet">Connect once so this device gets its copy.</EmptyState>
          )}
        </Card>
        <Card title="Records">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
            {CRM_ENTITY_NAMES.map((entity) => (
              <li key={entity} style={{ borderTop: '1px solid var(--border)' }}>
                <Link to={`/sync/data/${entity}`} style={rowLink}>
                  <Icon name="database" size={18} style={{ color: 'var(--text-muted)' }} />
                  <span style={{ flex: 1 }}>{entity}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{counts?.[entity] ?? 0}</span>
                  <Icon name="chevron" size={16} style={{ color: 'var(--text-muted)' }} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
