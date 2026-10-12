// What the Files tab reads (D10): the device's offline copy, through the CRM's cached lists (the
// `file` list is read once and kept until a file — or something it belongs to — changes).
import { useSyncData } from '../../sync/index.js';
import { cachedLists } from '../crm/data.js';
import { filesForClient } from './logic.js';

const ENTITIES = ['file', 'task', 'client', 'account'];

/** One client's files (its own, its accounts', its tasks'), with the client, its accounts and the tasks by id. */
export function useClientFiles(clientId) {
  const { data, loading, error } = useSyncData(async (e) => {
    const [files, tasks, clients, accounts] = await cachedLists(e, ENTITIES);
    const client = clients.byId().get(clientId) ?? null;
    if (!client) return { client: null };
    const myAccounts = [...accounts.where('client_id', clientId)].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return {
      client,
      accounts: myAccounts,
      accountsById: new Map(myAccounts.map((a) => [a.id, a])),
      tasksById: tasks.byId(),
      items: filesForClient({ files: files.records, tasks: tasks.records, accounts: myAccounts, clientId }),
    };
  }, [clientId], { entities: ENTITIES });
  return { data: data ?? null, loading, error };
}
