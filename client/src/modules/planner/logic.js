// The planner screens' logic, without React: due dates, the Today list, the morning plan, the
// tasks page's filters, defaults for a new task, and what an inbox item or a call's "next step"
// turns into. Pages build these once per data change (useMemo); tested in client/test/planner*.test.js.
//
// Dates are "YYYY-MM-DD" strings in the device's local calendar ("today" is localDate() on the
// device) and are compared as text; date arithmetic is done on the calendar (addDays), never with
// new Date('YYYY-MM-DD').
import { BUSINESS_IDS } from '@suite/shared/crm';
import { SHARED } from '@suite/shared/actors';
import { isDueTime, isOpenTask, ESTIMATE_MAX_MINUTES, DAY_MINUTES, relationshipsWithoutNextStep } from '@suite/shared/planner';
import { formatDate, parseLocalDate } from '../../ui/format.js';

export { DAY_MINUTES, relationshipsWithoutNextStep, isOpenTask };

// ---- dates -----------------------------------------------------------------------------------

/** "2026-10-07" + n days on the calendar (month and year ends, leap days). */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Monday and Sunday of the week `today` is in (weeks start on Monday, like the Monday plan). */
export function weekBounds(today) {
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const start = addDays(today, -((dow + 6) % 7));
  return { start, end: addDays(start, 6) };
}

/** The task's time of day, only when it has a date (a time left without one is ignored). */
export function dueTimeOf(task) {
  return task?.due_date && isDueTime(task.due_time) ? task.due_time : null;
}

/** 'overdue' | 'today' | 'upcoming' | 'none' (no date). Done tasks are judged the same way. */
export function dueState(task, today) {
  if (!task?.due_date) return 'none';
  if (task.due_date < today) return 'overdue';
  return task.due_date === today ? 'today' : 'upcoming';
}

/** "09:30" -> "9:30 AM" (the device's locale). */
export function formatTime(hhmm) {
  if (!isDueTime(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** A due date for a list row: "Today · 9:30 AM", "Tomorrow", "Yesterday", "Thu, Oct 9" (the year only when it isn’t this one). */
export function dueLabel(task, today) {
  if (!task?.due_date) return '';
  const time = dueTimeOf(task);
  let day;
  if (task.due_date === today) day = 'Today';
  else if (task.due_date === addDays(today, 1)) day = 'Tomorrow';
  else if (task.due_date === addDays(today, -1)) day = 'Yesterday';
  else if (task.due_date.slice(0, 4) === today.slice(0, 4)) day = shortDay(task.due_date);
  else day = formatDate(task.due_date, { weekday: true });
  return time ? `${day} · ${formatTime(time)}` : day;
}

/** "Thu, Oct 8" for a day the plan moves something to. */
export function shortDay(ymd) {
  return parseLocalDate(ymd).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---- estimates -------------------------------------------------------------------------------

/** 45 -> "45 min", 60 -> "1 h", 90 -> "1 h 30 min". */
export function formatMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** The estimate picker's choices (minutes), plus a record's own value when it isn't one of them. */
export const ESTIMATE_CHOICES = Object.freeze([5, 10, 15, 30, 45, 60, 90, 120, 180, 240, 360, 480]);
export function estimateOptions(current) {
  const values = [...ESTIMATE_CHOICES];
  const c = Number(current);
  if (current !== '' && current !== null && current !== undefined && Number.isSafeInteger(c) && !values.includes(c)) values.push(c);
  return values.sort((a, b) => a - b).map((v) => ({ value: String(v), label: formatMinutes(v) }));
}

// ---- who -----------------------------------------------------------------------------------------

/** A task's owner from the signed-in person's side: You / Partner / Shared. */
export function ownerLabel(owner, me) {
  if (owner === SHARED) return 'Shared';
  if (me && owner === me) return 'You';
  return 'Partner';
}

/** The other person's actor (owner <-> partner). */
export function otherActor(me) {
  return me === 'owner' ? 'partner' : 'owner';
}

/** Is this task on my lists: mine, or the shared list (never the other person's own)? */
export function isMineOrShared(task, me) {
  return task.owner === me || task.owner === SHARED;
}

// ---- ordering --------------------------------------------------------------------------------------

/**
 * Tasks in due order: by date (no date last), on the same date timed ones first in time order,
 * then the rest by when they were made (ids are UUIDv7: they sort by creation).
 */
export function compareDue(a, b) {
  const ad = a.due_date ?? '9999-99-99';
  const bd = b.due_date ?? '9999-99-99';
  if (ad !== bd) return ad < bd ? -1 : 1;
  const at = dueTimeOf(a) ?? '99:99';
  const bt = dueTimeOf(b) ?? '99:99';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const isTop = (task, today) => Boolean(task?.top_on) && task.top_on === today;

/**
 * The signed-in person's Today: their own tasks and the shared list (never the other person's own),
 * open ones — plus `keep` (ids finished this session, so a tick can be undone in place).
 *  - overdue: due before today, oldest first;
 *  - dueToday: due today, timed ones in time order, then the rest (top picks first);
 *  - picked: today's top picks not already above (no date, or due later).
 * Each task shows once; a top pick in overdue/dueToday is marked where it is (isTop).
 */
export function buildToday({ tasks, me, today, keep = new Set() }) {
  const overdue = [];
  const dueToday = [];
  const picked = [];
  for (const t of tasks) {
    if (!isMineOrShared(t, me)) continue;
    if (!isOpenTask(t) && !keep.has(t.id)) continue;
    const state = dueState(t, today);
    if (state === 'overdue') overdue.push(t);
    else if (state === 'today') dueToday.push(t);
    else if (isTop(t, today)) picked.push(t);
  }
  overdue.sort(compareDue);
  dueToday.sort((a, b) => {
    const at = dueTimeOf(a);
    const bt = dueTimeOf(b);
    if (at || bt) return compareDue(a, b);
    return (isTop(b, today) - isTop(a, today)) || compareDue(a, b);
  });
  picked.sort(compareDue);
  const topCount = tasks.filter((t) => isMineOrShared(t, me) && isOpenTask(t) && isTop(t, today)).length;
  return { overdue, dueToday, picked, topCount, total: overdue.length + dueToday.length + picked.length };
}

// ---- the morning plan -------------------------------------------------------------------------------

/**
 * What the morning plan proposes: overdue and due-today tasks on my Today (mine and the shared
 * list's), and my own open tasks with no date (the shared list's undated pile stays on Tasks: either
 * person may pick from it there). Ids, so the sheet keeps its rows while tasks are moved.
 * @returns {{ overdue: string[], dueToday: string[], undated: string[] }}
 */
export function proposePlan({ tasks, me, today }) {
  const { overdue, dueToday } = buildToday({ tasks, me, today });
  const undated = tasks.filter((t) => t.owner === me && isOpenTask(t) && !t.due_date)
    .sort((a, b) => (isTop(b, today) - isTop(a, today)) || compareDue(a, b));
  return { overdue: overdue.map((t) => t.id), dueToday: dueToday.map((t) => t.id), undated: undated.map((t) => t.id) };
}

/**
 * The day as planned: open tasks on my Today (overdue, due today, or picked as top today) and how
 * long they take by their estimates, against the day's length.
 */
export function planLoad({ tasks, me, today, dayMinutes = DAY_MINUTES }) {
  let minutes = 0;
  let count = 0;
  let unestimated = 0;
  for (const t of tasks) {
    if (!isMineOrShared(t, me) || !isOpenTask(t)) continue;
    if (!((t.due_date && t.due_date <= today) || isTop(t, today))) continue;
    count += 1;
    if (t.estimate_minutes) minutes += t.estimate_minutes;
    else unestimated += 1;
  }
  return { minutes, count, unestimated, dayMinutes, over: minutes > dayMinutes };
}

/** At most three top picks a day. */
export const TOP_LIMIT = 3;

/** The change that makes a task one of today's top picks, or not. */
export function topChange(task, today, on) {
  return { top_on: on ? today : (isTop(task, today) ? null : task.top_on ?? null) };
}

/**
 * Moving a task to another day: its date changes (its time of day stays) and it stops being one of
 * today's top picks. `undo` puts back what it was.
 */
export function moveChange(task, day, today) {
  return {
    change: { due_date: day, ...(isTop(task, today) ? { top_on: null } : {}) },
    undo: { due_date: task.due_date ?? null, ...(isTop(task, today) ? { top_on: task.top_on } : {}) },
  };
}

// ---- the tasks page ------------------------------------------------------------------------------------

export const OWNER_FILTERS = Object.freeze([
  { value: 'mine', label: 'Mine' },
  { value: 'partner', label: 'Partner’s' },
  { value: 'shared', label: 'Shared' },
  { value: 'all', label: 'All' },
]);

export const DUE_FILTERS = Object.freeze([
  { value: 'open', label: 'All open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'none', label: 'No date' },
  { value: 'done', label: 'Done' },
]);

/**
 * The tasks page's rows. owner: mine | partner | shared | all; business / client: an id or '' (any);
 * due: open (every open task) | overdue | today | week (due Monday–Sunday of this week) | none (no
 * date) | done. Open lists are in due order (overdue first, no date last); done is newest first.
 * `keep`: ids finished this session, still shown where they were (to undo a tick).
 */
export function filterTasks(tasks, { owner = 'all', business = '', client = '', due = 'open' } = {}, { me, today, keep = new Set() }) {
  const week = due === 'week' ? weekBounds(today) : null;
  const rows = tasks.filter((t) => {
    if (owner === 'mine' && t.owner !== me) return false;
    if (owner === 'shared' && t.owner !== SHARED) return false;
    if (owner === 'partner' && (t.owner === me || t.owner === SHARED)) return false;
    if (business && t.business_id !== business) return false;
    if (client && t.client_id !== client) return false;
    if (due === 'done') return !isOpenTask(t);
    if (!isOpenTask(t) && !keep.has(t.id)) return false;
    const state = dueState(t, today);
    if (due === 'overdue') return state === 'overdue';
    if (due === 'today') return state === 'today';
    if (due === 'none') return state === 'none';
    if (week) return Boolean(t.due_date) && t.due_date >= week.start && t.due_date <= week.end;
    return true;
  });
  if (due === 'done') return rows.sort((a, b) => (a.done_at === b.done_at ? (a.id < b.id ? 1 : -1) : (a.done_at < b.done_at ? 1 : -1)));
  return rows.sort(compareDue);
}

// ---- defaults ----------------------------------------------------------------------------------------

/**
 * The business a new task starts with: the one in context (the client page's timeline filter, a
 * relationship), else the last one this person used on this device, else Personal. Archived
 * businesses are skipped (except as the context itself), and so is one that no longer exists.
 */
export function defaultBusinessId({ context = null, lastUsed = null, businesses = [] }) {
  const live = new Map(businesses.map((b) => [b.id, b]));
  if (context && live.has(context)) return context;
  if (lastUsed && live.has(lastUsed) && !live.get(lastUsed).archived) return lastUsed;
  if (live.has(BUSINESS_IDS.personal)) return BUSINESS_IDS.personal;
  const first = businesses.filter((b) => !b.archived).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))[0];
  return first?.id ?? '';
}

/** A relationship as a picker shows it: "Great White North Design · Website — Green Leaf Dispensary". */
export function relationshipLabel(rel, { businessesById, accountsById, kindLabels = {} }) {
  const business = businessesById.get(rel.business_id)?.name ?? 'Unknown business';
  const account = accountsById.get(rel.account_id)?.name ?? 'Unknown account';
  return `${business} · ${kindLabels[rel.kind] ?? rel.kind} — ${account}`;
}

// ---- inbox ----------------------------------------------------------------------------------------------

/** Items still in the inbox, newest first. */
export function openInbox(items) {
  return items.filter((i) => !i.cleared_at)
    .sort((a, b) => (a.captured_at === b.captured_at ? (a.id < b.id ? 1 : -1) : (a.captured_at < b.captured_at ? 1 : -1)));
}

/** What capturing `text` saves (null when there is nothing to save). */
export function captureFields(text, { source, now }) {
  const t = String(text ?? '').trim();
  return t ? { text: t, source, captured_at: now } : null;
}

/** The inbox item once it became something (a task, a note) or was dismissed (entity null). */
export function clearedFields({ entity = null, id = null, now }) {
  return { cleared_at: now, became_entity: entity, became_id: id };
}

/** A captured line as a task title: its first line, cut to fit (the rest goes in the notes). */
export function titleFromText(text, max = 300) {
  const s = String(text ?? '').trim();
  const [first, ...rest] = s.split(/\r?\n/);
  const title = first.trim().length > max ? `${first.trim().slice(0, max - 1)}…` : first.trim();
  const notes = [first.trim().length > max ? first.trim() : null, rest.join('\n').trim() || null].filter(Boolean).join('\n');
  return { title, notes };
}

// ---- a call's next step -------------------------------------------------------------------------------

/**
 * The task a logged call or note sets as its next step, or nothing: title and date go together
 * (a next step is dated — that is what clears a relationship's "No next step" flag).
 * @param {{ title, date, relationshipId, accountId, businessId }} next  what the sheet holds
 * @param {{ clientId, me, relationshipsById, fallbackBusiness }} ctx
 * @returns {{ fields: object|null, problems: object }}
 */
export function nextStepFields(next, { clientId, me, relationshipsById = new Map(), fallbackBusiness = null }) {
  const title = String(next.title ?? '').trim();
  const date = next.date || '';
  if (!title && !date) return { fields: null, problems: {} };
  const problems = {};
  if (!title) problems.title = 'What is the next step?';
  if (!date) problems.date = 'Pick a day for the next step';
  if (title.length > 300) problems.title = 'Keep it under 300 characters';
  if (Object.keys(problems).length) return { fields: null, problems };
  const rel = next.relationshipId ? relationshipsById.get(next.relationshipId) : null;
  return {
    problems,
    fields: {
      title,
      owner: me,
      business_id: rel?.business_id ?? (next.businessId || fallbackBusiness),
      client_id: clientId,
      account_id: rel?.account_id ?? (next.accountId || null),
      relationship_id: rel?.id ?? null,
      due_date: date,
    },
  };
}

/**
 * The relationship a call's next step is for, when the call's account and business point at
 * exactly one active relationship — or, when neither is picked, the client's only active one: '' otherwise.
 */
export function guessRelationship(relationships, { accountId = '', businessId = '' }) {
  const active = relationships.filter((r) => r.status === 'active');
  const match = active.filter((r) => (!accountId || r.account_id === accountId) && (!businessId || r.business_id === businessId));
  if (accountId || businessId) return match.length === 1 ? match[0].id : '';
  return active.length === 1 ? active[0].id : '';
}

export { ESTIMATE_MAX_MINUTES };
