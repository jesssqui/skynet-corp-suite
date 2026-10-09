// Recurring costs (/costs, D6): what our businesses and the home pay for, by business (Personal
// included), soonest renewal first, with the monthly-equivalent and yearly totals per business and
// overall (yearly ÷ 12, quarterly ÷ 3; one-time costs left out; currencies never added together).
// Filters (business, status, words) live in the URL so Back restores them; ?open=<id> opens a cost,
// ?new=1&relationship=<id> a new one resold on that relationship (from the client page). Everything
// is read from and written to the device's offline copy, so it all works with no connection.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { COST_REMINDER_DAYS, costAmountText } from '@suite/shared/costs';
import { PageHeader, Card, Button, Badge, EmptyState, Icon, Segmented, SelectField, TextField } from '../../ui/index.js';
import { BusinessChip, Badges, RecordSync } from '../crm/parts.jsx';
import { pickableBusinesses } from '../crm/logic.js';
import { useToday } from '../planner/parts.jsx';
import { useCostsData } from './data.js';
import { filterCosts, groupCosts, totalsText, resoldTotalsText, renewalLabel, STATUS_FILTERS } from './logic.js';
import { CostForm } from './CostForm.jsx';
import './costs.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function CostRow({ cost, today, resoldTo, onOpen }) {
  const label = renewalLabel(cost, today);
  const amount = costAmountText(cost);
  const resold = costAmountText(cost, 'resold_amount_cents');
  return (
    <li className="costs-row" data-cost-id={cost.id}>
      <button type="button" className="costs-row-button" onClick={() => onOpen(cost)} aria-label={`Edit ${cost.name}`}>
        <span className="costs-row-main">
          <span style={{ fontWeight: 600, overflowWrap: 'anywhere', textDecoration: cost.status === 'cancelled' ? 'line-through' : 'none' }}>{cost.name}</span>
          <span style={{ ...muted, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {cost.vendor ? <span>{cost.vendor}</span> : null}
            {cost.auto_renews && cost.period !== 'once' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}><Icon name="repeat" size={14} />Renews on its own</span> : null}
            {cost.payment_method ? <span>{cost.payment_method}</span> : null}
          </span>
          {resoldTo ? (
            <span style={muted} data-testid="cost-resold">
              Resold to {resoldTo.name}{resold ? `: they pay ${resold}` : ''}
            </span>
          ) : null}
          <Badges record={cost}><Badge tone={label.tone}>{label.text}</Badge></Badges>
        </span>
        <span className="costs-row-amount">{amount || '—'}</span>
      </button>
      <RecordSync record={cost} what="cost" />
    </li>
  );
}

export default function CostsPage() {
  const { data, loading } = useCostsData();
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const business = params.get('business') ?? '';
  const status = params.get('status') ?? 'active';
  const q = params.get('q') ?? '';
  const [sheet, setSheet] = useState(null);

  const setParam = (key, value, fallback = '') => {
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  // ?open=<id> (a resold cost on the client page) and ?new=1&relationship=<id>: open the sheet once.
  const openId = params.get('open');
  const wantNew = params.get('new');
  useEffect(() => {
    if (!data || (!openId && !wantNew)) return;
    if (openId) {
      const cost = data.costs.find((c) => c.id === openId);
      if (cost) setSheet({ record: cost });
    } else {
      const rel = params.get('relationship');
      const r = rel ? data.relationshipsById.get(rel) : null;
      setSheet({ initial: { ...(r ? { relationship_id: r.id, business_id: r.business_id } : {}) } });
    }
    const next = new URLSearchParams(window.location.search);
    for (const k of ['open', 'new', 'relationship']) next.delete(k);
    setParams(next, { replace: true });
  }, [openId, wantNew, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const { groups, overall, shown } = useMemo(() => {
    if (!data) return { groups: [], overall: new Map(), shown: 0 };
    const rows = filterCosts(data.costs, { business, status, q });
    // Totals always count every active cost of the business(es) shown, whatever the status/words filter.
    const totalsOf = groupCosts(filterCosts(data.costs, { business, status: 'active' }), data.businesses);
    const g = groupCosts(rows, data.businesses).groups.map((x) => ({ ...x, totals: totalsOf.groups.find((y) => y.business.id === x.business.id)?.totals ?? new Map() }));
    return { groups: g, overall: totalsOf.overall, shown: rows.length };
  }, [data, business, status, q]);

  const resoldTo = (cost) => {
    if (!cost.relationship_id || !data) return null;
    const rel = data.relationshipsById.get(cost.relationship_id);
    const account = rel ? data.accountsById.get(rel.account_id) : null;
    return account ? { name: account.name, clientId: account.client_id } : null;
  };
  const businessOptions = useMemo(() => pickableBusinesses(data?.businesses ?? [], business || null), [data, business]);
  const filtered = business || status !== 'active' || q;
  const close = () => setSheet(null);
  const resoldOverall = resoldTotalsText(overall);

  return (
    <>
      <PageHeader
        title="Costs"
        subtitle={data ? `What our businesses and the home pay for · a reminder ${COST_REMINDER_DAYS} days before each renewal` : ' '}
        actions={(
          <Button variant="primary" disabled={!data} onClick={() => setSheet({ initial: business ? { business_id: business } : {} })}>
            <Icon name="plus" size={18} />New cost
          </Button>
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <Card>
          <div className="costs-total" data-testid="costs-total">
            <span style={{ ...muted, fontWeight: 600 }}>{business ? 'This business' : 'Everything'} · active costs</span>
            <span className="costs-total-figure">{totalsText(overall) || '$0/mo · $0/yr'}</span>
            {resoldOverall ? <span style={muted}>Resold to clients: {resoldOverall}</span> : null}
            <span style={muted}>Monthly equivalent: yearly ÷ 12, quarterly ÷ 3. One-time costs aren’t counted.</span>
          </div>
        </Card>
        <div className="costs-filters">
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Status</span>
            <Segmented label="Status" value={status} onChange={(v) => setParam('status', v, 'active')} options={STATUS_FILTERS} />
          </div>
          <SelectField
            id="costs-business"
            label="Paid by"
            value={business}
            onChange={(v) => setParam('business', v)}
            options={[{ value: '', label: 'All our businesses and Personal' }, ...businessOptions.map((b) => ({ value: b.id, label: b.name }))]}
          />
          <TextField id="costs-q" label="Search" type="search" value={q} onChange={(e) => setParam('q', e.target.value)} placeholder="Name, vendor, card" />
        </div>
        {!data ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : !shown ? (
          <Card>
            <EmptyState title={filtered ? 'No costs match' : 'No costs yet'}>
              {filtered
                ? <button type="button" className="crm-link-button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear the filters</button>
                : 'Add what the businesses and the home pay for — hosting, domains, software, insurance, subscriptions — with New cost.'}
            </EmptyState>
          </Card>
        ) : (
          <div className="costs-groups" data-testid="costs-groups">
            {groups.map((g) => (
              <Card key={g.business.id}>
                <section aria-label={g.business.name} data-business-id={g.business.id}>
                  <div className="costs-group-head">
                    <BusinessChip business={g.business} />
                    <span className="costs-group-total" data-testid="costs-business-total">{totalsText(g.totals) || 'Nothing recurring'}</span>
                  </div>
                  <ul className="costs-list">
                    {g.costs.map((c) => <CostRow key={c.id} cost={c} today={today} resoldTo={resoldTo(c)} onOpen={(cost) => setSheet({ record: cost })} />)}
                  </ul>
                </section>
              </Card>
            ))}
          </div>
        )}
        <p style={{ ...muted, margin: 0 }}>
          Reminders: System → <Link to="/system/automations">Automations</Link> (Recurring cost renewals; client service renewals come 30 days ahead).
        </p>
      </div>
      {sheet && data ? (
        <CostForm record={sheet.record} initial={sheet.initial} data={data} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
    </>
  );
}
