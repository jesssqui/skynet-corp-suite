// What the client screens read: the device's offline copy through the sync store (never
// /api/crm). Records under a deleted parent are already left out by engine.list ("Hidden under a
// deleted parent").
//
// Speed with thousands of clients: each record type is listed once and kept (per engine) until a
// change to that type — or to a type it belongs to, which can hide or show its records — arrives;
// lookups by a field (activities by client_id, …) and derived maps (last activity per client) are
// built once per such change. So saving a note re-reads only activities, and opening a client
// after the list reuses what the list already read.
import { useSyncData } from '../../sync/index.js';
import { lastOrderByClient, mergeLastActivity, quietFromByClient } from '../wholesale/logic.js';

// What each CRM type belongs to (its parent chain), for when the engine's definitions aren't here yet.
const BELONGS_TO = {
  business: [],
  client: [],
  account: ['client'],
  contact: ['client'],
  consent: ['contact', 'client', 'business'],
  relationship: ['account', 'client', 'business'],
  service: ['relationship', 'account', 'client', 'business'],
  activity: ['client'],
  link: ['account', 'contact', 'client'],
  // The planner's (C4a): a task belongs to one of our businesses; its client/account/relationship
  // are plain refs (a task outlives a deleted client).
  task: ['business'],
  inbox_item: [],
  // C4b: a goal belongs to one of our businesses; a workday to nothing.
  goal: ['business'],
  workday: [],
  // D1: the Order Manager's records belong to the account their customer is linked to.
  wholesale_customer: ['account', 'client'],
  wholesale_order: ['account', 'client'],
  wholesale_entry: ['account', 'client'],
  wholesale_note: ['account', 'client'], // D5
};

const caches = new WeakMap(); // engine -> { entries: Map<entity, Promise<Entry>>, off }

function cacheFor(engine) {
  let c = caches.get(engine);
  if (c) return c;
  c = { entries: new Map() };
  // Registered before any page's subscription reads (useSyncData runs its loads in a microtask
  // after the event), so a load after a change never gets the old list.
  c.off = engine.subscribe((e) => {
    if (e.type === 'status') {
      if (e.status.phase === 'stopped') c.entries.clear();
      return;
    }
    if (!e.entities) {
      c.entries.clear();
      return;
    }
    for (const entity of [...c.entries.keys()]) {
      const affected = new Set([entity, ...(BELONGS_TO[entity] ?? []), ...(engine.ancestorsOf?.(entity) ?? [])]);
      if (e.entities.some((x) => affected.has(x))) c.entries.delete(entity);
    }
  });
  caches.set(engine, c);
  return c;
}

function makeEntry(records) {
  const byField = new Map();
  const derived = new Map();
  const entry = {
    records,
    /** field -> Map<value, records[]> (built once). */
    by(field) {
      if (!byField.has(field)) {
        const m = new Map();
        for (const r of records) {
          const k = r[field];
          if (k === null || k === undefined) continue;
          const list = m.get(k);
          if (list) list.push(r);
          else m.set(k, [r]);
        }
        byField.set(field, m);
      }
      return byField.get(field);
    },
    /** Records whose `field` is `value`. */
    where(field, value) {
      return entry.by(field).get(value) ?? [];
    },
    byId() {
      return entry.derive('byId', (rs) => new Map(rs.map((r) => [r.id, r])));
    },
    /** A value computed from the records once (until they change). */
    derive(key, fn) {
      if (!derived.has(key)) derived.set(key, fn(records));
      return derived.get(key);
    },
  };
  return entry;
}

/**
 * Cached entries for several entities: those not cached are read together in one listMany (each
 * type and its parents read once), then kept until they change.
 * @returns {Promise<Entry[]>} in the order asked
 */
export function cachedLists(engine, entities) {
  const c = cacheFor(engine);
  const missing = entities.filter((x) => !c.entries.has(x));
  if (missing.length) {
    const all = engine.listMany(missing);
    for (const entity of missing) {
      const p = all.then((lists) => makeEntry(lists[entity]));
      c.entries.set(entity, p);
      p.catch(() => c.entries.get(entity) === p && c.entries.delete(entity));
    }
  }
  return Promise.all(entities.map((x) => c.entries.get(x)));
}

/** The records of one entity as a cached entry (see above). */
export async function cachedList(engine, entity) {
  return (await cachedLists(engine, [entity]))[0];
}

// D1: the Order Manager's orders count as activity on the list ("last activity"); the client page
// shows its orders, payments, returns and refunds on the timeline and each account's figures.
// D3: the customer cards give the list its "Quiet regular" chip.
// D5: the Order Manager's notes are timeline items too, and count as activity on the list.
const LIST_ENTITIES = ['business', 'client', 'account', 'contact', 'relationship', 'activity', 'wholesale_order', 'wholesale_customer', 'wholesale_note'];
const PAGE_ENTITIES = ['business', 'client', 'account', 'contact', 'relationship', 'service', 'consent', 'activity', 'link', 'task',
  'wholesale_customer', 'wholesale_order', 'wholesale_entry', 'wholesale_note'];

/** Last activity per client: Map<client_id, at>. */
export function lastActivityByClient(activities) {
  const m = new Map();
  for (const t of activities) {
    const cur = m.get(t.client_id);
    if (t.at && (!cur || t.at > cur)) m.set(t.client_id, t.at);
  }
  return m;
}

/** Everything the client list needs (every client; the page builds its index once per change). */
export function useClientListData() {
  const { data, loading, error } = useSyncData(async (e) => {
    const [businesses, clients, accounts, contacts, relationships, activities, wholesaleOrders, wholesaleCards, wholesaleNotes] = await cachedLists(e, LIST_ENTITIES);
    // Read what a client page needs too, in the background, so opening one from the list is quick.
    setTimeout(() => !e.isStopped() && cachedLists(e, PAGE_ENTITIES).catch(() => {}), 250);
    return {
      businesses: businesses.records,
      clients: clients.records,
      accounts: accounts.records,
      contacts: contacts.records,
      relationships: relationships.records,
      // Activities and (D1) Order Manager orders, whichever is later.
      lastActivity: mergeLastActivity(
        mergeLastActivity(lastActivityOf(activities), wholesaleOrders.derive('lastOrderByClient', lastOrderByClient)),
        wholesaleNotes.derive('lastOrderByClient', lastOrderByClient), // D5: its notes too (same shape: client_id, at)
      ),
      // D3: per client, the first day one of its Order Manager regulars counts as quiet (compared with today on the row).
      quietFrom: wholesaleCards.derive('quietFromByClient', quietFromByClient),
    };
  }, [], { entities: LIST_ENTITIES });
  return { data: data ?? null, loading, error };
}

/** Last activity per client from the cached activity list (built once per change; the Friday review reuses it). */
export function lastActivityOf(activitiesEntry) {
  return activitiesEntry.derive('lastByClient', lastActivityByClient);
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || (a.id < b.id ? -1 : 1);

/**
 * One client with everything under it, or { client: null } when this device doesn't have it
 * (deleted, or not downloaded yet).
 */
export function useClientPageData(clientId) {
  const { data, loading, error } = useSyncData(async (e) => {
    const [businesses, clients, accounts, contacts, relationships, services, consents, activities, links, tasks,
      wholesaleCustomers, wholesaleOrders, wholesaleEntries, wholesaleNotes] = await cachedLists(e, PAGE_ENTITIES);
    const client = clients.byId().get(clientId) ?? null;
    if (!client) return { client: null };
    const myAccounts = [...accounts.where('client_id', clientId)].sort(byName);
    const myContacts = [...contacts.where('client_id', clientId)].sort(byName);
    const myRelationships = myAccounts.flatMap((a) => relationships.where('account_id', a.id))
      .sort((a, b) => String(a.start_date ?? '9999').localeCompare(String(b.start_date ?? '9999')) || (a.id < b.id ? -1 : 1));
    return {
      client,
      businesses: businesses.records,
      accounts: myAccounts,
      contacts: myContacts,
      activities: activities.where('client_id', clientId),
      relationships: myRelationships,
      services: myRelationships.flatMap((r) => services.where('relationship_id', r.id)).sort(byName),
      consents: myContacts.flatMap((p) => consents.where('contact_id', p.id)),
      links: [...myAccounts.flatMap((a) => links.where('account_id', a.id)), ...myContacts.flatMap((p) => links.where('contact_id', p.id))],
      // The planner's (C4a): this client's tasks, and the tasks naming its relationships (the
      // "No next step" flag counts those, whoever's client they were filed under).
      tasks: tasks.where('client_id', clientId),
      relationshipTasks: myRelationships.flatMap((r) => tasks.where('relationship_id', r.id)),
      // D1: the Order Manager's records under this client's accounts (by account, so a record whose
      // client_id lags a moved account still shows where its account is).
      wholesaleCustomers: myAccounts.flatMap((a) => wholesaleCustomers.where('account_id', a.id)),
      wholesaleOrders: myAccounts.flatMap((a) => wholesaleOrders.where('account_id', a.id)),
      wholesaleEntries: myAccounts.flatMap((a) => wholesaleEntries.where('account_id', a.id)),
      wholesaleNotes: myAccounts.flatMap((a) => wholesaleNotes.where('account_id', a.id)), // D5
    };
  }, [clientId], { entities: PAGE_ENTITIES });
  return { data: data ?? null, loading, error };
}

/** Our businesses (for the businesses page). */
export function useBusinesses() {
  const { data, loading } = useSyncData(async (e) => {
    const entry = await cachedList(e, 'business');
    return [...entry.records].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  }, [], { entities: ['business'] });
  return { businesses: data ?? [], loading };
}
