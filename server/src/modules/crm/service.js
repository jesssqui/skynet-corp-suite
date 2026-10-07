// The CRM core (C3a): registers the record types with sync, seeds our businesses, and reads
// records for the API. It never writes its tables itself: every change is a sync step (devices)
// or sync.applyLocal (server code) — the sync module's guard makes any other write fail.
import { isId } from '@suite/shared/ids';
import { localDate } from '@suite/shared/time';
import { normalizePhone } from '@suite/shared/normalize';
import { OUR_BUSINESSES, consentStatus } from '@suite/shared/crm';
import { CRM_ENTITIES, CRM_ENTITY } from './entities.js';

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

  const checks = { link: checkLink };
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

  /** The live links of one outside record (D2): normally at most one per kind of target. */
  function liveLinks(app, externalId) {
    return [...liveLink.account.all(app, externalId), ...liveLink.contact.all(app, externalId)].map((r) => view('link', r));
  }

  return {
    seedBusinesses,
    liveLinks,
    listBusinesses,
    getBusiness: (id) => (isId(id) ? view('business', q.business.get(id)) : null),
    listClients,
    getClient,
    listActivities,
  };
}
