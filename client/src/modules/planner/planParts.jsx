// Planning pieces (C4b) the pages share: the Week / Month / Review tabs, a meter, the day's load
// with what to push (Today, Plan my day, the Monday plan's days), and the "To sort" list where a
// task is given a day or a goal in one or two taps. Every write goes through the offline store.
import { useMemo, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Button, Card, Icon, Notice, SelectField, TextField } from '../../ui/index.js';
import { store } from '../../sync/index.js';
import { BusinessChip, useAction } from '../crm/parts.jsx';
import { formatMinutes, shortDay, addDays } from './logic.js';
import { dayLoad, pushSuggestions, pushChange, goalChange, businessMismatch, quickDays, goalChoices } from './plan.js';
import { OwnerBadge, ShowMore, PAGE, muted } from './parts.jsx';

/** Week / Month / Review: the planning pages' own tabs. */
export function PlanTabs() {
  const tabs = [['/plan/week', 'Week'], ['/plan/month', 'Month'], ['/plan/review', 'Friday review']];
  return (
    <nav className="planner-plan-tabs" aria-label="Plans">
      {tabs.map(([to, label]) => (
        <NavLink key={to} to={to} className={({ isActive }) => `planner-plan-tab${isActive ? ' active' : ''}`}>{label}</NavLink>
      ))}
    </nav>
  );
}

/** A thin bar: value against max (amber when over). */
export function Meter({ value, max, over = false, label }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={`planner-meter${over ? ' over' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "Today", or "Thu, Oct 8". */
export function dayName(day, today) {
  if (day === today) return 'Today';
  if (day === addDays(today, 1)) return 'Tomorrow';
  return shortDay(day);
}

/** Read the latest copy before a change (a star or move just before must not be undone). */
const latest = async (task) => (await store.get('task', task.id)) ?? task;

/**
 * One day's load for `me` against their day length, and — when it is overbooked — what to push, in
 * order (pushSuggestions), each with a one-tap "Move to <next day with room>". Moved tasks stay
 * listed with Undo. Tasks without an estimate count 0 and are listed as such.
 * Shows nothing when the day fits and nothing was moved, unless `always`.
 */
export function DayLoadPanel({ tasks, me, today, day = today, dayMinutes, goalsById, always = false, testId = 'day-load', heading = true, framed = false }) {
  const load = useMemo(() => dayLoad(tasks, { me, today, day, dayMinutes }), [tasks, me, today, day, dayMinutes]);
  const suggestions = useMemo(
    () => (load.over ? pushSuggestions({ tasks, me, today, day, dayMinutes, goalsById }) : []),
    [load, tasks, me, today, day, dayMinutes, goalsById],
  );
  const [moved, setMoved] = useState(() => new Map()); // id -> { task, to, undo }
  const { busy, error, run } = useAction();
  if (!load.over && !moved.size && !always) return null;

  const move = (task, to) => run(async () => {
    const { change, undo } = pushChange(await latest(task), to, today, me);
    await store.update('task', task.id, change);
    setMoved((m) => new Map(m).set(task.id, { task, to, undo }));
  });
  const undo = (id) => run(async () => {
    await store.update('task', id, moved.get(id).undo);
    setMoved((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  });
  const name = dayName(day, today);
  const panel = (
    <div className="planner-load" data-testid={testId} data-over={load.over ? 'true' : 'false'} data-day={day}>
      {heading ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <strong data-testid={`${testId}-summary`}>
            {name}: {formatMinutes(load.minutes)} of {formatMinutes(dayMinutes)}
          </strong>
          {load.over ? (
            <span style={{ color: 'var(--warn)', fontWeight: 600, fontSize: 'var(--text-sm)' }} data-testid={`${testId}-over`}>
              <Icon name="alert" size={15} style={{ verticalAlign: '-3px' }} /> Overbooked by {formatMinutes(load.excess)}
            </span>
          ) : moved.size ? <span style={{ color: 'var(--ok)', fontWeight: 600, fontSize: 'var(--text-sm)' }} data-testid={`${testId}-fits`}>Fits now</span> : null}
        </div>
      ) : null}
      <Meter value={load.minutes} max={dayMinutes} over={load.over} label={`${name}’s planned time`} />
      {suggestions.length ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={muted}>To make it fit, move:</span>
          <ul className="planner-suggestions" data-testid={`${testId}-suggestions`}>
            {suggestions.map(({ task, to }) => (
              <li key={task.id} data-suggest-task={task.id}>
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <span style={{ fontWeight: 600 }}>{task.title}</span>
                  <span style={muted}> · {formatMinutes(task.estimate_minutes)}</span>
                </span>
                <Button disabled={busy} onClick={() => move(task, to)} aria-label={`Move “${task.title}” to ${shortDay(to)}`}>
                  <Icon name="arrowRight" size={16} />Move to {dayName(to, today)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {moved.size ? (
        <ul className="planner-suggestions" data-testid={`${testId}-moved`}>
          {[...moved.values()].map(({ task, to }) => (
            <li key={task.id} data-moved-task={task.id}>
              <span style={{ ...muted, minWidth: 0, overflowWrap: 'anywhere' }}>{task.title} → moved to {dayName(to, today)}</span>
              <Button variant="ghost" disabled={busy} onClick={() => undo(task.id)}>Undo</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {load.unestimated.length ? (
        <p style={{ ...muted, margin: 0 }} data-testid={`${testId}-unestimated`}>
          No estimate (counted as 0): {load.unestimated.slice(0, 5).map((t) => t.title).join(', ')}
          {load.unestimated.length > 5 ? ` and ${load.unestimated.length - 5} more` : ''}.
        </p>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
  return framed ? <Card>{panel}</Card> : panel;
}

/** One task to sort: quick days (one tap), another day + "Move there" (typed or picked), or a goal (two taps). */
function SortRow({ task, data, me, today, days, choices, busy, apply }) {
  const [day, setDay] = useState('');
  return (
    <li className="planner-sort-row" data-sort-task={task.id}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{task.title}</span>
        <OwnerBadge owner={task.owner} me={me} />
        <BusinessChip business={data.businessesById.get(task.business_id)} short />
        {task.estimate_minutes ? <span style={muted}>{formatMinutes(task.estimate_minutes)}</span> : null}
        {task.goal_id && data.goalsById.get(task.goal_id) ? (
          <span style={muted} data-testid="stale-goal">
            Was part of {data.goalsById.get(task.goal_id).done_at ? '✓ ' : ''}“{data.goalsById.get(task.goal_id).title}” (an earlier {data.goalsById.get(task.goal_id).kind === 'month' ? 'month' : 'week'})
          </span>
        ) : null}
      </div>
      <div className="planner-sort-actions">
        {days.map((d) => (
          <Button key={d.label} disabled={busy} onClick={() => apply(task, { due_date: d.day }, d.label === 'Today' ? 'today' : d.label === 'Tomorrow' ? 'tomorrow' : shortDay(d.day))} aria-label={`${d.label}: ${task.title}`}>
            {d.label}
          </Button>
        ))}
        <TextField
          id={`sort-day-${task.id}`}
          label="Another day"
          type="date"
          min={today}
          value={day}
          onChange={(e) => setDay(e.target.value)}
          style={{ flex: '1 1 140px' }}
        />
        <Button disabled={busy || !day || day < today} onClick={() => apply(task, { due_date: day }, shortDay(day))} aria-label={`Move there: ${task.title}`}>
          Move there
        </Button>
        <SelectField
          id={`sort-goal-${task.id}`}
          label="Or a goal"
          value=""
          disabled={busy || !choices.length}
          onChange={(id) => {
            const goal = data.goalsById.get(id);
            if (goal) apply(task, goalChange(task, goal), `goal “${goal.title}”`, goal);
          }}
          options={[{ value: '', label: choices.length ? 'Choose a goal…' : 'No goals this week or month yet' }, ...choices]}
          style={{ flex: '2 1 220px' }}
        />
      </div>
    </li>
  );
}

/**
 * The "To sort" list: open tasks with no day and no current goal. Each gets a day (Today /
 * Tomorrow / Monday: one tap; another day: pick or type it, then Move there) or a goal (pick from
 * the list: two taps). Filing under a goal never changes the task's business; when it differs,
 * the sorted line offers "Use <the goal's business>". A sorted task leaves the list; the last few
 * stay listed with Undo.
 */
export function SortList({ tasks, data, me, today, testId = 'to-sort' }) {
  const [shown, setShown] = useState(PAGE);
  const [sorted, setSorted] = useState([]); // [{ task, label, undo, useBusiness }] newest first
  const { busy, error, run } = useAction();
  const choices = useMemo(
    () => goalChoices(data.goals, { today, businessesById: data.businessesById }),
    [data.goals, data.businessesById, today],
  );
  const days = quickDays(today);
  const apply = (task, change, label, goal = null) => run(async () => {
    const cur = await latest(task);
    const undo = Object.fromEntries(Object.keys(change).map((k) => [k, cur[k] ?? null]));
    await store.update('task', task.id, change);
    const useBusiness = businessMismatch(cur, goal);
    setSorted((s) => [{ task, label, undo, useBusiness }, ...s.filter((x) => x.task.id !== task.id)].slice(0, 5));
  });
  const undo = (entry) => run(async () => {
    await store.update('task', entry.task.id, entry.undo);
    setSorted((s) => s.filter((x) => x !== entry));
  });
  const useBusiness = (entry) => run(async () => {
    const cur = await latest(entry.task);
    await store.update('task', entry.task.id, { business_id: entry.useBusiness });
    setSorted((s) => s.map((x) => (x === entry ? { ...x, useBusiness: null, undo: { ...x.undo, business_id: cur.business_id ?? null } } : x)));
  });
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      {sorted.length ? (
        <ul className="planner-suggestions" data-testid={`${testId}-sorted`}>
          {sorted.map((entry) => (
            <li key={entry.task.id}>
              <span style={{ ...muted, minWidth: 0, overflowWrap: 'anywhere' }}>
                {entry.task.title} → {entry.label}
                {entry.useBusiness ? <span data-testid="goal-business-note"> · Different business from the goal</span> : null}
              </span>
              {entry.useBusiness ? (
                <Button disabled={busy} onClick={() => useBusiness(entry)}>Use {data.businessesById.get(entry.useBusiness)?.name ?? 'its business'}</Button>
              ) : null}
              <Button variant="ghost" disabled={busy} onClick={() => undo(entry)}>Undo</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {tasks.length ? (
        <ul className="planner-sort-list" data-testid={testId}>
          {tasks.slice(0, shown).map((task) => (
            <SortRow key={task.id} task={task} data={data} me={me} today={today} days={days} choices={choices} busy={busy} apply={apply} />
          ))}
        </ul>
      ) : (
        <p style={{ ...muted, margin: 0 }} data-testid={`${testId}-empty`}>Nothing to sort: every open task has a day or a goal.</p>
      )}
      <ShowMore shown={shown} total={tasks.length} onMore={() => setShown((n) => n + PAGE)} testId={`${testId}-more`} />
    </div>
  );
}
