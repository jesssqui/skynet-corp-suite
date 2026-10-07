// The planner (C4a): registers tasks and inbox items with sync, with the module's own checks.
// It never writes its tables itself: every change is a sync step (devices) or sync.applyLocal
// (server code) — the sync module's guard makes any other write fail. It reads only its own
// tables; the CRM records a task points at are reached through sync refs (and ctx.services.crm).
import { isDueTime, ESTIMATE_MAX_MINUTES, automatedTaskOwner } from '@suite/shared/planner';
import { PLANNER_ENTITIES } from './entities.js';

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

export function createPlannerService({ db, services }) {
  const sync = services.sync;
  if (!sync) throw new Error('planner needs the sync module registered before it (modules/index.js)');
  if (!services.crm) throw new Error('planner needs the crm module registered before it (its tasks point at CRM records)');

  const checks = { task: checkTask };
  for (const def of PLANNER_ENTITIES) {
    sync.registerEntity({ module: 'planner', ...def, ...(checks[def.entity] ? { check: checks[def.entity] } : {}) });
  }

  const q = {
    openInbox: db.prepare('SELECT count(*) AS n FROM planner_inbox_items WHERE deleted_at IS NULL AND cleared_at IS NULL'),
  };

  return {
    /**
     * Who a task made by an automation for this business goes to (D packages): the business's
     * default owner, else the shared list. Tasks made by hand default to their maker (screens).
     */
    automatedOwnerFor(businessId) {
      return automatedTaskOwner(services.crm.getBusiness(businessId));
    },
    /** Items still in the capture inbox (for System / later notifications). */
    openInboxCount: () => q.openInbox.get().n,
  };
}
