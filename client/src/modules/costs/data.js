// What the Costs page reads: the device's offline copy, through the CRM screens' cached lists
// (../crm/data.js: each record type listed once and kept until it changes).
import { useSyncData } from '../../sync/index.js';
import { cachedLists } from '../crm/data.js';
import { sharesByCost } from './logic.js';

const COST_ENTITIES = ['business', 'client', 'account', 'relationship', 'recurring_cost', 'cost_share'];

/** Our businesses, the clients' relationships (for resold costs) and every cost on this device. */
export function useCostsData() {
  const { data, loading, error } = useSyncData(async (e) => {
    const [businesses, clients, accounts, relationships, costs, shareRows] = await cachedLists(e, COST_ENTITIES);
    return {
      businesses: [...businesses.records].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)),
      clients: clients.records,
      accounts: accounts.records,
      relationships: relationships.records,
      costs: costs.records,
      shareRows: shareRows.records,
      shares: sharesByCost(shareRows.records),
      clientsById: clients.byId(),
      accountsById: accounts.byId(),
      relationshipsById: relationships.byId(),
    };
  }, [], { entities: COST_ENTITIES });
  return { data: data ?? null, loading, error };
}
