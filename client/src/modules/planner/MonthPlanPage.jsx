// The monthly plan (/plan/month?month=YYYY-MM): one to three priorities per business with progress
// against their targets (more than three is warned about, never refused), the week goals of that
// month under each business (a week belongs to the month its Thursday is in), and last month's
// unfinished priorities offered for carrying over. Built for the Mac, works on a phone.
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, Card, Icon, Notice } from '../../ui/index.js';
import { useAuth } from '../../auth/session.jsx';
import { BusinessChip, TextButton } from '../crm/parts.jsx';
import { goalPeriodOf } from '@suite/shared/planner';
import { usePlannerData } from './data.js';
import {
  monthParam, monthLabel, weekLabel, weeksOfMonth, goalsOf, goalsByBusiness, planBusinesses, carryOverCandidates, goalProgress,
  priorityOverflow, addMonthStarts, planMonth, MONTH_PRIORITY_LIMIT,
} from './plan.js';
import { useToday, muted } from './parts.jsx';
import { TaskSheet, newTaskInitial } from './forms.jsx';
import { GoalSheet, GoalItem, GoalTick, CarryOver, CarriedTwice } from './goals.jsx';
import { PlanTabs } from './planParts.jsx';
import { PeriodNav } from './WeekPlanPage.jsx';

export default function MonthPlanPage() {
  const { data, loading } = usePlannerData();
  const { session } = useAuth();
  const me = session?.user?.actor ?? null;
  const today = useToday();
  const [params, setParams] = useSearchParams();
  const first = monthParam(params.get('month'), today);
  const [sheet, setSheet] = useState(null);

  const view = useMemo(() => {
    if (!data) return null;
    const priorities = goalsOf(data.goals, 'month', first);
    const weeks = weeksOfMonth(first);
    const weekGoals = weeks.flatMap((w) => goalsOf(data.goals, 'week', w));
    return {
      priorities,
      byBusiness: goalsByBusiness(priorities),
      weeks,
      weekGoals: goalsByBusiness(weekGoals),
      businesses: planBusinesses(data.businesses, [...priorities, ...weekGoals]),
      overflow: new Map(priorityOverflow(priorities).map((o) => [o.businessId, o.count])),
      carry: carryOverCandidates(data.goals, { kind: 'month', from: addMonthStarts(first, -1), to: first }),
    };
  }, [data, first]);

  const goMonth = (m) => {
    const next = new URLSearchParams(window.location.search);
    if (m === planMonth(today)) next.delete('month');
    else next.set('month', m.slice(0, 7));
    setParams(next, { replace: true });
  };
  const close = () => setSheet(null);
  const addTask = (goal) => setSheet({ kind: 'task', initial: newTaskInitial({ me, businesses: data.businesses, context: goal.business_id, goal_id: goal.id }) });
  const rowProps = { data, me, today, onEdit: (g) => setSheet({ kind: 'goal', record: g }), onAddTask: addTask, onOpenTask: (t) => setSheet({ kind: 'task', record: t }) };

  return (
    <>
      <PageHeader
        title="Monthly plan"
        subtitle={monthLabel(first)}
        actions={(
          <PeriodNav
            onPrev={() => goMonth(addMonthStarts(first, -1))}
            onNext={() => goMonth(addMonthStarts(first, 1))}
            onCurrent={() => goMonth(planMonth(today))}
            isCurrent={first === planMonth(today)}
            prevLabel="Last month"
            nextLabel="Next month"
            currentLabel="This month"
          />
        )}
      />
      <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
        <PlanTabs />
        {!data ? (
          <Card><p style={{ ...muted, margin: 0 }}>{loading ? 'Loading…' : ' '}</p></Card>
        ) : (
          <>
            <CarriedTwice goals={data.goals} kind="month" period={first} data={data} />
            {view.carry.length ? (
              <Card>
                <CarryOver candidates={view.carry} period={first} me={me} data={data} existing={view.priorities} kind="month" testId="carry-over-month" />
              </Card>
            ) : null}
            <div className="planner-month-grid" data-testid="month-priorities">
              {view.businesses.map((b) => {
                const priorities = view.byBusiness.get(b.id) ?? [];
                const weekGoals = view.weekGoals.get(b.id) ?? [];
                const over = view.overflow.get(b.id);
                return (
                  <Card key={b.id}>
                    <div className="planner-business-head" data-business={b.id}>
                      <BusinessChip business={b} />
                      <span style={muted} data-testid="priority-count">{priorities.length} of {MONTH_PRIORITY_LIMIT} priorities</span>
                      <TextButton style={{ marginLeft: 'auto' }} onClick={() => setSheet({ kind: 'goal', initial: { kind: 'month', period: first, business_id: b.id } })} aria-label={`Add a priority for ${b.name}`}>
                        <Icon name="plus" size={14} />Priority
                      </TextButton>
                    </div>
                    {over ? (
                      <Notice tone="warn"><span data-testid="priority-overflow">{over} priorities this month: one to three works best. Finish or move one.</span></Notice>
                    ) : null}
                    {priorities.length ? (
                      <ul className="planner-goal-list">
                        {priorities.map((g) => <GoalItem key={g.id} goal={g} siblings={priorities} {...rowProps} />)}
                      </ul>
                    ) : <p style={{ ...muted, margin: 0 }}>No priorities this month.</p>}
                    {weekGoals.length ? (
                      <div className="planner-month-weeks" data-testid={`month-weeks-${b.id}`}>
                        <h3 style={{ ...muted, fontWeight: 600, margin: 0 }}>Week goals this month</h3>
                        {view.weeks.map((w) => {
                          const list = weekGoals.filter((g) => goalPeriodOf(g) === w);
                          if (!list.length) return null;
                          return (
                            <div key={w} style={{ display: 'grid', gap: 2 }}>
                              <Link to={`/plan/week?week=${w}`} style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Week of {weekLabel(w)}</Link>
                              <ul className="planner-goal-list compact">
                                {list.map((g) => {
                                  const p = goalProgress(g);
                                  return (
                                    <li key={g.id} className={`planner-goal${g.done_at ? ' done' : ''}`} data-goal-id={g.id}>
                                      <GoalTick goal={g} />
                                      <span style={{ alignSelf: 'center', minWidth: 0, overflowWrap: 'anywhere' }}>
                                        <span className="planner-goal-title-text">{g.title}</span>
                                        {p.label ? <span style={muted}> · {p.label}</span> : null}
                                      </span>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>
      {sheet?.kind === 'goal' ? (
        <GoalSheet record={sheet.record} initial={sheet.initial} siblings={view?.priorities ?? []} businesses={data?.businesses ?? []} onClose={close} onDone={close} />
      ) : null}
      {sheet?.kind === 'task' ? <TaskSheet record={sheet.record} initial={sheet.initial} onClose={close} onDone={close} onDeleted={close} /> : null}
    </>
  );
}
