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
export function reviewNumbers({ crm, planner }, today) {
  const rels = crm.liveRelationships();
  const accounts = [...new Map(rels.map((r) => [r.account_id, { id: r.account_id, client_id: r.client_id }])).values()];
  const clients = [...new Set(rels.map((r) => r.client_id))].map((id) => ({ id }));
  const cutoff = addDays(today, -QUIET_DAYS);
  const quiet = crm.activeClientsWithLastActivity().filter((c) => {
    const since = dayOf(c.last_activity_at) ?? dayOf(c.created_at);
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
  const rels = crm.liveRelationships();
  const accounts = [...new Map(rels.map((r) => [r.account_id, { id: r.account_id, client_id: r.client_id }])).values()];
  const clients = [...new Map(rels.filter((r) => r.client_status === 'active').map((r) => [r.client_id, { id: r.client_id }])).values()];
  return relationshipsWithoutNextStep({ relationships: rels, accounts, clients, tasks: planner.openRelationshipTasks() });
}

/** Register both with the automations framework. `planner` is this module's service. */
export function registerPlannerAutomations({ automations, crm, planner }) {
  automations.register({
    id: 'friday-review',
    name: 'Friday review list',
    module: 'planner',
    description: 'Puts a “Friday review” task on the shared list for this Friday, with the review’s numbers in its notes: '
      + 'overdue tasks, renewals in 30 days, quiet clients and relationships with no next step. Once a week.',
    trigger: { type: 'schedule', every: 'week', day: 'fri', at: '08:00' },
    defaults: { enabled: true, alert: true },
    alertLink: '/plan/review',
    run(_ctx, { now, today, period, made, create }) {
      const existing = made(period.key).filter((m) => planner.taskState(m.id)?.live);
      if (existing.length) return { summary: `This week’s review task is already there (week of ${dayText(period.start, { weekday: false })})` };
      const numbers = reviewNumbers({ crm, planner }, today);
      const lines = reviewLines(numbers);
      const notes = [
        `Prepared by the suite on ${momentText(now)} for the two of you (about ${REVIEW_MINUTES} minutes).`,
        'Open it in the suite: Plan → Friday review (/plan/review).',
        '',
        ...lines,
      ].join('\n');
      create('task', {
        title: REVIEW_TITLE,
        notes,
        // Done together, so always the shared list (whatever Personal's default owner becomes).
        owner: SHARED,
        business_id: BUSINESS_IDS.personal,
        due_date: period.day,
        estimate_minutes: REVIEW_MINUTES,
      }, { key: period.key });
      return {
        summary: `Made the Friday review for ${dayText(period.day)}: ${numbers.overdue} overdue, ${numbers.renewals} renewals, `
          + `${numbers.quiet} quiet, ${numbers.noNextStep} with no next step`,
        alert: { title: 'The Friday review is ready', body: lines.join('\n'), link: '/plan/review' },
      };
    },
  });

  automations.register({
    id: 'no-next-step',
    name: 'Relationships with no next step',
    module: 'planner',
    description: 'For each active relationship with no dated next step, makes a task “Set the next step for … ” due today, '
      + 'for the business’s default owner. Never a second one while its task is open; nothing for closed clients.',
    trigger: { type: 'schedule', every: 'day', at: '07:30' },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, { today, made, create }) {
      const flagged = relationshipsToChase({ crm, planner });
      const titles = [];
      let waiting = 0;
      for (const r of flagged) {
        // "Never twice while one of its tasks is open": a task made earlier for this relationship
        // that is still open (e.g. moved to no date, which flags the relationship again) counts.
        if (made(r.id).some((m) => planner.taskState(m.id)?.open)) {
          waiting += 1;
          continue;
        }
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
      const still = waiting ? ` (${plural(waiting, 'relationship')} still ${waiting === 1 ? 'has its' : 'have their'} task open)` : '';
      if (!titles.length) {
        return { summary: flagged.length ? `Nothing new${still}` : 'Every active relationship has a next step' };
      }
      return {
        summary: `Made ${plural(titles.length, 'task')}${still}`,
        alert: {
          title: `${plural(titles.length, 'relationship')} ${titles.length === 1 ? 'needs' : 'need'} a next step`,
          body: titles.join('\n'),
          link: '/',
        },
      };
    },
  });
}
