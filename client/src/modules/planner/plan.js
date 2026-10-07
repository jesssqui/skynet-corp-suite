// Planning (C4b), without React: weeks and months, week goals and month priorities (carry-over,
// order, progress), tasks to sort, each day's load against the person's day length with what to
// push, the Friday review's lists and the Focus queue. Pages build these once per data change
// (useMemo); tested in client/test/plan.test.js.
//
// Dates are "YYYY-MM-DD" in the device's local calendar, compared as text; arithmetic is on the
// calendar (addDays, weekStart, monthStart from @suite/shared/planner), never new Date('YYYY-MM-DD').
// Weeks run Monday to Sunday.
import {
  addDays, weekStart, monthStart, addMonthStarts, weekday, goalPeriodOf, isUnplannedTask, isOpenTask, dayMinutesOf,
  WORKDAY_IDS, MONTH_PRIORITY_LIMIT, SHARED,
} from '@suite/shared/planner';
import { parseLocalDate } from '../../ui/format.js';
import { buildToday, compareDue, dueTimeOf, isMineOrShared, isTop, moveChange, relationshipsWithoutNextStep } from './logic.js';

export { MONTH_PRIORITY_LIMIT };

// ---- weeks and months ------------------------------------------------------------------------------

/** The seven days of the week starting `monday`. */
export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const fmt = (ymd, opts) => parseLocalDate(ymd).toLocaleDateString(undefined, opts);

/** "Oct 5 – 11, 2026" (or "Sep 28 – Oct 4, 2026", "Dec 28, 2026 – Jan 3, 2027"). */
export function weekLabel(monday) {
  const sunday = addDays(monday, 6);
  const sameYear = monday.slice(0, 4) === sunday.slice(0, 4);
  const sameMonth = monday.slice(0, 7) === sunday.slice(0, 7);
  if (!sameYear) return `${fmt(monday, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmt(sunday, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const start = fmt(monday, { month: 'short', day: 'numeric' });
  const end = sameMonth ? fmt(sunday, { day: 'numeric' }) : fmt(sunday, { month: 'short', day: 'numeric' });
  return `${start} – ${end}, ${sunday.slice(0, 4)}`;
}

/** "October 2026". */
export function monthLabel(first) {
  return fmt(first, { month: 'long', year: 'numeric' });
}

/** "Mon 5" — a day in the week strip. */
export function dayShort(ymd) {
  return fmt(ymd, { weekday: 'short', day: 'numeric' });
}

/**
 * The month a week belongs to (for the monthly plan's "week goals of the month"): the month its
 * Thursday is in, so a week split across two months counts once, where most of its days are.
 */
export function weekMonth(monday) {
  return monthStart(addDays(weekStart(monday), 3));
}

/** The Mondays of the weeks that belong to the month starting `first` (weekMonth). */
export function weeksOfMonth(first) {
  const out = [];
  for (let d = weekStart(first); ; d = addDays(d, 7)) {
    const m = weekMonth(d);
    if (m > first) return out;
    if (m === first) out.push(d);
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (v) => {
  if (!YMD.test(v ?? '')) return false;
  try {
    return addDays(v, 0) === v;
  } catch {
    return false;
  }
};

/** A `?week=` value as the Monday of its week (any day snaps to its Monday); this week when missing or bad. */
export function weekParam(value, today) {
  return weekStart(validYmd(value) ? value : today);
}

/** A `?month=` value ("2026-10" or any day of it) as its 1st; this month when missing or bad. */
export function monthParam(value, today) {
  const v = /^\d{4}-\d{2}$/.test(value ?? '') ? `${value}-01` : value;
  return monthStart(validYmd(v) ? v : today);
}

export { addMonthStarts };

// ---- goals --------------------------------------------------------------------------------------

/** A goal's owner from the record (null = no one in particular: shown as shared). */
export function goalOwner(goal) {
  return goal?.owner ?? SHARED;
}

/** Order inside a business's goals of one period: position (unset last), then when made. */
export function compareGoals(a, b) {
  const ap = Number.isSafeInteger(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
  const bp = Number.isSafeInteger(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
  if (ap !== bp) return ap - bp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The goals of one kind and period (snapped: goalPeriodOf), in order. */
export function goalsOf(goals, kind, period) {
  return goals.filter((g) => g.kind === kind && goalPeriodOf(g) === period).sort(compareGoals);
}

/** Businesses as a plan lists them: by position; archived ones only when they have goals here. */
export function planBusinesses(businesses, goals = []) {
  const withGoals = new Set(goals.map((g) => g.business_id));
  return businesses.filter((b) => !b.archived || withGoals.has(b.id))
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || String(a.name).localeCompare(String(b.name)));
}

/** goals grouped by business: Map<business_id, goal[]> (each list in order). */
export function goalsByBusiness(goals) {
  const m = new Map();
  for (const g of [...goals].sort(compareGoals)) {
    const list = m.get(g.business_id);
    if (list) list.push(g);
    else m.set(g.business_id, [g]);
  }
  return m;
}

/** Progress against the target: { progress, target, pct (0–100, null without a target), label }. */
export function goalProgress(goal) {
  const progress = Number.isFinite(goal?.progress) ? goal.progress : 0;
  const target = Number.isFinite(goal?.target) && goal.target > 0 ? goal.target : null;
  const n = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
  if (target === null) return { progress, target, pct: null, label: progress ? `${n(progress)} so far` : '' };
  return { progress, target, pct: Math.max(0, Math.min(100, Math.round((progress / target) * 100))), label: `${n(progress)} of ${n(target)}` };
}

/**
 * Month priorities above the limit (three a business): [{ businessId, count }]. Warned about on
 * screen, never refused — two devices adding one offline must not lose either.
 */
export function priorityOverflow(priorities) {
  const counts = new Map();
  for (const g of priorities) counts.set(g.business_id, (counts.get(g.business_id) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > MONTH_PRIORITY_LIMIT).map(([businessId, count]) => ({ businessId, count }));
}

/** The next position at the end of a list of goals. */
export function nextPosition(list) {
  return list.reduce((max, g) => (Number.isSafeInteger(g.position) && g.position > max ? g.position : max), -1) + 1;
}

/**
 * Moving goal `id` one place up (-1) or down (+1) in `list` (one business's goals of a period, in
 * order): the position changes to write, only those that differ ([{ id, position }]). Positions
 * become 0, 1, 2… in the new order (goals without one get one).
 */
export function reorderChanges(list, id, dir) {
  const order = [...list].sort(compareGoals);
  const i = order.findIndex((g) => g.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [];
  [order[i], order[j]] = [order[j], order[i]];
  return order.map((g, position) => ({ id: g.id, position })).filter((c, k) => order[k].position !== c.position);
}

/**
 * Last period's unfinished goals to offer for carrying over into `to`: not done, and not carried
 * into `to` already (a goal there has carried_from = its id). The old goal is left as it was.
 * @param {object[]} goals every live goal
 * @param {{ kind: 'week'|'month', from: string, to: string }} periods
 */
export function carryOverCandidates(goals, { kind, from, to }) {
  const carried = new Set(goals.filter((g) => g.kind === kind && goalPeriodOf(g) === to && g.carried_from).map((g) => g.carried_from));
  return goalsOf(goals, kind, from).filter((g) => !g.done_at && !carried.has(g.id));
}

/**
 * The new goal a carry-over makes in `period`: the same business, title, target, progress so far
 * (it is the same goal, continued), owner (or the person carrying it) and notes, at the end of its
 * business's list, remembering where it came from.
 */
export function carryFields(goal, period, { me, position = null }) {
  return {
    kind: goal.kind,
    period,
    business_id: goal.business_id,
    title: goal.title,
    target: goal.target ?? null,
    progress: goal.progress ?? null,
    owner: goal.owner ?? me ?? null,
    notes: goal.notes ?? null,
    position,
    carried_from: goal.id,
  };
}

/**
 * The goals a task's "Part of" picker offers: this week's and next week's goals, this month's
 * and next month's priorities (and the week and month of the task's own date), plus the task's
 * current goal wherever it is. [{ value, label, group }] in that order.
 */
export function goalChoices(goals, { today, dueDate = null, current = null, businessesById = new Map() }) {
  const weeks = new Set([weekStart(today), addDays(weekStart(today), 7)]);
  const months = new Set([monthStart(today), addMonthStarts(today, 1)]);
  if (dueDate && validYmd(dueDate)) {
    weeks.add(weekStart(dueDate));
    months.add(monthStart(dueDate));
  }
  const thisWeek = weekStart(today);
  const thisMonth = monthStart(today);
  const label = (g) => `${businessesById.get(g.business_id)?.name ?? 'Unknown business'} — ${g.title}${g.done_at ? ' (done)' : ''}`;
  const weekGroup = (p) => (p === thisWeek ? 'This week’s goals' : p === addDays(thisWeek, 7) ? 'Next week’s goals' : `Week of ${weekLabel(p)}`);
  const monthGroup = (p) => (p === thisMonth ? 'This month’s priorities' : `${monthLabel(p)} priorities`);
  const out = [];
  const seen = new Set();
  for (const p of [...weeks].sort()) {
    for (const g of goalsOf(goals, 'week', p)) {
      seen.add(g.id);
      out.push({ value: g.id, label: label(g), group: weekGroup(p) });
    }
  }
  for (const p of [...months].sort()) {
    for (const g of goalsOf(goals, 'month', p)) {
      seen.add(g.id);
      out.push({ value: g.id, label: label(g), group: monthGroup(p) });
    }
  }
  const cur = current ? goals.find((g) => g.id === current) : null;
  if (cur && !seen.has(cur.id)) {
    const p = goalPeriodOf(cur);
    out.unshift({ value: cur.id, label: label(cur), group: cur.kind === 'month' ? monthGroup(p) : weekGroup(p) });
  }
  return out;
}

/**
 * The change that files a task under a goal: its goal, and the goal's business when the task was
 * filed under another (a task for "follow up 5 quiet wholesale customers" is wholesale work).
 */
export function goalChange(task, goal) {
  if (!goal) return { goal_id: null };
  return { goal_id: goal.id, ...(task.business_id !== goal.business_id ? { business_id: goal.business_id } : {}) };
}

// ---- tasks to sort -------------------------------------------------------------------------------

/**
 * Open tasks that belong to no day and no goal (isUnplannedTask), oldest first. whose: 'mine' (my
 * own and the shared list's), 'partner' (the other person's own), 'all'.
 */
export function unplannedTasks(tasks, { goalsById, me, whose = 'mine' }) {
  return tasks.filter((t) => {
    if (!isUnplannedTask(t, goalsById)) return false;
    if (whose === 'mine') return isMineOrShared(t, me);
    if (whose === 'partner') return t.owner !== me && t.owner !== SHARED;
    return true;
  }).sort(compareDue);
}

/** The quick days a task to sort can be given: Today, Tomorrow, and next Monday (or the one after). */
export function quickDays(today) {
  const monday = addDays(weekStart(today), 7);
  return [
    { day: today, label: 'Today' },
    { day: addDays(today, 1), label: 'Tomorrow' },
    ...(monday !== addDays(today, 1) ? [{ day: monday, label: 'Monday' }] : []),
  ];
}

// ---- the day's load and what to push ------------------------------------------------------------------

/** A person's day length (minutes) from the workday records (the default when theirs is missing). */
export function dayMinutesFor(workdays, actor) {
  const rec = workdays?.find?.((w) => w.id === WORKDAY_IDS[actor]);
  return dayMinutesOf(rec);
}

/**
 * The day a task counts on for `me`'s load: overdue ones and today's top picks on today, others on
 * their due date; null when it isn't on `me`'s days (done, the other person's own, or undated and
 * not picked). Each task counts on one day only.
 */
export function taskDay(task, today, me) {
  if (!isOpenTask(task) || !isMineOrShared(task, me)) return null;
  if (task.due_date && task.due_date < today) return today;
  if (isTop(task, today, me)) return today;
  return task.due_date ?? null;
}

/** Minutes planned per day from today on, for `me`: Map<day, minutes> (one pass over the tasks). */
export function loadsByDay(tasks, { me, today }) {
  const m = new Map();
  for (const t of tasks) {
    const day = taskDay(t, today, me);
    if (!day || !t.estimate_minutes) continue;
    m.set(day, (m.get(day) ?? 0) + t.estimate_minutes);
  }
  return m;
}

/**
 * One day's load for `me` (their own tasks and the shared list's that count on it — taskDay):
 * { day, minutes, dayMinutes, over, excess, tasks (in Today's order), unestimated (no estimate:
 * counted 0 and listed) }.
 */
export function dayLoad(tasks, { me, today, day = today, dayMinutes }) {
  const on = [];
  for (const t of tasks) if (taskDay(t, today, me) === day) on.push(t);
  on.sort(compareDue);
  const minutes = on.reduce((sum, t) => sum + (t.estimate_minutes || 0), 0);
  return {
    day, minutes, dayMinutes, over: minutes > dayMinutes, excess: Math.max(0, minutes - dayMinutes),
    tasks: on, unestimated: on.filter((t) => !t.estimate_minutes),
  };
}

/**
 * The first day after `from` with room for `minutes` more (its load + minutes ≤ the day length),
 * looking up to `limit` days ahead; a task longer than a whole day goes to the first empty day.
 */
export function nextDayWithRoom(loads, { from, minutes, dayMinutes, limit = 90 }) {
  const fits = (d) => (minutes > dayMinutes ? (loads.get(d) ?? 0) === 0 : (loads.get(d) ?? 0) + minutes <= dayMinutes);
  for (let i = 1; i <= limit; i += 1) {
    const d = addDays(from, i);
    if (fits(d)) return d;
  }
  return addDays(from, 1);
}

/**
 * Why a task is pushed before another (lower first): untimed before timed, not in `me`'s top 3
 * before a top pick, no goal or a week goal before a month priority, the latest-created first.
 */
export function pushOrder(today, me, goalsById) {
  const monthly = (t) => (t.goal_id && goalsById.get(t.goal_id)?.kind === 'month' ? 1 : 0);
  return (a, b) => ((dueTimeOf(a) ? 1 : 0) - (dueTimeOf(b) ? 1 : 0))
    || (Number(isTop(a, today, me)) - Number(isTop(b, today, me)))
    || (monthly(a) - monthly(b))
    || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * What to push off an overbooked day, in pushOrder, until it fits: [{ task, to }] where `to` is
 * the next day with room (counting the suggestions before it). Tasks without an estimate count 0
 * and are never suggested (moving them frees nothing). [] when the day fits.
 * @param {{ tasks: object[], me, today, day?, dayMinutes, goalsById?: Map }} args
 */
export function pushSuggestions({ tasks, me, today, day = today, dayMinutes, goalsById = new Map() }) {
  const load = dayLoad(tasks, { me, today, day, dayMinutes });
  if (!load.over) return [];
  const loads = loadsByDay(tasks, { me, today });
  const out = [];
  let left = load.minutes;
  for (const t of load.tasks.filter((x) => x.estimate_minutes > 0).sort(pushOrder(today, me, goalsById))) {
    if (left <= dayMinutes) break;
    const to = nextDayWithRoom(loads, { from: day, minutes: t.estimate_minutes, dayMinutes });
    loads.set(to, (loads.get(to) ?? 0) + t.estimate_minutes);
    left -= t.estimate_minutes;
    out.push({ task: t, to });
  }
  return out;
}

/** Moving a suggested task to its day: the date changes, `me`'s top pick for today goes (moveChange). */
export function pushChange(task, to, today, me) {
  return moveChange(task, to, today, me);
}

/** The week's days with their loads for `me`: [{ day, past, minutes, over, count }]. */
export function weekLoads(tasks, { me, today, monday, dayMinutes }) {
  const loads = new Map();
  const counts = new Map();
  for (const t of tasks) {
    const d = taskDay(t, today, me);
    if (!d) continue;
    counts.set(d, (counts.get(d) ?? 0) + 1);
    if (t.estimate_minutes) loads.set(d, (loads.get(d) ?? 0) + t.estimate_minutes);
  }
  return weekDays(monday).map((day) => {
    const minutes = loads.get(day) ?? 0;
    return { day, past: day < today, today: day === today, minutes, count: counts.get(day) ?? 0, over: day >= today && minutes > dayMinutes };
  });
}

// ---- the Friday review ---------------------------------------------------------------------------

/** "renewals due in the next 30 days", "quiet for 60 days". */
export const RENEWAL_DAYS = 30;
export const QUIET_DAYS = 60;

/** A moment's local calendar day ("2026-10-07"), or null. */
function dayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Overdue tasks of both people (and the shared list), oldest first. */
export function overdueTasks(tasks, today) {
  return tasks.filter((t) => isOpenTask(t) && t.due_date && t.due_date < today).sort(compareDue);
}

/** Services (not done or cancelled) whose renewal date is today or in the next 30 days, soonest first. */
export function renewalsDue(services, today, days = RENEWAL_DAYS) {
  const end = addDays(today, days);
  return services.filter((s) => s.renewal_date && s.renewal_date >= today && s.renewal_date <= end && !['done', 'cancelled'].includes(s.status))
    .sort((a, b) => (a.renewal_date < b.renewal_date ? -1 : a.renewal_date > b.renewal_date ? 1 : (a.id < b.id ? -1 : 1)));
}

/**
 * Active clients with no activity for 60 days: their last activity (C3b's map, client id -> `at`)
 * — or, with none, when the client was made — was 60 or more days ago. Longest quiet first.
 * [{ client, last (ISO or null), since (the day counted from) }].
 */
export function quietClients(clients, lastActivity, today, days = QUIET_DAYS) {
  const cutoff = addDays(today, -days);
  const out = [];
  for (const c of clients) {
    if (c.status !== 'active') continue;
    const last = lastActivity?.get(c.id) ?? null;
    const since = dayOf(last) ?? dayOf(c._sync?.createdAt) ?? null;
    if (since !== null && since > cutoff) continue;
    out.push({ client: c, last, since });
  }
  return out.sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')) || String(a.client.name).localeCompare(String(b.client.name)));
}

/**
 * Tasks one person could hand to the other on Friday: `who`'s own open tasks due by the end of next
 * week (overdue included) or with no date, in due order.
 */
export function handoffTasks(tasks, { who, today }) {
  const end = addDays(weekStart(today), 13);
  return tasks.filter((t) => isOpenTask(t) && t.owner === who && (!t.due_date || t.due_date <= end)).sort(compareDue);
}

/**
 * Everything the Friday review lists, from the device's copy:
 * overdue (both people), renewals (30 days), quiet clients (60 days), this week's goals (both
 * people, by business then order), the relationships with no next step (C4a's rule).
 */
export function reviewLists({ tasks, today, goals, services, clients, accounts, relationships, lastActivity, businesses = [] }) {
  const pos = new Map(businesses.map((b) => [b.id, b.position ?? 1e9]));
  const weekGoals = goalsOf(goals, 'week', weekStart(today))
    .sort((a, b) => (pos.get(a.business_id) ?? 1e9) - (pos.get(b.business_id) ?? 1e9) || compareGoals(a, b));
  return {
    overdue: overdueTasks(tasks, today),
    renewals: renewalsDue(services, today),
    quiet: quietClients(clients, lastActivity, today),
    weekGoals,
    noNextStep: relationshipsWithoutNextStep({ relationships, accounts, clients, tasks }),
  };
}

// ---- Focus -----------------------------------------------------------------------------------------

/**
 * The Focus queue: today's tasks for `me` in Today's order (overdue, due today, the rest of the top
 * 3 — buildToday), open ones. A task Focus was opened on that isn't one of today's goes first.
 */
export function focusQueue({ tasks, me, today, start = null }) {
  const { overdue, dueToday, picked } = buildToday({ tasks, me, today });
  const ids = [...overdue, ...dueToday, ...picked].map((t) => t.id);
  if (start && !ids.includes(start) && tasks.some((t) => t.id === start)) ids.unshift(start);
  return ids;
}

/**
 * The task after `current` in the queue that is still to do (open, not skipped), wrapping round to
 * the start; null when none is left.
 * @param {string[]} ids the queue
 * @param {(id: string) => boolean} isLeft whether a task is still to do
 */
export function nextInQueue(ids, current, isLeft) {
  const i = ids.indexOf(current);
  for (let k = 1; k <= ids.length; k += 1) {
    const id = ids[(Math.max(i, -1) + k + ids.length) % ids.length];
    if (id !== current && isLeft(id)) return id;
  }
  return null;
}

/** The task before `current` that is still to do (wrapping), or null. */
export function previousInQueue(ids, current, isLeft) {
  return nextInQueue([...ids].reverse(), current, isLeft);
}

export { weekStart, monthStart, addDays, weekday };
