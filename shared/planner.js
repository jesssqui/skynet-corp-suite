// Planner facts shared by the server and devices: the value lists of tasks and inbox items,
// the "HH:MM" due time, who an automated task goes to and the "no next step" rule (C4a); goals,
// their periods, calendar-day arithmetic, each person's day length and "unplanned" (C4b). The
// record types themselves are registered by the server's planner module
// (server/src/modules/planner/entities.js) and reach devices through GET /api/sync/info.
// See CLAUDE.md, "Planner (C4a)" and "Planning (C4b)".
import { ACTORS, OWNERS, SHARED } from './actors.js';

export { OWNERS, SHARED };

/**
 * Today's top 3 is per person: a task holds the day each person picked it (`top_on_owner`,
 * `top_on_partner`), so a shared task can be one of both people's picks and one person's star never
 * fills the other's three. actor -> field.
 */
export const TOP_FIELDS = Object.freeze(Object.fromEntries(ACTORS.map((a) => [a, `top_on_${a}`])));

/** The field holding `actor`'s pick day ('top_on_owner' | 'top_on_partner'). */
export function topField(actor) {
  const f = TOP_FIELDS[actor];
  if (!f) throw new TypeError(`Not a person: ${actor}`);
  return f;
}

/** The planner's synced record types (entity names). */
export const PLANNER_ENTITY_NAMES = Object.freeze(['task', 'inbox_item', 'goal', 'workday']);

/** Where an inbox item was captured: typed (on the Mac), phone, Siri or the share sheet (C5). */
export const INBOX_SOURCES = Object.freeze(['typed', 'phone', 'siri', 'share']);

/** What an inbox item became (`became_entity`; free text on the record): D8 added 'lead'. */
export const INBOX_BECAME = Object.freeze(['task', 'activity', 'lead']);

export const TASK_TITLE_MAX = 300;
export const INBOX_TEXT_MAX = 5000;
/** A task's estimate is 1 minute to a working week. */
export const ESTIMATE_MAX_MINUTES = 60 * 24 * 7;
/** A person's day length when they haven't set one (C4b: each person's `workday.day_minutes`). */
export const DEFAULT_DAY_MINUTES = 8 * 60;
/** @deprecated C4a's name for DEFAULT_DAY_MINUTES. */
export const DAY_MINUTES = DEFAULT_DAY_MINUTES;
/** A day length is 30 minutes to 24 hours. */
export const DAY_MINUTES_MIN = 30;
export const DAY_MINUTES_MAX = 24 * 60;

// ---- goals (C4b) ---------------------------------------------------------------------------------
// A goal is a week goal ("finish the Lefty's homepage") or a month priority (one to three per
// business a month). Its `period` is the Monday of its week or the 1st of its month.

export const GOAL_KINDS = Object.freeze(['week', 'month']);
export const GOAL_TITLE_MAX = 300;
/** One to three priorities per business a month: more is warned about, never refused. */
export const MONTH_PRIORITY_LIMIT = 3;

/**
 * Each person's planner settings (the day length the overbooking warning uses) live in one
 * `workday` record per person, with a fixed id, made by the server at start (never by a device:
 * two phones creating "my settings" offline would make two). Devices only update it.
 */
export const WORKDAY_IDS = Object.freeze({
  owner: '01a1163c-1b00-7000-8000-00000000a001',
  partner: '01a1163c-1b00-7000-8000-00000000a002',
});

/** The day length (minutes) from a person's workday record (the default when unset). */
export function dayMinutesOf(workday) {
  const m = workday?.day_minutes;
  return Number.isSafeInteger(m) && m >= DAY_MINUTES_MIN && m <= DAY_MINUTES_MAX ? m : DEFAULT_DAY_MINUTES;
}

// ---- calendar days ("YYYY-MM-DD", the local calendar, compared as text) ---------------------------
// Arithmetic is done on the calendar with Date.UTC (no time zone, no DST): never new Date('YYYY-MM-DD').

function ymdParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  if (!m) throw new TypeError(`Not a YYYY-MM-DD date: ${ymd}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** "2026-10-07" + n days on the calendar (month and year ends, leap days). */
export function addDays(ymd, n) {
  const [y, m, d] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Day of the week, Monday = 0 … Sunday = 6. */
export function weekday(ymd) {
  const [y, m, d] = ymdParts(ymd);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday of the week `ymd` is in (weeks run Monday to Sunday). */
export function weekStart(ymd) {
  return addDays(ymd, -weekday(ymd));
}

/** The 1st of the month `ymd` is in. */
export function monthStart(ymd) {
  ymdParts(ymd);
  return `${ymd.slice(0, 8)}01`;
}

/** The 1st of the month `n` months after the one `ymd` is in. */
export function addMonthStarts(ymd, n) {
  const [y, m] = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}

/**
 * The month a day plans in: the month its week's Thursday is in. One rule everywhere ("this month"
 * on the Monday plan, a task's "Part of" choices, the morning plan, the monthly plan's default and
 * its week goals): a week split across two months belongs to the one with most of its days, so on
 * Wed Sep 30 and Thu Oct 1 (the week of Sep 28) "this month" is October — planned on the first
 * Monday, as the plan says.
 */
export function planMonth(ymd) {
  return monthStart(addDays(weekStart(ymd), 3));
}

/** The period a goal of `kind` covering the day `ymd` has: its week's Monday, or its month's 1st. */
export function goalPeriod(kind, ymd) {
  return kind === 'month' ? monthStart(ymd) : weekStart(ymd);
}

/** Is `period` a valid period for a goal of `kind` (a Monday for 'week', a 1st for 'month')? */
export function isGoalPeriod(kind, period) {
  if (!GOAL_KINDS.includes(kind) || typeof period !== 'string') return false;
  try {
    return goalPeriod(kind, period) === period;
  } catch {
    return false;
  }
}

/**
 * A goal's period as readers use it: snapped to its kind (a clash settled field by field could in
 * theory leave a week goal with a 1st that isn't a Monday — it counts for the week that day is in).
 */
export function goalPeriodOf(goal) {
  if (!goal?.period) return null;
  try {
    return goalPeriod(goal.kind === 'month' ? 'month' : 'week', goal.period);
  } catch {
    return null;
  }
}

const DUE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "09:30" -> true; "9:30", "24:00", "" -> false. A task's time of day, local, with its due date. */
export function isDueTime(value) {
  return typeof value === 'string' && DUE_TIME_RE.test(value);
}

/**
 * Who a task made by an automation (D packages: orders, renewals, payments…) goes to: the
 * business's `default_owner` (owner | partner | shared), or the shared list when it has none.
 * Tasks made by hand default to their maker instead (the screens do that).
 */
export function automatedTaskOwner(business) {
  return OWNERS.includes(business?.default_owner) ? business.default_owner : SHARED;
}

/** Open = not finished (done_at empty). */
export function isOpenTask(task) {
  return Boolean(task) && !task.done_at;
}

/**
 * A goal left behind: its period is before the current one (an earlier week for a week goal; an
 * earlier planning month — planMonth — for a month priority), done or not. Its open tasks no
 * longer belong anywhere current (a goal ticked done can still leave unfinished tasks).
 */
export function isStaleGoal(goal, today) {
  if (!goal || !today) return false;
  const period = goalPeriodOf(goal);
  if (!period) return false;
  return period < (goal.kind === 'month' ? planMonth(today) : weekStart(today));
}

/**
 * "Every task belongs to a day, a week goal or a month priority": an open task with no due date
 * and no live, current goal is unplanned — it waits to be sorted. No goal, a deleted one, or (with
 * `today` and goal records) a goal of an earlier period, done or not (isStaleGoal), all count.
 * @param {object} task
 * @param {Map<string, object>|Set<string>} liveGoals  the live goals by id (a Set: ids only, no staleness check)
 * @param {string|null} today  the device's local date ("YYYY-MM-DD")
 */
export function isUnplannedTask(task, liveGoals, today = null) {
  if (!isOpenTask(task) || task.due_date) return false;
  if (!task.goal_id || !liveGoals?.has(task.goal_id)) return true;
  const goal = typeof liveGoals.get === 'function' ? liveGoals.get(task.goal_id) : null;
  return goal && typeof goal === 'object' ? isStaleGoal(goal, today) : false;
}

/**
 * Relationship kinds the "no next step" rule leaves alone (D1): every account linked to an Order
 * Manager customer gets an active wholesale relationship, and wholesale customers are followed up
 * by their orders, not by a hand-set next step — until D3's wholesale check-ins exist, flagging them
 * would flood Today, the Friday review and the automation.
 */
export const NO_NEXT_STEP_EXEMPT_KINDS = Object.freeze(['wholesale']);

/**
 * "Every active relationship always has a next step": the active relationships whose account
 * and client are live, with no open task that names the relationship and has a due date.
 * Records are as a device or server read shows them (deleted ones left out): a relationship
 * whose account or client isn't in the lists is under a deleted record and isn't flagged.
 * @param {{ relationships: object[], accounts: object[], clients: object[], tasks: object[] }} records
 * @returns {object[]} the flagged relationships, in the order given
 */
export function relationshipsWithoutNextStep({ relationships = [], accounts = [], clients = [], tasks = [] }) {
  const clientIds = new Set(clients.map((c) => c.id));
  const accountClient = new Map(accounts.map((a) => [a.id, a.client_id]));
  const covered = new Set();
  for (const t of tasks) if (isOpenTask(t) && t.relationship_id && t.due_date) covered.add(t.relationship_id);
  return relationships.filter((r) => r.status === 'active'
    && !NO_NEXT_STEP_EXEMPT_KINDS.includes(r.kind)
    && accountClient.has(r.account_id)
    && clientIds.has(accountClient.get(r.account_id))
    && !covered.has(r.id));
}
