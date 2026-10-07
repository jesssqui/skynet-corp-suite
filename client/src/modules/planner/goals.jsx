// Week goals and month priorities on screen (C4b): the add/edit sheet, a goal with its progress,
// order and tasks, and the "carry over" list. Writes go through the offline store; an edit sends
// only what changed (goalForm.js), so the other person's change made meanwhile survives.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Icon, Notice, SelectField, Segmented, TextAreaField, TextField, CheckboxField } from '../../ui/index.js';
import { nowIso } from '../../ui/format.js';
import { store, useRecord } from '../../sync/index.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessChip, FormSheet, RecordSync, TextButton, useAction } from '../crm/parts.jsx';
import { SyncBadges } from '../../sync/components.jsx';
import { pickableBusinesses } from '../crm/logic.js';
import { goalForm, goalValues, editChanges, isDirty } from './goalForm.js';
import { goalOwner, goalProgress, reorderChanges, nextPosition, carryFields, carryTaskMoves, carriedTwice, MONTH_PRIORITY_LIMIT } from './plan.js';
import { compareDue, isOpenTask, otherActor } from './logic.js';
import { OwnerBadge, TaskList, muted } from './parts.jsx';
import { Meter } from './planParts.jsx';
import { useFinishedThisSession } from './prefs.js';

const KIND_WORD = { week: 'goal', month: 'priority' };

/**
 * Add or edit a week goal / month priority. New ones: `initial` = { kind, period, business_id };
 * `siblings` = the business's goals of that period (its position, and the three-a-month warning).
 * Changing a goal's business leaves its tasks alone (their business is their own; each task shows
 * "Different business from the goal" in its sheet).
 */
export function GoalSheet({ record = null, initial = {}, siblings = [], businesses = [], onClose, onDone }) {
  const { session } = useAuth();
  const me = session?.user?.actor ?? 'owner';
  const kind = record?.kind ?? initial.kind ?? 'week';
  const [start] = useState(() => goalValues(record, { owner: me, ...initial }));
  const [v, setV] = useState(start);
  const [problems, setProblems] = useState({});
  const { busy, error, run } = useAction();
  const live = useRecord('goal', record?.id ?? null).record;
  const set = (k) => (e) => {
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setV((cur) => ({ ...cur, [k]: value }));
  };
  const others = siblings.filter((g) => g.id !== record?.id && g.business_id === v.business_id);
  const overLimit = kind === 'month' && !record && others.length >= MONTH_PRIORITY_LIMIT;

  const save = async () => {
    const r = record ? editChanges(goalForm, start, v) : goalForm.toFields(v);
    setProblems(r.problems);
    if (Object.keys(r.problems).length) return;
    const ok = await run(async () => {
      if (record) {
        if (Object.keys(r.fields).length) await store.update('goal', record.id, r.fields);
      } else {
        await store.create('goal', { ...r.fields, kind, period: initial.period, position: nextPosition(others), carried_from: null });
      }
    });
    if (ok) onDone?.();
  };
  const remove = record ? async () => {
    if (await run(() => store.remove('goal', record.id))) onClose();
  } : null;
  const other = otherActor(me);
  const word = KIND_WORD[kind];
  return (
    <FormSheet
      title={record ? `Edit ${word}` : kind === 'month' ? 'New month priority' : 'New week goal'}
      testId="goal-form"
      onClose={onClose}
      dirty={isDirty(start, v)}
      busy={busy}
      error={error}
      onSave={save}
      onDelete={remove}
      deleteWarning={`Delete this ${word}? Its tasks stay (they go back to “To sort” unless they have a day). To finish it, tick it instead.`}
    >
      {live ? <RecordSync record={live} what={word} /> : null}
      <TextField
        id="goal-title"
        label={kind === 'month' ? 'Priority' : 'Goal'}
        value={v.title}
        onChange={set('title')}
        autoFocus={!record}
        maxLength={300}
        error={problems.title}
        placeholder={kind === 'month' ? 'e.g. Sign two new retainers' : 'e.g. Follow up 5 quiet customers'}
      />
      <SelectField
        id="goal-business"
        label="Our business"
        value={v.business_id}
        onChange={set('business_id')}
        error={problems.business_id}
        options={[{ value: '', label: 'Choose…' }, ...pickableBusinesses(businesses, v.business_id || null).map((b) => ({ value: b.id, label: b.name }))]}
      />
      {overLimit ? (
        <Notice tone="warn">
          <span data-testid="priority-limit">That makes {others.length + 1} priorities for this business this month. One to three works best.</span>
        </Notice>
      ) : null}
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Whose</span>
        <Segmented
          label="Whose"
          value={v.owner || 'shared'}
          onChange={set('owner')}
          options={[{ value: me, label: 'Mine' }, { value: other, label: 'Partner’s' }, { value: 'shared', label: 'Shared' }]}
        />
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
        <TextField id="goal-target" label="Target (optional)" inputMode="decimal" value={v.target} onChange={set('target')} error={problems.target} hint="e.g. 5 customers" />
        <TextField id="goal-progress" label="Progress so far" inputMode="decimal" value={v.progress} onChange={set('progress')} error={problems.progress} />
      </div>
      <TextAreaField id="goal-notes" label="Notes (optional)" value={v.notes} onChange={set('notes')} rows={2} />
      {record ? <CheckboxField id="goal-done" label="Done" checked={v.done} onChange={set('done')} /> : null}
    </FormSheet>
  );
}

/** The goal's done tick (one tap; the Friday review marks this week's goals with it). */
export function GoalTick({ goal }) {
  const { busy, error, run } = useAction();
  const done = Boolean(goal.done_at);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? `Not done: ${goal.title}` : `Done: ${goal.title}`}
      className={`planner-tick${done ? ' done' : ''}`}
      disabled={busy}
      title={error ?? undefined}
      onClick={() => run(() => store.update('goal', goal.id, { done_at: done ? null : nowIso() }))}
    >
      <span className="planner-tick-circle" aria-hidden="true">{done ? <Icon name="check" size={16} /> : null}</span>
    </button>
  );
}

const SHOWN_TASKS = 5;

/**
 * One goal: tick, title (edit), whose, progress against its target (+1 in one tap), order (up /
 * down within its business), and the tasks hanging off it with "Add task" pre-filled.
 * @param {{ goal, siblings, data, me, today, onEdit, onAddTask, onOpenTask, compact? }} props
 */
export function GoalItem({ goal, siblings, data, me, today, onEdit, onAddTask, onOpenTask, compact = false }) {
  const { busy, error, run } = useAction();
  const { keep, version } = useFinishedThisSession();
  const progress = goalProgress(goal);
  const all = data.tasksByGoal.get(goal.id) ?? [];
  const open = useMemo(() => all.filter((t) => isOpenTask(t) || keep.has(t.id)).sort(compareDue), [all, keep, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneCount = all.filter((t) => !isOpenTask(t)).length;
  const index = siblings.findIndex((g) => g.id === goal.id);
  const reorder = (dir) => run(async () => {
    for (const c of reorderChanges(siblings, goal.id, dir)) await store.update('goal', c.id, { position: c.position });
  });
  const bump = () => run(async () => {
    const cur = (await store.get('goal', goal.id)) ?? goal;
    await store.update('goal', goal.id, { progress: (Number.isFinite(cur.progress) ? cur.progress : 0) + 1 });
  });
  const word = KIND_WORD[goal.kind];
  return (
    <li className={`planner-goal${goal.done_at ? ' done' : ''}`} data-goal-id={goal.id} data-kind={goal.kind}>
      <GoalTick goal={goal} />
      <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <button type="button" className="planner-task-title" onClick={() => onEdit(goal)} aria-label={`Edit ${word}: ${goal.title}`}>
          <span>{goal.title}</span>
        </button>
        <div className="planner-task-meta">
          <OwnerBadge owner={goalOwner(goal)} me={me} />
          {progress.label ? <span data-testid="goal-progress">{progress.label}</span> : null}
          {goal.carried_from ? <span title="Carried over from the period before">Carried over</span> : null}
          <span>{open.length ? `${open.length} open ${open.length === 1 ? 'task' : 'tasks'}` : 'No open tasks'}{doneCount ? ` · ${doneCount} done` : ''}</span>
          <SyncBadges record={goal} />
        </div>
        {progress.pct !== null ? <Meter value={progress.progress} max={progress.target} label={`Progress: ${goal.title}`} /> : null}
        <div className="planner-goal-actions">
          <TextButton onClick={() => onAddTask(goal)} aria-label={`Add a task to ${goal.title}`}><Icon name="plus" size={14} />Task</TextButton>
          {progress.target !== null ? <TextButton disabled={busy} onClick={bump} aria-label={`Add 1 to the progress of ${goal.title}`}>+1</TextButton> : null}
          {siblings.length > 1 ? (
            <>
              <button type="button" className="planner-icon-button" disabled={busy || index <= 0} onClick={() => reorder(-1)} aria-label={`Move up: ${goal.title}`}><Icon name="up" size={18} /></button>
              <button type="button" className="planner-icon-button" disabled={busy || index >= siblings.length - 1} onClick={() => reorder(1)} aria-label={`Move down: ${goal.title}`}><Icon name="down" size={18} /></button>
            </>
          ) : null}
        </div>
        {error ? <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-xs)' }}>{error}</span> : null}
        {!compact && open.length ? (
          <div className="planner-goal-tasks">
            <TaskList
              tasks={open.slice(0, SHOWN_TASKS)}
              testId={`goal-tasks-${goal.id}`}
              me={me}
              today={today}
              businessesById={data.businessesById}
              clientsById={data.clientsById}
              accountsById={data.accountsById}
              onOpen={onOpenTask}
            />
            {open.length > SHOWN_TASKS ? <Link to={`/tasks?goal=${goal.id}`} style={{ fontSize: 'var(--text-sm)' }}>All {open.length} open tasks</Link> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Last period's unfinished goals, offered for carrying over into `period` (a new goal is copied;
 * the old one is left as it was, and its open, undated tasks move to the copy — goal_id only —
 * so they stay planned). One tap each, or all at once.
 */
export function CarryOver({ candidates, period, me, data, existing, kind, testId = 'carry-over' }) {
  const { busy, error, run } = useAction();
  if (!candidates.length) return null;
  const carry = (goals) => run(async () => {
    const positions = new Map();
    for (const g of goals) {
      const base = positions.get(g.business_id) ?? nextPosition(existing.filter((x) => x.business_id === g.business_id));
      const copy = await store.create('goal', carryFields(g, period, { me, position: base }));
      positions.set(g.business_id, base + 1);
      for (const id of carryTaskMoves(data.tasks, g.id)) await store.update('task', id, { goal_id: copy });
    }
  });
  return (
    <div className="planner-carry" data-testid={testId}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{candidates.length} unfinished from last {kind === 'month' ? 'month' : 'week'}</strong>
        {candidates.length > 1 ? <Button disabled={busy} onClick={() => carry(candidates)}>Carry all over</Button> : null}
      </div>
      <ul className="planner-suggestions">
        {candidates.map((g) => {
          const p = goalProgress(g);
          return (
            <li key={g.id} data-carry-goal={g.id}>
              <span style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                <BusinessChip business={data.businessesById.get(g.business_id)} short />
                <span style={{ overflowWrap: 'anywhere' }}>{g.title}</span>
                {p.label ? <span style={muted}>{p.label}</span> : null}
              </span>
              <Button disabled={busy} onClick={() => carry([g])} aria-label={`Carry over: ${g.title}`}>Carry over</Button>
            </li>
          );
        })}
      </ul>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}

/**
 * Goals carried over twice into one period (both devices carried the same goal before they saw
 * each other's copy): a notice per pair with one tap to remove the extra — its open tasks move to
 * the one kept first (goal_id only), then the extra is deleted.
 */
export function CarriedTwice({ goals, kind, period, data, testId = 'carried-twice' }) {
  const { busy, error, run } = useAction();
  const doubles = carriedTwice(goals, { kind, period });
  if (!doubles.length) return null;
  const fix = ({ keep, extras }) => run(async () => {
    for (const extra of extras) {
      for (const t of data.tasksByGoal.get(extra.id) ?? []) if (isOpenTask(t)) await store.update('task', t.id, { goal_id: keep.id });
      await store.remove('goal', extra.id);
    }
  });
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)' }} data-testid={testId}>
      {doubles.map((d) => (
        <Notice key={d.keep.id} tone="warn">
          <span>“{d.keep.title}” was carried over twice (on two devices at once).</span>{' '}
          <button type="button" className="crm-link-button" disabled={busy} onClick={() => fix(d)} aria-label={`Remove the extra copy of ${d.keep.title}`}>
            Remove the extra
          </button>
        </Notice>
      ))}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
