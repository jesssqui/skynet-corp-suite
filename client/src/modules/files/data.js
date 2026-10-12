// What the Files tab reads (D10): the device's offline copy, through the CRM's cached lists (the
// `file` list is read once and kept until a file — or something it belongs to — changes).
import { useSyncData } from '../../sync/index.js';
import { cachedLists } from '../crm/data.js';
import { filesForClient } from './logic.js';

const ENTITIES = ['file', 'task', 'client', 'account'];

// Worked out once per client and per change of the lists (D10 review: the client page asks for it from its
// Files card and once per account). The cached entries are new objects whenever their type changes, so they
// key the memo: files → tasks → accounts → clients → Map(clientId → view).
const memo = new WeakMap();
function remembered(entries, clientId, make) {
  let level = memo;
  for (const e of entries.slice(0, -1)) {
    if (!level.has(e)) level.set(e, new WeakMap());
    level = level.get(e);
  }
  const last = entries[entries.length - 1];
  if (!level.has(last)) level.set(last, new Map());
  const byClient = level.get(last);
  if (!byClient.has(clientId)) byClient.set(clientId, make());
  return byClient.get(clientId);
}

/** One client's files (its own, its accounts', its tasks'), with the client, its accounts and the tasks by id. */
export function useClientFiles(clientId) {
  const { data, loading, error } = useSyncData(async (e) => {
    const [files, tasks, clients, accounts] = await cachedLists(e, ENTITIES);
    return remembered([files, tasks, accounts, clients], clientId, () => {
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
    });
  }, [clientId], { entities: ENTITIES });
  return { data: data ?? null, loading, error };
}
