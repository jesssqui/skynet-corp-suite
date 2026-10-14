// One playbook (/playbooks/:id, D9): its details, its steps by stage (when, who, what each does, its
// links) with up/down to reorder and a sheet per step, Run…, and the runs made from it. Editing changes
// only runs started from now on — every run keeps its own copy of the steps. Offline, through the store.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { REPEAT_LABELS, repeatOf, byPosition, stagesOf } from '@suite/shared/playbooks';
import { Card, Button, Badge, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDate } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { BusinessChip, Badges, RecordSync, useAction } from '../crm/parts.jsx';
import { KIND_LABELS } from '../crm/logic.js';
import { useToday } from '../planner/parts.jsx';
import { usePlaybooksData } from './data.js';
import { reorderChanges, nextPosition, stepSummary } from './logic.js';
import { RunRow, StepLinks } from './parts.jsx';
import { PlaybookForm, StepForm, RunSheet } from './forms.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const iconButton = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 'var(--tap)', height: 'var(--tap)', border: 0,
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', borderRadius: 'var(--radius)',
};

export default function PlaybookPage() {
  const { id } = useParams();
  const { data, loading } = usePlaybooksData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const [sheet, setSheet] = useState(null);
  const moving = useAction();
  const playbook = data?.playbooksById.get(id) ?? null;
  const steps = useMemo(() => (playbook ? [...data.stepsOf(id)].sort(byPosition) : []), [data, id, playbook]);
  const runs = useMemo(() => (playbook ? [...data.runsOf(id)].sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))) : []), [data, id, playbook]);

  if (!data) return <p style={muted}>{loading ? 'Loading…' : ''}</p>;
  if (!playbook) return <EmptyState title="Playbook not found">It may have been deleted. <Link to="/playbooks">All playbooks</Link></EmptyState>;
  const business = data.businessesById.get(playbook.business_id);
  const businessName = (bid) => data.businessesById.get(bid)?.name ?? 'that business';
  const move = (stepId, dir) => moving.run(async () => {
    for (const c of reorderChanges(steps, stepId, dir)) await store.update('playbook_step', c.id, { position: c.position });
  });

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <Link to="/playbooks" style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 'var(--tap)' }}><Icon name="back" size={16} />Playbooks</Link>
        <header style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
            <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, overflowWrap: 'anywhere' }}>{playbook.name}</h1>
            <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <BusinessChip business={business} />
              <Badges record={playbook}>
                <Badge tone="accent">{REPEAT_LABELS[repeatOf(playbook)]}</Badge>
                {playbook.for_client ? <Badge>For a client{playbook.kind ? ` · ${KIND_LABELS[playbook.kind]}` : ''}</Badge> : null}
                {playbook.archived ? <Badge>Archived</Badge> : null}
              </Badges>
            </span>
          </div>
          <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button onClick={() => setSheet({ kind: 'edit' })}>Edit</Button>
            <Button variant="primary" disabled={!steps.length || playbook.archived || business?.archived} onClick={() => setSheet({ kind: 'run' })}>Run…</Button>
          </span>
        </header>
        {playbook.description ? <p style={{ ...muted, margin: 'var(--space-2) 0 0', whiteSpace: 'pre-wrap' }}>{playbook.description}</p> : null}
      </div>
      <RecordSync record={playbook} what="playbook" />
      <Notice tone="info">Changes apply to runs started from now on. Runs already started keep the steps they started with.</Notice>

      <Card title={`Steps (${steps.length})`}>
        {steps.length ? (
          <div style={{ display: 'grid', gap: 'var(--space-3)' }} data-testid="steps">
            {stagesOf(steps).map((stage) => (
              <section key={stage || '—'}>
                <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 650, margin: '0 0 var(--space-1)' }}>{stage || 'No stage'}</h3>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {steps.filter((s) => (s.stage ?? '') === stage).map((s) => {
                    const i = steps.indexOf(s);
                    return (
                      <li key={s.id} data-step-id={s.id} style={{ display: 'grid', gap: 2, borderTop: '1px solid var(--border)', padding: 'var(--space-1) 0' }}>
                        <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'flex-start' }}>
                        <button type="button" onClick={() => setSheet({ kind: 'step', record: s })} aria-label={`Edit step ${s.title}`}
                          style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 'var(--space-1) 0', color: 'var(--text)', cursor: 'pointer', display: 'grid', gap: 2, minHeight: 'var(--tap)' }}>
                          <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{s.title}</span>
                          <span style={muted}>{stepSummary(s, { businessName })}</span>
                          <Badges record={s} />
                        </button>
                        <span style={{ display: 'flex', flexShrink: 0 }}>
                          <button type="button" style={iconButton} aria-label={`Move ${s.title} up`} disabled={i === 0 || moving.busy} onClick={() => move(s.id, 'up')}><Icon name="up" size={18} /></button>
                          <button type="button" style={iconButton} aria-label={`Move ${s.title} down`} disabled={i === steps.length - 1 || moving.busy} onClick={() => move(s.id, 'down')}><Icon name="down" size={18} /></button>
                        </span>
                        </div>
                        <StepLinks text={s.links} />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : <p style={{ ...muted, margin: 0 }}>No steps yet.</p>}
        {moving.error ? <Notice tone="danger">{moving.error}</Notice> : null}
        <Button style={{ marginTop: 'var(--space-3)' }} onClick={() => setSheet({ kind: 'step', initial: { position: nextPosition(steps), stage: steps.at(-1)?.stage ?? '' } })}>
          <Icon name="plus" size={16} />Add a step
        </Button>
      </Card>

      <Card title="Runs">
        {runs.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {runs.map((r) => (
              <RunRow key={r.id} run={r} runSteps={data.runStepsOf(r.id)} tasks={data.tasksOf(r.id)} clientName={r.client_id ? data.clientsById.get(r.client_id)?.name ?? 'Deleted client' : null} today={today} />
            ))}
          </ul>
        ) : <p style={{ ...muted, margin: 0 }}>Not run yet.</p>}
        {playbook._sync?.updatedAt ? <p style={{ ...muted, margin: 'var(--space-2) 0 0' }}>Last changed {formatDate(playbook._sync.updatedAt.slice(0, 10))}.</p> : null}
      </Card>

      {sheet?.kind === 'edit' ? (
        <PlaybookForm record={playbook} businesses={data.businesses} onClose={() => setSheet(null)} onDone={() => setSheet(null)} onDeleted={() => { setSheet(null); window.history.back(); }} />
      ) : null}
      {sheet?.kind === 'step' ? (
        <StepForm record={sheet.record} initial={sheet.initial} playbook={playbook} businesses={data.businesses} onClose={() => setSheet(null)} onDone={() => setSheet(null)} onDeleted={() => setSheet(null)} />
      ) : null}
      {sheet?.kind === 'run' ? <RunSheet playbook={playbook} data={data} me={me} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
