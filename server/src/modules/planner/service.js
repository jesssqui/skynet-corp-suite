// The planner: registers tasks and inbox items (C4a), goals and workdays (C4b) with sync, with the
// module's own checks, and makes each person's workday record at start.
// It never writes its tables itself: every change is a sync step (devices) or sync.applyLocal
// (server code) — the sync module's guard makes any other write fail. It reads only its own
// tables; the CRM records a task points at are reached through sync refs (and ctx.services.crm).
import {
  isDueTime, ESTIMATE_MAX_MINUTES, automatedTaskOwner, isGoalPeriod, WORKDAY_IDS, DAY_MINUTES_MIN, DAY_MINUTES_MAX,
} from '@suite/shared/planner';
import { ACTORS } from '@suite/shared/actors';
import { PLANNER_ENTITIES } from './entities.js';
import { registerPlannerAutomations } from './automations.js';

/**
 * Rules for a task step that are right in any arrival order: they look only at the step's own
 * values, never at the row a concurrent change may have left (CLAUDE.md, the `check` hook's limits).
 *  - due_time is "HH:MM";
 *  - a time needs a date: a create with a time and no date, or an update that sets a time and
 *    clears the date in the same step, is refused. (A time left behind when the other device
 *    clears the date concurrently is possible; readers ignore a time without a date.)
 *  - estimate_minutes is 1 … a week.
 */
export function checkTask({ op, fields }) {
  if (op === 'delete' || !fields) return null;
  const has = (k) => Object.hasOwn(fields, k);
  if (has('due_time') && fields.due_time !== null && !isDueTime(fields.due_time)) {
    return { code: 'invalid_value', reason: 'due_time: a time of day as "HH:MM" (24-hour)' };
  }
  const setsTime = has('due_time') && fields.due_time !== null;
  const noDate = op === 'create' ? !fields.due_date : has('due_date') && fields.due_date === null;
  if (setsTime && noDate) return { code: 'invalid_value', reason: 'due_time: a time needs a due date' };
  if (has('estimate_minutes') && fields.estimate_minutes !== null
    && !(fields.estimate_minutes >= 1 && fields.estimate_minutes <= ESTIMATE_MAX_MINUTES)) {
    return { code: 'invalid_value', reason: `estimate_minutes: 1 to ${ESTIMATE_MAX_MINUTES}` };
  }
  return null;
}

/**
 * Rules for a goal step (C4b), again only the step's own values:
 *  - `period` fits `kind`: a week goal's is the Monday of its week, a month priority's the 1st of
 *    its month;
 *  - an update changing either sends both, so the pair is checked together and the later step
 *    wins both fields (a step with only one of them could pair with the other device's change);
 *  - target is more than 0, progress 0 or more.
 * Month priorities above three a business are not refused: two devices adding one offline must
 * never lose one (the screens warn instead).
 */
export function checkGoal({ op, fields }) {
  if (op === 'delete' || !fields) return null;
  const has = (k) => Object.hasOwn(fields, k);
  if (op === 'update' && has('kind') !== has('period')) {
    return { code: 'invalid_value', reason: 'kind and period change together: send both' };
  }
  if (has('period') && !isGoalPeriod(fields.kind, fields.period)) {
    return {
      code: 'invalid_value',
      reason: fields.kind === 'month'
        ? 'period: a month priority’s period is the 1st of its month'
        : 'period: a week goal’s period is the Monday of its week',
    };
  }
  if (has('target') && fields.target !== null && !(fields.target > 0)) return { code: 'invalid_value', reason: 'target: more than 0' };
  if (has('progress') && fields.progress !== null && !(fields.progress >= 0)) return { code: 'invalid_value', reason: 'progress: 0 or more' };
  return null;
}

/**
 * Workdays: one per person, with its fixed id (WORKDAY_IDS) — a create with any other id is
 * refused (only the server's seed makes them), and an update never changes whose it is. A day
 * length is 30 minutes to 24 hours (null = the default).
 */
export function checkWorkday({ op, recordId, fields }) {
  if (!fields) return null;
  if (op === 'create' && recordId !== WORKDAY_IDS[fields.actor]) {
    return { code: 'invalid_value', reason: 'workday: one per person, with its fixed id (made by the server)' };
  }
  if (op === 'update' && Object.hasOwn(fields, 'actor')) return { code: 'invalid_value', reason: 'workday: actor can’t change' };
  if (!Object.hasOwn(fields, 'day_minutes') || fields.day_minutes === null) return null;
  const m = fields.day_minutes;
  return m >= DAY_MINUTES_MIN && m <= DAY_MINUTES_MAX ? null
    : { code: 'invalid_value', reason: `day_minutes: ${DAY_MINUTES_MIN} to ${DAY_MINUTES_MAX}` };
}

/** Workday seeds are stamped at an old fixed time, so any real edit (even re-sent after a restore) wins. */
export const WORKDAY_SEED_STAMP_MS = Date.UTC(2026, 0, 1);

export function createPlannerService({ db, services, log }) {
  const sync = services.sync;
  if (!sync) throw new Error('planner needs the sync module registered before it (modules/index.js)');
  if (!services.crm) throw new Error('planner needs the crm module registered before it (its tasks point at CRM records)');

  const checks = { task: checkTask, goal: checkGoal, workday: checkWorkday };
  for (const def of PLANNER_ENTITIES) {
    sync.registerEntity({ module: 'planner', ...def, ...(checks[def.entity] ? { check: checks[def.entity] } : {}) });
  }

  const q = {
    openInbox: db.prepare('SELECT count(*) AS n FROM planner_inbox_items WHERE deleted_at IS NULL AND cleared_at IS NULL'),
    goals: db.prepare(`SELECT * FROM planner_goals WHERE deleted_at IS NULL AND kind = ? AND period = ?
      ORDER BY business_id, position IS NULL, position, id`),
    overdue: db.prepare(`SELECT count(*) AS n FROM planner_tasks
      WHERE deleted_at IS NULL AND done_at IS NULL AND due_date IS NOT NULL AND due_date < ?`),
    relTasks: db.prepare(`SELECT id, relationship_id, due_date, done_at FROM planner_tasks
      WHERE deleted_at IS NULL AND done_at IS NULL AND relationship_id IS NOT NULL`),
    task: db.prepare('SELECT id, deleted_at, done_at FROM planner_tasks WHERE id = ?'),
  };

  const service = {
    /**
     * Who a task made by an automation for this business goes to (D packages): the business's
     * default owner, else the shared list. Tasks made by hand default to their maker (screens).
     */
    automatedOwnerFor(businessId) {
      return automatedTaskOwner(services.crm.getBusiness(businessId));
    },
    /** Items still in the capture inbox (for System / later notifications). */
    openInboxCount: () => q.openInbox.get().n,
    /**
     * Live goals of one period (C8's overview: "goals against targets"): kind 'week' with a
     * Monday, or 'month' with a 1st. Goals of a deleted business don't exist (businesses are never
     * deleted).
     */
    goals: (kind, period) => q.goals.all(kind, period),
    /**
     * Each person's workday record, with its fixed id (WORKDAY_IDS), made once: only an id that has
     * never existed here is created, so nothing is duplicated after a restart or a restore.
     */
    seedWorkdays() {
      const made = [];
      for (const actor of ACTORS) {
        const id = WORKDAY_IDS[actor];
        if (sync.recordState('workday', id)) continue;
        const r = sync.applyLocal({ entity: 'workday', op: 'create', recordId: id, stampMs: WORKDAY_SEED_STAMP_MS, fields: { actor } });
        if (r.status !== 'applied') throw new Error(`planner: could not create the ${actor}'s workday: ${r.code} ${r.reason}`);
        made.push(id);
      }
      if (made.length) log?.info?.(`created ${made.length} workday settings`);
      return made;
    },
    // ---- reads for the planner's automations (C8) ----
    /** Open tasks (both people and the shared list) due before `today`. */
    overdueCount: (today) => q.overdue.get(today).n,
    /** Open tasks that name a relationship (for C4a's "no next step" rule on the server). */
    openRelationshipTasks: () => q.relTasks.all(),
    /** { live, open } for a task id (live = not deleted; open = live and not done), or null. */
    taskState(id) {
      const t = q.task.get(id);
      if (!t) return null;
      const live = t.deleted_at === null;
      return { live, open: live && t.done_at === null };
    },
  };

  // C8: the Friday review list and "no next step" (when the automations module is registered).
  if (services.automations) registerPlannerAutomations({ automations: services.automations, crm: services.crm, planner: service });
  return service;
}
