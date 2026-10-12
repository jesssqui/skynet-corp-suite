// Pieces the playbook screens and the client page share: a run's row (name, client, progress, next task),
// a step's links (web addresses open in a new tab; a suite file — "file:<id>" — shows as a file until
// D10's files can open it: the seam is fileHref), and a run's checklist by stage with ticks.
import { Link } from 'react-router-dom';
import { parseLinks, RUN_STATUS_LABELS, runStatus } from '@suite/shared/playbooks';
import { Badge } from '../../ui/index.js';
import { Badges } from '../crm/parts.jsx';
import { TaskTick, OwnerBadge } from '../planner/parts.jsx';
import { dueLabel } from '../planner/logic.js';
import { runChecklist, progressText } from './logic.js';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };
const STATUS_TONES = { active: 'accent', done: 'ok', stopped: 'neutral', starting: 'warn' };

/**
 * Where a suite file opens (D10's seam): null until the files module says. D10 can set it with
 * setFileHref((id) => `/files/${id}`) from its own module; nothing here depends on D10's code.
 */
let fileHref = () => null;
export function setFileHref(fn) {
  fileHref = typeof fn === 'function' ? fn : () => null;
}

export function StepLinks({ text }) {
  const links = parseLinks(text);
  if (!links.length) return null;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }} data-testid="step-links">
      {links.map((l, i) => {
        if (l.kind === 'url') {
          return (
            <li key={i} style={{ ...muted, overflowWrap: 'anywhere' }}>
              <a href={l.href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{l.label ?? l.href}</a>
            </li>
          );
        }
        if (l.kind === 'file') {
          const href = fileHref(l.id);
          const label = `File: ${l.label ?? l.id}`;
          return <li key={i} style={{ ...muted, overflowWrap: 'anywhere' }}>{href ? <Link to={href} style={{ color: 'var(--accent)' }}>{label}</Link> : label}</li>;
        }
        return <li key={i} style={{ ...muted, overflowWrap: 'anywhere' }}>{l.text}</li>;
      })}
    </ul>
  );
}

export function RunStatusBadge({ run }) {
  const s = runStatus(run);
  return <Badge tone={STATUS_TONES[s]}>{RUN_STATUS_LABELS[s]}</Badge>;
}

/** One run in a list: its name (→ its page), client, progress and the next open task. */
export function RunRow({ run, runSteps, tasks, clientName = null, today, twice = false }) {
  const c = runChecklist(runSteps, tasks);
  return (
    <li data-run-id={run.id} style={{ display: 'grid', gap: 2, padding: 'var(--space-2) 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Link to={`/playbooks/runs/${run.id}`} style={{ fontWeight: 600, color: 'var(--text)', overflowWrap: 'anywhere' }}>{run.name}</Link>
        <Badges record={run}><RunStatusBadge run={run} />{twice ? <Badge tone="warn">Run twice</Badge> : null}</Badges>
      </span>
      <span style={muted} data-testid="run-progress">
        {clientName ? `${clientName} · ` : ''}{progressText(c)}
        {c.nextTask && runStatus(run) === 'active' ? ` · next: ${c.nextTask.title} (${dueLabel(c.nextTask, today) || 'no day'})` : ''}
      </span>
    </li>
  );
}

/** A run's checklist: its stages in order, each step with its tasks (ticks), or why it was left out / what it set. */
export function RunChecklist({ runSteps, tasks, me, today, onError }) {
  const c = runChecklist(runSteps, tasks);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }} data-testid="run-checklist">
      {c.stages.map((g) => (
        <section key={g.stage || '—'} data-stage={g.stage}>
          <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 650, margin: '0 0 var(--space-2)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {g.stage || 'Steps'}
            {g.stage && g.stage === c.current ? <Badge tone="accent">Now</Badge> : null}
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
            {g.items.map(({ step, tasks: ts }) => (
              <li key={step.id} data-run-step={step.id} style={{ display: 'grid', gap: 2 }}>
                {step.outcome === 'skipped' ? (
                  <span style={muted}>Left out: {step.title} — {step.outcome_note}</span>
                ) : step.outcome === 'renewal' ? (
                  <span style={{ fontSize: 'var(--text-sm)' }}>{step.outcome_note}</span>
                ) : ts.length ? ts.map((t) => (
                  <span key={t.id} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }} data-task-id={t.id}>
                    <TaskTick task={t} onError={onError} />
                    <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                      <Link to={`/tasks?open=${t.id}`} style={{ color: 'var(--text)', overflowWrap: 'anywhere', textDecoration: t.done_at ? 'line-through' : 'none' }}>{t.title}</Link>
                      <span style={{ ...muted, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
                        <span>{t.done_at ? 'Done' : dueLabel(t, today) || 'No day'}{!t.done_at && t.due_date && t.due_date < today ? ' · overdue' : ''}</span>
                        <OwnerBadge owner={t.owner} me={me} />
                      </span>
                    </span>
                  </span>
                )) : <span style={muted}>{step.title} — its task was deleted</span>}
                <StepLinks text={step.links} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
