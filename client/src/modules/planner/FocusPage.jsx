// Focus (/focus?task=<id>): one task at a time for heads-down work — its title, notes and estimate,
// and beside it (below it on a phone) the client's key details when it has a client: contacts with
// tap-to-call / mail, their businesses, the last few timeline items. Done / Skip / Next: Done and
// Skip move on to the next of today's tasks in Today's order (focusQueue); Next looks at the next
// one and leaves this one in the queue; Skip leaves it out for this session. Reached from Today's
// "Focus" and from a task's sheet. Reads the offline copy; Done is saved through the store.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { formatPhone } from '@suite/shared/normalize';
import { PageHeader, Card, Button, EmptyState, Icon, Notice } from '../../ui/index.js';
import { formatDateTime } from '../../ui/format.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessChip, useAction } from '../crm/parts.jsx';
import { ACTIVITY_LABELS, sortTimeline } from '../crm/logic.js';
import { useClientPageData } from '../crm/data.js';
import { usePlannerData } from './data.js';
import { dueLabel, dueState, formatMinutes } from './logic.js';
import { focusQueue, nextInQueue, previousInQueue } from './plan.js';
import { OwnerBadge, toggleDone, useToday, muted } from './parts.jsx';
import { TaskSheet } from './forms.jsx';

const LAST_ACTIVITIES = 4;

/** The client's key details beside the task. */
function ClientPanel({ clientId }) {
  const { data } = useClientPageData(clientId);
  if (!data) return <Card><p style={{ ...muted, margin: 0 }}>Loading the client…</p></Card>;
  if (!data.client) return <Card><p style={{ ...muted, margin: 0 }}>This task’s client isn’t on this device (deleted, or not downloaded yet).</p></Card>;
  const { client, contacts, accounts, activities } = data;
  const last = sortTimeline(activities).slice(0, LAST_ACTIVITIES);
  return (
    <Card>
      <div data-testid="focus-client" style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 650, overflowWrap: 'anywhere' }}>{client.name}</h2>
          <Link to={`/crm/clients/${client.id}`} className="planner-link-row" style={{ minHeight: 'var(--tap)' }}>Open client <Icon name="chevron" size={16} /></Link>
        </div>
        {accounts.length ? (
          <p style={{ ...muted, margin: 0 }}>{accounts.map((a) => [a.name, a.city].filter(Boolean).join(', ')).join(' · ')}</p>
        ) : null}
        {contacts.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="focus-contacts">
            {contacts.map((c) => (
              <li key={c.id} style={{ display: 'grid', gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{c.name}{c.role ? <span style={muted}> · {c.role}</span> : null}</span>
                <span style={{ display: 'flex', gap: '0 var(--space-4)', flexWrap: 'wrap' }}>
                  {c.phone ? <a className="crm-contact-link" href={`tel:${c.phone}`}><Icon name="call" size={16} />{formatPhone(c.phone)}</a> : null}
                  {c.email ? <a className="crm-contact-link" href={`mailto:${c.email}`}><Icon name="mail" size={16} />{c.email}</a> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : <p style={{ ...muted, margin: 0 }}>No contacts yet.</p>}
        <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <h3 style={{ ...muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 }}>Latest</h3>
          {last.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }} data-testid="focus-timeline">
              {last.map((a) => (
                <li key={a.id} style={{ display: 'grid', gap: 2 }}>
                  <span style={muted}><strong style={{ color: 'var(--text)' }}>{ACTIVITY_LABELS[a.type] ?? a.type}</strong> · {formatDateTime(a.at)}</span>
                  <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{a.body}</span>
                </li>
              ))}
            </ul>
          ) : <p style={{ ...muted, margin: 0 }}>Nothing on the timeline yet.</p>}
        </div>
      </div>
    </Card>
  );
}

export default function FocusPage() {
  const { data, loading } = usePlannerData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const startId = params.get('task');
  // The queue is taken once, when the data is first here: Today's order at that moment.
  const [queue, setQueue] = useState(null);
  const [current, setCurrent] = useState(null);
  const [skipped, setSkipped] = useState(() => new Set());
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (!data || queue) return;
    const ids = focusQueue({ tasks: data.tasks, me, today, start: startId });
    setQueue(ids);
    setCurrent(startId && ids.includes(startId) ? startId : ids[0] ?? null);
  }, [data, queue, me, today, startId]);

  const tasksById = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  const task = current ? tasksById.get(current) : null;
  const isLeft = (id, skip = skipped) => {
    const t = tasksById.get(id);
    return Boolean(t) && !t.done_at && !skip.has(id);
  };
  const go = (id) => {
    setCurrent(id);
    if (id) setParams({ task: id }, { replace: true });
  };
  const done = () => run(async () => {
    if (!task.done_at) await toggleDone(task);
    go(nextInQueue(queue, current, (id) => id !== current && isLeft(id)));
  });
  const skip = () => {
    const next = new Set(skipped).add(current);
    setSkipped(next);
    go(nextInQueue(queue, current, (id) => isLeft(id, next)));
  };
  const next = () => go(nextInQueue(queue, current, (id) => isLeft(id)) ?? current);
  const prev = () => go(previousInQueue(queue, current, (id) => isLeft(id)) ?? current);

  const position = queue && current ? queue.indexOf(current) + 1 : 0;
  const left = queue ? queue.filter((id) => isLeft(id)).length : 0;
  const finishedAll = queue && !current;
  return (
    <>
      <PageHeader
        title="Focus"
        subtitle={queue ? (queue.length ? `${left} of today’s ${queue.length} left${skipped.size ? ` · ${skipped.size} skipped` : ''}` : 'Nothing on today') : ' '}
        actions={<Button onClick={() => navigate('/')}><Icon name="back" size={18} />Today</Button>}
      />
      {!data || !queue ? (
        <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
      ) : finishedAll || !task ? (
        <Card>
          <EmptyState title={queue.length ? 'That’s today’s list done' : 'Nothing on today'}>
            {skipped.size ? (
              <button type="button" className="crm-link-button" onClick={() => { const s = new Set(); setSkipped(s); go(queue.find((id) => isLeft(id, s)) ?? null); }}>
                Go back to the {skipped.size} skipped
              </button>
            ) : <Link to="/">Back to Today</Link>}
          </EmptyState>
        </Card>
      ) : (
        <div className="planner-focus" data-testid="focus" data-task-id={task.id}>
          <Card>
            <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
              <span style={muted} data-testid="focus-position">{position} of {queue.length}</span>
              <h2 className="planner-focus-title" data-testid="focus-title" style={{ textDecoration: task.done_at ? 'line-through' : 'none' }}>{task.title}</h2>
              <div className="planner-task-meta" style={{ marginTop: 0 }}>
                {task.due_date ? (
                  <span style={{ color: dueState(task, today) === 'overdue' ? 'var(--danger)' : undefined }}>
                    {dueState(task, today) === 'overdue' ? 'Overdue · ' : ''}{dueLabel(task, today)}
                  </span>
                ) : null}
                <span><Icon name="clock" size={13} style={{ verticalAlign: '-2px' }} /> {task.estimate_minutes ? formatMinutes(task.estimate_minutes) : 'No estimate'}</span>
                <OwnerBadge owner={task.owner} me={me} />
                <BusinessChip business={data.businessesById.get(task.business_id)} short />
                {task.goal_id && data.goalsById.get(task.goal_id) ? <span><Icon name="target" size={13} style={{ verticalAlign: '-2px' }} /> {data.goalsById.get(task.goal_id).title}</span> : null}
              </div>
              {task.notes ? <p style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} data-testid="focus-notes">{task.notes}</p> : <p style={{ ...muted, margin: 0 }}>No notes.</p>}
              {task.done_at ? <Notice tone="ok">Done.</Notice> : null}
              {skipped.has(task.id) ? <Notice tone="info">Skipped for now.</Notice> : null}
              <div className="planner-focus-actions">
                <Button variant="primary" disabled={busy || Boolean(task.done_at)} onClick={done}><Icon name="check" size={18} />Done</Button>
                <Button disabled={busy} onClick={skip}>Skip</Button>
                <Button disabled={busy} onClick={next}>Next<Icon name="chevron" size={16} /></Button>
              </div>
              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <button type="button" className="crm-link-button" onClick={prev}>Previous</button>
                <button type="button" className="crm-link-button" onClick={() => setEditing(true)}>Edit task</button>
              </div>
              {error ? <Notice tone="danger">{error}</Notice> : null}
            </div>
          </Card>
          {task.client_id ? <ClientPanel clientId={task.client_id} /> : null}
        </div>
      )}
      {editing && task ? <TaskSheet record={task} onClose={() => setEditing(false)} onDone={() => setEditing(false)} onDeleted={() => { setEditing(false); next(); }} /> : null}
    </>
  );
}
