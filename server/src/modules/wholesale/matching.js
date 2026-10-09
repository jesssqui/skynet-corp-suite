// Matching the same client across businesses (D2), pure: the service hands in the CRM's records and
// the Order Manager customers waiting for a client; this says which to link automatically and what to
// suggest for review. See CLAUDE.md, "Matching (D2)". The plan's table:
//   same email (clean, `=`)                -> linked automatically
//   same phone (clean, `=`)                -> linked automatically
//   similar business name                  -> suggested for review
//   same street and postal code            -> suggested for review
//   name only (two "Mike"s)                -> never linked, never suggested (people's names aren't compared)
// "Automatically" only when it is unambiguous: exactly one client in scope has the email/phone, it is
// active and has a Wholesale, GWND or consulting relationship, the account is clear (the contact's own,
// else the client's only one), that account isn't linked to another Order Manager customer yet, no one
// said "Not the same" or undid a link between them — and (demoteShared, in the service's state()) no
// other waiting customer matches that client automatically too. Anything else strong is a suggestion
// that says why.
// Scope: clients with a relationship (any status) with Wholesale, Great White North Design or Business
// consulting — linked automatically or suggested — and clients with no relationship at all yet (made by
// hand): suggested only, never linked automatically. A client whose only relationships are with Save
// Point Shop, the retail stores or Personal is never matched.
import { BUSINESS_IDS } from '@suite/shared/crm';
import { normalizeEmail, isEmail, normalizePhone, isPhone, formatPhone } from '@suite/shared/normalize';
import { buildMatchIndex, similarEntries, similarNames, addressKey } from '@suite/shared/intake';

/** Our businesses whose clients are matched (real emails and phone numbers). */
export const MATCH_BUSINESS_IDS = Object.freeze([BUSINESS_IDS.wholesale, BUSINESS_IDS.agency, BUSINESS_IDS.consulting]);
/** An email or phone on more clients than this is a shared placeholder (info@…, a head office): not matched. */
export const SHARED_VALUE_LIMIT = 10;
/** At most this many suggestions per Order Manager customer (strongest first). */
export const SUGGESTIONS_PER_CUSTOMER = 5;

const idSet = (businessIds) => (businessIds instanceof Set ? businessIds : new Set(businessIds ?? []));

/** Can a client be linked automatically? Only with a Wholesale, GWND or consulting relationship (any status). */
export function canAutoLink(businessIds) {
  const ids = idSet(businessIds);
  return MATCH_BUSINESS_IDS.some((id) => ids.has(id));
}

/** Is a client (by the businesses it has relationships with) one matching looks at (suggestions)? */
export function inScope(businessIds) {
  const ids = idSet(businessIds);
  return ids.size === 0 || canAutoLink(ids);
}

/**
 * An Order Manager customer's email and phone fit to match on: exactly the suite's clean stored form
 * (the Order Manager sends them that way), and never a value it listed in contact_problems.
 */
export function customerContact(customer) {
  const problems = new Set((customer.contactProblems ?? []).map((p) => p.field));
  const clean = (value, normalize, valid) => {
    if (typeof value !== 'string' || !value) return null;
    const v = normalize(value);
    return v === value && valid(v) ? v : null;
  };
  return {
    email: problems.has('email') ? null : clean(customer.email, normalizeEmail, isEmail),
    phone: problems.has('phone') ? null : clean(customer.phone, normalizePhone, isPhone),
  };
}

/** The customer's address as an addressKey (line 1 and 2, its postal code), or null. */
export function customerAddressKey(customer) {
  const a = customer.address ?? {};
  return addressKey([a.line1, a.line2].filter(Boolean).join(', '), a.postal_code);
}

const pushTo = (map, key, value) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * Everything matching compares, indexed once per pass: clients (with their accounts, contacts, the
 * businesses they work with and whether they are in scope), contacts by clean email and phone,
 * accounts by address, and names (clients' and accounts') for similar-name look-ups (C7's index).
 * @param {{ clients, accounts, contacts, relationships }} records crm.matchingRecords()
 */
export function buildCrmIndex({ clients = [], accounts = [], contacts = [], relationships = [] }) {
  const businesses = new Map();
  for (const r of relationships) {
    if (!businesses.has(r.client_id)) businesses.set(r.client_id, new Set());
    businesses.get(r.client_id).add(r.business_id);
  }
  const clientsById = new Map();
  for (const c of clients) {
    const ids = businesses.get(c.id) ?? new Set();
    clientsById.set(c.id, {
      id: c.id, name: c.name, status: c.status, businessIds: [...ids].sort(), inScope: inScope(ids), canAutoLink: canAutoLink(ids), accounts: [], contacts: [],
    });
  }
  const accountsById = new Map();
  for (const a of accounts) {
    const c = clientsById.get(a.client_id);
    if (!c) continue;
    const acc = { ...a, addressKey: addressKey(a.street, a.postal_code) };
    accountsById.set(a.id, acc);
    c.accounts.push(acc);
  }
  for (const p of contacts) clientsById.get(p.client_id)?.contacts.push(p);

  const scoped = [...clientsById.values()].filter((c) => c.inScope);
  const byEmail = new Map();
  const byPhone = new Map();
  const byAddress = new Map();
  for (const c of scoped) {
    for (const p of c.contacts) {
      if (p.email) pushTo(byEmail, p.email, p);
      if (p.phone) pushTo(byPhone, p.phone, p);
    }
    for (const a of c.accounts) if (a.addressKey) pushTo(byAddress, a.addressKey, a);
  }
  const names = buildMatchIndex({ clients: scoped, accounts: scoped.flatMap((c) => c.accounts) });
  return { clientsById, accountsById, byEmail, byPhone, byAddress, names };
}

const distinctClients = (rows) => [...new Set(rows.map((r) => r.client_id))];

/** "Pat at Lefty’s Vape Shop" — a contact and, when it names one, its account. */
function contactLabel(index, contact) {
  const account = contact.account_id ? index.accountsById.get(contact.account_id) : null;
  return account && account.client_id === contact.client_id ? `${contact.name} at ${account.name}` : contact.name;
}

function addressText(account) {
  return [account.street, account.city, account.postal_code].filter(Boolean).join(', ');
}

/**
 * One waiting Order Manager customer against the CRM.
 * @param {object} customer { uid, businessName, email, phone, contactProblems, address, gone, linkProblem }
 * @param {ReturnType<typeof buildCrmIndex>} index
 * @param {{ decision?: (clientId) => ({ notSame, undone } | null), linkedAccounts?: Set<string> }} opts
 *   decision: what people decided about this customer and that client; linkedAccounts: accounts that
 *   already have a live Order Manager link.
 * @returns {{ auto: null | { clientId, accountId, reason, reasons }, suggestions: Array<{ clientId, accountId,
 *   strong, reasons: Array<{ kind, text }>, why }> }}
 */
export function matchCustomer(customer, index, { decision = () => null, linkedAccounts = new Set() } = {}) {
  const entries = new Map(); // client id -> what points at it
  const entry = (clientId) => {
    let e = entries.get(clientId);
    if (!e) {
      e = { clientId, strong: new Set(), contacts: [], reasons: [], accountHints: new Set() };
      entries.set(clientId, e);
    }
    return e;
  };
  const { email, phone } = customerContact(customer);
  const strongBy = (value, map, kind) => {
    if (!value) return;
    const hits = map.get(value) ?? [];
    if (distinctClients(hits).length > SHARED_VALUE_LIMIT) return; // a shared placeholder, not a person
    const seen = new Set();
    for (const p of hits) {
      const e = entry(p.client_id);
      e.strong.add(kind);
      e.contacts.push(p);
      if (seen.has(p.client_id)) continue; // one reason per client and kind
      seen.add(p.client_id);
      e.reasons.push({ kind, text: `Same ${kind} as ${contactLabel(index, p)}` });
    }
  };
  strongBy(email, index.byEmail, 'email');
  strongBy(phone, index.byPhone, 'phone');

  if (customer.businessName) {
    const seen = new Set();
    for (const { entry: n } of similarEntries(index.names, customer.businessName)) {
      if (seen.has(`${n.clientId}:${n.accountId}`)) continue;
      seen.add(`${n.clientId}:${n.accountId}`);
      const e = entry(n.clientId);
      if (n.accountId) e.accountHints.add(n.accountId);
      if (!e.reasons.some((r) => r.kind === 'name')) e.reasons.push({ kind: 'name', text: `Similar name: “${n.name}”` });
    }
  }
  const address = customerAddressKey(customer);
  if (address) {
    const accounts = index.byAddress.get(address) ?? [];
    if (distinctClients(accounts).length <= SHARED_VALUE_LIMIT) {
      for (const a of accounts) {
        const e = entry(a.client_id);
        e.accountHints.add(a.id);
        if (!e.reasons.some((r) => r.kind === 'address')) e.reasons.push({ kind: 'address', text: `Same address: ${addressText(a)}` });
      }
    }
  }

  // "Not the same" takes a pair out for good (until cleared); a client no longer here is no match.
  for (const id of [...entries.keys()]) {
    if (!index.clientsById.get(id)?.inScope || decision(id)?.notSame) entries.delete(id);
  }

  const strong = [...entries.values()].filter((e) => e.strong.size);
  let auto = null;
  for (const e of strong) {
    const client = index.clientsById.get(e.clientId);
    const kinds = [...e.strong].sort().join(' and '); // "email", "phone", "email and phone"
    // The account: the one its matching contacts name, else the client's only one.
    const named = new Set(e.contacts.map((p) => p.account_id).filter((id) => index.accountsById.get(id)?.client_id === client.id));
    const accountId = named.size === 1 ? [...named][0] : (named.size === 0 && client.accounts.length === 1 ? client.accounts[0].id : null);
    e.accountId = accountId;
    if (strong.length > 1) e.why = `The same ${kinds === 'email and phone' ? 'details are' : `${kinds} is`} on ${strong.length} clients: pick the right one`;
    else if (customer.gone) e.why = 'Deleted in the Order Manager';
    else if (customer.linkProblem) e.why = 'Linked to more than one account: undo one link first';
    else if (client.status !== 'active') e.why = 'The client is closed';
    else if (!client.canAutoLink) e.why = 'The client has no Wholesale, GWND or consulting relationship yet: link it by hand';
    else if (named.size > 1) e.why = 'Its contacts are on different accounts: pick one';
    else if (!accountId) e.why = client.accounts.length ? 'The client has several accounts: pick one' : 'The client has no account yet';
    else if (decision(e.clientId)?.undone) e.why = 'A link between them was undone before';
    else if (linkedAccounts.has(accountId)) e.why = 'That account is already linked to another Order Manager customer';
    else auto = { clientId: client.id, accountId, reason: `same ${kinds}`, reasons: e.reasons };
  }

  const suggestions = [...entries.values()]
    .filter((e) => !auto || e.clientId !== auto.clientId)
    .map((e) => ({
      clientId: e.clientId,
      accountId: e.accountId ?? (e.accountHints.size === 1 ? [...e.accountHints][0] : null),
      strong: e.strong.size > 0,
      reasons: e.reasons,
      why: e.why ?? null,
    }))
    .sort((x, y) => (y.strong - x.strong) || (y.reasons.length - x.reasons.length)
      || String(index.clientsById.get(x.clientId).name).localeCompare(String(index.clientsById.get(y.clientId).name)))
    .slice(0, SUGGESTIONS_PER_CUSTOMER);
  return { auto, suggestions };
}

export const SEVERAL_CUSTOMERS_WHY = 'Several Order Manager customers match this client: pick the right one';

/**
 * One pass's results (matchCustomer per waiting customer): when two or more customers would be linked
 * automatically to the same client, none is — each becomes a strong suggestion saying so — so the result
 * never depends on whether they arrived together or one at a time. Changes `results` in place.
 */
export function demoteShared(results) {
  const perClient = new Map();
  for (const r of results) if (r.auto) perClient.set(r.auto.clientId, (perClient.get(r.auto.clientId) ?? 0) + 1);
  for (const r of results) {
    if (!r.auto || perClient.get(r.auto.clientId) < 2) continue;
    r.suggestions = [{ clientId: r.auto.clientId, accountId: r.auto.accountId, strong: true, reasons: r.auto.reasons, why: SEVERAL_CUSTOMERS_WHY },
      ...r.suggestions].slice(0, SUGGESTIONS_PER_CUSTOMER);
    r.auto = null;
  }
  return results;
}

/** A pair of client ids in one order (the decisions table's a < b). */
export const pairKey = (x, y) => (x < y ? [x, y] : [y, x]);

/**
 * Possible duplicate clients inside the CRM (both in scope): a clean email or phone on contacts of
 * both, or similar names (client or account) with an account at the same address. A value on more
 * than SHARED_VALUE_LIMIT clients is a placeholder and ignored. Nothing is merged: the review shows
 * them with "Not the same" and links to both pages.
 * @param {{ notSame?: (a, b) => boolean }} opts a < b
 * @returns {Array<{ a, b, reasons: Array<{ kind, text }> }>} a, b: client ids (a < b)
 */
export function duplicateClients(index, { notSame = () => false } = {}) {
  const pairs = new Map();
  const add = (x, y, reason) => {
    if (x === y) return;
    const [a, b] = pairKey(x, y);
    const k = `${a}|${b}`;
    let p = pairs.get(k);
    if (!p) {
      p = { a, b, reasons: [] };
      pairs.set(k, p);
    }
    if (!p.reasons.some((r) => r.kind === reason.kind)) p.reasons.push(reason);
  };
  const eachPair = (ids, fn) => {
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) fn(ids[i], ids[j]);
  };
  for (const [kind, map, show] of [['email', index.byEmail, (v) => v], ['phone', index.byPhone, formatPhone]]) {
    for (const [value, rows] of map) {
      const ids = distinctClients(rows);
      if (ids.length < 2 || ids.length > SHARED_VALUE_LIMIT) continue;
      eachPair(ids, (x, y) => add(x, y, { kind, text: `Same ${kind}: ${show(value)}` }));
    }
  }
  const namesOf = (id) => {
    const c = index.clientsById.get(id);
    return [c.name, ...c.accounts.map((a) => a.name)];
  };
  for (const accounts of index.byAddress.values()) {
    const ids = distinctClients(accounts);
    if (ids.length < 2 || ids.length > SHARED_VALUE_LIMIT) continue;
    eachPair(ids, (x, y) => {
      if (!namesOf(x).some((n) => namesOf(y).some((m) => similarNames(n, m)))) return;
      add(x, y, { kind: 'address', text: `Similar names at the same address: ${addressText(accounts.find((a) => a.client_id === x))}` });
    });
  }
  const name = (id) => String(index.clientsById.get(id)?.name ?? '');
  return [...pairs.values()]
    .filter((p) => !notSame(p.a, p.b))
    .sort((x, y) => (y.reasons.length - x.reasons.length) || name(x.a).localeCompare(name(y.a)) || name(x.b).localeCompare(name(y.b)));
}

/** A client as the review page shows it beside the other record (accounts and contacts capped). */
export function clientSummary(index, clientId, { max = 6 } = {}) {
  const c = index.clientsById.get(clientId);
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    businessIds: c.businessIds,
    accounts: c.accounts.slice(0, max).map((a) => ({ id: a.id, name: a.name, street: a.street, city: a.city, postalCode: a.postal_code })),
    accountCount: c.accounts.length,
    contacts: c.contacts.slice(0, max).map((p) => ({ id: p.id, name: p.name, role: p.role, email: p.email, phone: p.phone, accountId: p.account_id })),
    contactCount: c.contacts.length,
  };
}
