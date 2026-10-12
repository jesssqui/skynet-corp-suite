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
import { campaignOptions, campaignScope, inCampaign, joinCampaign, leadCampaignList, bulkJoin, bulkLeave, bulkSet } from './campaigns.js';
import { LEAD_SOURCES } from '@suite/shared/leads';
import { store } from '../../sync/index.js';
import { SOURCE_LABELS, STAGE_LABELS, LOST_LABELS, filterLeads, pipelineView, valueText, leadValueText, daysInStage, nextStepOf } from './leads.js';
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

/** In select mode a card is a checkbox row, not a link. */
function SelectableCard({ children, className, lead, selected, onToggle }) {
  return (
    <label className={className} style={{ cursor: 'pointer', outline: selected ? '2px solid var(--accent, #2563eb)' : 'none' }}>
      <input type="checkbox" checked={selected} onChange={() => onToggle(lead.id)} aria-label={`Select ${lead.name}`} />
      {children}
    </label>
  );
}

function LeadCard({ lead, business, client, next, today, contactedOn = null, campaigns = [], selecting = false, selected = false, onToggle = null }) {
  const open = isOpenLead(lead);
  const value = leadValueText(lead);
  const Wrap = selecting ? SelectableCard : Link;
  return (
    <li data-lead-id={lead.id}>
      <Wrap className="pipeline-card" {...(selecting ? { lead, selected, onToggle } : { to: `/crm/leads/${lead.id}` })}>
        <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <strong style={{ overflowWrap: 'anywhere' }}>{lead.name}</strong>
          {value ? <span style={{ ...muted, fontWeight: 600 }}>{value}</span> : null}
        </span>
        <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <BusinessChip business={business} short />
          {lead.kind ? <span style={muted}>{KIND_LABELS[lead.kind]}</span> : null}
          {contactedOn ? <span data-testid="lead-contacted"><Badge tone="neutral">Contacted {formatDate(contactedOn)}</Badge></span> : null}
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
        {campaigns.length ? (
          <span style={{ ...muted, display: 'flex', gap: 'var(--space-1) var(--space-2)', flexWrap: 'wrap' }} data-testid="lead-campaigns">
            {campaigns.map((c) => <Badge key={c.id} tone="neutral">{c.label}</Badge>)}
          </span>
        ) : null}
        <Badges record={lead} />
      </Wrap>
    </li>
  );
}

function Column({ stage, leads, active, head, data, today, selecting, selected, onToggle, onSelectAll }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <section className="pipeline-col" data-active={active ? 'true' : 'false'} data-testid={`pipeline-${stage}`} aria-label={STAGE_LABELS[stage]}>
      <Card>
        <div className="pipeline-col-head">
          <h2 style={h2}>{head.title}</h2>
          <span style={muted} data-testid={`pipeline-${stage}-total`}>{head.figure}</span>
        </div>
        {selecting && leads.length ? (
          <div style={{ marginBottom: 'var(--space-2)' }}>
            <TextButton onClick={() => onSelectAll(leads.map((l) => l.id))}>Select all {leads.length} here</TextButton>
          </div>
        ) : null}
        {leads.length ? (
          <ul className="pipeline-list">
            {leads.slice(0, shown).map((l) => (
              <LeadCard
                key={l.id}
                lead={l}
                business={data.businessesById.get(l.business_id)}
                client={data.clientsById.get(l.client_id ?? l.won_client_id)}
                next={nextStepOf(data.tasksByLead.get(l.id))}
                contactedOn={data.lastContact.get(l.id) ?? null}
                campaigns={leadCampaignList(data.campaigns, data.campaignsByLead.get(l.id))}
                today={today}
                selecting={selecting}
                selected={selected.has(l.id)}
                onToggle={onToggle}
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
  const contactedFilter = params.get('contacted') ?? ''; // 'yes' | 'no' | ''
  const campaign = params.get('campaign') ?? ''; // a campaign id (with its sub-campaigns), or 'none'
  const [sheet, setSheet] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(null); // { label, done, total } while a bulk change runs
  const [report, setReport] = useState('');
  const [pickCampaign, setPickCampaign] = useState('');
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const addAll = (ids) => setSelected((s) => new Set([...s, ...ids]));
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); setReport(''); };
  const navigate = useNavigate();
  const setParam = (key, value, fallback = '') => {
    const next = new URLSearchParams(window.location.search);
    if (!value || value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const view = useMemo(() => {
    if (!data) return null;
    const scope = campaign === 'none' ? 'none' : campaign ? campaignScope(data.campaigns, campaign) : null;
    const filtered = filterLeads(data.leads, { business, q, owner }).filter((l) => !scope || inCampaign(data.campaignsByLead.get(l.id), scope))
      .filter((l) => !contactedFilter || data.lastContact.has(l.id) === (contactedFilter === 'yes'));
    const hasNext = (l) => Boolean(nextStepOf(data.tasksByLead.get(l.id)));
    const flagged = filtered.filter((l) => isOpenLead(l) && !hasNext(l));
    const shownLeads = flaggedOnly ? flagged : filtered;
    const pv = pipelineView(shownLeads, { today });
    const shownIds = [...OPEN_LEAD_STAGES.flatMap((s) => pv.columns[s]), ...pv.won, ...pv.lost].map((l) => l.id);
    return { ...pv, flagged: flagged.length, total: filtered.length, shownIds };
  }, [data, business, q, owner, flaggedOnly, today, campaign, contactedFilter]);

  const businessOptions = useMemo(() => pickableBusinesses(data?.businesses ?? [], business || null), [data, business]);
  const close = () => setSheet(null);
  const ids = [...selected];
  const run = async (label, fn, summarise) => {
    if (busy || !ids.length) return;
    setBusy({ label, done: 0, total: ids.length });
    setReport('');
    try {
      const r = await fn((done) => setBusy({ label, done, total: ids.length }));
      setReport(`${summarise(r)}${r.failed ? ` ${r.failed} could not be changed.` : ''}`);
      if (!r.failed) setSelected(new Set());
    } finally { setBusy(null); }
  };
  const campaignName = (id) => campaignOptions(data?.campaigns ?? [], { keep: id }).find((o) => o.value === id)?.label ?? 'the campaign';

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
          <>
            <Link to="/crm/import-leads" className="crm-link-button" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="upload" size={16} />Import leads
            </Link>
            <Button disabled={!data} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
              {selecting ? 'Done selecting' : 'Select leads'}
            </Button>
            <Button variant="primary" disabled={!data} onClick={() => setSheet({ initial: business ? { business_id: business } : {} })}>
              <Icon name="plus" size={18} />New lead
            </Button>
          </>
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
          <SelectField
            id="pipeline-campaign"
            label="Campaign"
            value={campaign}
            onChange={(v) => setParam('campaign', v)}
            options={[{ value: '', label: 'All campaigns' }, { value: 'none', label: 'In no campaign' }, ...campaignOptions(data?.campaigns ?? [], { keep: campaign })]}
          />
          <SelectField
            id="pipeline-contacted"
            label="Contacted"
            value={contactedFilter}
            onChange={(v) => setParam('contacted', v)}
            options={[{ value: '', label: 'Contacted or not' }, { value: 'yes', label: 'Already contacted' }, { value: 'no', label: 'Not contacted yet' }]}
          />
          <TextField id="pipeline-q" label="Search" type="search" value={q} onChange={(e) => setParam('q', e.target.value)} placeholder="Name, contact, email, phone" />
        </div>
        <div className="pipeline-stage-switch">
          <Segmented label="Stage" value={stage} onChange={(v) => setParam('stage', v, 'lead')} options={switchOptions} />
        </div>
        {selecting && view ? (
          <Card>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="bulk-bar">
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                <strong data-testid="bulk-count">{ids.length} selected</strong>
                <TextButton onClick={() => addAll(view.shownIds)}>Select all {view.shownIds.length} shown</TextButton>
                {ids.length ? <TextButton onClick={() => setSelected(new Set())}>Clear</TextButton> : null}
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <SelectField
                  id="bulk-campaign"
                  label="Campaign"
                  value={pickCampaign}
                  onChange={setPickCampaign}
                  options={[{ value: '', label: 'Pick a campaign…' }, ...campaignOptions(data.campaigns)]}
                />
                <Button
                  disabled={!ids.length || !pickCampaign || Boolean(busy)}
                  onClick={() => run('Adding', (p) => bulkJoin(store, data.memberships, ids, pickCampaign, p),
                    (r) => `Added ${r.added} to ${campaignName(pickCampaign)}${r.already ? ` (${r.already} already in it)` : ''}.`)}
                >Add to campaign</Button>
                <Button
                  disabled={!ids.length || !pickCampaign || Boolean(busy)}
                  onClick={() => run('Removing', (p) => bulkLeave(store, data.memberships, ids, pickCampaign, p),
                    (r) => `Removed ${r.removed} from ${campaignName(pickCampaign)}${r.notIn ? ` (${r.notIn} weren’t in it)` : ''}.`)}
                >Remove from campaign</Button>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <SelectField
                  id="bulk-source"
                  label="Source"
                  value=""
                  onChange={(v) => v && run('Changing source', (p) => bulkSet(store, ids, 'source', v, p), (r) => `Source set to “${SOURCE_LABELS[v]}” on ${r.changed} lead${r.changed === 1 ? '' : 's'}${r.same ? ` (${r.same} already had it)` : ''}.`)}
                  options={[{ value: '', label: 'Set the source…' }, ...LEAD_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] ?? s }))]}
                />
                <SelectField
                  id="bulk-owner"
                  label="Whose"
                  value=""
                  onChange={(v) => v && run('Changing owner', (p) => bulkSet(store, ids, 'owner', v, p), (r) => `Owner changed on ${r.changed} lead${r.changed === 1 ? '' : 's'}${r.same ? ` (${r.same} already had it)` : ''}.`)}
                  options={[{ value: '', label: 'Hand over to…' }, { value: me, label: 'Me' }, { value: me === 'owner' ? 'partner' : 'owner', label: 'My partner' }, { value: 'shared', label: 'Shared' }]}
                />
              </div>
              {busy ? <p style={{ ...muted, margin: 0 }} role="status">{busy.label}… {busy.done} of {busy.total}</p> : null}
              {report ? <p style={{ margin: 0 }} role="status" data-testid="bulk-report">{report}</p> : null}
            </div>
          </Card>
        ) : null}
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
                <Column key={s} stage={s} leads={view.columns[s]} active={stage === s} head={heads[s]} data={data} today={today} selecting={selecting} selected={selected} onToggle={toggle} onSelectAll={addAll} />
              ))}
            </div>
            <div className="pipeline-closed">
              <Column stage="won" leads={view.won} active={stage === 'won'} head={heads.won} data={data} today={today} selecting={selecting} selected={selected} onToggle={toggle} onSelectAll={addAll} />
              <Column stage="lost" leads={view.lost} active={stage === 'lost'} head={heads.lost} data={data} today={today} selecting={selecting} selected={selected} onToggle={toggle} onSelectAll={addAll} />
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
          onDone={async (id) => {
            close();
            if (id && campaign && campaign !== 'none') await joinCampaign(store, data.memberships, id, campaign).catch(() => {}); // a new lead starts in the campaign being looked at
            if (id) navigate(`/crm/leads/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
