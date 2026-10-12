// The client page's Projects card (D9): this client's playbook runs — projects, jobs, onboarding,
// retainers — with their progress and next task, and "Run a playbook" (the Playbooks page, for this
// client). Done and stopped runs are counted, shown on request. Offline, from the device's copy.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isActiveRun } from '@suite/shared/playbooks';
import { Card } from '../../ui/index.js';
import { useToday } from '../planner/parts.jsx';
import { useClientRunsData } from './data.js';
import { clientRuns } from './logic.js';
import { RunRow } from './parts.jsx';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

export function ClientProjectsCard({ clientId }) {
  const { data } = useClientRunsData(clientId);
  const today = useToday();
  const [all, setAll] = useState(false);
  if (!data) return null;
  const runs = clientRuns(data.runs, clientId);
  const shown = all ? runs : runs.filter(isActiveRun);
  const finished = runs.length - runs.filter(isActiveRun).length;
  return (
    <Card title="Projects">
      <div data-testid="client-projects">
        {shown.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {shown.map((r) => <RunRow key={r.id} run={r} runSteps={data.runStepsOf(r.id)} tasks={data.tasksOf(r.id)} today={today} />)}
          </ul>
        ) : <p style={{ ...muted, margin: 0 }}>Nothing under way.</p>}
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center', marginTop: 'var(--space-2)' }}>
          <Link to={`/playbooks?client=${clientId}`} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 'var(--tap)', fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--accent)' }}>
            Run a playbook
          </Link>
          {finished ? (
            <button type="button" onClick={() => setAll((v) => !v)} style={{ ...muted, background: 'none', border: 0, padding: 0, minHeight: 'var(--tap)', color: 'var(--accent)', cursor: 'pointer' }}>
              {all ? 'Hide done and stopped' : `Show done and stopped (${finished})`}
            </button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
