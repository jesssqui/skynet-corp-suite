// The Monday plan (/plan/week?week=YYYY-MM-DD): the week's goals per business (add, edit, reorder,
// tasks hanging off them), last week's unfinished goals offered for carrying over, the "To sort"
// step (tasks with no day and no goal), and the week's load per day against the person's day
// length, with what to push off an overbooked day. Built for the Mac, works on a phone. Reads the
// device's offline copy; writes through the store.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Button, Icon, Segmented } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessChip, TextButton } from '../crm/parts.jsx';
import { usePlannerData } from './data.js';
import { formatMinutes } from './logic.js';
import {
  weekParam, weekLabel, weekLoads, dayShort, goalsOf, goalsByBusiness, planBusinesses, carryOverCandidates, unplannedTasks,
  dayMinutesFor, monthStart, addDays, weekStart,
} from './plan.js';
import { useToday, muted } from './parts.jsx';
import { TaskSheet, newTaskInitial } from './forms.jsx';
import { GoalSheet, GoalItem, CarryOver } from './goals.jsx';
import { PlanTabs, DayLoadPanel, SortList, Meter } from './planParts.jsx';

const h2 = { fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: 0 };

/** Prev / this / next period buttons. */
export function PeriodNav({ onPrev, onNext, onCurrent, isCurrent, prevLabel, nextLabel, currentLabel }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
      <Button onClick={onPrev} aria-label={prevLabel}><Icon name="back" size={18} /></Button>
      {!isCurrent ? <Button onClick={onCurrent}>{currentLabel}</Button> : null}
      <Button onClick={onNext} aria-label={nextLabel}><Icon name="chevron" size={18} /></Button>
    </div>
  );
}

/** The week strip: each day's planned time against the day length; overbooked days open their suggestions. */
function WeekDays({ data, me, today, monday, dayMinutes, open, setOpen }) {
  const days = useMemo(() => weekLoads(data.tasks, { me, today, monday, dayMinutes }), [data.tasks, me, today, monday, dayMinutes]);
  return (
    <ul className="planner-week-days" data-testid="week-days">
      {days.map((d) => (
        <li key={d.day} data-day={d.day} data-over={d.over ? 'true' : 'false'} className={`planner-week-day${d.past ? ' past' : ''}${d.today ? ' today' : ''}`}>
          <div className="planner-week-day-row">
            <span style={{ fontWeight: d.today ? 700 : 600, minWidth: 64 }}>{d.today ? 'Today' : dayShort(d.day)}</span>
            <div style={{ flex: 1, minWidth: 60 }}>
              {d.past ? null : <Meter value={d.minutes} max={dayMinutes} over={d.over} label={`${dayShort(d.day)} planned`} />}
            </div>
            <span style={{ ...muted, minWidth: 72, textAlign: 'right', color: d.over ? 'var(--warn)' : undefined, fontWeight: d.over ? 600 : 400 }}>
              {d.past ? 'Past' : d.count ? `${formatMinutes(d.minutes)} · ${d.count} ${d.count === 1 ? 'task' : 'tasks'}` : 'Free'}
            </span>
            {d.over ? (
              <TextButton onClick={() => setOpen(open === d.day ? null : d.day)} aria-expanded={open === d.day} aria-label={`What to push off ${dayShort(d.day)}`}>
                {open === d.day ? 'Hide' : 'Fix'}
              </TextButton>
            ) : null}
          </div>
          {open === d.day ? (
            <DayLoadPanel tasks={data.tasks} me={me} today={today} day={d.day} dayMinutes={dayMinutes} goalsById={data.goalsById} always testId={`day-load-${d.day}`} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function WeekPlanPage() {
  const { data, loading } = usePlannerData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const monday = weekParam(params.get('week'), today);
  const [sheet, setSheet] = useState(null);
  const [openDay, setOpenDay] = useState(null);
  const [whose, setWhose] = useState('mine');
  const sortRef = useRef(null);

  const view = useMemo(() => {
    if (!data) return null;
    const goals = goalsOf(data.goals, 'week', monday);
    return {
      goals,
      byBusiness: goalsByBusiness(goals),
      businesses: planBusinesses(data.businesses, goals),
      priorities: goalsByBusiness(goalsOf(data.goals, 'month', monthStart(addDays(monday, 3)))),
      carry: carryOverCandidates(data.goals, { kind: 'week', from: addDays(monday, -7), to: monday }),
    };
  }, [data, monday]);
  const toSort = useMemo(() => (data ? unplannedTasks(data.tasks, { goalsById: data.goalsById, me, whose }) : []), [data, me, whose]);
  const dayMinutes = data ? dayMinutesFor(data.workdays, me) : 0;

  // ?sort=1 (from Today, Tasks and Plan my day): straight to the To sort step.
  const wantsSort = params.get('sort') === '1';
  useEffect(() => {
    if (wantsSort && data && sortRef.current) sortRef.current.scrollIntoView({ block: 'start' });
  }, [wantsSort, Boolean(data)]); // eslint-disable-line react-hooks/exhaustive-deps

  const goWeek = (d) => {
    const next = new URLSearchParams(window.location.search);
    next.delete('sort');
    if (d === weekStart(today)) next.delete('week');
    else next.set('week', d);
    setParams(next, { replace: true });
  };
  const close = () => setSheet(null);
  const addGoal = (businessId) => setSheet({ kind: 'goal', initial: { kind: 'week', period: monday, business_id: businessId } });
  const addTask = (goal) => setSheet({
    kind: 'task',
    initial: newTaskInitial({ me, businesses: data.businesses, context: goal.business_id, goal_id: goal.id }),
  });
  const thisWeek = monday === weekStart(today);
  const rowProps = { data, me, today, onEdit: (g) => setSheet({ kind: 'goal', record: g }), onAddTask: addTask, onOpenTask: (t) => setSheet({ kind: 'task', record: t }) };

  return (
    <>
      <PageHeader
        title="Monday plan"
        subtitle={`Week of ${weekLabel(monday)}`}
        actions={(
          <PeriodNav
            onPrev={() => goWeek(addDays(monday, -7))}
            onNext={() => goWeek(addDays(monday, 7))}
            onCurrent={() => goWeek(weekStart(today))}
            isCurrent={thisWeek}
            prevLabel="Last week"
            nextLabel="Next week"
            currentLabel="This week"
          />
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <PlanTabs />
        {!data ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : (
          <div className="planner-plan-grid">
            <div className="planner-col">
              {view.carry.length ? (
                <Card>
                  <CarryOver candidates={view.carry} period={monday} me={me} data={data} existing={view.goals} kind="week" />
                </Card>
              ) : null}
              <section className="planner-col" aria-label="This week’s goals" data-testid="week-goals">
                {view.businesses.map((b) => {
                  const goals = view.byBusiness.get(b.id) ?? [];
                  const priorities = view.priorities.get(b.id) ?? [];
                  return (
                    <Card key={b.id}>
                      <div className="planner-business-head" data-business={b.id}>
                        <BusinessChip business={b} />
                        <TextButton onClick={() => addGoal(b.id)} aria-label={`Add a week goal for ${b.name}`}><Icon name="plus" size={14} />Goal</TextButton>
                      </div>
                      {priorities.length ? (
                        <p style={{ ...muted, margin: '0 0 var(--space-2)' }}>
                          <Icon name="target" size={13} style={{ verticalAlign: '-2px' }} /> This month: {priorities.map((p) => p.title).join(' · ')}
                        </p>
                      ) : null}
                      {goals.length ? (
                        <ul className="planner-goal-list">
                          {goals.map((g) => <GoalItem key={g.id} goal={g} siblings={goals} {...rowProps} />)}
                        </ul>
                      ) : <p style={{ ...muted, margin: 0 }}>No goals this week.</p>}
                    </Card>
                  );
                })}
              </section>
            </div>
            <div className="planner-col">
              <Card>
                <div className="planner-section-head">
                  <h2 style={h2}>The week</h2>
                  <span style={muted}>Your day: {formatMinutes(dayMinutes)}</span>
                </div>
                <WeekDays data={data} me={me} today={today} monday={monday} dayMinutes={dayMinutes} open={openDay} setOpen={setOpenDay} />
                <p style={{ ...muted, margin: 'var(--space-2) 0 0' }}>Your tasks and the shared list’s, by their estimates. Change your day length in Plan my day on Today.</p>
              </Card>
              <div ref={sortRef} id="to-sort" style={{ scrollMarginTop: 'var(--space-4)' }}>
                <Card>
                  <div className="planner-section-head">
                    <h2 style={h2}>To sort</h2>
                    <span style={muted} data-testid="to-sort-count">{toSort.length}</span>
                  </div>
                  <p style={{ ...muted, margin: '0 0 var(--space-2)' }}>Every task belongs to a day, a week goal or a month priority. These have none yet.</p>
                  <div style={{ marginBottom: 'var(--space-2)', overflowX: 'auto' }}>
                    <Segmented
                      label="Whose to sort"
                      value={whose}
                      onChange={setWhose}
                      options={[{ value: 'mine', label: 'Mine + shared' }, { value: 'partner', label: 'Partner’s' }, { value: 'all', label: 'All' }]}
                    />
                  </div>
                  <SortList tasks={toSort} data={data} me={me} today={today} />
                </Card>
              </div>
              <Link to="/plan/month" className="planner-link-row" style={{ padding: '0 var(--space-2)' }}>
                <Icon name="target" size={20} /> This month’s priorities <Icon name="chevron" size={16} />
              </Link>
            </div>
          </div>
        )}
      </div>
      {sheet?.kind === 'goal' ? (
        <GoalSheet
          record={sheet.record}
          initial={sheet.initial}
          siblings={view?.goals ?? []}
          businesses={data?.businesses ?? []}
          onClose={close}
          onDone={close}
        />
      ) : null}
      {sheet?.kind === 'task' ? <TaskSheet record={sheet.record} initial={sheet.initial} onClose={close} onDone={close} onDeleted={close} /> : null}
    </>
  );
}
