// "Plan my day" (the morning plan): what's overdue, due today and my undated tasks for this week's
// goals and this month's priorities; pick up to three as today's top, move what won't fit to a
// named day. The day's load is measured against the person's day length (their workday record,
// changed here) and an overbooked day lists what to push, each with a one-tap move (C4b). Tasks
// with no day and no goal aren't proposed: they are counted, with a link to sort them. Each tap
// is saved at once through the offline store (one or two fields), so nothing is lost if the sheet
// is closed; moved tasks stay listed with an Undo.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WORKDAY_IDS } from '@suite/shared/planner';
import { Sheet, Button, Icon, Notice, TextField, SelectField } from '../../ui/index.js';
import { store } from '../../sync/index.js';
import { TextButton, useAction } from '../crm/parts.jsx';
import {
  proposePlan, topChange, moveChange, isTop, countTop, addDays, shortDay, dueLabel,
  formatMinutes, TOP_LIMIT,
} from './logic.js';
import { dayMinutesFor } from './plan.js';
import { OwnerBadge } from './parts.jsx';
import { DayLoadPanel } from './planParts.jsx';

/** Day lengths to choose from: 2 h to 14 h in half hours, plus the current one. */
function dayLengthOptions(current) {
  const values = new Set([current]);
  for (let m = 120; m <= 14 * 60; m += 30) values.add(m);
  return [...values].sort((a, b) => a - b).map((m) => ({ value: String(m), label: formatMinutes(m) }));
}

/** "Your day: 8 h · Change" — each person's own day length, synced (their workday record). */
function DayLength({ me, minutes }) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'end', flexWrap: 'wrap' }} data-testid="day-length">
      {editing ? (
        <SelectField
          id="day-length"
          label="Your day length"
          value={String(minutes)}
          disabled={busy}
          onChange={async (v) => {
            if (await run(() => store.update('workday', WORKDAY_IDS[me], { day_minutes: Number(v) }))) setEditing(false);
          }}
          options={dayLengthOptions(minutes)}
          style={{ flex: '1 1 160px' }}
        />
      ) : (
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          Your day: {formatMinutes(minutes)}
          <TextButton onClick={() => setEditing(true)} aria-label="Change your day length">Change</TextButton>
        </span>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

const muted = { color: 'var(--text-muted)', fontSize: 'var(--text-sm)' };

function PlanRow({ task, me, today, topCount, moved, moving, onTop, onMove, onUndo, setMoving }) {
  const [day, setDay] = useState(addDays(today, 2));
  const top = isTop(task, today, me);
  const due = dueLabel(task, today);
  const meta = [
    due && task.due_date < today ? `Overdue · ${due}` : due,
    task.estimate_minutes ? formatMinutes(task.estimate_minutes) : null,
  ].filter(Boolean).join(' · ');
  if (moved) {
    return (
      <li className="planner-plan-row" data-plan-task={task.id} data-moved-to={moved.day}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflowWrap: 'anywhere', color: 'var(--text-muted)' }}>{task.title}</div>
          <div style={muted}><Icon name="arrowRight" size={14} style={{ verticalAlign: '-2px' }} /> Moved to {moved.label}</div>
        </div>
        <Button variant="ghost" onClick={() => onUndo(task)}>Undo</Button>
      </li>
    );
  }
  return (
    <li className="planner-plan-row" data-plan-task={task.id}>
      <div style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <div style={{ fontWeight: 600, overflowWrap: 'anywhere', textDecoration: task.done_at ? 'line-through' : 'none' }}>{task.title}</div>
        <div style={{ ...muted, display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          {meta ? <span style={{ color: task.due_date && task.due_date < today ? 'var(--danger)' : undefined }}>{meta}</span> : <span>No date</span>}
          <OwnerBadge owner={task.owner} me={me} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="planner-star"
          aria-pressed={top}
          aria-label={top ? `Unpick from today’s top 3: ${task.title}` : `Pick for today’s top 3: ${task.title}`}
          title={!top && topCount >= TOP_LIMIT ? 'Three are picked: unpick one first' : 'Today’s top 3'}
          disabled={!top && topCount >= TOP_LIMIT}
          onClick={() => onTop(task, !top)}
        >
          <Icon name="star" size={20} />
        </button>
        <Button onClick={() => setMoving(moving ? null : task.id)} aria-expanded={moving} aria-label={`Move to another day: ${task.title}`}>Move</Button>
      </div>
      {moving ? (
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'end' }} data-testid="move-chooser">
          {task.due_date !== today ? <Button onClick={() => onMove(task, today)}>Today</Button> : null}
          <Button variant="primary" onClick={() => onMove(task, addDays(today, 1))}>Tomorrow</Button>
          <TextField id={`move-${task.id}`} label="Another day" type="date" min={addDays(today, 1)} value={day} onChange={(e) => setDay(e.target.value)} style={{ flex: '1 1 150px' }} />
          <Button disabled={!day || day <= today} onClick={() => onMove(task, day)}>Move there</Button>
        </div>
      ) : null}
    </li>
  );
}

export default function PlanSheet({ data, me, today, inboxCount, onClose }) {
  // The proposal is taken once, when the sheet opens: rows stay put while tasks are moved.
  const [proposal] = useState(() => proposePlan({ tasks: data.tasks, me, today, goalsById: data.goalsById }));
  const [moved, setMoved] = useState(() => new Map()); // id -> { day, label, undo }
  const [moving, setMoving] = useState(null);
  const { error, run } = useAction();
  const tasksById = useMemo(() => new Map(data.tasks.map((t) => [t.id, t])), [data.tasks]);
  const dayMinutes = dayMinutesFor(data.workdays, me);
  const topCount = useMemo(() => countTop(data.tasks, me, today), [data.tasks, me, today]);

  // Changes are worked out from the latest record (store.get), not this render's copy: a star
  // tapped just before Move must be cleared by the move.
  const latest = async (task) => (await store.get('task', task.id)) ?? task;
  const onTop = (task, on) => run(async () => store.update('task', task.id, topChange(await latest(task), today, on, me)));
  const onMove = (task, day) => run(async () => {
    const { change, undo } = moveChange(await latest(task), day, today, me);
    await store.update('task', task.id, change);
    const label = day === today ? 'today' : day === addDays(today, 1) ? `tomorrow (${shortDay(day)})` : shortDay(day);
    setMoved((m) => new Map(m).set(task.id, { day, label, undo }));
    setMoving(null);
  });
  const onUndo = (task) => run(async () => {
    await store.update('task', task.id, moved.get(task.id).undo);
    setMoved((m) => {
      const next = new Map(m);
      next.delete(task.id);
      return next;
    });
  });

  const sections = [
    ['Overdue', proposal.overdue],
    ['Due today', proposal.dueToday],
    ['For this week’s goals and this month’s priorities', proposal.forGoals],
  ].map(([label, ids]) => [label, ids.map((id) => tasksById.get(id)).filter(Boolean)]).filter(([, rows]) => rows.length);

  return (
    <Sheet
      title="Plan my day"
      onClose={onClose}
      testId="plan-sheet"
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid="plan-load">
        <DayLoadPanel tasks={data.tasks} me={me} today={today} dayMinutes={dayMinutes} goalsById={data.goalsById} always testId="plan-day" />
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
          <DayLength me={me} minutes={dayMinutes} />
          <span style={muted} data-testid="top-count">Top 3: {topCount} of {TOP_LIMIT} picked</span>
        </div>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {sections.length ? sections.map(([label, rows]) => (
        <section key={label} style={{ display: 'grid', gap: 'var(--space-1)' }}>
          <h3 style={{ ...muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 }}>{label}</h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((t) => (
              <PlanRow
                key={t.id}
                task={t}
                me={me}
                today={today}
                topCount={topCount}
                moved={moved.get(t.id)}
                moving={moving === t.id}
                setMoving={setMoving}
                onTop={onTop}
                onMove={onMove}
                onUndo={onUndo}
              />
            ))}
          </ul>
        </section>
      )) : <p style={{ ...muted, margin: 0 }}>Nothing overdue, due today or waiting on this week’s goals. Capture something, or add a task.</p>}
      {proposal.toSort ? (
        <Link to="/plan/week?sort=1" className="planner-link-row" data-testid="plan-to-sort">
          <Icon name="flag" size={18} /> {proposal.toSort} with no day or goal to sort <Icon name="chevron" size={16} />
        </Link>
      ) : null}
      {inboxCount ? (
        <Link to="/inbox" className="planner-link-row">
          <Icon name="inbox" size={18} /> {inboxCount} in the inbox to sort first <Icon name="chevron" size={16} />
        </Link>
      ) : null}
    </Sheet>
  );
}
