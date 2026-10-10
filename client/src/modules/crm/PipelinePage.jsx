// The pipeline (/crm/pipeline, D8): leads by stage — lead, talking, quoted side by side on wide screens,
// one stage at a time on phones (?stage=) — with each stage's count and first-year value per currency,
// and won and lost this month. Each lead shows its next step (its earliest open dated task) or the
// "No next step" flag. Filters (business, owner, words, "no next step only") live in the URL. Read from
// and written to the device's offline copy: it all works with no connection.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { OPEN_LEAD_STAGES, isOpenLead } from '@suite/shared/leads';
import { PageHeader, Card, Button, Badge, EmptyState, Icon, Segmented, SelectField, TextField, Notice } from '../../ui/index.js';
import { formatDate, formatDay } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { useToday } from '../planner/parts.jsx';
import { usePipelineData } from './data.js';
import { BusinessChip, Badges, TextButton } from './parts.jsx';
import { pickableBusinesses, KIND_LABELS } from './logic.js';
import { STAGE_LABELS, LOST_LABELS, filterLeads, pipelineView, valueText, leadValueText, daysInStage, nextStepOf } from './leads.js';
import { LeadForm } from './leadForms.jsx';
import CrmTabs from './CrmTabs.jsx';
import './crm.css';

const PAGE = 50;
const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };
const STAGES = [...OPEN_LEAD_STAGES, 'won', 'lost'];

function stageAge(days) {
  if (days === null) return '';
  if (days === 0) return 'since today';
  return days === 1 ? '1 day' : `${days} days`;
}

function LeadCard({ lead, business, client, next, today }) {
  const open = isOpenLead(lead);
  const value = leadValueText(lead);
  return (
    <li data-lead-id={lead.id}>
      <Link to={`/crm/leads/${lead.id}`} className="pipeline-card">
        <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <strong style={{ overflowWrap: 'anywhere' }}>{lead.name}</strong>
          {value ? <span style={{ ...muted, fontWeight: 600 }}>{value}</span> : null}
        </span>
        <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <BusinessChip business={business} short />
          {lead.kind ? <span style={muted}>{KIND_LABELS[lead.kind]}</span> : null}
          {client ? <span style={muted}>· client {client.name}</span> : null}
        </span>
        {open ? (
          <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {next ? (
              <span style={{ ...muted, color: next.due_date < today ? 'var(--danger)' : 'var(--text-muted)' }} data-testid="lead-next">
                Next: {next.title} · {next.due_date < today ? 'overdue, ' : ''}{formatDate(next.due_date)}
              </span>
            ) : <span data-testid="lead-no-next-step"><Badge tone="warn">No next step</Badge></span>}
            <span style={muted}>{STAGE_LABELS[lead.stage]} {stageAge(daysInStage(lead, today))}</span>
          </span>
        ) : (
          <span style={muted}>
            {lead.stage === 'lost' ? `Lost: ${LOST_LABELS[lead.lost_reason] ?? 'no reason'}` : 'Won'}
            {lead.closed_at ? ` · ${formatDay(lead.closed_at)}` : ''}
          </span>
        )}
        <Badges record={lead} />
      </Link>
    </li>
  );
}

function Column({ stage, leads, active, head, data, today }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <section className="pipeline-col" data-active={active ? 'true' : 'false'} data-testid={`pipeline-${stage}`} aria-label={STAGE_LABELS[stage]}>
      <Card>
        <div className="pipeline-col-head">
          <h2 style={h2}>{head.title}</h2>
          <span style={muted} data-testid={`pipeline-${stage}-total`}>{head.figure}</span>
        </div>
        {leads.length ? (
          <ul className="pipeline-list">
            {leads.slice(0, shown).map((l) => (
              <LeadCard
                key={l.id}
                lead={l}
                business={data.businessesById.get(l.business_id)}
                client={data.clientsById.get(l.client_id ?? l.won_client_id)}
                next={nextStepOf(data.tasksByLead.get(l.id))}
                today={today}
              />
            ))}
          </ul>
        ) : <p style={{ ...muted, margin: 0 }}>{head.empty}</p>}
        {leads.length > shown ? (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Button onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, leads.length - shown)} more</Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

export default function PipelinePage() {
  const { data, loading } = usePipelineData();
  const today = useToday();
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const [params, setParams] = useSearchParams();
  const business = params.get('business') ?? '';
  const owner = params.get('owner') ?? '';
  const q = params.get('q') ?? '';
  const stage = STAGES.includes(params.get('stage')) ? params.get('stage') : 'lead';
  const flaggedOnly = params.get('flag') === '1';
  const [sheet, setSheet] = useState(null);
  const navigate = useNavigate();
  const setParam = (key, value, fallback = '') => {
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const view = useMemo(() => {
    if (!data) return null;
    const filtered = filterLeads(data.leads, { business, q, owner });
    const hasNext = (l) => Boolean(nextStepOf(data.tasksByLead.get(l.id)));
    const flagged = filtered.filter((l) => isOpenLead(l) && !hasNext(l));
    const shownLeads = flaggedOnly ? flagged : filtered;
    return { ...pipelineView(shownLeads, { today }), flagged: flagged.length, total: filtered.length };
  }, [data, business, q, owner, flaggedOnly, today]);

  const businessOptions = useMemo(() => pickableBusinesses(data?.businesses ?? [], business || null), [data, business]);
  const close = () => setSheet(null);

  const heads = view ? {
    ...Object.fromEntries(OPEN_LEAD_STAGES.map((s) => {
      const t = view.totals.stages[s];
      const v = valueText(t.value);
      return [s, { title: STAGE_LABELS[s], figure: `${t.count}${v ? ` · ${v}` : ''}`, empty: 'No leads here.' }];
    })),
    won: { title: 'Won this month', figure: `${view.totals.wonThisMonth}${view.totals.wonValueThisMonth.size ? ` · ${valueText(view.totals.wonValueThisMonth)}` : ''}`, empty: 'None won yet this month.' },
    lost: { title: 'Lost this month', figure: `${view.totals.lostThisMonth}`, empty: 'None lost this month.' },
  } : null;
  const switchOptions = STAGES.map((s) => ({
    value: s,
    label: `${STAGE_LABELS[s]} ${view ? (s === 'won' ? view.totals.wonThisMonth : s === 'lost' ? view.totals.lostThisMonth : view.columns[s].length) : ''}`.trim(),
  }));

  return (
    <>
      <CrmTabs />
      <PageHeader
        title="Pipeline"
        subtitle="Leads from first contact to won or lost · value = the first year"
        actions={(
          <Button variant="primary" disabled={!data} onClick={() => setSheet({ initial: business ? { business_id: business } : {} })}>
            <Icon name="plus" size={18} />New lead
          </Button>
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <div className="pipeline-filters">
          <SelectField
            id="pipeline-business"
            label="Our business"
            value={business}
            onChange={(v) => setParam('business', v)}
            options={[{ value: '', label: 'All our businesses' }, ...businessOptions.map((b) => ({ value: b.id, label: b.name }))]}
          />
          <SelectField
            id="pipeline-owner"
            label="Whose"
            value={owner}
            onChange={(v) => setParam('owner', v)}
            options={[{ value: '', label: 'Everyone’s' }, { value: me, label: 'Mine' }, { value: me === 'owner' ? 'partner' : 'owner', label: 'My partner’s' }, { value: 'shared', label: 'Shared' }]}
          />
          <TextField id="pipeline-q" label="Search" type="search" value={q} onChange={(e) => setParam('q', e.target.value)} placeholder="Name, contact, email, phone" />
        </div>
        <div className="pipeline-stage-switch">
          <Segmented label="Stage" value={stage} onChange={(v) => setParam('stage', v, 'lead')} options={switchOptions} />
        </div>
        {view?.flagged ? (
          <Notice tone="warn">
            <span data-testid="pipeline-flagged">
              {view.flagged === 1 ? '1 open lead has' : `${view.flagged} open leads have`} no next step (an open task with a day).{' '}
              <button type="button" className="crm-link-button" onClick={() => setParam('flag', flaggedOnly ? '' : '1')}>
                {flaggedOnly ? 'Show every lead' : 'Show only those'}
              </button>
            </span>
          </Notice>
        ) : flaggedOnly ? (
          <p style={{ ...muted, margin: 0 }}>Every open lead has a next step. <TextButton onClick={() => setParam('flag', '')}>Show every lead</TextButton></p>
        ) : null}
        {!view ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : !data.leads.length ? (
          <Card>
            <EmptyState title="No leads yet">
              Add one with New lead, turn an inbox item into a lead, or start from the <Link to="/crm/cross-sell">cross-sell list</Link>.
            </EmptyState>
          </Card>
        ) : (
          <>
            <div className="pipeline-open">
              {OPEN_LEAD_STAGES.map((s) => (
                <Column key={s} stage={s} leads={view.columns[s]} active={stage === s} head={heads[s]} data={data} today={today} />
              ))}
            </div>
            <div className="pipeline-closed">
              <Column stage="won" leads={view.won} active={stage === 'won'} head={heads.won} data={data} today={today} />
              <Column stage="lost" leads={view.lost} active={stage === 'lost'} head={heads.lost} data={data} today={today} />
            </div>
          </>
        )}
      </div>
      {sheet ? (
        <LeadForm
          initial={sheet.initial}
          businesses={data.businesses}
          clientsById={data.clientsById}
          accountsById={data.accountsById}
          onClose={close}
          onDone={(id) => { close(); if (id) navigate(`/crm/leads/${id}`); }}
        />
      ) : null}
    </>
  );
}
