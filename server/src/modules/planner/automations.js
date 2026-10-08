// The planner's automations (C8), registered with the automations framework:
//   friday-review   every Friday at 8:00 — one "Friday review" task on the shared list, with the
//                   review's numbers in its notes (alert by default)
//   no-next-step    every day at 7:30 — a "Set the next step for <account> (<business>)" task for
//                   each active relationship with no dated next step (silent by default)
// Both only create tasks (and, when set to alert, an in-app alert): "they prepare, you approve".
// Reads go through this module's own tables and the CRM's service; writes through sync (the
// framework's create() = sync.applyLocal as 'system'), so devices pull the tasks like any other.
// See CLAUDE.md, "Automations (C8)".
import { addDays, weekStart, relationshipsWithoutNextStep, SHARED } from '@suite/shared/planner';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate, parseLocalDate } from '@suite/shared/time';

export const REVIEW_TITLE = 'Friday review';
export const REVIEW_MINUTES = 15;
export const RENEWAL_DAYS = 30;
export const QUIET_DAYS = 60;
/** At most this many "Set the next step" tasks a run; the rest wait (one summary task counts them). */
export const NEXT_STEP_CAP = 10;
/** Titles listed in an alert's body before "and N more". */
export const ALERT_LIST_MAX = 5;
const SUMMARY_KEY = 'over-the-cap';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A stored moment's local calendar day, or null. */
function dayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localDate(d);
}

/** "Friday, Oct 9" for a calendar day. */
const dayText = (ymd, { weekday = true } = {}) => parseLocalDate(ymd)
  .toLocaleDateString('en-CA', { ...(weekday ? { weekday: 'long' } : {}), month: 'short', day: 'numeric' });

/** "Fri, Oct 9, 8:00 a.m." in the server's local time. */
function momentText(date) {
  const day = date.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
  const h = date.getHours();
  return `${day}, ${h % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

/**
 * The Friday review's numbers, read on the server the way the review page (reviewLists in
 * client/src/modules/planner/plan.js) reads them on a device: overdue tasks (both people and the
 * shared list), renewals in the next 30 days, active clients quiet for 60 days (their last
 * activity, or when they were made), relationships with no next step (C4a's rule), and this
 * week's goals done.
 */
export function reviewNumbers({ crm, planner, services = null }, today) {
  const rels = crm.liveRelationships();
  const accounts = [...new Map(rels.map((r) => [r.account_id, { id: r.account_id, client_id: r.client_id }])).values()];
  const clients = [...new Set(rels.map((r) => r.client_id))].map((id) => ({ id }));
  const cutoff = addDays(today, -QUIET_DAYS);
  // D1: an Order Manager order counts as activity (read through the wholesale service, like the devices do).
  const lastOrders = services?.wholesale?.lastOrderAtByClient?.() ?? new Map();
  const quiet = crm.activeClientsWithLastActivity().filter((c) => {
    const order = lastOrders.get(c.id) ?? null;
    const latest = c.last_activity_at && (!order || c.last_activity_at > order) ? c.last_activity_at : order;
    const since = dayOf(latest) ?? dayOf(c.created_at);
    return since === null || since <= cutoff;
  });
  const goals = planner.goals('week', weekStart(today));
  return {
    overdue: planner.overdueCount(today),
    renewals: crm.renewalsBetween(today, addDays(today, RENEWAL_DAYS)).length,
    quiet: quiet.length,
    noNextStep: relationshipsWithoutNextStep({ relationships: rels, accounts, clients, tasks: planner.openRelationshipTasks() }).length,
    goals: goals.length,
    goalsDone: goals.filter((g) => g.done_at).length,
  };
}

export function reviewLines(n) {
  return [
    `• ${plural(n.overdue, 'overdue task')} (both of you and the shared list)`,
    `• ${plural(n.renewals, 'renewal')} in the next ${RENEWAL_DAYS} days`,
    `• ${plural(n.quiet, 'active client')} quiet for ${QUIET_DAYS} days`,
    `• ${plural(n.noNextStep, 'active relationship')} with no next step`,
    `• This week’s goals: ${n.goalsDone} of ${n.goals} done`,
  ];
}

/**
 * The relationships "no next step" makes a task for: C4a's rule (active, live, no open task naming
 * it with a due date) on live rows, **and** the client is active (a closed client's relationships
 * are left alone — closing a client is how you say "no next steps"). Paused and ended
 * relationships are never flagged by the rule.
 */
export function relationshipsToChase({ crm, planner }) {
  // Archived businesses are retired: their relationships get no new tasks.
  const rels = crm.liveRelationships().filter((r) => !r.business_archived);
  const accounts = [...new Map(rels.map((r) => [r.account_id, { id: r.account_id, client_id: r.client_id }])).values()];
  const clients = [...new Map(rels.filter((r) => r.client_status === 'active').map((r) => [r.client_id, { id: r.client_id }])).values()];
  return relationshipsWithoutNextStep({ relationships: rels, accounts, clients, tasks: planner.openRelationshipTasks() });
}

/** Register both with the automations framework. `planner` is this module's service. */
export function registerPlannerAutomations({ automations, crm, planner, services = null }) {
  automations.register({
    id: 'friday-review',
    name: 'Friday review list',
    module: 'planner',
    description: 'Puts a “Friday review” task on the shared list for this Friday, with the review’s numbers in its notes: '
      + 'overdue tasks, renewals in 30 days, quiet clients and relationships with no next step. Once a week.',
    trigger: { type: 'schedule', every: 'week', day: 'fri', at: '08:00' },
    defaults: { enabled: true, alert: true },
    alertLink: '/plan/review',
    run(_ctx, { now, today, period, trigger, made, create, update }) {
      const numbers = () => reviewNumbers({ crm, planner, services }, today);
      const notesFor = (lines) => [
        `Prepared by the suite on ${momentText(now)} for the two of you (about ${REVIEW_MINUTES} minutes).`,
        'Open it in the suite: Plan → Friday review (/plan/review).',
        '',
        ...lines,
      ].join('\n');
      const counts = (n) => `${n.overdue} overdue, ${n.renewals} renewals, ${n.quiet} quiet, ${n.noNextStep} with no next step`;
      const existing = made(period.key).map((m) => ({ ...m, state: planner.taskState(m.id) })).filter((m) => m.state?.live);
      if (existing.length) {
        // Made earlier in the week (Run now): Friday's scheduled run refreshes its numbers, so the
        // review starts from that morning's, and still raises the alert when set to alert.
        const open = existing.find((m) => m.state.open);
        if (trigger !== 'schedule' || !open) {
          return { summary: `This week’s review task is already there (week of ${dayText(period.start, { weekday: false })})` };
        }
        const n = numbers();
        const lines = reviewLines(n);
        update('task', open.id, { notes: notesFor(lines) });
        return {
          summary: `Updated this week’s review with today’s numbers: ${counts(n)}`,
          alert: { title: 'The Friday review is ready', body: lines.join('\n'), link: '/plan/review' },
        };
      }
      const n = numbers();
      const lines = reviewLines(n);
      create('task', {
        title: REVIEW_TITLE,
        notes: notesFor(lines),
        // Done together, so always the shared list (whatever Personal's default owner becomes).
        owner: SHARED,
        business_id: BUSINESS_IDS.personal,
        due_date: period.day,
        estimate_minutes: REVIEW_MINUTES,
      }, { key: period.key });
      return {
        summary: `Made the Friday review for ${dayText(period.day)}: ${counts(n)}`,
        alert: { title: 'The Friday review is ready', body: lines.join('\n'), link: '/plan/review' },
      };
    },
  });

  automations.register({
    id: 'no-next-step',
    name: 'Relationships with no next step',
    module: 'planner',
    description: 'For each active relationship with no dated next step, makes a task “Set the next step for … ” due today, '
      + 'for the business’s default owner — at most 10 a day, oldest first (one summary task counts the rest). Never a second '
      + 'one while its task is open; nothing for closed clients or archived businesses. Off until you switch it on.',
    trigger: { type: 'schedule', every: 'day', at: '07:30' },
    // Off until someone switches it on: on a database with many clients its first run would
    // otherwise meet every relationship at once (see NEXT_STEP_CAP).
    defaults: { enabled: false, alert: false },
    alertLink: '/',
    run(_ctx, { now, today, made, create, update }) {
      const flagged = relationshipsToChase({ crm, planner });
      // "Never twice while one of its tasks is open": a task made earlier for this relationship that
      // is still open — and still names it (re-filed under another one, it no longer counts) —
      // keeps it from getting another, even when moved to no date (which flags it again).
      const hasOpen = (r) => made(r.id).some((m) => {
        const st = planner.taskState(m.id);
        return st?.open && st.relationshipId === r.id;
      });
      const due = flagged.filter((r) => !hasOpen(r));
      const waiting = flagged.length - due.length;
      // Oldest relationships first; at most NEXT_STEP_CAP tasks a run (a small transaction, and a
      // Today that stays usable). The rest wait for the next runs, counted on one summary task.
      due.sort((a, b) => String(a.created_at ?? '\uffff').localeCompare(String(b.created_at ?? '\uffff')) || (a.id < b.id ? -1 : 1));
      const batch = due.slice(0, NEXT_STEP_CAP);
      const rest = due.length - batch.length;
      const titles = [];
      for (const r of batch) {
        const title = `Set the next step for ${r.account_name} (${r.business_name})`;
        create('task', {
          title: title.slice(0, 300),
          owner: planner.automatedOwnerFor(r.business_id),
          business_id: r.business_id,
          client_id: r.client_id,
          account_id: r.account_id,
          relationship_id: r.id,
          due_date: today,
        }, { key: r.id });
        titles.push(title);
      }
      const summaryNote = summaryTask({ made, create, update, planner, rest, today, now });
      const still = waiting ? ` (${plural(waiting, 'relationship')} still ${waiting === 1 ? 'has its' : 'have their'} task open)` : '';
      const more = rest ? `; ${rest.toLocaleString('en-CA')} more waiting${summaryNote}` : '';
      if (!titles.length) {
        return { summary: flagged.length ? `Nothing new${still}` : 'Every active relationship has a next step' };
      }
      return {
        summary: `Made ${plural(titles.length, 'task')}${more}${still}`,
        alert: {
          title: `${plural(titles.length + rest, 'relationship')} ${titles.length + rest === 1 ? 'needs' : 'need'} a next step`,
          body: listBody(titles, rest),
          link: '/',
        },
      };
    },
  });
}

/**
 * The one task that stands for the relationships over the cap: "N more relationships have no next
 * step", on the shared list (Personal), due today, pointing at the lists on Today and the review.
 * Made once and kept up to date while open (title, notes, day); finished by the suite when nothing
 * is left over (it is its own counter, not someone's work). Returns a note for the run summary.
 */
function summaryTask({ made, create, update, planner, rest, today, now }) {
  const open = made(SUMMARY_KEY).find((m) => planner.taskState(m.id)?.open);
  if (!rest) {
    if (open) update('task', open.id, { done_at: now.toISOString() });
    return '';
  }
  const title = `${plural(rest, 'more relationship')} ${rest === 1 ? 'has' : 'have'} no next step`;
  const notes = [
    `The suite makes at most ${NEXT_STEP_CAP} “Set the next step” tasks a day, oldest relationships first, so Today isn’t flooded.`,
    `${rest.toLocaleString('en-CA')} more are waiting: see Today → No next step, or Plan → Friday review (/plan/review).`,
    `Counted on ${momentText(now)}.`,
  ].join('\n');
  if (open) {
    const t = planner.taskState(open.id);
    if (t.title !== title || t.dueDate !== today) update('task', open.id, { title, notes, due_date: today });
    return ' (counted on one summary task)';
  }
  create('task', { title, notes, owner: SHARED, business_id: BUSINESS_IDS.personal, due_date: today }, { key: SUMMARY_KEY });
  return ' (one summary task made)';
}

/** The first few lines, then "and N more" — an alert's body stays short whatever the count. */
export function listBody(titles, extra = 0, show = ALERT_LIST_MAX) {
  const shown = titles.slice(0, show);
  const more = titles.length - shown.length + extra;
  return [...shown, ...(more ? [`and ${more.toLocaleString('en-CA')} more`] : [])].join('\n');
}
