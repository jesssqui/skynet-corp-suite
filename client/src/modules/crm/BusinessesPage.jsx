import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CRM_ENTITY_NAMES } from '@suite/shared/crm';
import { SHARED } from '@suite/shared/actors';
import { PageHeader, Card, Badge, EmptyState, Icon, Notice } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { store, useSyncData } from '../../sync/index.js';
import { useBusinesses } from './data.js';
import { businessColor, errorText } from './logic.js';

// Our businesses (/crm/businesses): who new tasks go to, each one's colour (the chips on the
// client screens) and whether it is archived (hidden from pickers; records keep showing it) —
// plus each CRM record type in the plain offline view (/sync/data/:entity). All from the
// device's offline copy.

/** Who a business's new tasks go to, said from the signed-in person's side (there are two of you). */
function ownerLabel(owner, me) {
  if (owner === SHARED) return 'Shared list';
  if (!me) return owner;
  return owner === me ? 'You' : 'Your partner';
}

const rowLink = {
  display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 'var(--tap)', color: 'inherit', textDecoration: 'none',
};

/** A colour picker that saves a moment after the last change (dragging in the picker sends many). */
function ColorPicker({ business, onError }) {
  const [value, setValue] = useState(businessColor(business));
  const timer = useRef(null);
  useEffect(() => setValue(businessColor(business)), [business]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <input
      type="color"
      aria-label={`Colour for ${business.name}`}
      value={value}
      onChange={(e) => {
        const color = e.target.value;
        setValue(color);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => store.update('business', business.id, { color }).catch((err) => onError(errorText(err))), 400);
      }}
      style={{ width: 44, height: 44, padding: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', cursor: 'pointer' }}
    />
  );
}

export default function BusinessesPage() {
  const { businesses, loading } = useBusinesses();
  // As people see them: records under a deleted client (and so on) aren't counted.
  const { data: counts } = useSyncData((engine) => engine.liveCounts(CRM_ENTITY_NAMES), [], { entities: CRM_ENTITY_NAMES });
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const [error, setError] = useState(null);
  return (
    <>
      <PageHeader title="Our businesses" subtitle={<Link to="/crm">Clients</Link>} />
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start' }}>
        <Card title="Our businesses">
          {error ? <Notice tone="danger" style={{ marginBottom: 'var(--space-3)' }}>{error}</Notice> : null}
          {loading ? (
            <span style={{ color: 'var(--text-muted)' }}>Loading…</span>
          ) : businesses.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
              {businesses.map((b) => (
                <li key={b.id} style={{ borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 56, flexWrap: 'wrap', padding: '6px 0' }}>
                  <ColorPicker business={b} onError={setError} />
                  <span style={{ flex: '1 1 120px', minWidth: 0, overflowWrap: 'anywhere', color: b.archived ? 'var(--text-muted)' : 'inherit' }}>{b.name}</span>
                  <Badge tone="neutral">{ownerLabel(b.default_owner, me)}</Badge>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 'var(--tap)', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(b.archived)}
                      onChange={(e) => store.update('business', b.id, { archived: e.target.checked }).catch((err) => setError(errorText(err)))}
                      style={{ width: 20, height: 20, margin: 0 }}
                    />
                    Archived
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Not downloaded yet">Connect once so this device gets its copy.</EmptyState>
          )}
        </Card>
        <Card title="Records on this device">
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
