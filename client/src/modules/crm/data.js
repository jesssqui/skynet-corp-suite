// What the client screens read: the device's offline copy through the sync store (never
// /api/crm), one subscription per page that re-reads when CRM records change. Records under a
// deleted parent are already left out by engine.list/get ("Hidden under a deleted parent").
import { CRM_ENTITY_NAMES } from '@suite/shared/crm';
import { useSyncData } from '../../sync/index.js';

const LIST_ENTITIES = ['business', 'client', 'account', 'contact', 'relationship', 'activity'];

/** Everything the client list needs (every client; the page builds its index once per change). */
export function useClientListData() {
  const { data, loading, error } = useSyncData(async (e) => {
    const [businesses, clients, accounts, contacts, relationships, activities] = await Promise.all(LIST_ENTITIES.map((x) => e.list(x)));
    return { businesses, clients, accounts, contacts, relationships, activities };
  }, [], { entities: LIST_ENTITIES });
  return { data: data ?? null, loading, error };
}

/**
 * One client with everything under it, or { client: null } when this device doesn't have it
 * (deleted, or not downloaded yet).
 */
export function useClientPageData(clientId) {
  const { data, loading, error } = useSyncData(async (e) => {
    const client = clientId ? await e.get('client', clientId) : null;
    if (!client) return { client: null };
    const mine = { where: { client_id: clientId } };
    const [businesses, accounts, contacts, activities] = await Promise.all([
      e.list('business'), e.list('account', { ...mine, sort: 'name' }), e.list('contact', { ...mine, sort: 'name' }), e.list('activity', mine),
    ]);
    const accountIds = new Set(accounts.map((a) => a.id));
    const contactIds = new Set(contacts.map((p) => p.id));
    const relationships = await e.list('relationship', { where: (r) => accountIds.has(r.account_id), sort: 'start_date' });
    const relationshipIds = new Set(relationships.map((r) => r.id));
    const [services, consents, links] = await Promise.all([
      e.list('service', { where: (s) => relationshipIds.has(s.relationship_id), sort: 'name' }),
      e.list('consent', { where: (k) => contactIds.has(k.contact_id) }),
      e.list('link', { where: (l) => accountIds.has(l.account_id) || contactIds.has(l.contact_id) }),
    ]);
    return { client, businesses, accounts, contacts, activities, relationships, services, consents, links };
  }, [clientId], { entities: CRM_ENTITY_NAMES });
  return { data: data ?? null, loading, error };
}

/** Our businesses (for the businesses page). */
export function useBusinesses() {
  const { data, loading } = useSyncData((e) => e.list('business', { sort: 'position' }), [], { entities: ['business'] });
  return { businesses: data ?? [], loading };
}
