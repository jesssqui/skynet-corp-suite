// What the planner screens read: the device's offline copy through the sync store, with the CRM
// screens' cached lists (../crm/data.js: each record type listed once and kept until it changes),
// so Today, Tasks, Inbox and the client page share one read of thousands of tasks. Pages build
// their structures (Today's sections, filters) once per change with useMemo.
import { useSyncData } from '../../sync/index.js';
import { cachedLists, cachedList, lastActivityOf } from '../crm/data.js';
import { lastOrderByClient, mergeLastActivity } from '../wholesale/logic.js';

// D8: leads too (Today's "No next step" lists open leads; task rows name their lead).
const PLANNER_ENTITIES = ['business', 'client', 'account', 'relationship', 'task', 'inbox_item', 'goal', 'workday', 'lead'];

function maps(entries) {
  const [businesses, clients, accounts, relationships, tasks, inbox, goals, workdays, leads] = entries;
  return {
    businesses: businesses.records,
    clients: clients.records,
    accounts: accounts.records,
    relationships: relationships.records,
    tasks: tasks.records,
    inbox: inbox.records,
    businessesById: businesses.byId(),
    clientsById: clients.byId(),
    accountsById: accounts.byId(),
    relationshipsById: relationships.byId(),
    // Tasks naming each relationship (the "No next step" rule), built once per task change.
    tasksByRelationship: tasks.by('relationship_id'),
    // C4b: goals (week goals and month priorities), the tasks under each, each person's workday.
    goals: goals.records,
    goalsById: goals.byId(),
    tasksByGoal: tasks.by('goal_id'),
    workdays: workdays.records,
    // D8: leads and the tasks naming each (its "No next step").
    leads: leads.records,
    leadsById: leads.byId(),
  };
}

/** Everything Today, Tasks and the task sheet need: records and their lookups. */
export function usePlannerData() {
  const { data, loading, error } = useSyncData(async (e) => maps(await cachedLists(e, PLANNER_ENTITIES)), [], { entities: PLANNER_ENTITIES });
  return { data: data ?? null, loading, error };
}

// D1: Order Manager orders count as activity for quiet clients, as on the client list and the server;
// D5: so do its notes.
// D6: our recurring costs renewing soon are listed beside the services' renewals.
const REVIEW_ENTITIES = [...PLANNER_ENTITIES, 'service', 'activity', 'wholesale_order', 'wholesale_note', 'recurring_cost'];

/**
 * The Friday review: the planner's records plus services and (D6) recurring costs (renewals) and the last activity per
 * client (quiet clients), all from the cached lists.
 */
export function useReviewData() {
  const { data, loading, error } = useSyncData(async (e) => {
    const entries = await cachedLists(e, REVIEW_ENTITIES);
    const [services, activities, orders, notes, costs] = entries.slice(PLANNER_ENTITIES.length);
    return { ...maps(entries), services: services.records, costs: costs.records, lastActivity: reviewLastActivity(activities, orders, notes) };
  }, [], { entities: REVIEW_ENTITIES });
  return { data: data ?? null, loading, error };
}

/** Last activity per client for the review: notes and calls, or (D1) an Order Manager order or (D5) note, whichever is later. */
export function reviewLastActivity(activities, orders, notes = null) {
  const withOrders = mergeLastActivity(lastActivityOf(activities), orders.derive('lastOrderByClient', lastOrderByClient));
  return notes ? mergeLastActivity(withOrders, notes.derive('lastOrderByClient', lastOrderByClient)) : withOrders;
}

/** How many items are still in the capture inbox (the nav's count). */
export function useInboxCount() {
  const { data } = useSyncData(async (e) => {
    const entry = await cachedList(e, 'inbox_item');
    return entry.derive('openCount', (rs) => rs.filter((i) => !i.cleared_at).length);
  }, [], { entities: ['inbox_item'] });
  return data ?? 0;
}
