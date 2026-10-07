// Planning (C4b) logic, without React or a server: tasks to sort, the overbooked day and what to
// push (both people, shared tasks, tasks without an estimate), weeks and months across year, month
// and DST edges, carrying goals over, the Friday review's lists, the Focus queue (Today's order),
// and the morning plan no longer proposing undated tasks that belong nowhere. Invented names only.
process.env.TZ = 'America/Toronto'; // DST: Mar 8 and Nov 1, 2026 (set before any Date is made)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { isUnplannedTask, WORKDAY_IDS, goalPeriodOf, isGoalPeriod } from '@suite/shared/planner';
import {
  weekDays, weekLabel, monthLabel, weekMonth, weeksOfMonth, weekParam, monthParam, addMonthStarts, weekStart, monthStart, addDays,
  compareGoals, goalsOf, goalProgress, priorityOverflow, reorderChanges, nextPosition, carryOverCandidates, carryFields, goalChoices, goalChange,
  unplannedTasks, quickDays, dayMinutesFor, businessMismatch, carryTaskMoves, carriedTwice, planMonth, isStaleGoal, taskDay, dayLoad, loadsByDay, nextDayWithRoom, pushSuggestions, pushChange, weekLoads,
  overdueTasks, renewalsDue, quietClients, handoffTasks, reviewLists, focusQueue, nextInQueue, previousInQueue, planBusinesses,
} from '../src/modules/planner/plan.js';
import { buildToday, proposePlan, filterTasks, isCurrentGoal } from '../src/modules/planner/logic.js';

const TODAY = '2026-10-07'; // a Wednesday
const MONDAY = '2026-10-05';
const W = BUSINESS_IDS.wholesale;
const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;

let seq = 0;
const pad = (n) => String(n).padStart(4, '0');
/** A task whose id sorts by creation (like a UUIDv7). */
function task(fields) {
  seq += 1;
  return {
    id: `t-${pad(seq)}`, title: `Task ${seq}`, owner: 'owner', business_id: W, done_at: null, top_on_owner: null, top_on_partner: null,
    due_date: null, due_time: null, estimate_minutes: null, goal_id: null, ...fields,
  };
}
function goal(fields) {
  seq += 1;
  return { id: `g-${pad(seq)}`, kind: 'week', period: MONDAY, business_id: W, title: `Goal ${seq}`, owner: 'owner', done_at: null, position: null, ...fields };
}
const titles = (rows) => rows.map((t) => t.title);
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));

// ---- weeks and months -------------------------------------------------------------------------------

test('weeks run Monday to Sunday and months from the 1st, across year, month and DST edges', () => {
  assert.equal(weekStart('2027-01-01'), '2026-12-28', 'New Year’s Day 2027 is in the week of Dec 28');
  assert.equal(weekStart('2026-12-28'), '2026-12-28');
  assert.equal(weekStart('2027-01-03'), '2026-12-28', 'Sunday ends it');
  assert.equal(weekStart('2027-01-04'), '2027-01-04');
  assert.deepEqual(weekDays('2026-12-28'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  assert.equal(weekStart('2026-03-08'), '2026-03-02', 'DST starts (Sunday): still the week of Mar 2');
  assert.equal(addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09', 'a 23-hour day is still one day');
  assert.equal(weekStart('2026-11-01'), '2026-10-26', 'DST ends (Sunday)');
  assert.equal(addDays('2026-11-01', 1), '2026-11-02', 'a 25-hour day is still one day');
  assert.deepEqual(weekDays('2026-10-26').slice(5), ['2026-10-31', '2026-11-01']);
  assert.equal(weekStart('2028-02-29'), '2028-02-28', 'leap day');
  assert.equal(monthStart('2026-10-31'), '2026-10-01');
  assert.equal(addMonthStarts('2026-12-15', 1), '2027-01-01');
  assert.equal(addMonthStarts('2027-01-31', -1), '2026-12-01');
  assert.equal(addMonthStarts('2026-03-31', -1), '2026-02-01');
  // A week split across two months belongs to the month its Thursday is in.
  assert.equal(weekMonth('2026-09-28'), '2026-10-01', 'Sep 28 – Oct 4: Thursday Oct 1');
  assert.equal(weekMonth('2026-08-31'), '2026-09-01');
  assert.equal(weekMonth('2026-12-28'), '2026-12-01', 'Dec 28 – Jan 3: Thursday Dec 31');
  assert.deepEqual(weeksOfMonth('2026-10-01'), ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  assert.deepEqual(weeksOfMonth('2026-11-01'), ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']);
  assert.deepEqual(weeksOfMonth('2027-01-01'), ['2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25']);
  // URL parameters: any day snaps to its Monday / 1st; nonsense is this week / month.
  assert.equal(weekParam('2026-10-09', TODAY), MONDAY);
  assert.equal(weekParam('2026-02-30', TODAY), MONDAY);
  assert.equal(weekParam(null, TODAY), MONDAY);
  assert.equal(monthParam('2026-11', TODAY), '2026-11-01');
  assert.equal(monthParam('2026-11-17', TODAY), '2026-11-01');
  assert.equal(monthParam('nope', TODAY), '2026-10-01');
  // Labels in local time (never shifted a day by UTC parsing).
  assert.match(weekLabel(MONDAY), /Oct 5 – 11, 2026/);
  assert.match(weekLabel('2026-09-28'), /Sep 28 – Oct 4, 2026/);
  assert.match(weekLabel('2026-12-28'), /Dec 28, 2026 – Jan 3, 2027/);
  assert.match(monthLabel('2026-11-01'), /November 2026/);
  // Goal periods (the server's check uses the same rule).
  assert.equal(isGoalPeriod('week', '2026-10-05'), true);
  assert.equal(isGoalPeriod('week', '2026-10-01'), false);
  assert.equal(isGoalPeriod('month', '2026-10-01'), true);
  assert.equal(goalPeriodOf({ kind: 'month', period: '2026-10-15' }), '2026-10-01');
});

// ---- goals -----------------------------------------------------------------------------------------

test('goals: order, progress against the target, the three-a-month warning, reordering, the plan’s businesses', () => {
  const a = goal({ title: 'A', position: 2 });
  const b = goal({ title: 'B', position: 0 });
  const c = goal({ title: 'C' }); // no position: last
  const other = goal({ title: 'Next week', period: '2026-10-12' });
  assert.deepEqual(titles(goalsOf([a, b, c, other], 'week', MONDAY)), ['B', 'A', 'C']);
  assert.deepEqual([b, a, c].sort(compareGoals).map((g) => g.title), ['B', 'A', 'C']);
  assert.deepEqual(goalProgress({ target: 5, progress: 2 }), { progress: 2, target: 5, pct: 40, label: '2 of 5' });
  assert.deepEqual(goalProgress({ target: 4, progress: 6 }).pct, 100);
  assert.deepEqual(goalProgress({ target: null, progress: null }), { progress: 0, target: null, pct: null, label: '' });
  assert.equal(goalProgress({ target: 3, progress: 1.25 }).label, '1.3 of 3');
  const p = (biz) => goal({ kind: 'month', period: '2026-10-01', business_id: biz });
  assert.deepEqual(priorityOverflow([p(W), p(W), p(W), p(AGENCY)]), []);
  assert.deepEqual(priorityOverflow([p(W), p(W), p(W), p(W), p(AGENCY)]), [{ businessId: W, count: 4 }]);
  // Moving C up: positions written in the new order, only those that change.
  // Order B (0), A (2), C (none). Moving C up: B, C, A — C becomes 1 (A keeps 2).
  assert.deepEqual(reorderChanges([a, b, c], c.id, -1), [{ id: c.id, position: 1 }]);
  assert.deepEqual(reorderChanges([a, b, c], b.id, -1), [], 'the first can’t go up');
  assert.deepEqual(reorderChanges([a, b, c], c.id, 1), [], 'the last can’t go down');
  assert.deepEqual(reorderChanges([a, b, c], b.id, 1), [{ id: a.id, position: 0 }, { id: b.id, position: 1 }, { id: c.id, position: 2 }]);
  assert.equal(nextPosition([a, b, c]), 3);
  assert.equal(nextPosition([]), 0);
  const businesses = [{ id: W, name: 'Wholesale', position: 1 }, { id: AGENCY, name: 'Agency', position: 2, archived: true }, { id: PERSONAL, name: 'Personal', position: 6 }];
  assert.deepEqual(planBusinesses(businesses, []).map((x) => x.id), [W, PERSONAL], 'archived hidden');
  assert.deepEqual(planBusinesses(businesses, [goal({ business_id: AGENCY })]).map((x) => x.id), [W, AGENCY, PERSONAL], '…unless it has goals here');
});

test('carry-over: last period’s unfinished goals are offered once; the copy keeps business, target and progress', () => {
  const last = '2026-09-28';
  const open = goal({ title: 'Follow up 5 quiet wholesale customers', period: last, target: 5, progress: 3, notes: 'Start with the Simcoe ones', owner: 'partner' });
  const done = goal({ title: 'Ship the price list', period: last, done_at: '2026-10-02T15:00:00.000Z' });
  const mine = goal({ title: 'Tidy the garage', period: last, business_id: PERSONAL, owner: null });
  const month = goal({ kind: 'month', period: '2026-09-01', title: 'Launch the Lefty’s site' });
  const goals = [open, done, mine, month];
  assert.deepEqual(titles(carryOverCandidates(goals, { kind: 'week', from: last, to: MONDAY })), ['Follow up 5 quiet wholesale customers', 'Tidy the garage']);
  const copy = carryFields(open, MONDAY, { me: 'owner', position: 0 });
  assert.deepEqual(copy, {
    kind: 'week', period: MONDAY, business_id: W, title: open.title, target: 5, progress: 3, owner: 'partner', notes: 'Start with the Simcoe ones',
    position: 0, carried_from: open.id,
  });
  assert.equal(carryFields(mine, MONDAY, { me: 'owner' }).owner, 'owner', 'no owner: the person carrying it');
  const carried = goal({ ...copy, id: undefined });
  carried.id = 'g-carried';
  assert.deepEqual(titles(carryOverCandidates([...goals, carried], { kind: 'week', from: last, to: MONDAY })), ['Tidy the garage'], 'offered once');
  assert.equal(open.period, last, 'the old goal is left as it was');
  assert.deepEqual(titles(carryOverCandidates(goals, { kind: 'month', from: '2026-09-01', to: '2026-10-01' })), ['Launch the Lefty’s site']);
});

test('a task’s “Part of” choices and filing a task under a goal (its business is kept; a difference is pointed out)', () => {
  const businessesById = new Map([[W, { id: W, name: 'Wholesale' }], [PERSONAL, { id: PERSONAL, name: 'Personal' }]]);
  const thisWeek = goal({ title: 'Follow up quiet customers' });
  const nextWeek = goal({ title: 'Count the stock', period: '2026-10-12' });
  const old = goal({ title: 'Old goal', period: '2026-08-31' });
  const priority = goal({ kind: 'month', period: '2026-10-01', title: 'Open 3 new stores' });
  const later = goal({ title: 'Week of the trade show', period: '2026-11-16' });
  const goals = [thisWeek, nextWeek, old, priority, later];
  const choices = goalChoices(goals, { today: TODAY, businessesById });
  assert.deepEqual(choices.map((c) => [c.group, c.label]), [
    ['This week’s goals', 'Wholesale — Follow up quiet customers'],
    ['Next week’s goals', 'Wholesale — Count the stock'],
    ['This month’s priorities', 'Wholesale — Open 3 new stores'],
  ]);
  const withDate = goalChoices(goals, { today: TODAY, dueDate: '2026-11-18', current: old.id, businessesById });
  assert.equal(withDate[0].value, old.id, 'its current goal is always offered');
  assert.ok(withDate.some((c) => c.value === later.id), 'and the goals of the week it is due');
  // Filing under a goal never changes the business silently: the screens say it differs and offer it.
  const t = task({ business_id: PERSONAL });
  assert.deepEqual(goalChange(t, thisWeek), { goal_id: thisWeek.id });
  assert.equal(businessMismatch(t, thisWeek), W);
  assert.equal(businessMismatch(task({ business_id: W }), thisWeek), null);
  assert.deepEqual(goalChange(t, null), { goal_id: null });
});

// ---- tasks to sort -----------------------------------------------------------------------------------

test('“this month” is one rule everywhere: the month this week’s Thursday is in (Sep 30 and Oct 1 agree)', () => {
  const sept = goal({ kind: 'month', period: '2026-09-01', title: 'September priority' });
  const oct = goal({ kind: 'month', period: '2026-10-01', title: 'October priority' });
  const bizById = new Map([[W, { id: W, name: 'Wholesale' }]]);
  for (const day of ['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-04']) {
    assert.equal(planMonth(day), '2026-10-01', `${day}: the week of Sep 28 plans in October`);
    assert.equal(weekMonth(weekStart(day)), planMonth(day), 'the Monday plan’s “This month” line');
    assert.deepEqual([isCurrentGoal(sept, day), isCurrentGoal(oct, day)], [false, true], 'the morning plan');
    const choices = goalChoices([sept, oct], { today: day, businessesById: bizById });
    assert.deepEqual(choices.filter((c) => c.group === 'This month’s priorities').map((c) => c.label), ['Wholesale — October priority'], 'the task sheet');
    assert.equal(monthParam(null, day), '2026-10-01', 'the monthly plan opens on it');
  }
  assert.equal(planMonth('2026-09-27'), '2026-09-01', 'the Sunday before is still September');
  assert.equal(planMonth('2026-11-01'), '2026-10-01', 'Sun Nov 1 ends a week that plans in October');
  assert.equal(planMonth('2026-11-02'), '2026-11-01');
});

test('unplanned: an open task with no day and no live goal; whose; the tasks page filter; quick days', () => {
  const g = goal({});
  const gone = 'g-deleted';
  const goalsById = byId([g]);
  const rows = [
    task({ title: 'No day, no goal' }),
    task({ title: 'Shared, no day, no goal', owner: 'shared' }),
    task({ title: 'Partner’s, no day, no goal', owner: 'partner' }),
    task({ title: 'Its goal was deleted', goal_id: gone }),
    task({ title: 'On a goal', goal_id: g.id }),
    task({ title: 'Has a day', due_date: '2026-10-20' }),
    task({ title: 'Done', done_at: '2026-10-06T10:00:00.000Z' }),
    task({ title: 'Picked for today but no day', top_on_owner: TODAY }),
  ];
  assert.deepEqual(rows.map((t) => isUnplannedTask(t, goalsById)), [true, true, true, true, false, false, false, true]);
  assert.deepEqual(titles(unplannedTasks(rows, { goalsById, me: 'owner' })), ['No day, no goal', 'Shared, no day, no goal', 'Its goal was deleted', 'Picked for today but no day']);
  assert.deepEqual(titles(unplannedTasks(rows, { goalsById, me: 'owner', whose: 'partner' })), ['Partner’s, no day, no goal']);
  assert.equal(unplannedTasks(rows, { goalsById, me: 'owner', whose: 'all' }).length, 5);
  assert.deepEqual(
    titles(filterTasks(rows, { due: 'unplanned', owner: 'mine' }, { me: 'owner', today: TODAY, goalsById })),
    ['No day, no goal', 'Its goal was deleted', 'Picked for today but no day'],
  );
  assert.deepEqual(titles(filterTasks(rows, { goal: g.id }, { me: 'owner', today: TODAY, goalsById })), ['On a goal']);
  assert.deepEqual(quickDays(TODAY).map((d) => [d.label, d.day]), [['Today', TODAY], ['Tomorrow', '2026-10-08'], ['Monday', '2026-10-12']]);
  assert.deepEqual(quickDays('2026-10-11').map((d) => d.label), ['Today', 'Tomorrow'], 'on Sunday, tomorrow is Monday');
});

test('a task left on a goal of an earlier period (done or not) is unplanned; carrying over moves open, undated tasks to the copy', () => {
  const lastWeek = goal({ title: 'Last week, not done', period: '2026-09-28' });
  const lastWeekDone = goal({ title: 'Last week, done', period: '2026-09-28', done_at: '2026-10-02T12:00:00.000Z' });
  const lastMonth = goal({ kind: 'month', period: '2026-09-01', title: 'September' });
  const thisWeek = goal({ title: 'This week' });
  const goalsById = byId([lastWeek, lastWeekDone, lastMonth, thisWeek]);
  const stale = task({ title: 'On last week’s goal', goal_id: lastWeek.id });
  const onDone = task({ title: 'On a finished goal', goal_id: lastWeekDone.id });
  const onMonth = task({ title: 'On September’s priority', goal_id: lastMonth.id });
  const current = task({ title: 'On this week’s goal', goal_id: thisWeek.id });
  const dated = task({ title: 'Dated, last week’s goal', goal_id: lastWeek.id, due_date: '2026-10-09' });
  const doneTask = task({ title: 'Done, last week’s goal', goal_id: lastWeek.id, done_at: '2026-10-01T10:00:00.000Z' });
  const rows = [stale, onDone, onMonth, current, dated, doneTask];
  const stuck = ['On last week’s goal', 'On a finished goal', 'On September’s priority'];
  assert.deepEqual(titles(unplannedTasks(rows, { goalsById, me: 'owner', today: TODAY })), stuck, 'a goal ticked done still leaves its open tasks to sort');
  assert.equal(isStaleGoal(lastWeekDone, TODAY), true);
  assert.equal(isStaleGoal(thisWeek, TODAY), false);
  assert.equal(isUnplannedTask(stale, goalsById), false, 'without today: no staleness check (C4a callers)');
  assert.equal(isUnplannedTask(stale, new Set([lastWeek.id]), TODAY), false, 'ids only: no staleness check');
  assert.deepEqual(titles(filterTasks(rows, { due: 'unplanned' }, { me: 'owner', today: TODAY, goalsById })), stuck);
  assert.equal(proposePlan({ tasks: rows, me: 'owner', today: TODAY, goalsById }).toSort, 3);
  // Carrying last week's goal over takes its open, undated tasks along (dated and done ones stay).
  assert.deepEqual(carryTaskMoves(rows, lastWeek.id), [stale.id]);
  const copy = goal({ ...carryFields(lastWeek, MONDAY, { me: 'owner' }) });
  const moved = rows.map((t) => (carryTaskMoves(rows, lastWeek.id).includes(t.id) ? { ...t, goal_id: copy.id } : t));
  assert.deepEqual(titles(unplannedTasks(moved, { goalsById: byId([...goalsById.values(), copy]), me: 'owner', today: TODAY })), ['On a finished goal', 'On September’s priority']);
  // Carried on two devices at once: the first copy is kept, the other is the extra.
  const twin = goal({ ...carryFields(lastWeek, MONDAY, { me: 'partner' }) });
  const other = goal({ ...carryFields(lastWeekDone, MONDAY, { me: 'owner' }) });
  assert.deepEqual(carriedTwice([copy, twin, other, lastWeek], { kind: 'week', period: MONDAY }).map((d) => [d.keep.id, d.extras.map((e) => e.id)]), [[copy.id, [twin.id]]]);
  assert.deepEqual(carriedTwice([copy, twin], { kind: 'week', period: '2026-10-12' }), []);
});

test('the morning plan proposes overdue, due today and my undated goal tasks — not undated tasks that belong nowhere', () => {
  const g = goal({});
  const lastMonth = goal({ kind: 'month', period: '2026-09-01' });
  const priority = goal({ kind: 'month', period: '2026-10-01' });
  const rows = [
    task({ title: 'Overdue', due_date: '2026-10-06' }),
    task({ title: 'Due today', due_date: TODAY }),
    task({ title: 'Goal task, undated', goal_id: g.id }),
    task({ title: 'Priority task, undated', goal_id: priority.id }),
    task({ title: 'Old priority task', goal_id: lastMonth.id }),
    task({ title: 'Partner’s goal task', goal_id: g.id, owner: 'partner' }),
    task({ title: 'Loose end' }),
    task({ title: 'Shared loose end', owner: 'shared' }),
  ];
  const tasksById = byId(rows);
  const plan = proposePlan({ tasks: rows, me: 'owner', today: TODAY, goalsById: byId([g, lastMonth, priority]) });
  const t = (ids) => ids.map((id) => tasksById.get(id).title);
  assert.deepEqual(t(plan.overdue), ['Overdue']);
  assert.deepEqual(t(plan.dueToday), ['Due today']);
  assert.deepEqual(t(plan.forGoals), ['Goal task, undated', 'Priority task, undated']);
  assert.equal(plan.toSort, 3, 'the loose ends (mine and the shared one) and the task left on last month’s priority are counted for sorting instead');
});

// ---- the overbooked day ------------------------------------------------------------------------------

test('a day’s load: my own and shared tasks; overdue and top picks count on today; no estimate counts 0 and is listed', () => {
  const rows = [
    task({ title: 'Mine today 3h', due_date: TODAY, estimate_minutes: 180 }),
    task({ title: 'Shared today 2h', owner: 'shared', due_date: TODAY, estimate_minutes: 120 }),
    task({ title: 'Partner’s own today 5h', owner: 'partner', due_date: TODAY, estimate_minutes: 300 }),
    task({ title: 'Overdue 1h', due_date: '2026-10-01', estimate_minutes: 60 }),
    task({ title: 'Picked, undated 1h', top_on_owner: TODAY, estimate_minutes: 60 }),
    task({ title: 'Partner picked it', owner: 'shared', top_on_partner: TODAY, estimate_minutes: 45 }),
    task({ title: 'No estimate', due_date: TODAY }),
    task({ title: 'Tomorrow 2h', due_date: '2026-10-08', estimate_minutes: 120 }),
    task({ title: 'Done today', due_date: TODAY, estimate_minutes: 480, done_at: '2026-10-07T09:00:00.000Z' }),
  ];
  const load = dayLoad(rows, { me: 'owner', today: TODAY, dayMinutes: 480 });
  assert.equal(load.minutes, 180 + 120 + 60 + 60);
  assert.equal(load.over, false);
  assert.deepEqual(titles(load.unestimated), ['No estimate']);
  assert.equal(load.tasks.length, 5);
  assert.equal(taskDay(rows[5], TODAY, 'owner'), null, 'the partner’s pick of an undated shared task isn’t on my day');
  assert.equal(taskDay(rows[5], TODAY, 'partner'), TODAY);
  // The partner's day: their own 5h + the shared 2h + the shared task they picked (45 min).
  const theirs = dayLoad(rows, { me: 'partner', today: TODAY, dayMinutes: 360 });
  assert.equal(theirs.minutes, 300 + 120 + 45);
  assert.deepEqual([theirs.over, theirs.excess], [true, 105]);
  assert.equal(dayLoad(rows, { me: 'owner', today: TODAY, day: '2026-10-08', dayMinutes: 480 }).minutes, 120);
  assert.deepEqual(Object.fromEntries(loadsByDay(rows, { me: 'owner', today: TODAY })), { [TODAY]: 420, '2026-10-08': 120 });
  // Day lengths per person (the workday records; the default when one is missing or unset).
  const workdays = [{ id: WORKDAY_IDS.owner, actor: 'owner', day_minutes: 360 }, { id: WORKDAY_IDS.partner, actor: 'partner', day_minutes: null }];
  assert.deepEqual([dayMinutesFor(workdays, 'owner'), dayMinutesFor(workdays, 'partner'), dayMinutesFor([], 'owner')], [360, 480, 480]);
});

test('what to push: untimed before timed, not top 3, no goal or week goal before a month priority, latest first — until the day fits', () => {
  const week = goal({});
  const month = goal({ kind: 'month', period: '2026-10-01' });
  const goalsById = byId([week, month]);
  const d = (f) => task({ due_date: TODAY, estimate_minutes: 60, ...f });
  const timed = d({ title: 'Timed', due_time: '10:00' });
  const top = d({ title: 'Top pick', top_on_owner: TODAY });
  const forMonth = d({ title: 'For a month priority', goal_id: month.id });
  const older = d({ title: 'Older, no goal' });
  const forWeek = d({ title: 'Newer, week goal', goal_id: week.id });
  const noEstimate = task({ title: 'No estimate', due_date: TODAY });
  const sharedNewest = d({ title: 'Shared, newest', owner: 'shared' });
  const partners = d({ title: 'Partner’s own', owner: 'partner', estimate_minutes: 600 });
  const rows = [timed, top, forMonth, older, forWeek, noEstimate, sharedNewest, partners];
  // 7 × 1 h on my day against 8 h: fits.
  assert.deepEqual(pushSuggestions({ tasks: rows, me: 'owner', today: TODAY, dayMinutes: 480, goalsById }), []);
  // 6 h on my day (the partner's own isn't mine; no estimate counts 0). Against 3 h: push 3 h, in order.
  const s = pushSuggestions({ tasks: rows, me: 'owner', today: TODAY, dayMinutes: 180, goalsById });
  assert.deepEqual(titles(s.map((x) => x.task)), ['Shared, newest', 'Newer, week goal', 'Older, no goal']);
  // Each to the next day with room: tomorrow holds 3 h.
  assert.deepEqual(s.map((x) => x.to), ['2026-10-08', '2026-10-08', '2026-10-08']);
  // Against 2 h: the month priority's task next — and the fourth hour no longer fits tomorrow.
  const four = pushSuggestions({ tasks: rows, me: 'owner', today: TODAY, dayMinutes: 120, goalsById });
  assert.deepEqual(titles(four.map((x) => x.task)).at(-1), 'For a month priority');
  assert.deepEqual(four.map((x) => x.to), ['2026-10-08', '2026-10-08', '2026-10-09', '2026-10-09'], '2 h a day');
  // Against 1 h: then the top pick; the timed one is last, and stays (1 h fits).
  const all = pushSuggestions({ tasks: rows, me: 'owner', today: TODAY, dayMinutes: 60, goalsById });
  assert.deepEqual(titles(all.map((x) => x.task)), ['Shared, newest', 'Newer, week goal', 'Older, no goal', 'For a month priority', 'Top pick']);
  assert.ok(!all.some((x) => x.task === noEstimate), 'a task without an estimate frees nothing');
  // The partner's overbooked day: their 10 h task and the shared one.
  const theirs = pushSuggestions({ tasks: rows, me: 'partner', today: TODAY, dayMinutes: 480, goalsById });
  assert.deepEqual(titles(theirs.map((x) => x.task)), ['Partner’s own'], 'the latest made goes first and is enough');
  assert.equal(theirs[0].to, '2026-10-08', 'longer than a day: the first empty day');
  // A shared task the partner starred today counts on my day but is never suggested (it's their pick).
  const theirPick = d({ title: 'Shared, the partner’s pick', owner: 'shared', top_on_partner: TODAY });
  const withPick = pushSuggestions({ tasks: [...rows, theirPick], me: 'owner', today: TODAY, dayMinutes: 180, goalsById });
  assert.ok(!withPick.some((x) => x.task === theirPick), 'not suggested');
  assert.deepEqual(titles(withPick.map((x) => x.task)), ['Shared, newest', 'Newer, week goal', 'Older, no goal', 'For a month priority'], 'it still counts: one more hour to push');
  assert.equal(dayLoad([...rows, theirPick], { me: 'partner', today: TODAY, dayMinutes: 480 }).tasks.includes(theirPick), true, 'and it counts on the partner’s day too');
  // Moving one: its date, and my top pick for today goes.
  assert.deepEqual(pushChange(top, '2026-10-08', TODAY, 'owner').change, { due_date: '2026-10-08', top_on_owner: null });
  // The next day with room skips full days.
  const loads = new Map([['2026-10-08', 450], ['2026-10-09', 470]]);
  assert.equal(nextDayWithRoom(loads, { from: TODAY, minutes: 60, dayMinutes: 480 }), '2026-10-10');
  assert.equal(nextDayWithRoom(loads, { from: TODAY, minutes: 30, dayMinutes: 480 }), '2026-10-08', 'exactly full fits');
  assert.equal(nextDayWithRoom(loads, { from: TODAY, minutes: 600, dayMinutes: 480 }), '2026-10-10', 'longer than a day: the first empty day');
});

test('the week’s loads: past days, today with overdue work, overbooked days', () => {
  const rows = [
    task({ due_date: '2026-10-05', estimate_minutes: 600 }), // overdue: counts on today
    task({ due_date: TODAY, estimate_minutes: 60 }),
    task({ due_date: '2026-10-09', estimate_minutes: 540 }),
    task({ due_date: '2026-10-11' }),
  ];
  const days = weekLoads(rows, { me: 'owner', today: TODAY, monday: MONDAY, dayMinutes: 480 });
  assert.deepEqual(days.map((d) => [d.day, d.past, d.minutes, d.over, d.count]), [
    ['2026-10-05', true, 0, false, 0],
    ['2026-10-06', true, 0, false, 0],
    [TODAY, false, 660, true, 2],
    ['2026-10-08', false, 0, false, 0],
    ['2026-10-09', false, 540, true, 1],
    ['2026-10-10', false, 0, false, 0],
    ['2026-10-11', false, 0, false, 1],
  ]);
});

// ---- the Friday review ----------------------------------------------------------------------------------

test('the Friday review: overdue for both, renewals in 30 days, clients quiet for 60 days, this week’s goals, handoffs', () => {
  const FRIDAY = '2026-10-09';
  const tasks = [
    task({ title: 'My overdue', due_date: '2026-10-01' }),
    task({ title: 'Partner overdue', owner: 'partner', due_date: '2026-09-30' }),
    task({ title: 'Shared overdue', owner: 'shared', due_date: '2026-10-08' }),
    task({ title: 'Done overdue', due_date: '2026-10-01', done_at: '2026-10-02T10:00:00.000Z' }),
    task({ title: 'Mine next week', due_date: '2026-10-15' }),
    task({ title: 'Mine in two weeks', due_date: '2026-10-19' }),
    task({ title: 'Mine undated' }),
  ];
  assert.deepEqual(titles(overdueTasks(tasks, FRIDAY)), ['Partner overdue', 'My overdue', 'Shared overdue']);
  assert.deepEqual(titles(handoffTasks(tasks, { who: 'owner', today: FRIDAY })), ['My overdue', 'Mine next week', 'Mine undated']);
  assert.deepEqual(titles(handoffTasks(tasks, { who: 'partner', today: FRIDAY })), ['Partner overdue']);
  const svc = (name, renewal_date, status = 'active') => ({ id: `s-${name}`, name, renewal_date, status });
  const services = [svc('Today', FRIDAY), svc('In 30 days', '2026-11-08'), svc('In 31 days', '2026-11-09'), svc('Yesterday', '2026-10-08'), svc('Cancelled', '2026-10-20', 'cancelled'), svc('Paused', '2026-10-20', 'paused'), svc('None', null)];
  assert.deepEqual(renewalsDue(services, FRIDAY).map((s) => s.name), ['Today', 'Paused', 'In 30 days']);
  // Quiet: last activity 60+ days ago; none at all counts from when the client was made.
  const client = (name, fields = {}) => ({ id: `c-${name}`, name, status: 'active', _sync: { createdAt: '2026-01-05T15:00:00.000Z' }, ...fields });
  const clients = [client('Busy'), client('Sixty days'), client('Fifty-nine days'), client('Never, old'), client('Never, new', { _sync: { createdAt: '2026-10-01T15:00:00.000Z' } }), client('Closed', { status: 'closed' })];
  // 60 days before Oct 9 is Aug 10. Activity times are UTC moments, read as local days (Toronto: -4h).
  const last = new Map([['c-Busy', '2026-10-08T14:00:00.000Z'], ['c-Sixty days', '2026-08-11T02:00:00.000Z'], ['c-Fifty-nine days', '2026-08-11T15:00:00.000Z']]);
  assert.deepEqual(quietClients(clients, last, FRIDAY).map((q) => q.client.name), ['Never, old', 'Sixty days'], 'Aug 11 02:00 UTC is Aug 10 in Toronto');
  const goals = [goal({ title: 'Agency goal', business_id: AGENCY }), goal({ title: 'Wholesale goal' }), goal({ title: 'Last week', period: '2026-09-28' })];
  const lists = reviewLists({
    tasks, today: FRIDAY, goals, services, clients, accounts: [], relationships: [], lastActivity: last,
    businesses: [{ id: W, position: 1 }, { id: AGENCY, position: 2 }],
  });
  assert.deepEqual(titles(lists.weekGoals), ['Wholesale goal', 'Agency goal']);
  assert.equal(lists.overdue.length, 3);
  assert.equal(lists.renewals.length, 3);
  assert.equal(lists.quiet.length, 2);
  assert.deepEqual(lists.noNextStep, []);
});

// ---- Focus -----------------------------------------------------------------------------------------------

test('the Focus queue is Today’s order; Done or Skip moves to the next still to do, wrapping round', () => {
  const rows = [
    task({ title: 'Due today, untimed', due_date: TODAY }),
    task({ title: 'Overdue', due_date: '2026-10-05' }),
    task({ title: 'Due today 9:00', due_date: TODAY, due_time: '09:00' }),
    task({ title: 'Picked, undated', top_on_owner: TODAY }),
    task({ title: 'Shared today', owner: 'shared', due_date: TODAY, due_time: '13:00' }),
    task({ title: 'Partner’s', owner: 'partner', due_date: TODAY }),
    task({ title: 'Done', due_date: TODAY, done_at: '2026-10-07T08:00:00.000Z' }),
    task({ title: 'Tomorrow', due_date: '2026-10-08' }),
  ];
  const tasksById = byId(rows);
  const queue = focusQueue({ tasks: rows, me: 'owner', today: TODAY });
  const { overdue, dueToday, picked } = buildToday({ tasks: rows, me: 'owner', today: TODAY });
  assert.deepEqual(queue, [...overdue, ...dueToday, ...picked].map((t) => t.id), 'exactly Today’s order');
  assert.deepEqual(queue.map((id) => tasksById.get(id).title), ['Overdue', 'Due today 9:00', 'Shared today', 'Due today, untimed', 'Picked, undated']);
  // Opened from a task that isn't on today: it goes first.
  const fromTask = focusQueue({ tasks: rows, me: 'owner', today: TODAY, start: rows[7].id });
  assert.equal(tasksById.get(fromTask[0]).title, 'Tomorrow');
  // Next still to do: skips done and skipped ones, wraps round, null when nothing is left.
  const done = new Set([queue[1]]);
  const skipped = new Set([queue[2]]);
  const left = (id) => !done.has(id) && !skipped.has(id);
  assert.equal(nextInQueue(queue, queue[0], left), queue[3]);
  assert.equal(nextInQueue(queue, queue[4], left), queue[0], 'wraps round');
  assert.equal(previousInQueue(queue, queue[3], left), queue[0]);
  assert.equal(nextInQueue(queue, queue[0], (id) => id === queue[0]), null, 'only the current one left');
  assert.equal(nextInQueue([], 'x', () => true), null);
});
