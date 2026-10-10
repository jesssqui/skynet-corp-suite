// The CRM core (C3a): registers the record types with sync, seeds our businesses, and reads
// records for the API. It never writes its tables itself: every change is a sync step (devices)
// or sync.applyLocal (server code) — the sync module's guard makes any other write fail.
import { isId } from '@suite/shared/ids';
import { localDate } from '@suite/shared/time';
import { normalizePhone } from '@suite/shared/normalize';
import { OUR_BUSINESSES, consentStatus } from '@suite/shared/crm';
import { CRM_ENTITIES, CRM_ENTITY } from './entities.js';
import { createImportService } from './import.js';
import { isCurrency } from '@suite/shared/costs';

/**
 * D8: a lead step's own rules, right in any arrival order (only the step's values and the row before
 * it): a step that makes a lead lost carries its reason; one that makes it won names the client it
 * became (or the lead already does); the currency is three capital letters; the value is 0 or more.
 */
export function checkLead({ op, fields, current }) {
  if (op === 'delete' || !fields) return null;
  const has = (k) => Object.hasOwn(fields, k) && fields[k] !== null;
  if (fields.stage === 'lost' && !(has('lost_reason') || (op === 'update' && current?.stage === 'lost' && current?.lost_reason))) {
    return { code: 'invalid_value', reason: 'lost_reason: say why the lead was lost' };
  }
  if (fields.stage === 'won' && !(has('won_client_id') || current?.won_client_id)) {
    return { code: 'invalid_value', reason: 'won_client_id: a won lead names the client it became' };
  }
  if (has('currency') && !isCurrency(fields.currency)) return { code: 'invalid_value', reason: 'currency: three capital letters, like CAD or USD' };
  if (has('value_cents') && !(fields.value_cents >= 0)) return { code: 'invalid_value', reason: 'value_cents: 0 or more' };
  return null;
}

export const LIMITS = { listDefault: 50, listMax: 200, recentActivities: 20 };
// Seeds are stamped at this old, fixed time (+ position ms): any real edit is later and wins.
export const SEED_STAMP_MS = Date.UTC(2026, 0, 1);

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const STANDARD = ['created_at', 'created_by', 'updated_at', 'updated_by'];

export function createCrmService({ db, services, log }) {
  const sync = services.sync;
  if (!sync) throw new Error('crm needs the sync module registered before it (modules/index.js)');

  // ---- links: one live link per (app, external_id) and kind of target ---------------------
  // A link counts only while its account or contact, and that one's client, are live: deletes
  // don't cascade, so a link under a deleted record stays in the table — but the outside record
  // is free to be linked again elsewhere. (If a deleted record comes back through a clash, two
  // live links can exist; liveLinks() returns all of them for D2 to settle.)
  const liveLink = {
    account: db.prepare(`SELECT l.* FROM crm_links l
      JOIN crm_accounts a ON a.id = l.account_id AND a.deleted_at IS NULL
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE l.app = ? AND l.external_id = ? AND l.deleted_at IS NULL ORDER BY l.id`),
    contact: db.prepare(`SELECT l.* FROM crm_links l
      JOIN crm_contacts p ON p.id = l.contact_id AND p.deleted_at IS NULL
      JOIN crm_clients c ON c.id = p.client_id AND c.deleted_at IS NULL
      WHERE l.app = ? AND l.external_id = ? AND l.deleted_at IS NULL ORDER BY l.id`),
  };
  function checkLink({ op, fields }) {
    if (op !== 'create') return null;
    const kind = fields.account_id ? 'account' : fields.contact_id ? 'contact' : null;
    if (!kind) return null; // neither (or both): the table's CHECK refuses it
    const other = liveLink[kind].get(fields.app, fields.external_id);
    if (!other) return null;
    return {
      code: 'already_linked',
      reason: `${fields.app} record ${fields.external_id} is already linked to ${kind} ${other[`${kind}_id`]}: undo that link first`,
    };
  }

  const checks = { link: checkLink, lead: checkLead };
  for (const def of CRM_ENTITIES) sync.registerEntity({ module: 'crm', ...def, ...(checks[def.entity] ? { check: checks[def.entity] } : {}) });

  /** A row as the API shows it: synced fields (booleans as true/false), who/when, and its sync state. */
  function view(entity, row, { withSync = true } = {}) {
    if (!row) return null;
    const def = CRM_ENTITY[entity];
    const out = { id: row.id };
    for (const [name, f] of Object.entries(def.fields)) {
      const v = row[name];
      out[name] = v === null || v === undefined ? null : (f.type === 'boolean' ? v === 1 : v);
    }
    for (const c of STANDARD) if (Object.hasOwn(row, c)) out[c] = row[c];
    if (withSync) {
      const state = sync.recordState(entity, row.id);
      out._sync = { flagged: Boolean(state?.flagged), clashes: state?.clashes ?? [] };
    }
    return out;
  }

  // ---- seeds ---------------------------------------------------------------------------
  /**
   * Our businesses and Personal, made through the sync steps with their fixed ids. Only an id
   * that has never existed here is created: after a restart or a restore nothing is duplicated,
   * and one renamed or archived in the app stays that way. Stamped at an old fixed time
   * (SEED_STAMP_MS), so after a restore from before the CRM existed, edits re-sent from devices
   * are later than the re-made seed and win. Returns the ids created now.
   */
  function seedBusinesses() {
    const made = [];
    for (const b of OUR_BUSINESSES) {
      if (sync.recordState('business', b.id)) continue;
      const r = sync.applyLocal({
        entity: 'business', op: 'create', recordId: b.id, stampMs: SEED_STAMP_MS + b.position,
        fields: { name: b.name, default_owner: b.default_owner, position: b.position },
      });
      if (r.status !== 'applied') throw new Error(`crm: could not create business ${b.name}: ${r.code} ${r.reason}`);
      made.push(b.id);
    }
    if (made.length) log?.info(`created ${made.length} of our businesses`);
    return made;
  }

  // ---- reads ---------------------------------------------------------------------------
  // A record shows only while it and everything it belongs to (its `parent` chain) is live: deletes
  // don't cascade, so every query joins up its chain. Non-parent refs (contact.account_id,
  // activity.account_id / business_id) are returned as stored and may name a deleted record.
  // A relationship (and so its services) belongs to an account *and* one of our businesses.
  const REL_PARENTS = `JOIN crm_accounts a ON a.id = r.account_id AND a.deleted_at IS NULL
    JOIN crm_businesses b ON b.id = r.business_id AND b.deleted_at IS NULL`;
  const q = {
    businesses: db.prepare(`SELECT * FROM crm_businesses WHERE deleted_at IS NULL
      ORDER BY position IS NULL, position, name COLLATE NOCASE, id`),
    business: db.prepare('SELECT * FROM crm_businesses WHERE id = ? AND deleted_at IS NULL'),
    client: db.prepare('SELECT * FROM crm_clients WHERE id = ? AND deleted_at IS NULL'),
    accounts: db.prepare('SELECT * FROM crm_accounts WHERE client_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, id'),
    relationships: db.prepare(`SELECT r.* FROM crm_relationships r ${REL_PARENTS}
      WHERE a.client_id = ? AND r.deleted_at IS NULL ORDER BY r.start_date IS NULL, r.start_date, r.id`),
    services: db.prepare(`SELECT s.* FROM crm_services s JOIN crm_relationships r ON r.id = s.relationship_id ${REL_PARENTS}
      WHERE a.client_id = ? AND r.deleted_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.start_date IS NULL, s.start_date, s.id`),
    contacts: db.prepare('SELECT * FROM crm_contacts WHERE client_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE, id'),
    consents: db.prepare(`SELECT k.* FROM crm_consents k
      JOIN crm_contacts p ON p.id = k.contact_id AND p.deleted_at IS NULL
      JOIN crm_businesses b ON b.id = k.business_id AND b.deleted_at IS NULL
      WHERE p.client_id = ? AND k.deleted_at IS NULL`),
    links: db.prepare(`SELECT l.* FROM crm_links l JOIN crm_accounts a ON a.id = l.account_id
        WHERE a.client_id = @id AND a.deleted_at IS NULL AND l.deleted_at IS NULL
      UNION ALL
      SELECT l.* FROM crm_links l JOIN crm_contacts p ON p.id = l.contact_id
        WHERE p.client_id = @id AND p.deleted_at IS NULL AND l.deleted_at IS NULL`),
  };

  function listBusinesses() {
    return q.businesses.all().map((r) => view('business', r));
  }

  /**
   * Clients for lists and search.
   * @param {{ q?: string, business?: string, status?: string, limit?: number, offset?: number }} opts
   *   q: part of the client's, an account's or a contact's name, a contact's email, or a phone
   *   number however it's typed; business: one of our businesses (clients with a relationship
   *   with it, any status); status: active | closed.
   * Each filter is one set of client ids (`c.id IN (…)`, computed once), never a per-client
   * subquery; the page is picked first and only its rows get counts.
   */
  function listClients({ q: text = '', business = null, status = null, limit = LIMITS.listDefault, offset = 0 } = {}) {
    const where = ['c.deleted_at IS NULL'];
    const params = {};
    if (status) {
      where.push('c.status = @status');
      params.status = status;
    }
    if (business) {
      where.push(`c.id IN (SELECT a.client_id FROM crm_relationships r ${REL_PARENTS}
        WHERE r.business_id = @business AND r.deleted_at IS NULL)`);
      params.business = business;
    }
    const term = text.trim();
    if (term) {
      params.like = `%${escapeLike(term)}%`;
      // A phone typed any way ("(519) 555-0100", "+1 519…"): compare its stored form.
      const phone = /^[\d\s()+.-]+$/.test(term) ? normalizePhone(term) : null;
      if (phone && phone.replace('+', '').length >= 3) params.phone = `%${escapeLike(phone)}%`;
      where.push(`(c.name LIKE @like ESCAPE '\\'
        OR c.id IN (SELECT client_id FROM crm_accounts WHERE deleted_at IS NULL AND name LIKE @like ESCAPE '\\')
        OR c.id IN (SELECT client_id FROM crm_contacts WHERE deleted_at IS NULL
          AND (name LIKE @like ESCAPE '\\' OR email LIKE @like ESCAPE '\\'${params.phone ? " OR phone LIKE @phone ESCAPE '\\'" : ''})))`);
    }
    const sqlWhere = where.join(' AND ');
    const total = db.prepare(`SELECT count(*) AS n FROM crm_clients c WHERE ${sqlWhere}`).get(params).n;
    const ids = db.prepare(`SELECT c.id FROM crm_clients c WHERE ${sqlWhere}
      ORDER BY c.name COLLATE NOCASE, c.id LIMIT @limit OFFSET @offset`).pluck().all({ ...params, limit, offset });
    const rows = ids.length ? db.prepare(`SELECT c.*,
        (SELECT count(*) FROM crm_accounts a WHERE a.client_id = c.id AND a.deleted_at IS NULL) AS account_count,
        (SELECT count(*) FROM crm_contacts p WHERE p.client_id = c.id AND p.deleted_at IS NULL) AS contact_count,
        (SELECT group_concat(DISTINCT r.business_id) FROM crm_accounts a JOIN crm_relationships r ON r.account_id = a.id
          JOIN crm_businesses b ON b.id = r.business_id AND b.deleted_at IS NULL
          WHERE a.client_id = c.id AND a.deleted_at IS NULL AND r.deleted_at IS NULL) AS business_ids,
        (SELECT max(t.at) FROM crm_activities t WHERE t.client_id = c.id AND t.deleted_at IS NULL) AS last_activity_at
      FROM crm_clients c WHERE c.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      clients: ids.map((id) => byId.get(id)).map((r) => ({
        ...view('client', r, { withSync: false }),
        accountCount: r.account_count,
        contactCount: r.contact_count,
        businessIds: r.business_ids ? r.business_ids.split(',').sort() : [],
        lastActivityAt: r.last_activity_at,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Consent per business for one contact's rows, as of `today` (the server's local date):
   * { [businessId]: { given, withdrawn, expired, expiresOn, date, kind, source, id, recordedAt, recordedBy } }
   */
  function consentSummary(rows, today = localDate()) {
    const out = {};
    for (const businessId of new Set(rows.map((r) => r.business_id))) {
      const st = consentStatus(rows, businessId, today);
      const r = st.row;
      out[businessId] = {
        given: st.given, withdrawn: st.withdrawn, expired: st.expired, expiresOn: st.expiresOn,
        date: r.date, kind: r.kind, source: r.source, id: r.id, recordedAt: r.created_at, recordedBy: r.created_by,
      };
    }
    return out;
  }

  /**
   * One client with everything under it: accounts (each with its relationships, their services,
   * and its links), contacts (consent per business, links), the latest activities. null when
   * there is no such live client. Records that can clash carry `_sync: { flagged, clashes }`
   * (append-only activities and consent can't).
   */
  function getClient(id) {
    if (!isId(id)) return null;
    const client = view('client', q.client.get(id));
    if (!client) return null;
    const services = q.services.all(id).map((r) => view('service', r));
    const relationships = q.relationships.all(id).map((r) => ({
      ...view('relationship', r),
      services: services.filter((s) => s.relationship_id === r.id),
    }));
    const links = q.links.all({ id }).map((r) => view('link', r));
    const accounts = q.accounts.all(id).map((r) => ({
      ...view('account', r),
      relationships: relationships.filter((x) => x.account_id === r.id),
      links: links.filter((l) => l.account_id === r.id),
    }));
    const consents = q.consents.all(id).map((r) => view('consent', r, { withSync: false }));
    const contacts = q.contacts.all(id).map((r) => ({
      ...view('contact', r),
      consent: consentSummary(consents.filter((k) => k.contact_id === r.id)),
      links: links.filter((l) => l.contact_id === r.id),
    }));
    const recent = listActivities(id, { limit: LIMITS.recentActivities });
    return { client, accounts, contacts, activities: recent.activities, activityCount: recent.total };
  }

  /**
   * A client's timeline, newest first, filterable by our business, their account and type.
   * @returns {{ activities, total, limit, offset } | null} null when there is no such client
   */
  function listActivities(clientId, { business = null, account = null, type = null, limit = LIMITS.listDefault, offset = 0 } = {}) {
    if (!isId(clientId) || !q.client.get(clientId)) return null;
    const where = ['client_id = @clientId', 'deleted_at IS NULL'];
    const params = { clientId, limit, offset };
    if (business) { where.push('business_id = @business'); params.business = business; }
    if (account) { where.push('account_id = @account'); params.account = account; }
    if (type) { where.push('type = @type'); params.type = type; }
    const sqlWhere = where.join(' AND ');
    const { limit: _l, offset: _o, ...countParams } = params;
    const total = db.prepare(`SELECT count(*) AS n FROM crm_activities WHERE ${sqlWhere}`).get(countParams).n;
    const rows = db.prepare(`SELECT * FROM crm_activities WHERE ${sqlWhere}
      ORDER BY at DESC, id DESC LIMIT @limit OFFSET @offset`).all(params);
    return { activities: rows.map((r) => view('activity', r, { withSync: false })), total, limit, offset };
  }

  // ---- reads for other modules (C8: the planner's automations) -----------------------------
  const live = {
    relationships: db.prepare(`SELECT r.*, a.name AS account_name, a.client_id AS client_id, c.name AS client_name,
        c.status AS client_status, b.name AS business_name, b.archived AS business_archived
      FROM crm_relationships r ${REL_PARENTS}
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE r.deleted_at IS NULL ORDER BY c.name COLLATE NOCASE, a.name COLLATE NOCASE, r.id`),
    renewals: db.prepare(`SELECT s.*, a.name AS account_name, a.client_id AS client_id, r.business_id AS business_id
      FROM crm_services s JOIN crm_relationships r ON r.id = s.relationship_id AND r.deleted_at IS NULL ${REL_PARENTS}
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE s.deleted_at IS NULL AND s.renewal_date BETWEEN ? AND ? AND (s.status IS NULL OR s.status NOT IN ('done', 'cancelled'))
      ORDER BY s.renewal_date, s.id`),
    // D6: one service with what its renewal reminder needs; null unless it and its relationship,
    // account, client (and our business) are live.
    service: db.prepare(`SELECT s.*, a.name AS account_name, a.client_id AS client_id, c.name AS client_name,
        c.status AS client_status, r.business_id AS business_id, r.account_id AS account_id, r.status AS relationship_status
      FROM crm_services s JOIN crm_relationships r ON r.id = s.relationship_id AND r.deleted_at IS NULL ${REL_PARENTS}
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE s.id = ? AND s.deleted_at IS NULL`),
    clientsActivity: db.prepare(`SELECT c.id, c.name, c.status, c.created_at,
        (SELECT max(t.at) FROM crm_activities t WHERE t.client_id = c.id AND t.deleted_at IS NULL) AS last_activity_at
      FROM crm_clients c WHERE c.deleted_at IS NULL AND c.status = 'active' ORDER BY c.name COLLATE NOCASE, c.id`),
  };

  /** The live links of one outside record (D2): normally at most one per kind of target. */
  function liveLinks(app, externalId) {
    return [...liveLink.account.all(app, externalId), ...liveLink.contact.all(app, externalId)].map((r) => view('link', r));
  }

  // ---- reads for the wholesale connection (D1) -------------------------------------------
  const forLinks = {
    accountLinks: db.prepare(`SELECT l.id, l.external_id, l.account_id, a.client_id, l.matched_by, l.match_reason, l.created_at, l.created_by
      FROM crm_links l
      JOIN crm_accounts a ON a.id = l.account_id AND a.deleted_at IS NULL
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE l.app = ? AND l.deleted_at IS NULL ORDER BY l.external_id, l.id`),
    account: db.prepare(`SELECT a.*, c.name AS client_name, c.status AS client_status FROM crm_accounts a
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE a.id = ? AND a.deleted_at IS NULL`),
    accountRelationships: db.prepare(`SELECT r.* FROM crm_relationships r
      JOIN crm_businesses b ON b.id = r.business_id AND b.deleted_at IS NULL
      WHERE r.account_id = ? AND r.deleted_at IS NULL ORDER BY r.id`),
    clientNames: db.prepare(`SELECT c.id, c.name, c.status FROM crm_clients c
      WHERE c.deleted_at IS NULL AND c.id IN (SELECT value FROM json_each(?))`),
    // D3: who a drafted email goes to — the account's own contacts first, then the client's
    // contacts not tied to any account (a contact of the client's other account isn't asked).
    accountContacts: db.prepare(`SELECT p.* FROM crm_contacts p
      JOIN crm_accounts a ON a.id = ? AND a.deleted_at IS NULL AND a.client_id = p.client_id
      JOIN crm_clients c ON c.id = p.client_id AND c.deleted_at IS NULL
      WHERE p.deleted_at IS NULL AND (p.account_id = a.id OR p.account_id IS NULL)
      ORDER BY p.account_id IS NULL, p.created_at, p.id`),
  };

  // ---- reads for leads and the cross-sell list (D8) ----------------------------------------
  const forLeads = {
    leads: db.prepare(`SELECT l.* FROM crm_leads l JOIN crm_businesses b ON b.id = l.business_id AND b.deleted_at IS NULL
      WHERE l.deleted_at IS NULL ORDER BY l.created_at, l.id`),
    clients: db.prepare('SELECT * FROM crm_clients WHERE deleted_at IS NULL'),
    accounts: db.prepare(`SELECT a.* FROM crm_accounts a JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL
      WHERE a.deleted_at IS NULL`),
    contacts: db.prepare(`SELECT p.* FROM crm_contacts p JOIN crm_clients c ON c.id = p.client_id AND c.deleted_at IS NULL
      WHERE p.deleted_at IS NULL`),
    consents: db.prepare(`SELECT k.* FROM crm_consents k JOIN crm_contacts p ON p.id = k.contact_id AND p.deleted_at IS NULL
      JOIN crm_clients c ON c.id = p.client_id AND c.deleted_at IS NULL
      JOIN crm_businesses b ON b.id = k.business_id AND b.deleted_at IS NULL WHERE k.deleted_at IS NULL`),
    relationships: db.prepare(`SELECT r.* FROM crm_relationships r ${REL_PARENTS}
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL WHERE r.deleted_at IS NULL`),
  };
  const plain = (entity) => (r) => view(entity, r, { withSync: false });

  // ---- reads for matching and undoing links (D2) -----------------------------------------
  const forMatching = {
    clients: db.prepare('SELECT id, name, status FROM crm_clients WHERE deleted_at IS NULL'),
    accounts: db.prepare(`SELECT a.id, a.client_id, a.name, a.street, a.city, a.region, a.postal_code, a.country
      FROM crm_accounts a JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL WHERE a.deleted_at IS NULL`),
    contacts: db.prepare(`SELECT p.id, p.client_id, p.account_id, p.name, p.role, p.email, p.phone
      FROM crm_contacts p JOIN crm_clients c ON c.id = p.client_id AND c.deleted_at IS NULL WHERE p.deleted_at IS NULL`),
    relationships: db.prepare(`SELECT r.id, r.account_id, a.client_id, r.business_id, r.kind, r.status
      FROM crm_relationships r ${REL_PARENTS}
      JOIN crm_clients c ON c.id = a.client_id AND c.deleted_at IS NULL WHERE r.deleted_at IS NULL`),
  };
  const RECORD_TABLE = Object.fromEntries(CRM_ENTITIES.map((d) => [d.entity, d.table]));
  const liveRow = Object.fromEntries(Object.entries(RECORD_TABLE).map(([entity, table]) => [entity,
    db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`)]));
  const usage = {
    client: {
      accounts: db.prepare('SELECT id FROM crm_accounts WHERE client_id = ? AND deleted_at IS NULL'),
      contacts: db.prepare('SELECT id FROM crm_contacts WHERE client_id = ? AND deleted_at IS NULL'),
      activities: db.prepare('SELECT id FROM crm_activities WHERE client_id = ? AND deleted_at IS NULL'),
      relationships: db.prepare(`SELECT r.id FROM crm_relationships r JOIN crm_accounts a ON a.id = r.account_id AND a.deleted_at IS NULL
        WHERE a.client_id = ? AND r.deleted_at IS NULL`),
      services: db.prepare(`SELECT s.id FROM crm_services s JOIN crm_relationships r ON r.id = s.relationship_id AND r.deleted_at IS NULL
        JOIN crm_accounts a ON a.id = r.account_id AND a.deleted_at IS NULL WHERE a.client_id = ? AND s.deleted_at IS NULL`),
      consents: db.prepare(`SELECT k.id FROM crm_consents k JOIN crm_contacts p ON p.id = k.contact_id AND p.deleted_at IS NULL
        WHERE p.client_id = ? AND k.deleted_at IS NULL`),
      links: db.prepare(`SELECT l.id FROM crm_links l JOIN crm_accounts a ON a.id = l.account_id AND a.deleted_at IS NULL
          WHERE a.client_id = @id AND l.deleted_at IS NULL
        UNION ALL SELECT l.id FROM crm_links l JOIN crm_contacts p ON p.id = l.contact_id AND p.deleted_at IS NULL
          WHERE p.client_id = @id AND l.deleted_at IS NULL`),
    },
    account: {
      contacts: db.prepare('SELECT id FROM crm_contacts WHERE account_id = ? AND deleted_at IS NULL'),
      activities: db.prepare('SELECT id FROM crm_activities WHERE account_id = ? AND deleted_at IS NULL'),
      relationships: db.prepare('SELECT id FROM crm_relationships WHERE account_id = ? AND deleted_at IS NULL'),
      services: db.prepare(`SELECT s.id FROM crm_services s JOIN crm_relationships r ON r.id = s.relationship_id AND r.deleted_at IS NULL
        WHERE r.account_id = ? AND s.deleted_at IS NULL`),
      links: db.prepare('SELECT id FROM crm_links WHERE account_id = ? AND deleted_at IS NULL'),
    },
    relationship: {
      services: db.prepare('SELECT id FROM crm_services WHERE relationship_id = ? AND deleted_at IS NULL'),
    },
    contact: {
      consents: db.prepare('SELECT id FROM crm_consents WHERE contact_id = ? AND deleted_at IS NULL'),
      links: db.prepare('SELECT id FROM crm_links WHERE contact_id = ? AND deleted_at IS NULL'),
    },
  };

  /**
   * Everything matching compares (D2), in four plain queries (no per-client subqueries): live
   * clients, their live accounts and contacts, and the live relationships (account, client and one
   * of our live businesses) — rows as stored.
   */
  function matchingRecords() {
    return {
      clients: forMatching.clients.all(),
      accounts: forMatching.accounts.all(),
      contacts: forMatching.contacts.all(),
      relationships: forMatching.relationships.all(),
    };
  }

  /**
   * What hangs off one record (D2's undo: "remove it only if nothing else was added"): for each kind
   * of record that can point at it, the ids of the live ones. client: accounts, contacts, activities,
   * relationships (of its accounts), services, consents, links; account: contacts (naming it),
   * activities (naming it), relationships, services, links; relationship: services; contact:
   * consents, links. → null for another entity or a bad id.
   */
  function usageOf(entity, id) {
    const qs = usage[entity];
    if (!qs || !isId(id)) return null;
    const out = {};
    for (const [kind, stmt] of Object.entries(qs)) {
      out[kind] = (entity === 'client' && kind === 'links' ? stmt.all({ id }) : stmt.all(id)).map((r) => r.id);
    }
    return out;
  }

  /** One live record's synced fields (booleans as true/false) with who/when, or null (D2: "still as it was made?"). */
  function liveRecord(entity, id) {
    if (!liveRow[entity] || !isId(id)) return null;
    return view(entity, liveRow[entity].get(id), { withSync: false });
  }

  /**
   * Every live account link of one app (its account and that account's client live), with the
   * account's client: [{ id, external_id, account_id, client_id, matched_by, match_reason, created_at, created_by }].
   * Contact links aren't listed: D1 attaches an outside customer's records to an account.
   */
  const liveAccountLinks = (app) => forLinks.accountLinks.all(app);

  /** One live account (its client live too) with client_name and client_status, or null. */
  function liveAccount(id) {
    if (!isId(id)) return null;
    const row = forLinks.account.get(id);
    return row ? { ...view('account', row, { withSync: false }), client_name: row.client_name, client_status: row.client_status } : null;
  }

  return {
    seedBusinesses,
    // C7: the accounting CSV import (preview, commit in chunks, batches). See import.js.
    imports: createImportService({ db, sync, log }),
    liveLinks,
    // D2 (matching, undoing links): everything matching compares, what hangs off a record, one live record.
    matchingRecords,
    usageOf,
    liveRecord,
    // D1 (the wholesale connection): live account links of an app, one live account, its relationships.
    liveAccountLinks,
    liveAccount,
    /** The live relationships of one account (with a live business of ours), as stored. */
    accountRelationships: (accountId) => (isId(accountId) ? forLinks.accountRelationships.all(accountId).map((r) => view('relationship', r, { withSync: false })) : []),
    /** id -> { id, name, status } for the live clients among `ids`. */
    clientNames: (ids) => new Map(forLinks.clientNames.all(JSON.stringify([...new Set(ids)])).map((r) => [r.id, r])),
    /** D3: an account's live contacts (its own first, then its client's with no account), oldest first. */
    accountContacts: (accountId) => (isId(accountId) ? forLinks.accountContacts.all(accountId).map((r) => view('contact', r, { withSync: false })) : []),
    listBusinesses,
    getBusiness: (id) => (isId(id) ? view('business', q.business.get(id)) : null),
    listClients,
    getClient,
    listActivities,
    /**
     * Every live relationship (its account, client and business live) with its account's and
     * client's names, the client's status and the business's name — rows as stored (snake_case),
     * plus account_name, client_id, client_name, client_status, business_name, business_archived
     * (1 when archived). For server-side
     * rules like C4a's "no next step" (the planner's automations).
     */
    liveRelationships: () => live.relationships.all(),
    /**
     * Live services (not done or cancelled) whose renewal_date is from..to (YYYY-MM-DD, inclusive), as
     * stored plus account_name, client_id and business_id (the relationship's).
     */
    renewalsBetween: (from, to) => live.renewals.all(from, to),
    /**
     * D6 (renewal reminders): one service as stored plus account_name, account_id, client_id,
     * client_name, client_status, relationship_status and business_id — any status — or null when it, its relationship,
     * account or client is deleted.
     */
    liveService: (id) => (isId(id) ? live.service.get(id) ?? null : null),
    /** Live active clients with created_at and the time of their latest activity (null when none). */
    activeClientsWithLastActivity: () => live.clientsActivity.all(),
    /** D8: every live lead (any stage; its business live), oldest first, as the API shows records (no sync state). */
    liveLeads: () => forLeads.leads.all().map(plain('lead')),
    /**
     * D8 (the monthly cross-sell list, crossSellList in @suite/shared/leads): the live clients, accounts
     * (booleans as true/false: age_restricted), relationships, contacts, consents and leads it reads.
     */
    crossSellInputs: () => ({
      clients: forLeads.clients.all().map(plain('client')),
      accounts: forLeads.accounts.all().map(plain('account')),
      relationships: forLeads.relationships.all().map(plain('relationship')),
      contacts: forLeads.contacts.all().map(plain('contact')),
      consents: forLeads.consents.all().map(plain('consent')),
      leads: forLeads.leads.all().map(plain('lead')),
    }),
  };
}
