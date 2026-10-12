// One run (/playbooks/runs/:id, D9): a project, job, onboarding or retainer — its client, start day, the
// playbook it came from (as it was then), progress, and its checklist by stage (the tasks it made, with
// ticks; offers left out and why; the renewal dates it set). Mark done / Stop repeating / Reopen, Edit
// (name, end date, notes) and Delete (for a mistake: with its open tasks). Offline, through the store.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { REPEAT_LABELS, repeatOf, runStatus, monthLabel } from '@suite/shared/playbooks';
import { Card, Button, Badge, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDate, formatDateTime } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { BusinessChip, Badges, RecordSync, useAction } from '../crm/parts.jsx';
import { useToday } from '../planner/parts.jsx';
import { usePlaybooksData } from './data.js';
import { runChecklist, progressText } from './logic.js';
import { RunChecklist, RunStatusBadge } from './parts.jsx';
import { RunEditForm } from './forms.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

export default function RunPage() {
  const { id } = useParams();
  const { data, loading } = usePlaybooksData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tickError, setTickError] = useState(null);
  const action = useAction();
  const run = data?.runsById.get(id) ?? null;
  const runSteps = useMemo(() => (run ? data.runStepsOf(id) : []), [data, id, run]);
  const tasks = useMemo(() => (run ? data.tasksOf(id) : []), [data, id, run]);

  if (!data) return <p style={muted}>{loading ? 'Loading…' : ''}</p>;
  if (!run) return <EmptyState title="Run not found">It may have been deleted. <Link to="/playbooks">Playbooks</Link></EmptyState>;
  const c = runChecklist(runSteps, tasks);
  const status = runStatus(run);
  const monthly = repeatOf(run) === 'monthly';
  const playbook = run.playbook_id ? data.playbooksById.get(run.playbook_id) : null;
  const client = run.client_id ? data.clientsById.get(run.client_id) : null;
  const account = run.account_id ? data.accountsById.get(run.account_id) : null;
  const openTasks = tasks.filter((t) => !t.done_at);
  const setStatus = (s) => action.run(() => store.update('playbook_run', run.id, { status: s }));
  const remove = () => action.run(async () => {
    for (const t of openTasks) await store.remove('task', t.id);
    await store.remove('playbook_run', run.id);
    navigate('/playbooks');
  });

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <Link to="/playbooks" style={{ ...muted, display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 'var(--tap)' }}><Icon name="back" size={16} />Playbooks</Link>
        <header style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <h1 style={{ fontSize: 'var(--text-xl)', fontWeight: 650, overflowWrap: 'anywhere' }}>{run.name}</h1>
          <span style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <BusinessChip business={data.businessesById.get(run.business_id)} />
            <Badges record={run}><RunStatusBadge run={run} />{monthly ? <Badge tone="accent">{REPEAT_LABELS.monthly}</Badge> : null}</Badges>
          </span>
          <span style={muted}>
            {client ? <>For <Link to={`/crm/clients/${client.id}`}>{client.name}</Link>{account && account.name !== client.name ? ` · ${account.name}` : ''} · </> : run.client_id ? 'For a deleted client · ' : ''}
            {monthly ? `Every month from ${monthLabel(run.start_date)}${run.end_date ? ` until ${formatDate(run.end_date)}` : ''}` : `Started ${formatDate(run.start_date)}`}
          </span>
          <span style={muted}>
            From the playbook {playbook ? <Link to={`/playbooks/${playbook.id}`}>{playbook.name}</Link> : '(since deleted)'}
            {run.playbook_as_of ? ` as it was on ${formatDateTime(run.playbook_as_of)}` : ''} — later changes to it don’t touch this run.
          </span>
        </header>
      </div>
      <RecordSync record={run} what="run" />

      <Card title="Progress">
        <p style={{ margin: 0, fontWeight: 600 }} data-testid="run-progress-line">{progressText(c)}</p>
        {c.total ? (
          <div aria-hidden="true" style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', marginTop: 'var(--space-2)', overflow: 'hidden' }}>
            <div style={{ width: `${Math.round((c.done / c.total) * 100)}%`, height: '100%', background: 'var(--ok)' }} />
          </div>
        ) : null}
        {c.allDone && status === 'active' && !monthly ? <Notice tone="ok" style={{ marginTop: 'var(--space-2)' }}>Every task is done. Mark the run done?</Notice> : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-3)' }}>
          {status === 'active' ? <Button variant={c.allDone ? 'primary' : 'secondary'} disabled={action.busy} onClick={() => setStatus('done')}>Mark done</Button> : null}
          {status === 'active' && monthly ? <Button disabled={action.busy} onClick={() => setStatus('stopped')}>Stop repeating</Button> : null}
          {status !== 'active' ? <Button disabled={action.busy} onClick={() => setStatus('active')}>Reopen</Button> : null}
          <Button variant="ghost" onClick={() => setSheet('edit')}>Edit</Button>
          <Button variant="ghost" style={{ marginLeft: 'auto', color: 'var(--danger)' }} onClick={() => setConfirmDelete(true)}>Delete…</Button>
        </div>
        {confirmDelete ? (
          <div style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }} data-testid="run-delete-confirm">
            <Notice tone="warn">
              Delete this run? Only for one made by mistake. {openTasks.length ? `Its ${openTasks.length} open task${openTasks.length === 1 ? '' : 's'} go with it; ` : ''}
              done tasks, renewal dates and anything it added to the client stay.
            </Notice>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button variant="danger" disabled={action.busy} onClick={remove}>Delete</Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Keep it</Button>
            </div>
          </div>
        ) : null}
        {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
        {run.notes ? <p style={{ ...muted, whiteSpace: 'pre-wrap', margin: 'var(--space-3) 0 0' }}>{run.notes}</p> : null}
      </Card>

      <Card title="Checklist">
        {tickError ? <Notice tone="danger">{tickError}</Notice> : null}
        <RunChecklist runSteps={runSteps} tasks={tasks} me={me} today={today} onError={setTickError} />
        {monthly ? <p style={{ ...muted, margin: 'var(--space-3) 0 0' }}>Each month’s tasks are made a week before it starts, from the steps this run started with.</p> : null}
      </Card>

      {sheet === 'edit' ? <RunEditForm record={run} onClose={() => setSheet(null)} onDone={() => setSheet(null)} /> : null}
    </div>
  );
}
