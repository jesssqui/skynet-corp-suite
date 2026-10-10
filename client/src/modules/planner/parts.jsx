// Pieces the planner screens (and the client page) share: the owner badge, the tick, a task row,
// and the capture field. Every write goes through the offline store, so all of it works offline.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Icon } from '../../ui/index.js';
import { localDate, nowIso } from '../../ui/format.js';
import { store } from '../../sync/index.js';
import { SyncBadges } from '../../sync/components.jsx';
import { BusinessChip, useAction } from '../crm/parts.jsx';
import { captureFields, saveCapture, dueLabel, dueState, formatMinutes, isTop, ownerLabel } from './logic.js';
import { isPhone, keepFinished } from './prefs.js';
import './planner.css';

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

/** Whose task it is, from the viewer's side: You / Partner / Shared. */
export function OwnerBadge({ owner, me }) {
  const label = ownerLabel(owner, me);
  const tone = label === 'You' ? 'accent' : label === 'Shared' ? 'ok' : 'neutral';
  return <span data-owner-badge={owner}><Badge tone={tone}>{label === 'Partner' ? 'Partner’s' : label}</Badge></span>;
}

/** Finish a task (done_at = now; it stays shown this session so the tick can be undone) or reopen it. */
export async function toggleDone(task) {
  if (task.done_at) {
    await store.update('task', task.id, { done_at: null });
  } else {
    keepFinished(task.id);
    await store.update('task', task.id, { done_at: nowIso() });
  }
}

/** The round tick, a full tap target. */
export function TaskTick({ task, onError }) {
  const done = Boolean(task.done_at);
  const { busy, run } = useAction();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Not done: ${task.title}` : `Done: ${task.title}`}
      className={`planner-tick${done ? ' done' : ''}`}
      disabled={busy}
      onClick={async () => {
        const ok = await run(() => toggleDone(task));
        if (!ok) onError?.('Couldn’t save that tick. Try again.');
      }}
    >
      <span className="planner-tick-circle" aria-hidden="true">{done ? <Icon name="check" size={16} /> : null}</span>
    </button>
  );
}

/**
 * One task in a list: tick, title (opens it), and a line with its due day, owner, business,
 * client (a deleted client is named as such), estimate, its goal (C4b) and whether it's one of
 * today's top 3.
 */
export function TaskRow({ task, me, today, businessesById, clientsById, accountsById, goalsById, leadsById = null, onOpen, showClient = true, showOwner = true, actions = null }) {
  const [error, setError] = useState(null);
  const state = dueState(task, today);
  const due = dueLabel(task, today);
  const business = businessesById?.get(task.business_id);
  const client = task.client_id ? clientsById?.get(task.client_id) : null;
  const account = task.account_id ? accountsById?.get(task.account_id) : null;
  const goal = task.goal_id ? goalsById?.get(task.goal_id) : null;
  const lead = task.lead_id ? leadsById?.get(task.lead_id) : null; // D8
  const done = Boolean(task.done_at);
  return (
    <li className={`planner-task${done ? ' done' : ''}`} data-task-id={task.id} data-owner={task.owner}>
      <TaskTick task={task} onError={setError} />
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <button type="button" className="planner-task-title" onClick={() => onOpen?.(task)}>
          {isTop(task, today, me) ? <Icon name="star" size={15} title="One of today’s top 3" style={{ fill: 'currentColor', color: 'var(--warn)' }} /> : null}
          <span>{task.title}</span>
        </button>
        <div className="planner-task-meta">
          {due ? (
            <span style={{ color: state === 'overdue' && !done ? 'var(--danger)' : 'var(--text-muted)', fontWeight: state === 'overdue' && !done ? 600 : 400 }}>
              {state === 'overdue' && !done ? `Overdue · ${due}` : due}
            </span>
          ) : null}
          {showOwner ? <OwnerBadge owner={task.owner} me={me} /> : null}
          {business ? <BusinessChip business={business} short /> : null}
          {showClient && task.client_id ? (
            client ? (
              <Link to={`/crm/clients/${client.id}`} className="planner-client-link">{client.name}{account ? ` · ${account.name}` : ''}</Link>
            ) : <span style={{ fontStyle: 'italic' }}>Deleted client</span>
          ) : null}
          {!showClient && account ? <span>{account.name}</span> : null}
          {lead ? <Link to={`/crm/leads/${lead.id}`} className="planner-client-link" data-testid="task-lead">Lead: {lead.name}</Link> : null}
          {task.estimate_minutes ? <span><Icon name="clock" size={13} style={{ verticalAlign: '-2px' }} /> {formatMinutes(task.estimate_minutes)}</span> : null}
          {goal ? (
            <span className="planner-goal-tag" title={goal.kind === 'month' ? 'Month priority' : 'Week goal'}>
              <Icon name="target" size={13} style={{ verticalAlign: '-2px' }} /> {goal.title}
            </span>
          ) : null}
          <SyncBadges record={task} />
        </div>
        {actions ? <div className="planner-row-actions">{actions(task)}</div> : null}
        {error ? <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-xs)' }}>{error}</span> : null}
      </div>
    </li>
  );
}

/** A list of task rows (or nothing). */
export function TaskList({ tasks, testId, ...rowProps }) {
  if (!tasks.length) return null;
  return (
    <ul className="planner-task-list" data-testid={testId}>
      {tasks.map((t) => <TaskRow key={t.id} task={t} {...rowProps} />)}
    </ul>
  );
}

export const PAGE = 50;

/** "Show N more" under a long list (adds `step` rows each time). */
export function ShowMore({ shown, total, onMore, step = PAGE, testId }) {
  if (total <= shown) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
      <Button onClick={onMore} data-testid={testId}>Show {Math.min(step, total - shown)} more</Button>
      <span style={muted}>{shown} of {total}</span>
    </div>
  );
}

/** A task list shown 50 at a time (Today's sections can hold hundreds at scale). */
export function PagedTaskList({ tasks, testId, ...rowProps }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <TaskList tasks={tasks.slice(0, shown)} testId={testId} {...rowProps} />
      <ShowMore shown={shown} total={tasks.length} onMore={() => setShown((n) => n + PAGE)} testId={testId ? `${testId}-more` : undefined} />
    </>
  );
}

/**
 * Capture anything into the inbox: one field and Add, saved on this device at once (offline too).
 * On phones it sits above the tab bar (planner.css), so it is in reach from Today and Inbox.
 */
export function CaptureBar({ inboxCount = null }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(null);
  const { busy, error, run } = useAction();
  const submit = async (e) => {
    e.preventDefault();
    const fields = captureFields(text, { source: isPhone() ? 'phone' : 'typed', now: nowIso() });
    if (!fields || busy) return;
    // Cleared before the save, so what is typed while it saves is kept (saveCapture).
    if (await run(() => saveCapture(text, { setText, save: () => store.create('inbox_item', fields) }))) setSaved(fields.text);
  };
  return (
    <form className="planner-capture" onSubmit={submit} aria-label="Capture to the inbox" data-testid="capture">
      <div className="planner-capture-row">
        <input
          type="text"
          aria-label="Capture"
          placeholder="Capture a task, a note, an idea…"
          value={text}
          onChange={(e) => { setText(e.target.value); setSaved(null); }}
          enterKeyHint="send"
          maxLength={5000}
          autoComplete="off"
        />
        <Button variant="primary" type="submit" disabled={busy || !text.trim()} style={{ flexShrink: 0 }}>
          <Icon name="plus" size={18} />Add
        </Button>
      </div>
      <div aria-live="polite" className="planner-capture-note">
        {error ? <span style={{ color: 'var(--danger)' }}>{error}</span> : saved ? (
          <span>Saved to the inbox{inboxCount !== null ? <> · <Link to="/inbox">{inboxCount} to sort</Link></> : null}</span>
        ) : null}
      </div>
    </form>
  );
}

/** Room at the end of a page for the phone's fixed capture field (nothing on wider screens). */
export function CaptureSpacer() {
  return <div className="planner-capture-spacer" aria-hidden="true" />;
}

export { muted };

/**
 * The device's local date, kept current: re-read when the app comes back to the foreground and
 * every minute (a page left open overnight moves to the new day).
 */
export function useToday() {
  const [today, setToday] = useState(() => localDate());
  useEffect(() => {
    const check = () => setToday(localDate());
    const timer = setInterval(check, 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return today;
}
