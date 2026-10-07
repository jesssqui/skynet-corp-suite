// What the planner screens read: the device's offline copy through the sync store, with the CRM
// screens' cached lists (../crm/data.js: each record type listed once and kept until it changes),
// so Today, Tasks, Inbox and the client page share one read of thousands of tasks. Pages build
// their structures (Today's sections, filters) once per change with useMemo.
import { useSyncData } from '../../sync/index.js';
import { cachedLists, cachedList } from '../crm/data.js';

const PLANNER_ENTITIES = ['business', 'client', 'account', 'relationship', 'task', 'inbox_item'];

function maps(entries) {
  const [businesses, clients, accounts, relationships, tasks, inbox] = entries;
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
  };
}

/** Everything Today, Tasks and the task sheet need: records and their lookups. */
export function usePlannerData() {
  const { data, loading, error } = useSyncData(async (e) => maps(await cachedLists(e, PLANNER_ENTITIES)), [], { entities: PLANNER_ENTITIES });
  return { data: data ?? null, loading, error };
}

/** How many items are still in the capture inbox (the nav's count). */
export function useInboxCount() {
  const { data } = useSyncData(async (e) => {
    const entry = await cachedList(e, 'inbox_item');
    return entry.derive('openCount', (rs) => rs.filter((i) => !i.cleared_at).length);
  }, [], { entities: ['inbox_item'] });
  return data ?? 0;
}
