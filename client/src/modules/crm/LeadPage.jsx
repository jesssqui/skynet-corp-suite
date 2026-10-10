// One lead (/crm/leads/:id, D8): who, for which of our businesses, its stage with the moves from here
// (another open stage, Won… — which makes the client and relationship —, Lost… with its reason, Reopen),
// its next step (the tasks naming it; "No next step" when none is open with a day), and its own timeline
// (notes, calls and every stage change) with Add note / Log call and an optional next step. Everything is
// read from and written to the device's offline copy, so it all works with no connection.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatPhone } from '@suite/shared/normalize';
import { OPEN_LEAD_STAGES, isOpenLead } from '@suite/shared/leads';
import { Card, Button, Badge, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDate, formatDateTime, formatDay } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { TaskSheet, newTaskInitial } from '../planner/forms.jsx';
import { useToday } from '../planner/parts.jsx';
import { useLeadPageData } from './data.js';
import { BusinessChip, Badges, RecordSync, TextButton, useAction } from './parts.jsx';
import { KIND_LABELS, actorLabel } from './logic.js';
import {
  STAGE_LABELS, SOURCE_LABELS, LOST_LABELS, LEAD_ACTIVITY_LABELS, stageChange, saveStageChange, leadValueText, daysInStage, nextStepOf,
} from './leads.js';
import { LeadForm, LostSheet, WinSheet, LeadActivityForm } from './leadForms.jsx';
import CrmTabs from './CrmTabs.jsx';
import './crm.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };
const sectionHead = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' };
const ICONS = { note: 'note', call: 'call', email: 'mail', meeting: 'meeting', stage: 'flag' };
const STAGE_TONES = { lead: 'neutral', talking: 'accent', quoted: 'accent', won: 'ok', lost: 'danger' };
const ownerText = (owner, me) => (!owner || owner === 'shared' ? 'Shared' : owner === me ? 'Mine' : 'My partner’s');

/** The stage a lost lead goes back to: the one it was lost from (its last "→ Lost" row), else Lead. */
function reopenStage(activities) {
  const row = activities.find((a) => a.type === 'stage' && a.stage_to === 'lost');
  return OPEN_LEAD_STAGES.includes(row?.stage_from) ? row.stage_from : 'lead';
}

function ActivityRow({ activity, me }) {
  const who = actorLabel(activity._sync?.createdBy ?? (activity._sync?.local ? me : null), me);
  const body = activity.type === 'stage'
    ? `${STAGE_LABELS[activity.stage_from] ?? '—'} → ${STAGE_LABELS[activity.stage_to] ?? activity.stage_to}${activity.body ? `: ${activity.body}` : ''}`
    : activity.body;
  return (
    <li className="crm-activity" data-lead-activity-id={activity.id}>
      <span className="crm-activity-icon" aria-hidden="true"><Icon name={ICONS[activity.type] ?? 'note'} size={16} /></span>
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <div style={{ ...muted, display: 'flex', gap: '0 var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <strong style={{ color: 'var(--text)' }}>{LEAD_ACTIVITY_LABELS[activity.type] ?? activity.type}</strong>
          <time dateTime={activity.at}>{formatDateTime(activity.at)}</time>
          {who ? <span>by {who === 'You' ? 'you' : who === 'Your partner' ? 'your partner' : who.toLowerCase()}</span> : null}
          <Badges record={activity} />
        </div>
        {body ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{body}</p> : null}
      </div>
    </li>
  );
}

function LeadScreen({ leadId }) {
  const { data, loading } = useLeadPageData(leadId);
  const today = useToday();
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const navigate = useNavigate();
  const [sheet, setSheet] = useState(null);
  const { busy, error, run } = useAction();
  const next = useMemo(() => (data?.lead ? nextStepOf(data.tasks) : null), [data]);

  if (!data) return <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>;
  if (!data.lead) {
    return (
      <Card>
        <EmptyState title="This lead isn’t on this device">
          It may have been deleted, or this device hasn’t downloaded it yet. <Link to="/crm/pipeline">Back to the pipeline</Link>
        </EmptyState>
      </Card>
    );
  }
  const { lead, activities, tasks } = data;
  const open = isOpenLead(lead);
  const business = data.businessesById.get(lead.business_id);
  const client = data.clientsById.get(lead.client_id);
  const account = data.accountsById.get(lead.account_id);
  const wonClient = data.clientsById.get(lead.won_client_id);
  const value = leadValueText(lead);
  const openTasks = tasks.filter((t) => !t.done_at).sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')));
  const doneCount = tasks.length - openTasks.length;
  const close = () => setSheet(null);
  const move = (to) => {
    const change = stageChange(lead, to); // the buttons only offer moves that can be made
    return change.problem ? null : run(() => saveStageChange(store, lead, change));
  };
  const addStep = () => setSheet({
    kind: 'task',
    initial: newTaskInitial({
      me, businesses: data.businesses, context: lead.business_id, lead_id: lead.id,
      client_id: lead.won_client_id ?? lead.client_id ?? '', account_id: lead.account_id ?? '',
    }),
  });
  const days = daysInStage(lead, today);

  return (
    <div className="crm-client" data-testid="lead-page">
      <Card>
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ display: 'grid', gap: 'var(--space-2)', minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', overflowWrap: 'anywhere' }} data-testid="lead-name">{lead.name}</h1>
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                <span data-testid="lead-stage"><Badge tone={STAGE_TONES[lead.stage]}>{STAGE_LABELS[lead.stage]}</Badge></span>
                <BusinessChip business={business} />
                {lead.kind ? <span style={muted}>{KIND_LABELS[lead.kind]}</span> : null}
                {value ? <span style={{ ...muted, fontWeight: 600 }}>{value}</span> : null}
                {open && days !== null ? <span style={muted}>{days === 0 ? 'since today' : `${days} day${days === 1 ? '' : 's'} at this stage`}</span> : null}
                <Badges record={lead} />
              </div>
            </div>
            <Button onClick={() => setSheet({ kind: 'edit' })}><Icon name="edit" size={16} />Edit</Button>
          </div>
          {client ? (
            <p style={{ ...muted, margin: 0 }} data-testid="lead-client">
              For a current client: <Link to={`/crm/clients/${client.id}`}>{client.name}</Link>{account ? ` · ${account.name}` : ''}
            </p>
          ) : null}
          {lead.stage === 'won' ? (
            <Notice tone="info">
              <span data-testid="lead-won">
                Won{lead.closed_at ? ` on ${formatDay(lead.closed_at)}` : ''}
                {wonClient ? <>: <Link to={`/crm/clients/${wonClient.id}`}>{wonClient.name}</Link> is a client.</> : '.'}
              </span>
            </Notice>
          ) : null}
          {lead.stage === 'lost' ? (
            <Notice tone="warn">
              <span data-testid="lead-lost">
                Lost{lead.closed_at ? ` on ${formatDay(lead.closed_at)}` : ''}: {LOST_LABELS[lead.lost_reason] ?? 'no reason given'}{lead.lost_note ? ` — ${lead.lost_note}` : ''}
              </span>
            </Notice>
          ) : null}
          <div className="lead-stage-buttons" role="group" aria-label="Move this lead">
            {open ? (
              <>
                {OPEN_LEAD_STAGES.filter((s) => s !== lead.stage).map((s) => (
                  <Button key={s} disabled={busy} onClick={() => move(s)}>Move to {STAGE_LABELS[s]}</Button>
                ))}
                <Button variant="primary" disabled={busy} onClick={() => setSheet({ kind: 'win' })}><Icon name="check" size={16} />Won…</Button>
                <Button disabled={busy} onClick={() => setSheet({ kind: 'lost' })}>Lost…</Button>
              </>
            ) : lead.stage === 'lost' ? (
              <Button disabled={busy} onClick={() => move(reopenStage(activities))}>Reopen ({STAGE_LABELS[reopenStage(activities)]})</Button>
            ) : null}
          </div>
          {open ? <p style={{ ...muted, margin: 0 }}>Quoted is set by hand when you send a quote (quotes in the suite come later).</p> : null}
          {error ? <p role="alert" style={{ color: 'var(--danger)', margin: 0 }}>{error}</p> : null}
          <RecordSync record={lead} what="lead" />
        </div>
      </Card>

      <div className="lead-grid">
        <div className="crm-col">
          <Card>
            <div style={sectionHead}>
              <h2 style={h2}>Next step</h2>
              <TextButton onClick={addStep}><Icon name="plus" size={14} />Add next step</TextButton>
            </div>
            {open && !next ? (
              <p style={{ margin: '0 0 var(--space-2)' }} data-testid="lead-flag">
                <Badge tone="warn">No next step</Badge> <span style={muted}>Add a task with a day, or log a call with its next step.</span>
              </p>
            ) : null}
            {openTasks.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-1)' }} data-testid="lead-tasks">
                {openTasks.map((t) => (
                  <li key={t.id}>
                    <button type="button" className="crm-link-button" style={{ textAlign: 'left' }} onClick={() => setSheet({ kind: 'task', record: t })}>
                      {t.title}
                    </button>
                    <span style={{ ...muted, color: t.due_date && t.due_date < today ? 'var(--danger)' : 'var(--text-muted)' }}>
                      {' '}· {t.due_date ? `${t.due_date < today ? 'overdue, ' : ''}${formatDate(t.due_date)}` : 'no day'} · {ownerText(t.owner, me)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p style={{ ...muted, margin: 0 }}>No open tasks for this lead.</p>}
            {doneCount ? <p style={{ ...muted, margin: 'var(--space-2) 0 0' }}>{doneCount} done</p> : null}
          </Card>
          <Card>
            <div style={sectionHead}><h2 style={h2}>Details</h2></div>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 'var(--space-1) var(--space-3)' }}>
              {lead.contact_name ? <><dt style={muted}>Contact</dt><dd style={{ margin: 0 }}>{lead.contact_name}</dd></> : null}
              {lead.email ? <><dt style={muted}>Email</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}><a href={`mailto:${lead.email}`}>{lead.email}</a></dd></> : null}
              {lead.phone ? <><dt style={muted}>Phone</dt><dd style={{ margin: 0 }}><a href={`tel:${lead.phone}`}>{formatPhone(lead.phone)}</a></dd></> : null}
              <dt style={muted}>Came from</dt><dd style={{ margin: 0 }}>{SOURCE_LABELS[lead.source] ?? '—'}</dd>
              <dt style={muted}>Whose</dt><dd style={{ margin: 0 }}>{ownerText(lead.owner, me)}</dd>
              {lead._sync?.createdAt ? <><dt style={muted}>Added</dt><dd style={{ margin: 0 }}>{formatDay(lead._sync.createdAt)}</dd></> : null}
            </dl>
            {lead.notes ? <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 'var(--space-3) 0 0' }}>{lead.notes}</p> : null}
          </Card>
        </div>
        <div className="crm-col">
          <Card>
            <div style={sectionHead}>
              <h2 style={h2}>Timeline</h2>
              <span style={muted}>{activities.length}</span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
              <Button variant="primary" onClick={() => setSheet({ kind: 'activity', type: 'note' })}><Icon name="note" size={18} />Add note</Button>
              <Button onClick={() => setSheet({ kind: 'activity', type: 'call' })}><Icon name="call" size={18} />Log call</Button>
            </div>
            {activities.length ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="lead-timeline">
                {activities.map((a) => <ActivityRow key={a.id} activity={a} me={me} />)}
              </ul>
            ) : <EmptyState title="Nothing logged yet">Add a note or log a call: it works offline too.</EmptyState>}
          </Card>
        </div>
      </div>

      {sheet?.kind === 'edit' ? (
        <LeadForm
          record={lead}
          businesses={data.businesses}
          clientsById={data.clientsById}
          accountsById={data.accountsById}
          onClose={close}
          onDone={close}
          onDeleted={() => navigate('/crm/pipeline', { replace: true })}
        />
      ) : null}
      {sheet?.kind === 'lost' ? <LostSheet lead={lead} onClose={close} onDone={close} /> : null}
      {sheet?.kind === 'win' ? (
        <WinSheet lead={lead} data={data} onClose={close} onDone={(clientId) => { close(); navigate(`/crm/clients/${clientId}`); }} />
      ) : null}
      {sheet?.kind === 'activity' ? <LeadActivityForm key={sheet.type} lead={lead} type={sheet.type} onClose={close} onDone={close} /> : null}
      {sheet?.kind === 'task' ? (
        <TaskSheet record={sheet.record} initial={sheet.initial} title={sheet.record ? undefined : 'Next step'} onClose={close} onDone={close} onDeleted={close} />
      ) : null}
    </div>
  );
}

export default function LeadPage() {
  const { id } = useParams();
  return (
    <>
      <CrmTabs />
      <p style={{ margin: '0 0 var(--space-3)' }}><Link to="/crm/pipeline">← Pipeline</Link></p>
      <LeadScreen key={id} leadId={id} />
    </>
  );
}
