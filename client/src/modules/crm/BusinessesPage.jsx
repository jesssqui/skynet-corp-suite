import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CRM_ENTITY_NAMES } from '@suite/shared/crm';
import { SHARED } from '@suite/shared/actors';
import { PageHeader, Card, Badge, Button, EmptyState, Icon, Notice, Segmented, TextField } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { store, useSyncData } from '../../sync/index.js';
import { useBusinesses } from './data.js';
import { businessColor, errorText } from './logic.js';
import { businessForm, nextBusinessPosition } from './formFields.js';
import { useForm } from './forms.jsx';
import { FormSheet } from './parts.jsx';

// Our businesses: who new tasks go to, each one's colour (the chips on the client screens) and
// whether it is archived (hidden from pickers; records keep showing it). The card is shared by
// /crm/businesses and the Admin page (System → Admin). Adding one is here too. Businesses are
// never deleted: archive one instead.

/** Who a business's new tasks go to, said from the signed-in person's side (there are two of you). */
export function ownerLabel(owner, me) {
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

/** Archived (hidden from pickers): shows the tick at once; the saved record catches up a moment later. */
function ArchivedToggle({ business, onError }) {
  const [checked, setChecked] = useState(Boolean(business.archived));
  useEffect(() => setChecked(Boolean(business.archived)), [business.archived]);
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 'var(--tap)', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          const archived = e.target.checked;
          setChecked(archived);
          store.update('business', business.id, { archived }).catch((err) => {
            setChecked(Boolean(business.archived));
            onError(errorText(err));
          });
        }}
        style={{ width: 20, height: 20, margin: 0 }}
      />
      Archived
    </label>
  );
}

/** Add a business: a name, a colour and who new tasks go to. It lands at the end of the list. */
function BusinessForm({ businesses, me, onClose }) {
  const parent = { position: nextBusinessPosition(businesses), archived: false };
  const { v, set, save, dirty, problems, busy, error } = useForm(businessForm, null, {
    entity: 'business', parent, onDone: () => onClose(),
  });
  const owners = [
    { value: 'owner', label: ownerLabel('owner', me) },
    { value: 'partner', label: ownerLabel('partner', me) },
    { value: SHARED, label: 'Shared list' },
  ];
  return (
    <FormSheet
      title="Add a business"
      testId="business-form"
      onClose={onClose}
      dirty={dirty}
      busy={busy}
      error={error}
      onSave={save}
      saveLabel="Add business"
    >
      <TextField id="business-name" label="Name" value={v.name} onChange={set('name')} autoFocus maxLength={100} error={problems.name} hint="Shown as it is written" />
      <div style={{ display: 'grid', gap: 6 }}>
        <label htmlFor="business-color" style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Colour</label>
        <input
          id="business-color"
          type="color"
          value={v.color}
          onChange={set('color')}
          style={{ width: 44, height: 44, padding: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface)', cursor: 'pointer' }}
        />
        {problems.color ? <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{problems.color}</span> : null}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>New tasks go to</span>
        <Segmented label="New tasks go to" value={v.default_owner} onChange={set('default_owner')} options={owners} />
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Automated tasks for this business follow this too.</span>
        {problems.default_owner ? <span style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{problems.default_owner}</span> : null}
      </div>
    </FormSheet>
  );
}

/** The "Our businesses" card: the list, archive, colour, owner — and Add a business. */
export function BusinessesCard() {
  const { businesses, loading } = useBusinesses();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Our businesses">
      {error ? <Notice tone="danger" style={{ marginBottom: 'var(--space-3)' }}>{error}</Notice> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-3)' }}>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add a business
        </Button>
      </div>
      {loading ? (
        <span style={{ color: 'var(--text-muted)' }}>Loading…</span>
      ) : businesses.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
          {businesses.map((b) => (
            <li key={b.id} style={{ borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minHeight: 56, flexWrap: 'wrap', padding: '6px 0' }}>
              <ColorPicker business={b} onError={setError} />
              <span style={{ flex: '1 1 120px', minWidth: 0, overflowWrap: 'anywhere', color: b.archived ? 'var(--text-muted)' : 'inherit' }}>{b.name}</span>
              <Badge tone="neutral">{ownerLabel(b.default_owner, me)}</Badge>
              <ArchivedToggle business={b} onError={setError} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Not downloaded yet">Connect once so this device gets its copy.</EmptyState>
      )}
      {adding ? <BusinessForm businesses={businesses} me={me} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

export default function BusinessesPage() {
  // As people see them: records under a deleted client (and so on) aren't counted.
  const { data: counts } = useSyncData((engine) => engine.liveCounts(CRM_ENTITY_NAMES), [], { entities: CRM_ENTITY_NAMES });
  return (
    <>
      <PageHeader title="Our businesses" subtitle={<Link to="/crm">Clients</Link>} />
      <div style={{ display: 'grid', gap: 'var(--space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'start' }}>
        <BusinessesCard />
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
