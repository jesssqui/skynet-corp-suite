// Playbooks (/playbooks, D9): the projects and jobs under way (each run's progress and next task), every
// playbook by business with Run, and examples to start from. ?client=<id> (from the client page's Projects
// card) runs one for that client; ?finished=1 lists done and stopped runs too; ?archived=1 archived
// playbooks. Read from and written to the device's offline copy, so all of it works with no connection.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EXAMPLE_PLAYBOOKS, REPEAT_LABELS, repeatOf, isActiveRun } from '@suite/shared/playbooks';
import { PageHeader, Card, Button, Badge, EmptyState, Notice } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { store } from '../../sync/index.js';
import { BusinessChip, Badges, useAction } from '../crm/parts.jsx';
import { KIND_LABELS } from '../crm/logic.js';
import { useToday } from '../planner/parts.jsx';
import { usePlaybooksData } from './data.js';
import { exampleRecords } from './logic.js';
import { RunRow } from './parts.jsx';
import { PlaybookForm, RunSheet } from './forms.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const list = { listStyle: 'none', margin: 0, padding: 0 };

export default function PlaybooksPage() {
  const { data } = usePlaybooksData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const forClient = params.get('client') ?? '';
  const showFinished = params.get('finished') === '1';
  const showArchived = params.get('archived') === '1';
  const [sheet, setSheet] = useState(null);
  const adding = useAction();
  const toggle = (key) => {
    const next = new URLSearchParams(window.location.search);
    if (next.get(key) === '1') next.delete(key);
    else next.set(key, '1');
    setParams(next, { replace: true });
  };

  const groups = useMemo(() => {
    if (!data) return [];
    return data.businesses
      .map((b) => ({ business: b, playbooks: data.playbooks.filter((p) => p.business_id === b.id && (showArchived || !p.archived)).sort((x, y) => String(x.name).localeCompare(String(y.name))) }))
      .filter((g) => g.playbooks.length);
  }, [data, showArchived]);
  const runs = useMemo(() => (data ? data.runs.filter((r) => showFinished || isActiveRun(r))
    .sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)) || (a.id < b.id ? 1 : -1)) : []), [data, showFinished]);
  const finishedCount = data ? data.runs.filter((r) => !isActiveRun(r)).length : 0;
  const client = forClient && data ? data.clientsById.get(forClient) : null;

  const addExample = (example) => adding.run(async () => {
    const { playbook, steps } = exampleRecords(example);
    const id = await store.create('playbook', playbook);
    for (const s of steps) await store.create('playbook_step', { playbook_id: id, ...s });
    navigate(`/playbooks/${id}`);
  });

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <PageHeader
        title="Playbooks"
        subtitle="Steps you repeat — projects, jobs, onboarding, retainers. Running one makes its tasks, with owners and dates."
        actions={<Button variant="primary" disabled={!data} onClick={() => setSheet({ kind: 'playbook' })}>New playbook</Button>}
      />
      {client ? (
        <Notice tone="info">
          Running a playbook for <strong>{client.name}</strong>: pick one below. <Link to="/playbooks">Not for them</Link>
        </Notice>
      ) : null}

      <Card title={showFinished ? 'Projects and jobs' : 'Under way'}>
        {!data ? <p style={muted}>Loading…</p> : runs.length ? (
          <ul style={list} data-testid="runs-list">
            {runs.map((r) => (
              <RunRow key={r.id} run={r} runSteps={data.runStepsOf(r.id)} tasks={data.tasksOf(r.id)} clientName={r.client_id ? data.clientsById.get(r.client_id)?.name ?? 'Deleted client' : null} today={today} />
            ))}
          </ul>
        ) : <p style={{ ...muted, margin: 0 }}>Nothing under way. Run a playbook below.</p>}
        {finishedCount ? (
          <button type="button" onClick={() => toggle('finished')} style={{ ...muted, background: 'none', border: 0, padding: 0, minHeight: 'var(--tap)', color: 'var(--accent)', cursor: 'pointer' }}>
            {showFinished ? 'Hide done and stopped' : `Show done and stopped (${finishedCount})`}
          </button>
        ) : null}
      </Card>

      {data && !groups.length ? (
        <EmptyState title="No playbooks yet">Start from an example below, or make a new one.</EmptyState>
      ) : null}
      {groups.map(({ business, playbooks }) => (
        <Card key={business.id} title={business.name}>
          <ul style={list} data-business-id={business.id}>
            {playbooks.map((p) => {
              const steps = data.stepsOf(p.id).length;
              return (
                <li key={p.id} data-playbook-id={p.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: 'var(--space-2) 0', borderTop: '1px solid var(--border)' }}>
                  <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 180px' }}>
                    <Link to={`/playbooks/${p.id}`} style={{ fontWeight: 600, color: 'var(--text)', overflowWrap: 'anywhere' }}>{p.name}</Link>
                    <span style={muted}>
                      {steps} step{steps === 1 ? '' : 's'} · {REPEAT_LABELS[repeatOf(p)]}{p.for_client ? ` · for a client${p.kind ? ` (${KIND_LABELS[p.kind]})` : ''}` : ''}
                    </span>
                    <Badges record={p}>{p.archived ? <Badge>Archived</Badge> : null}</Badges>
                  </span>
                  <Button disabled={!steps || p.archived || (client && !p.for_client)} onClick={() => setSheet({ kind: 'run', playbook: p })}>Run…</Button>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      {data && data.playbooks.some((p) => p.archived) ? (
        <button type="button" onClick={() => toggle('archived')} style={{ ...muted, background: 'none', border: 0, padding: 0, minHeight: 'var(--tap)', color: 'var(--accent)', cursor: 'pointer', justifySelf: 'start' }}>
          {showArchived ? 'Hide archived playbooks' : 'Show archived playbooks'}
        </button>
      ) : null}

      <Card title="Start from an example">
        <ul style={list} data-testid="examples">
          {EXAMPLE_PLAYBOOKS.map((ex) => (
            <li key={ex.key} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: 'var(--space-2) 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 200px' }}>
                <span style={{ fontWeight: 600 }}>{ex.name}</span>
                {data?.businessesById.get(ex.business_id) ? <span><BusinessChip business={data.businessesById.get(ex.business_id)} /></span> : null}
                <span style={muted}>{ex.description}</span>
              </span>
              <Button disabled={!data || adding.busy} onClick={() => addExample(ex)} aria-label={`Add the example ${ex.name}`}>Add it</Button>
            </li>
          ))}
        </ul>
        {adding.error ? <Notice tone="danger">{adding.error}</Notice> : null}
        <p style={{ ...muted, margin: 'var(--space-2) 0 0' }}>An example becomes your own playbook: change its steps as you like.</p>
      </Card>

      {sheet?.kind === 'playbook' ? (
        <PlaybookForm businesses={data.businesses} onClose={() => setSheet(null)} onDone={(id) => { setSheet(null); navigate(`/playbooks/${id}`); }} />
      ) : null}
      {sheet?.kind === 'run' ? (
        <RunSheet playbook={sheet.playbook} data={data} me={me} initialClientId={sheet.playbook.for_client ? forClient : ''} onClose={() => setSheet(null)} />
      ) : null}
    </div>
  );
}
