// The cross-sell list (/crm/cross-sell, D8): current clients who could use another of our services,
// worked out on this device with the same rule as the monthly automation (crossSellList and
// CROSS_SELL_PAIRS in @suite/shared/leads: an active relationship with one service and none with the
// other; age-restricted accounts never listed for a business that doesn't already work with them; an
// open lead or one lost in the last 180 days takes a line off). Each line shows the people and whether
// that business may email them. Nothing is sent: "Make a lead" puts it in the pipeline. Offline.
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CROSS_SELL_PAIRS, LOST_COOLDOWN_DAYS, crossSellList } from '@suite/shared/leads';
import { PageHeader, Card, Button, Badge, EmptyState, Icon, SelectField } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { useToday } from '../planner/parts.jsx';
import { useCrossSellData } from './data.js';
import { BusinessChip, useAction } from './parts.jsx';
import { crossSellLeadFields } from './leads.js';
import CrmTabs from './CrmTabs.jsx';
import './crm.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };

function Entry({ entry, onMake, busy }) {
  return (
    <li className="crm-account" data-cross-sell={entry.key}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <Link to={`/crm/clients/${entry.client.id}`} style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{entry.client.name}</Link>
          {entry.account.name !== entry.client.name ? <span style={muted}>{entry.account.name}</span> : null}
          <span style={muted}>{entry.pair.why}</span>
          {entry.contacts.length ? (
            <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              {entry.contacts.map(({ contact, emailConsent }) => (
                <span key={contact.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <span>{contact.name}</span>
                  {emailConsent ? <Badge tone="ok">May email</Badge> : contact.email ? <Badge tone="warn">No email consent</Badge> : null}
                </span>
              ))}
            </span>
          ) : <span style={muted}>No contact on file</span>}
        </div>
        <Button disabled={busy} onClick={() => onMake(entry)}><Icon name="plus" size={16} />Make a lead</Button>
      </div>
    </li>
  );
}

export default function CrossSellPage() {
  const { data, loading } = useCrossSellData();
  const today = useToday();
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const business = params.get('business') ?? '';
  const { busy, error, run } = useAction();
  const making = useRef(new Map()); // entry key -> lead id: a double tap or a retry never makes two

  const groups = useMemo(() => {
    if (!data) return null;
    const archived = new Set(data.businesses.filter((b) => b.archived).map((b) => b.id));
    const list = crossSellList({ ...data, today }).filter((e) => !archived.has(e.pair.to.business) && (!business || e.pair.to.business === business));
    return CROSS_SELL_PAIRS.map((pair) => ({ pair, entries: list.filter((e) => e.pair.id === pair.id) })).filter((g) => g.entries.length);
  }, [data, today, business]);
  const total = groups?.reduce((n, g) => n + g.entries.length, 0) ?? 0;
  const toBusinesses = [...new Set(CROSS_SELL_PAIRS.map((p) => p.to.business))];

  const make = async (entry) => {
    let id = making.current.get(entry.key);
    const ok = await run(async () => {
      if (!id) {
        id = await store.create('lead', crossSellLeadFields(entry, { me }));
        making.current.set(entry.key, id);
      }
    });
    if (ok) navigate(`/crm/leads/${id}`);
  };

  return (
    <>
      <CrmTabs />
      <PageHeader title="Cross-sell" subtitle="Current clients who could use another of our services · nothing is sent from here" />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div style={{ maxWidth: 360 }}>
          <SelectField
            id="cross-sell-business"
            label="For our business"
            value={business}
            onChange={(v) => { const n = new URLSearchParams(window.location.search); if (v) n.set('business', v); else n.delete('business'); setParams(n, { replace: true }); }}
            options={[{ value: '', label: 'All' }, ...toBusinesses.map((id) => ({ value: id, label: data?.businessesById.get(id)?.name ?? id }))]}
          />
        </div>
        {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
        {!groups ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : !total ? (
          <Card><EmptyState title="No one to suggest right now">Every current client either has these services with us already, has an open lead, or said no recently.</EmptyState></Card>
        ) : groups.map(({ pair, entries }) => (
          <Card key={pair.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-2)' }}>
              <h2 style={h2}>{pair.why}</h2>
              <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <BusinessChip business={data.businessesById.get(pair.to.business)} />
                <span style={muted} data-testid={`cross-sell-count-${pair.id}`}>{entries.length}</span>
              </span>
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid={`cross-sell-${pair.id}`}>
              {entries.map((e) => <Entry key={e.key} entry={e} busy={busy} onMake={make} />)}
            </ul>
          </Card>
        ))}
        <p style={{ ...muted, margin: 0 }}>
          The same list arrives as one task per business on the first workday of each month. Age-restricted accounts (wholesale)
          are never listed for a business that doesn’t already work with them; a client with an open lead for the service, or one
          lost in the last {LOST_COOLDOWN_DAYS} days, is left off. Email only those marked “May email”.
        </p>
      </div>
    </>
  );
}
