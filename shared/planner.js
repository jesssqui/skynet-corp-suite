// Planner facts shared by the server and devices (C4a): the value lists of tasks and inbox items,
// the "HH:MM" due time, who an automated task goes to, and the "no next step" rule. The record
// types themselves are registered by the server's planner module
// (server/src/modules/planner/entities.js) and reach devices through GET /api/sync/info.
// See CLAUDE.md, "Planner (C4a)".
import { OWNERS, SHARED } from './actors.js';

export { OWNERS, SHARED };

/** The planner's synced record types (entity names). */
export const PLANNER_ENTITY_NAMES = Object.freeze(['task', 'inbox_item']);

/** Where an inbox item was captured: typed (on the Mac), phone, Siri or the share sheet (C5). */
export const INBOX_SOURCES = Object.freeze(['typed', 'phone', 'siri', 'share']);

/** What an inbox item became (`became_entity`); free text on the record so D8 can add 'lead'. */
export const INBOX_BECAME = Object.freeze(['task', 'activity']);

export const TASK_TITLE_MAX = 300;
export const INBOX_TEXT_MAX = 5000;
/** A task's estimate is 1 minute to a working week. */
export const ESTIMATE_MAX_MINUTES = 60 * 24 * 7;
/** The day the morning plan measures estimates against (C4b replaces it with the real overbooking warning). */
export const DAY_MINUTES = 8 * 60;

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
    && accountClient.has(r.account_id)
    && clientIds.has(accountClient.get(r.account_id))
    && !covered.has(r.id));
}
