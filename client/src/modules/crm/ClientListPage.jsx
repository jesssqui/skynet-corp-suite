import { useMemo, useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, EmptyState, Segmented, SelectField, Icon, Badge } from '../../ui/index.js';
import { formatDay } from '../../ui/format.js';
import { useClientListData } from './data.js';
import { buildClientIndex, filterClients, pickableBusinesses } from './logic.js';
import { BusinessChip } from './parts.jsx';
import { ClientForm } from './forms.jsx';
import './crm.css';

// The client list (/crm): search and filters over the device's offline copy. The index (one row
// per client with what search looks at) is built once per data change; each keystroke only
// filters it. Rows are shown 50 at a time. Filters live in the URL, so Back restores them.

const PAGE = 50;
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

function ClientRow({ row, businessesById }) {
  const { client } = row;
  return (
    <li style={{ borderTop: '1px solid var(--border)' }} data-client-row={client.id}>
      <Link to={`/crm/clients/${client.id}`} className="crm-row-link">
        <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 220px' }}>
          <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ overflowWrap: 'anywhere' }}>{client.name}</strong>
            {client.status === 'closed' ? <Badge>Closed</Badge> : null}
            {client._sync?.pending ? <Badge>Waiting to sync</Badge> : null}
            {client._sync?.flagged || client._sync?.clashes?.length ? <Badge tone="warn">Check this</Badge> : null}
          </span>
          {row.accountNames.length ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }}>{row.accountNames.join(' · ')}</span>
          ) : null}
        </span>
        <span style={{ display: 'grid', gap: 4, justifyItems: 'start', flex: '0 1 auto', minWidth: 0 }}>
          {row.businessIds.length ? (
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {row.businessIds
                .map((id) => businessesById.get(id))
                .filter(Boolean)
                .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
                .map((b) => <BusinessChip key={b.id} business={b} short />)}
            </span>
          ) : null}
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
            {row.lastActivityAt ? `Last activity ${formatDay(row.lastActivityAt)}` : 'No activity yet'}
          </span>
        </span>
        <Icon name="chevron" size={16} style={{ color: 'var(--text-muted)', alignSelf: 'center' }} />
      </Link>
    </li>
  );
}

export default function ClientListPage() {
  const { data, loading } = useClientListData();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const business = params.get('business') ?? '';
  const status = params.get('status') ?? 'active';
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  useEffect(() => setShown(PAGE), [q, business, status]);

  const setParam = (key, value, fallback = '') => {
    // From the address bar, not this render's params: two quick changes (a pick, then a tap) must
    // not undo each other while the router re-renders.
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  // Built once per change of the device's copy; filtering below is per keystroke.
  const index = useMemo(() => (data ? buildClientIndex(data) : []), [data]);
  const businessesById = useMemo(() => new Map((data?.businesses ?? []).map((b) => [b.id, b])), [data]);
  const businessOptions = useMemo(() => pickableBusinesses(data?.businesses ?? [], business || null), [data, business]);
  const rows = useMemo(() => filterClients(index, { q, business, status }), [index, q, business, status]);
  const filtered = Boolean(q || business || status !== 'active');

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle={data ? `${rows.length} ${rows.length === 1 ? 'client' : 'clients'}${filtered ? ' found' : ' active'}` : ' '}
        actions={(
          <>
            <Button onClick={() => navigate('/crm/quick-add')}><Icon name="list" size={18} />Quick add</Button>
            <Button variant="primary" onClick={() => setAdding(true)}><Icon name="plus" size={18} />New client</Button>
          </>
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="crm-filters">
          <label className="crm-search">
            <Icon name="search" size={18} style={{ color: 'var(--text-muted)' }} />
            <input
              type="search"
              aria-label="Search clients"
              placeholder="Name, email or phone"
              value={q}
              onChange={(e) => setParam('q', e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <SelectField
            id="clients-business"
            label="Our business"
            value={business}
            onChange={(v) => setParam('business', v)}
            options={[{ value: '', label: 'All our businesses' }, ...businessOptions.map((b) => ({ value: b.id, label: b.name }))]}
          />
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Status</span>
            <Segmented label="Status" value={status} onChange={(v) => setParam('status', v, 'active')} options={STATUS_OPTIONS} />
          </div>
        </div>
        <Card padded={false}>
          {loading && !data ? (
            <p style={{ color: 'var(--text-muted)', padding: 'var(--space-4)', margin: 0 }}>Loading…</p>
          ) : rows.length ? (
            <ul style={{ listStyle: 'none', margin: '-1px 0 0', padding: 0 }} data-testid="client-list">
              {rows.slice(0, shown).map((row) => <ClientRow key={row.client.id} row={row} businessesById={businessesById} />)}
            </ul>
          ) : index.length ? (
            <EmptyState title="No clients match">
              <button type="button" className="crm-link-button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear the search and filters</button>
            </EmptyState>
          ) : (
            <EmptyState title="No clients yet">
              Add the first one with New client, type a list in <Link to="/crm/quick-add">Quick add</Link>, or <Link to="/crm/import">import your customer list</Link>.
            </EmptyState>
          )}
          {rows.length > shown ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', padding: 'var(--space-3) var(--space-4)', borderTop: '1px solid var(--border)' }}>
              <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button>
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }} data-testid="clients-shown">{shown} of {rows.length}</span>
            </div>
          ) : null}
        </Card>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <Link to="/crm/quick-add">Quick add (a list, one per line)</Link>
          <Link to="/crm/import">Import a customer list (CSV)</Link>
          <Link to="/crm/businesses">Our businesses</Link>
          <Link to="/sync">Records on this device (Offline data)</Link>
        </p>
      </div>
      {adding ? (
        <ClientForm
          onClose={() => setAdding(false)}
          onDone={(id) => { setAdding(false); navigate(`/crm/clients/${id}`); }}
        />
      ) : null}
    </>
  );
}
