// The CRM's core records (C3a): every record type created, changed and deleted through sync
// steps (devices) and applyLocal (server code), clean contact details, consent, references
// between records, the seeded businesses, the guard, and the read API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { nowIso, localDate } from '@suite/shared/time';
import { createHlc } from '@suite/shared/hlc';
import { OUR_BUSINESSES, BUSINESS_IDS, CRM_ENTITY_NAMES, addMonths, consentExpiresOn } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { CRM_ENTITIES } from '../src/modules/crm/entities.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { tmpDir, testConfig, startApp as startTestApp, ensureTestUsers, sessionFor, quietLog } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const AGENCY = BUSINESS_IDS.agency;
const CONSULTING = BUSINESS_IDS.consulting;
const TABLES = CRM_ENTITIES.map((e) => e.table);

const apps = new Map();

async function startApp(t, config, mods = modules) {
  const env = await startTestApp(t, config, { modules: mods });
  const users = await ensureTestUsers(env.ctx);
  const observer = sessionFor(env.ctx, users.owner);
  apps.set(env.base, { ctx: env.ctx, users, observer });
  t.after(() => apps.delete(env.base));
  return { ...env, config, users, observer };
}

async function setup(t) {
  return startApp(t, testConfig(tmpDir(t)));
}

/** A phone or Mac signed in as `actor`: makes steps with its own clock, pushes, pulls. */
function makeDevice(base, actor) {
  const app = apps.get(base);
  const { cookie, deviceId: id } = sessionFor(app.ctx, app.users[actor]);
  const clock = createHlc(id);
  const d = {
    id, actor, base, cookie, cursor: null, clock,
    headers: () => ({ 'content-type': 'application/json', cookie: d.cookie, origin: d.base }),
    moveTo(newBase) {
      const again = sessionFor(apps.get(newBase).ctx, apps.get(newBase).users[actor], { deviceHint: id });
      assert.equal(again.deviceId, id);
      d.base = newBase;
      d.cookie = again.cookie;
    },
    step(op, entity, recordId, fields) {
      return { key: newId(), entity, recordId, op, ...(fields ? { fields } : {}), hlc: clock.now(), ...(d.cursor ? { seen: d.cursor } : {}) };
    },
    async push(steps) {
      const res = await fetch(`${d.base}/api/sync/push`, { method: 'POST', headers: d.headers(), body: JSON.stringify({ steps }) });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      clock.receive(body.hlc);
      return body.results;
    },
    async one(step) {
      return (await d.push([step]))[0];
    },
    /** Create a record; asserts it applied; returns its id. */
    async create(entity, fields, id = newId()) {
      const r = await d.one(d.step('create', entity, id, fields));
      assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
      return id;
    },
    async pull() {
      const records = new Map();
      let since = d.cursor;
      for (;;) {
        const qs = new URLSearchParams(since ? { since } : {});
        const res = await fetch(`${d.base}/api/sync/pull?${qs}`, { headers: d.headers() });
        const body = await res.json();
        clock.receive(body.hlc);
        for (const c of body.changes) records.set(`${c.entity}/${c.id}`, c);
        since = body.cursor;
        if (!body.hasMore) break;
      }
      d.cursor = since;
      return records;
    },
  };
  return d;
}

async function getJson(base, path, cookie = apps.get(base).observer.cookie) {
  const res = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: await res.json() };
}

async function resolve(base, clashId, resolution) {
  const res = await fetch(`${base}/api/sync/clashes/${clashId}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: apps.get(base).observer.cookie, origin: base },
    body: JSON.stringify({ resolution }),
  });
  return { status: res.status, body: await res.json() };
}

const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
const n = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const businessSteps = (db) => n(db, "SELECT count(*) AS n FROM sync_steps WHERE entity = 'business'");

// ---------------------------------------------------------------- registration and seeds

test('the CRM registers its record types with sync (nine, and D8’s lead and lead_activity): fields, refs, formats, append-only', async (t) => {
  const { ctx } = await setup(t);
  const info = ctx.services.sync.info();
  const crm = info.entities.filter((e) => e.module === 'crm');
  assert.deepEqual(crm.map((e) => e.entity), [...CRM_ENTITY_NAMES]);
  const by = Object.fromEntries(crm.map((e) => [e.entity, e]));
  assert.deepEqual(by.contact.fields.email, { type: 'text', max: 254, format: 'email' });
  assert.deepEqual(by.contact.fields.phone, { type: 'text', max: 20, format: 'phone' });
  assert.deepEqual(by.contact.fields.client_id, { type: 'id', required: true, ref: 'client', parent: true });
  assert.deepEqual(by.contact.fields.account_id, { type: 'id', ref: 'account' }, 'optional, and not what it belongs to');
  const parents = Object.fromEntries(crm.map((e) => [e.entity, Object.entries(e.fields).filter(([, f]) => f.parent).map(([k, f]) => `${k}->${f.ref}`)]));
  assert.deepEqual(parents, {
    business: [],
    client: [],
    account: ['client_id->client'],
    contact: ['client_id->client'],
    consent: ['contact_id->contact', 'business_id->business'],
    relationship: ['account_id->account', 'business_id->business'],
    service: ['relationship_id->relationship'],
    activity: ['client_id->client'],
    link: ['account_id->account', 'contact_id->contact'],
    lead: ['business_id->business'],
    lead_activity: ['lead_id->lead'],
  });
  assert.deepEqual(by.account.fields.age_restricted, { type: 'boolean' });
  assert.deepEqual(by.business.fields.default_owner.values, ['owner', 'partner', 'shared']);
  assert.deepEqual(by.relationship.fields.kind.values, ['wholesale', 'website', 'social', 'consulting']);
  assert.deepEqual(by.activity.fields.type.values, ['note', 'call', 'email', 'meeting', 'order', 'milestone']);
  assert.deepEqual(by.service.fields.billing.values, ['flat', 'hourly']);
  for (const e of ['consent', 'activity', 'lead_activity']) {
    assert.equal(by[e].appendOnly, true, e);
    assert.deepEqual(by[e].ops, ['create'], e);
  }
  assert.deepEqual(by.link.ops, ['create', 'delete']);
  assert.deepEqual(by.business.ops, ['create', 'update'], 'businesses are archived, never deleted');
  assert.deepEqual(by.business.fields.archived, { type: 'boolean' });
  assert.deepEqual(by.consent.fields.kind.values, ['express', 'implied_purchase', 'implied_inquiry']);
  assert.deepEqual(by.consent.fields.expires_on, { type: 'date' });
  for (const e of ['client', 'account', 'contact', 'relationship', 'service']) {
    assert.deepEqual(by[e].ops, ['create', 'update', 'delete'], e);
  }
});

test('a ref to an entity nobody registered stops the server at start', async (t) => {
  const dangling = {
    name: 'dangling',
    createService({ services, db }) {
      db.exec('CREATE TABLE IF NOT EXISTS dangling_things (id TEXT PRIMARY KEY, thing_id TEXT, deleted_at TEXT)');
      services.sync.registerEntity({
        module: 'dangling', entity: 'thing', table: 'dangling_things', fields: { thing_id: { type: 'id', ref: 'gizmo' } },
      });
    },
  };
  const config = testConfig(tmpDir(t));
  const db = openDb(config.dbPath);
  t.after(() => db.close());
  await assert.rejects(createApp({ config, db, log: quietLog, modules: [...modules, dangling] }), /thing\.thing_id points to gizmo/);
});

test('our businesses are created once at first start, through sync steps, with their fixed ids', async (t) => {
  const env = await setup(t);
  const { db, ctx, base } = env;
  const rows = db.prepare('SELECT * FROM crm_businesses ORDER BY position').all();
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.default_owner]), OUR_BUSINESSES.map((b) => [b.id, b.name, b.default_owner]));
  assert.ok(rows.every((r) => r.created_by === 'system' && r.deleted_at === null));
  assert.ok(rows.every((r) => r.created_at.startsWith('2026-01-01T00:00:00.00')), 'stamped at the old fixed seed time');
  assert.equal(businessSteps(db), 6, 'each one is a step in the log');

  const { body } = await getJson(base, '/api/crm/businesses');
  assert.deepEqual(body.businesses.map((b) => b.name), ['Wholesale', 'Great White North Design', 'Business consulting', 'Save Point Shop', 'Retail stores', 'Personal']);
  assert.deepEqual(body.businesses[0]._sync, { flagged: false, clashes: [] });

  // A device gets them with its first pull.
  const phone = makeDevice(base, 'partner');
  const pulled = await phone.pull();
  assert.equal([...pulled.keys()].filter((k) => k.startsWith('business/')).length, 6);

  // Renamed in the app, one archived: a restart changes nothing and re-creates nothing.
  assert.equal(ctx.services.sync.applyLocal({ actor: 'owner', entity: 'business', op: 'update', recordId: W, fields: { name: 'Wholesale (PouchPlug)', color: '#0a7cff' } }).status, 'applied');
  assert.equal(ctx.services.sync.applyLocal({ actor: 'owner', entity: 'business', op: 'update', recordId: BUSINESS_IDS.retail, fields: { archived: true } }).status, 'applied');
  // Never deleted: relationships, consent and code (BUSINESS_IDS) depend on them.
  const del = ctx.services.sync.applyLocal({ actor: 'owner', entity: 'business', op: 'delete', recordId: BUSINESS_IDS.retail });
  assert.deepEqual([del.status, del.code], ['rejected', 'op_not_allowed']);
  const before = businessSteps(db);
  await env.close();
  const again = await startApp(t, env.config);
  assert.equal(businessSteps(again.db), before, 'no new steps on restart');
  assert.equal(n(again.db, 'SELECT count(*) AS n FROM crm_businesses'), 6);
  assert.equal(row(again.db, 'crm_businesses', W).name, 'Wholesale (PouchPlug)');
  assert.equal(row(again.db, 'crm_businesses', BUSINESS_IDS.retail).archived, 1, 'an archived one stays archived');
  assert.equal((await getJson(again.base, '/api/crm/businesses')).body.businesses.find((b) => b.id === BUSINESS_IDS.retail).archived, true);
  assert.deepEqual(again.ctx.services.crm.seedBusinesses(), []);
});

test('seeds survive a restore without duplicates; a backup from before the CRM gets them back with the same ids', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  // A database from before C3a (no crm module — nor the planner, which needs it, nor what needs the planner), backed up.
  const preModules = modules.filter((m) => !['crm', 'planner', 'wholesale', 'calendar', 'costs', 'stockroom'].includes(m.name));
  const pre = await startApp(t, config, preModules);
  const preBackup = await runBackup({ db: pre.db, dir: config.backup.dir, offsiteDir: null, keepDays: 30 });
  await pre.close();

  // C3a starts on it: businesses seeded. A phone records a wholesale customer.
  const first = await startApp(t, config);
  assert.equal(n(first.db, 'SELECT count(*) AS n FROM crm_businesses'), 6);
  const phone = makeDevice(first.base, 'owner');
  await phone.pull();
  const kept = [];
  const clientId = newId();
  const accountId = newId();
  kept.push(phone.step('create', 'client', clientId, { name: 'Lefty’s', status: 'active' }));
  kept.push(phone.step('create', 'account', accountId, { client_id: clientId, name: 'Vape shop' }));
  kept.push(phone.step('create', 'relationship', newId(), { account_id: accountId, business_id: W, kind: 'wholesale', status: 'active' }));
  kept.push(phone.step('update', 'business', W, { name: 'PouchPlug wholesale', color: '#0a7cff' }));
  assert.deepEqual((await phone.push(kept)).map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);

  // A backup with the CRM, restored: still six, nothing new.
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: null, keepDays: 30 });
  const steps = businessSteps(first.db);
  await first.close();
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const second = await startApp(t, config);
  assert.equal(n(second.db, 'SELECT count(*) AS n FROM crm_businesses'), 6);
  assert.equal(businessSteps(second.db), steps);
  await second.close();

  // Restored from before the CRM existed: the businesses come back with the same ids, so the
  // phone's kept steps (re-sent after a restore) still point at the right one.
  await restoreBackup({ from: preBackup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  const third = await startApp(t, config);
  assert.deepEqual(third.db.prepare('SELECT id FROM crm_businesses ORDER BY position').all().map((r) => r.id), OUR_BUSINESSES.map((b) => b.id));
  phone.moveTo(third.base);
  const resent = await phone.push(kept);
  assert.deepEqual(resent.slice(0, 3).map((r) => r.status), ['applied', 'applied', 'applied']);
  assert.equal(row(third.db, 'crm_relationships', kept[2].recordId).business_id, W);
  // The rename is newer than the re-made seed (stamped at the old seed time), so it wins.
  assert.notEqual(resent[3].status, 'rejected', JSON.stringify(resent[3]));
  assert.deepEqual(resent[3].applied, ['name', 'color']);
  assert.deepEqual([row(third.db, 'crm_businesses', W).name, row(third.db, 'crm_businesses', W).color], ['PouchPlug wholesale', '#0a7cff']);
});

// ---------------------------------------------------------------- every record type through sync

test('every record type is created, changed and deleted through device steps, with who and when', async (t) => {
  const { base, db, ctx } = await setup(t);
  const a = makeDevice(base, 'owner');
  const b = makeDevice(base, 'partner');
  await a.pull();

  const biz = await a.create('business', { name: 'Side project', default_owner: 'partner', position: 7, color: '#336699' });
  const client = await a.create('client', { name: 'Mike’s group', status: 'active', tags: 'vip, referral' });
  const account = await a.create('account', { client_id: client, name: 'Lefty’s Cannabis', city: 'Simcoe', postal_code: 'N3Y 4K3', age_restricted: true });
  const contact = await a.create('contact', { client_id: client, account_id: account, name: 'Mike', email: 'mike@leftys.ca', phone: '5195550100', preferred_channel: 'text' });
  const consent = await a.create('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-10-01', kind: 'express', source: 'asked in person' });
  const rel = await a.create('relationship', { account_id: account, business_id: AGENCY, kind: 'website', status: 'active', start_date: '2026-09-01' });
  const service = await a.create('service', { relationship_id: rel, name: 'Website build', status: 'active', billing: 'flat', amount_cents: 450000, period: 'once', stage: 'design' });
  const activity = await a.create('activity', { client_id: client, account_id: account, business_id: AGENCY, type: 'meeting', body: 'Kick-off', at: nowIso() });
  const accountLink = await a.create('link', { account_id: account, app: 'wom', external_id: '42', matched_by: 'approved' });
  const contactLink = await a.create('link', { contact_id: contact, app: 'wom', external_id: '42', matched_by: 'auto' });

  const lead = await a.create('lead', { name: 'Brantford Auto Body', business_id: AGENCY, kind: 'website', stage: 'lead', email: 'pat@bab.ca' });
  const leadActivity = await a.create('lead_activity', { lead_id: lead, type: 'call', body: 'Wants a quote', at: nowIso() });
  const made = { business: biz, client, account, contact, consent, relationship: rel, service, activity, link: accountLink, lead, lead_activity: leadActivity };
  for (const e of CRM_ENTITIES) {
    const r = row(db, e.table, made[e.entity]);
    assert.ok(r, e.entity);
    assert.equal(r.created_by, 'owner', e.entity);
    assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/, e.entity);
  }
  assert.equal(row(db, 'crm_accounts', account).age_restricted, 1);

  // Changes from the other person's device.
  await b.pull();
  const updates = [
    ['business', biz, { name: 'Side project 2' }],
    ['client', client, { notes: 'Owns three businesses', status: 'active' }],
    ['account', account, { website: 'https://leftys.ca', age_restricted: false }],
    ['contact', contact, { role: 'Owner', phone: '5195550199' }],
    ['relationship', rel, { status: 'paused' }],
    ['service', service, { stage: 'build', renewal_date: '2027-09-01' }],
    ['lead', lead, { stage: 'talking' }],
  ];
  for (const [entity, id, fields] of updates) {
    const r = await b.one(b.step('update', entity, id, fields));
    assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
    const saved = row(db, CRM_ENTITIES.find((e) => e.entity === entity).table, id);
    assert.equal(saved.updated_by, 'partner', entity);
  }
  assert.equal(row(db, 'crm_contacts', contact).phone, '5195550199');
  assert.equal(row(db, 'crm_accounts', account).age_restricted, 0);

  // Append-only and create/delete-only types refuse changes.
  for (const [entity, id, op, fields] of [
    ['consent', consent, 'update', { withdrawn: true }], ['consent', consent, 'delete'],
    ['activity', activity, 'update', { body: 'x' }], ['activity', activity, 'delete'],
    ['lead_activity', leadActivity, 'update', { body: 'x' }],
    ['link', accountLink, 'update', { matched_by: 'auto' }],
    ['business', biz, 'delete'],
  ]) {
    const r = await b.one(b.step(op, entity, id, fields));
    assert.deepEqual([r.status, r.code], ['rejected', 'op_not_allowed'], `${entity} ${op}`);
  }

  // Deletes (children first, the way a screen would): soft, and gone from the read API.
  for (const [entity, id] of [['link', contactLink], ['link', accountLink], ['service', service], ['relationship', rel], ['contact', contact], ['account', account], ['client', client]]) {
    const r = await b.one(b.step('delete', entity, id));
    assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
    assert.ok(row(db, CRM_ENTITIES.find((e) => e.entity === entity).table, id).deleted_at, entity);
  }
  assert.equal((await getJson(base, `/api/crm/clients/${client}`)).status, 404);
  assert.equal((await getJson(base, '/api/crm/clients')).body.total, 0);

  // Server code writes the same way (applyLocal): same rules, same log.
  const imported = ctx.services.sync.applyLocal({ actor: 'owner', entity: 'client', op: 'create', fields: { name: 'Imported', status: 'active' } });
  assert.equal(imported.status, 'applied');
  const noted = ctx.services.sync.applyLocal({ entity: 'activity', op: 'create', fields: { client_id: imported.recordId, type: 'order', body: 'Order #1001', at: nowIso() } });
  assert.equal(noted.status, 'applied');
  assert.equal(row(db, 'crm_activities', noted.recordId).created_by, 'system');
  const pulled = await a.pull();
  assert.equal(pulled.get(`activity/${noted.recordId}`).fields.body, 'Order #1001');
  assert.equal(pulled.get(`client/${client}`).deleted, true);
});

test('nothing writes around the sync steps: direct SQL on any CRM table fails', async (t) => {
  const { db, ctx } = await setup(t);
  // One record of every type (made the right way), so updates and deletes have rows to hit.
  const local = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ entity, op: 'create', fields });
    assert.equal(r.status, 'applied', `${entity}: ${JSON.stringify(r)}`);
    return r.recordId;
  };
  const client = local('client', { name: 'Real', status: 'active' });
  const account = local('account', { client_id: client, name: 'Shop' });
  const contact = local('contact', { client_id: client, name: 'Mike' });
  local('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-10-01' });
  const rel = local('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  local('service', { relationship_id: rel, name: 'Supply', status: 'active' });
  local('activity', { client_id: client, type: 'note', body: 'x', at: nowIso() });
  local('link', { account_id: account, app: 'wom', external_id: '1', matched_by: 'auto' });
  const lead = local('lead', { name: 'Lead', business_id: W, stage: 'lead' });
  local('lead_activity', { lead_id: lead, type: 'note', body: 'x', at: nowIso() });
  for (const table of TABLES) {
    assert.ok(n(db, `SELECT count(*) AS n FROM ${table}`) > 0, table);
    assert.throws(() => db.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(newId()), /written only through the sync module/, table);
    assert.throws(() => db.prepare(`UPDATE ${table} SET deleted_at = 'x'`).run(), /written only through the sync module/, table);
    assert.throws(() => db.prepare(`DELETE FROM ${table}`).run(), /written only through the sync module/, table);
  }
  assert.equal(row(db, 'crm_clients', client).deleted_at, null);
  assert.equal(n(db, 'SELECT count(*) AS n FROM crm_businesses WHERE deleted_at IS NULL'), 6);
});

// ---------------------------------------------------------------- clean contact details

test('clean contact details: the server refuses emails, phones, postal codes and tags not in their stored form', async (t) => {
  const { base, db, ctx } = await setup(t);
  const a = makeDevice(base, 'owner');
  const client = await a.create('client', { name: 'Mike’s group', status: 'active' });
  const account = await a.create('account', { client_id: client, name: 'Vape shop' });
  const contact = await a.create('contact', { client_id: client, name: 'Mike' });

  const refused = [
    ['contact', contact, { email: 'Mike@Leftys.ca' }],
    ['contact', contact, { email: ' mike@leftys.ca' }],
    ['contact', contact, { email: 'mike at leftys' }],
    ['contact', contact, { phone: '(519) 555-0100' }],
    ['contact', contact, { phone: '15195550100' }],
    ['contact', contact, { phone: '555' }],
    ['contact', contact, { phone: '5550100' }], // 7 digits: the same in every area code
    ['contact', contact, { phone: '4312345678x' }],
    ['contact', contact, { phone: '13800138000' }], // not North American, and no country code
    ['contact', contact, { phone: '+15195550100' }], // North America is stored without +1
    ['contact', contact, { email: 'mike\u200b@leftys.ca' }],
    ['account', account, { postal_code: 'n3y4k3' }],
    ['client', client, { tags: 'vip,vip' }],
  ];
  for (const [entity, id, fields] of refused) {
    const r = await a.one(a.step('update', entity, id, fields));
    assert.deepEqual([r.status, r.code], ['rejected', 'invalid_value'], JSON.stringify(fields));
  }
  const ok = await a.one(a.step('update', 'contact', contact, { email: 'mike@leftys.ca', phone: '5195550100' }));
  assert.equal(ok.status, 'applied');
  const vienna = await a.one(a.step('update', 'contact', contact, { phone: '+4312345678' }));
  assert.equal(vienna.status, 'applied', 'outside North America: + and the country code');

  // Server code (imports) passes what it got; applyLocal stores the clean form.
  const imported = ctx.services.sync.applyLocal({
    entity: 'contact', op: 'create',
    fields: { client_id: client, name: 'Sam', email: '  SAM@Exam\u200bple.com\ufeff ', phone: '+1 (519) 555-0123 ext. 4' },
  });
  assert.equal(imported.status, 'applied', JSON.stringify(imported));
  const saved = row(db, 'crm_contacts', imported.recordId);
  assert.deepEqual([saved.email, saved.phone], ['sam@example.com', '5195550123']);
  const abroad = ctx.services.sync.applyLocal({ entity: 'contact', op: 'create', fields: { client_id: client, name: 'Anna', phone: '0043 1 2345678' } });
  assert.equal(row(db, 'crm_contacts', abroad.recordId).phone, '+4312345678');
  const local7 = ctx.services.sync.applyLocal({ entity: 'contact', op: 'create', fields: { client_id: client, name: 'X', phone: '555-0100' } });
  assert.deepEqual([local7.code, /10 digits for North America/.test(local7.reason)], ['invalid_value', true]);
  const bad = ctx.services.sync.applyLocal({ entity: 'contact', op: 'create', fields: { client_id: client, name: 'X', email: 'nope' } });
  assert.deepEqual([bad.status, bad.code], ['rejected', 'invalid_value']);
});

// ---------------------------------------------------------------- consent

test('consent per business is append-only; the latest counts, a same-day withdrawal wins, implied consent lapses', async (t) => {
  const { base } = await setup(t);
  const a = makeDevice(base, 'owner');
  const client = await a.create('client', { name: 'Mike’s group', status: 'active' });
  const contact = await a.create('contact', { client_id: client, name: 'Mike', email: 'mike@leftys.ca' });
  const consentOf = async () => (await getJson(base, `/api/crm/clients/${client}`)).body.contacts[0].consent;
  const given = await a.create('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-01-15', kind: 'express', source: 'trade show sign-up' });
  let c = await consentOf();
  assert.deepEqual([c[W].given, c[W].id, c[W].source, c[W].recordedBy, c[W].expiresOn], [true, given, 'trade show sign-up', 'owner', null]);
  assert.equal(c[CONSULTING], undefined, 'never asked: nothing');

  // Withdrawn for wholesale: a new row. An older sign-up form entered later doesn't undo it.
  const withdrawn = await a.create('consent', { contact_id: contact, business_id: W, withdrawn: true, date: '2026-06-30' });
  await a.create('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-03-01', kind: 'express' });
  c = await consentOf();
  assert.deepEqual([c[W].given, c[W].withdrawn, c[W].id, c[W].date], [false, true, withdrawn, '2026-06-30']);
  // A sign-up the same day, recorded after the unsubscribe, doesn't win either: the withdrawal does.
  await a.create('consent', { contact_id: contact, business_id: W, withdrawn: false, date: '2026-06-30', kind: 'express' });
  assert.equal((await consentOf())[W].given, false);

  // Implied consent lapses: 2 years after a purchase, 6 months after an inquiry (a row without
  // expires_on still lapses: readers work it out from kind and date).
  const today = localDate();
  const longAgo = addMonths(today, -25);
  await a.create('consent', { contact_id: contact, business_id: AGENCY, withdrawn: false, date: longAgo, kind: 'implied_purchase' });
  c = await consentOf();
  assert.deepEqual([c[AGENCY].given, c[AGENCY].expired, c[AGENCY].expiresOn], [false, true, addMonths(longAgo, 24)]);
  const recent = addMonths(today, -1);
  await a.create('consent', { contact_id: contact, business_id: CONSULTING, withdrawn: false, date: recent, kind: 'implied_inquiry', expires_on: consentExpiresOn({ kind: 'implied_inquiry', date: recent }) });
  c = await consentOf();
  assert.deepEqual([c[CONSULTING].given, c[CONSULTING].expiresOn], [true, addMonths(recent, 6)]);

  // Express first, a purchase later: still given, and it never lapses (the express row decides).
  const SPS = BUSINESS_IDS.save_point;
  const yes = await a.create('consent', { contact_id: contact, business_id: SPS, withdrawn: false, date: addMonths(today, -30), kind: 'express' });
  await a.create('consent', { contact_id: contact, business_id: SPS, withdrawn: false, date: addMonths(today, -26), kind: 'implied_purchase' });
  c = await consentOf();
  assert.deepEqual([c[SPS].given, c[SPS].kind, c[SPS].id, c[SPS].expiresOn], [true, 'express', yes, null]);

  const r = await a.one(a.step('create', 'consent', newId(), { contact_id: contact, business_id: W, date: '2026-07-01' }));
  assert.deepEqual([r.status, r.code], ['rejected', 'invalid_value'], 'withdrawn is required: say yes or no');
});

// ---------------------------------------------------------------- references between records

test('references: a record that isn\'t there yet is not_found (retried later); a deleted one is refused', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const b = makeDevice(base, 'partner');

  // B learns of a client that A has not pushed yet (say, A's push is still on its way after a restore).
  const client = newId();
  const early = b.step('create', 'account', newId(), { client_id: client, name: 'Vape shop' });
  const r1 = await b.one(early);
  assert.deepEqual([r1.status, r1.code], ['rejected', 'not_found']);
  assert.match(r1.reason, /client_id/);
  assert.deepEqual(r1.missing, { field: 'client_id', entity: 'client', id: client }, 'names what it waits for');
  const own = await b.one(b.step('update', 'contact', newId(), { name: 'x' }));
  assert.deepEqual([own.code, own.missing.entity, own.missing.field], ['not_found', 'contact', null], 'its own record');
  assert.equal(n(db, 'SELECT count(*) AS n FROM crm_accounts'), 0, 'nothing written');
  await a.create('client', { name: 'Lefty’s', status: 'active' }, client);
  assert.equal((await b.one(early)).status, 'applied', 'the same step, retried unchanged, applies');

  // Pointing at a record of the wrong type is the same as pointing at nothing.
  const wrong = await b.one(b.step('create', 'contact', newId(), { client_id: early.recordId, name: 'x' }));
  assert.equal(wrong.code, 'not_found');
  // Moving a contact to an account that doesn't exist (yet), likewise.
  const contact = await b.create('contact', { client_id: client, name: 'Mike' });
  assert.equal((await b.one(b.step('update', 'contact', contact, { account_id: newId() }))).code, 'not_found');

  // Deleted, and the device knew (it had pulled the delete): refused, not resurrected.
  const gone = await a.create('client', { name: 'Gone', status: 'closed' });
  await a.pull();
  assert.equal((await a.one(a.step('delete', 'client', gone))).status, 'applied');
  await a.pull();
  const late = await a.one(a.step('create', 'activity', newId(), { client_id: gone, type: 'note', body: 'x', at: nowIso() }));
  assert.deepEqual([late.status, late.code], ['rejected', 'deleted']);
  assert.ok(row(db, 'crm_clients', gone).deleted_at, 'still deleted');
});

test('a note added to a client the other person deleted at the same time keeps the client, flagged (either order)', async (t) => {
  for (const order of ['delete-first', 'note-first']) {
    const { base, db } = await setup(t);
    const a = makeDevice(base, 'owner');
    const b = makeDevice(base, 'partner');
    const client = await a.create('client', { name: `Lefty’s ${order}`, status: 'active' });
    await a.pull();
    await b.pull();
    const del = a.step('delete', 'client', client);
    const note = b.step('create', 'activity', newId(), { client_id: client, type: 'call', body: 'Wants a quote for a new sign', at: nowIso() });

    if (order === 'delete-first') {
      assert.equal((await a.one(del)).status, 'applied');
      const r = await b.one(note);
      assert.equal(r.status, 'applied', 'the note itself applied');
      assert.deepEqual(r.revived, [{ entity: 'client', id: client }]);
      assert.equal(r.clashes.length, 1);
    } else {
      assert.equal((await b.one(note)).status, 'applied');
      const r = await a.one(del);
      assert.deepEqual([r.status, r.kept], ['clash', true]);
    }
    const c = row(db, 'crm_clients', client);
    assert.deepEqual([c.deleted_at, c.flagged], [null, 1], `${order}: kept and flagged`);
    assert.ok(row(db, 'crm_activities', note.recordId), `${order}: the note is in`);
    const [clash] = (await getJson(base, `/api/sync/clashes?entity=client&recordId=${client}`)).body.clashes;
    assert.equal(clash.kind, 'delete');
    assert.equal(clash.loser.actor, 'owner', 'the delete lost');
    assert.deepEqual(clash.winner.value, { _child: { entity: 'activity', id: note.recordId } }, 'what kept it');

    // Both devices see the client again, flagged, with the question on it; the client page too.
    const pulled = (await a.pull()).get(`client/${client}`);
    assert.deepEqual([pulled.deleted, pulled.flagged, pulled.clashes.length], [false, true, 1]);
    const page = (await getJson(base, `/api/crm/clients/${client}`)).body;
    assert.equal(page.client._sync.flagged, true);
    assert.equal(page.client._sync.clashes[0].id, clash.id);
    assert.equal(page.activities[0].body, 'Wants a quote for a new sign');

    // Settled: kept (delete-first) or deleted after all (note-first).
    const resolution = order === 'delete-first' ? 'keep_winner' : 'keep_loser';
    assert.equal((await resolve(base, clash.id, resolution)).status, 200);
    const after = row(db, 'crm_clients', client);
    if (resolution === 'keep_winner') assert.deepEqual([after.deleted_at, after.flagged], [null, 0]);
    else assert.ok(after.deleted_at);
  }
});

test('the chain: work added deep under a client deleted at the same time keeps the client (either order)', async (t) => {
  for (const order of ['delete-first', 'service-first']) {
    const { base, db } = await setup(t);
    const a = makeDevice(base, 'owner');
    const b = makeDevice(base, 'partner');
    const client = await a.create('client', { name: 'Lefty’s', status: 'active' });
    const account = await a.create('account', { client_id: client, name: 'Dispensary' });
    const rel = await a.create('relationship', { account_id: account, business_id: AGENCY, kind: 'social', status: 'active' });
    await a.pull();
    await b.pull();
    // A deletes the client (only the client: nothing cascades); B adds a retainer to its relationship.
    const del = a.step('delete', 'client', client);
    const svc = b.step('create', 'service', newId(), { relationship_id: rel, name: 'Social retainer', status: 'active', amount_cents: 80000, period: 'monthly' });
    if (order === 'delete-first') {
      assert.equal((await a.one(del)).status, 'applied');
      const r = await b.one(svc);
      assert.equal(r.status, 'applied');
      assert.deepEqual(r.revived, [{ entity: 'client', id: client }], 'the deleted ancestor, two levels up');
    } else {
      assert.equal((await b.one(svc)).status, 'applied');
      assert.deepEqual((await a.one(del)).kept, true, 'its subtree changed unseen');
    }
    assert.deepEqual([row(db, 'crm_clients', client).deleted_at, row(db, 'crm_clients', client).flagged], [null, 1], order);
    const [clash] = (await getJson(base, `/api/sync/clashes?entity=client&recordId=${client}`)).body.clashes;
    assert.deepEqual(clash.winner.value, { _child: { entity: 'service', id: svc.recordId } }, order);
    const page = (await getJson(base, `/api/crm/clients/${client}`)).body;
    assert.equal(page.accounts[0].relationships[0].services[0].name, 'Social retainer', `${order}: on the client page`);
  }
});

test('an edit of a contact while the other person deleted its client keeps the client; optional links may point at deleted records', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const b = makeDevice(base, 'partner');
  const client = await a.create('client', { name: 'Lefty’s', status: 'active' });
  const account = await a.create('account', { client_id: client, name: 'Dispensary' });
  const contact = await a.create('contact', { client_id: client, account_id: account, name: 'Mike' });
  await a.pull();
  await b.pull();
  assert.equal((await a.one(a.step('delete', 'client', client))).status, 'applied');
  const r = await b.one(b.step('update', 'contact', contact, { phone: '5195550100' }));
  assert.equal(r.status, 'applied');
  assert.deepEqual(r.revived, [{ entity: 'client', id: client }]);
  assert.equal(row(db, 'crm_clients', client).flagged, 1);

  // An account deleted (knowingly): contacts and notes may still name it; it reads as none.
  await a.pull();
  await b.pull();
  assert.equal((await a.one(a.step('delete', 'account', account))).status, 'applied');
  await a.pull();
  const note = await a.one(a.step('create', 'activity', newId(), { client_id: client, account_id: account, type: 'note', body: 'x', at: nowIso() }));
  assert.equal(note.status, 'applied', 'account_id is not what a note belongs to');
  assert.equal(row(db, 'crm_accounts', account).deleted_at !== null, true, 'and it stays deleted');
  const page = (await getJson(base, `/api/crm/clients/${client}`)).body;
  assert.deepEqual([page.accounts.length, page.contacts[0].account_id], [0, account]);
  // But nothing can be added under it.
  const rel = await a.one(a.step('create', 'relationship', newId(), { account_id: account, business_id: W, kind: 'wholesale', status: 'active' }));
  assert.deepEqual([rel.status, rel.code], ['rejected', 'deleted']);
});

test('a delete of what the device had fully seen just deletes, even with notes on it', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const b = makeDevice(base, 'partner');
  const client = await a.create('client', { name: 'Old client', status: 'closed' });
  await b.create('activity', { client_id: client, type: 'note', body: 'Seen by A before deleting', at: nowIso() });
  // A note added and then removed elsewhere doesn't hold a delete either (contacts can be deleted).
  const contact = await b.create('contact', { client_id: client, name: 'Temp' });
  assert.equal((await b.one(b.step('delete', 'contact', contact))).status, 'applied');
  await a.pull();
  const r = await a.one(a.step('delete', 'client', client));
  assert.equal(r.status, 'applied');
  assert.ok(row(db, 'crm_clients', client).deleted_at);
  assert.equal(n(db, 'SELECT count(*) AS n FROM sync_clashes'), 0);
});

test('links: exactly one target, one live link per outside record and kind; a link under a deleted record frees it', async (t) => {
  const { base, ctx } = await setup(t);
  const a = makeDevice(base, 'owner');
  const client = await a.create('client', { name: 'Mike’s group', status: 'active' });
  const account = await a.create('account', { client_id: client, name: 'Vape shop' });
  const contact = await a.create('contact', { client_id: client, account_id: account, name: 'Mike' });
  const both = await a.one(a.step('create', 'link', newId(), { account_id: account, contact_id: contact, app: 'wom', external_id: '7', matched_by: 'auto' }));
  assert.equal(both.code, 'constraint');
  const neither = await a.one(a.step('create', 'link', newId(), { app: 'wom', external_id: '7', matched_by: 'auto' }));
  assert.equal(neither.code, 'constraint');
  const first = await a.create('link', { account_id: account, app: 'wom', external_id: '7', matched_by: 'auto' });
  await a.create('link', { contact_id: contact, app: 'wom', external_id: '7', matched_by: 'auto' });
  const twice = await a.one(a.step('create', 'link', newId(), { account_id: account, app: 'wom', external_id: '7', matched_by: 'approved' }));
  assert.deepEqual([twice.status, twice.code], ['rejected', 'already_linked']);
  assert.match(twice.reason, new RegExp(`account ${account}`));
  const local = ctx.services.sync.applyLocal({ entity: 'link', op: 'create', fields: { account_id: account, app: 'wom', external_id: '7', matched_by: 'auto' } });
  assert.equal(local.code, 'already_linked', 'server code (D2) gets the same answer');
  const unknownApp = await a.one(a.step('create', 'link', newId(), { account_id: account, app: 'quickbooks', external_id: '7', matched_by: 'auto' }));
  assert.equal(unknownApp.code, 'invalid_value');
  // Undo (delete) the link, then link again.
  assert.equal((await a.one(a.step('delete', 'link', first))).status, 'applied');
  const again = await a.create('link', { account_id: account, app: 'wom', external_id: '7', matched_by: 'approved' });
  let page = (await getJson(base, `/api/crm/clients/${client}`)).body;
  assert.deepEqual(page.accounts[0].links.map((l) => l.matched_by), ['approved']);
  assert.deepEqual(page.contacts[0].links.map((l) => [l.app, l.external_id]), [['wom', '7']]);

  // The account is deleted (its link stays in the table, nothing cascades): the Order Manager
  // customer can now be linked to another account — the orphan link no longer counts.
  await a.pull();
  assert.equal((await a.one(a.step('delete', 'account', account))).status, 'applied');
  const other = await a.create('account', { client_id: client, name: 'Vape shop (new)' });
  assert.equal((await a.one(a.step('create', 'link', newId(), { account_id: other, app: 'wom', external_id: '7', matched_by: 'approved' }))).status, 'applied');
  assert.equal(ctx.services.crm.liveLinks('wom', '7').filter((l) => l.account_id).length, 1);
  assert.notEqual(ctx.services.crm.liveLinks('wom', '7').find((l) => l.account_id).id, again);
  // Same when the whole client goes: its contact link stops counting.
  await a.pull();
  assert.equal((await a.one(a.step('delete', 'client', client))).status, 'applied');
  assert.deepEqual(ctx.services.crm.liveLinks('wom', '7'), []);
  const client2 = await a.create('client', { name: 'Mike (again)', status: 'active' });
  const contact2 = await a.create('contact', { client_id: client2, name: 'Mike' });
  assert.equal((await a.one(a.step('create', 'link', newId(), { contact_id: contact2, app: 'wom', external_id: '7', matched_by: 'auto' }))).status, 'applied');
  page = (await getJson(base, `/api/crm/clients/${client2}`)).body;
  assert.equal(page.contacts[0].links.length, 1);
});

// ---------------------------------------------------------------- the plan's example and the read API

/** The plan's example: one owner, three businesses, each with a different one of ours. */
async function threeBusinesses(a) {
  const client = await a.create('client', { name: 'Mike Leduc', status: 'active', tags: 'referral' });
  const dispensary = await a.create('account', { client_id: client, name: 'Lefty’s Cannabis Dispensary', street: '12 Norfolk St S', city: 'Simcoe', region: 'ON', postal_code: 'N3Y 2V8', website: 'https://leftys.ca', age_restricted: true });
  const vape = await a.create('account', { client_id: client, name: 'Cloud Nine Vape', city: 'Delhi', region: 'ON', age_restricted: true });
  const parent = await a.create('account', { client_id: client, name: 'Leduc Holdings' });
  const owner = await a.create('contact', { client_id: client, name: 'Mike Leduc', role: 'Owner', email: 'mike@leduc.ca', phone: '5195550100', preferred_channel: 'text' });
  const manager = await a.create('contact', { client_id: client, account_id: vape, name: 'Dana', role: 'Store manager', email: 'dana@cloudnine.ca' });
  const website = await a.create('relationship', { account_id: dispensary, business_id: AGENCY, kind: 'website', status: 'active', start_date: '2026-08-01' });
  const social = await a.create('relationship', { account_id: dispensary, business_id: AGENCY, kind: 'social', status: 'active', start_date: '2026-09-01' });
  const wholesale = await a.create('relationship', { account_id: vape, business_id: W, kind: 'wholesale', status: 'active', start_date: '2025-04-01' });
  const consulting = await a.create('relationship', { account_id: parent, business_id: CONSULTING, kind: 'consulting', status: 'active' });
  const build = await a.create('service', { relationship_id: website, name: 'Website build', status: 'active', stage: 'design', billing: 'flat', amount_cents: 450000, period: 'once' });
  const retainer = await a.create('service', { relationship_id: social, name: 'Social media retainer', status: 'active', billing: 'flat', amount_cents: 80000, period: 'monthly', renewal_date: '2027-09-01' });
  const growth = await a.create('service', { relationship_id: consulting, name: 'Growth consulting', status: 'active', billing: 'hourly', rate_cents: 15000, sessions: 6, scope: 'Q4 plan' });
  await a.create('consent', { contact_id: owner, business_id: AGENCY, withdrawn: false, date: '2026-08-01', kind: 'express' });
  await a.create('consent', { contact_id: manager, business_id: W, withdrawn: false, date: '2025-04-01', kind: 'implied_purchase' });
  const times = ['2026-09-01T15:00:00.000Z', '2026-09-20T15:00:00.000Z', '2026-10-01T15:00:00.000Z'];
  await a.create('activity', { client_id: client, account_id: dispensary, business_id: AGENCY, type: 'milestone', body: 'Homepage design approved', at: times[1] });
  await a.create('activity', { client_id: client, account_id: vape, business_id: W, type: 'order', body: 'Order: 40 tins', at: times[0] });
  await a.create('activity', { client_id: client, account_id: parent, business_id: CONSULTING, type: 'meeting', body: 'Talked about the Q4 plan', at: times[2] });
  await a.create('link', { account_id: vape, app: 'wom', external_id: '118', matched_by: 'approved' });
  return { client, dispensary, vape, parent, owner, manager, website, social, wholesale, consulting, build, retainer, growth };
}

test('the plan\'s example: one owner with three businesses, built through steps, on one page', async (t) => {
  const { base } = await setup(t);
  const a = makeDevice(base, 'owner');
  const x = await threeBusinesses(a);
  const { status, body } = await getJson(base, `/api/crm/clients/${x.client}`);
  assert.equal(status, 200);

  assert.deepEqual(Object.keys(body).sort(), ['accounts', 'activities', 'activityCount', 'client', 'contacts']);
  assert.equal(body.client.name, 'Mike Leduc');
  assert.equal(body.client.tags, 'referral');
  assert.equal(body.client.created_by, 'owner');
  assert.deepEqual(body.client._sync, { flagged: false, clashes: [] });

  // Accounts (by name), each with what our businesses do for it.
  assert.deepEqual(body.accounts.map((acc) => acc.name), ['Cloud Nine Vape', 'Leduc Holdings', 'Lefty’s Cannabis Dispensary']);
  const acc = Object.fromEntries(body.accounts.map((r) => [r.id, r]));
  const dispensary = acc[x.dispensary];
  assert.equal(dispensary.age_restricted, true);
  assert.equal(dispensary.postal_code, 'N3Y 2V8');
  assert.deepEqual(dispensary.relationships.map((r) => [r.business_id, r.kind]), [[AGENCY, 'website'], [AGENCY, 'social']]);
  assert.deepEqual(dispensary.relationships[0].services.map((s) => [s.name, s.amount_cents, s.period, s.stage]), [['Website build', 450000, 'once', 'design']]);
  assert.deepEqual(dispensary.relationships[1].services.map((s) => [s.name, s.amount_cents, s.period, s.renewal_date]), [['Social media retainer', 80000, 'monthly', '2027-09-01']]);
  assert.deepEqual(acc[x.vape].relationships.map((r) => [r.business_id, r.kind, r.services.length]), [[W, 'wholesale', 0]]);
  assert.deepEqual(acc[x.vape].links.map((l) => [l.app, l.external_id, l.matched_by]), [['wom', '118', 'approved']]);
  assert.equal(acc[x.parent].age_restricted, null, 'not set');
  assert.deepEqual(acc[x.parent].relationships[0].services.map((s) => [s.billing, s.rate_cents, s.sessions]), [['hourly', 15000, 6]]);

  // Contacts: the owner at the client level, the manager at the vape shop; consent per business.
  const [dana, mike] = body.contacts;
  assert.deepEqual([mike.name, mike.account_id, mike.email, mike.phone], ['Mike Leduc', null, 'mike@leduc.ca', '5195550100']);
  assert.deepEqual([dana.account_id, Object.keys(dana.consent)], [x.vape, [W]]);
  assert.equal(mike.consent[AGENCY].given, true);
  assert.equal(mike.consent[W], undefined);

  // The timeline: newest first, every business.
  assert.equal(body.activityCount, 3);
  assert.deepEqual(body.activities.map((r) => r.type), ['meeting', 'milestone', 'order']);
  assert.equal(body.activities[0].created_by, 'owner');

  // One client, three of our businesses.
  const list = (await getJson(base, '/api/crm/clients')).body;
  assert.equal(list.total, 1);
  assert.deepEqual(list.clients[0].businessIds, [W, AGENCY, CONSULTING].sort());
  assert.deepEqual([list.clients[0].accountCount, list.clients[0].contactCount], [3, 2]);
  assert.equal(list.clients[0].lastActivityAt, '2026-10-01T15:00:00.000Z');

  // Filtered by our business or theirs.
  const tl = (await getJson(base, `/api/crm/clients/${x.client}/activities?business=${W}`)).body;
  assert.deepEqual([tl.total, tl.activities[0].body], [1, 'Order: 40 tins']);
  const byAccount = (await getJson(base, `/api/crm/clients/${x.client}/activities?account=${x.dispensary}`)).body;
  assert.deepEqual(byAccount.activities.map((r) => r.type), ['milestone']);
  const page2 = (await getJson(base, `/api/crm/clients/${x.client}/activities?limit=2&offset=2`)).body;
  assert.deepEqual([page2.total, page2.activities.length, page2.activities[0].type], [3, 1, 'order']);
});

test('deletes don\'t cascade: what belongs to a deleted record is hidden with it, and kept', async (t) => {
  const { base, db } = await setup(t);
  const a = makeDevice(base, 'owner');
  const x = await threeBusinesses(a);
  await a.pull();
  // The vape shop account is deleted: its relationship, link and the client's wholesale business go from reads.
  assert.equal((await a.one(a.step('delete', 'account', x.vape))).status, 'applied');
  const page = (await getJson(base, `/api/crm/clients/${x.client}`)).body;
  assert.deepEqual(page.accounts.map((r) => r.id).sort(), [x.dispensary, x.parent].sort());
  const dana = page.contacts.find((c) => c.id === x.manager);
  assert.equal(dana.account_id, x.vape, 'a non-parent ref keeps naming it (read it as none)');
  const list = (await getJson(base, '/api/crm/clients')).body.clients[0];
  assert.deepEqual(list.businessIds, [AGENCY, CONSULTING].sort());
  assert.equal((await getJson(base, `/api/crm/clients?business=${W}`)).body.total, 0);
  assert.equal(row(db, 'crm_relationships', x.wholesale).deleted_at, null, 'the relationship itself is untouched');

  // The client is deleted: everything under it goes from the reads, nothing is deleted with it.
  await a.pull();
  assert.equal((await a.one(a.step('delete', 'client', x.client))).status, 'applied');
  assert.equal((await getJson(base, `/api/crm/clients/${x.client}`)).status, 404);
  assert.equal((await getJson(base, '/api/crm/clients')).body.total, 0);
  assert.equal(n(db, 'SELECT count(*) AS n FROM crm_accounts WHERE deleted_at IS NULL'), 2, 'its other accounts are still there');
  assert.equal(n(db, 'SELECT count(*) AS n FROM crm_activities'), 3);
});

test('client list: search by name, email or phone however typed; filter by our business and status', async (t) => {
  const { base } = await setup(t);
  const a = makeDevice(base, 'owner');
  const x = await threeBusinesses(a);
  const other = await a.create('client', { name: 'Ana’s Bakery', status: 'closed' });
  await a.create('contact', { client_id: other, name: 'Ana', email: 'ana@bakery.ca', phone: '2265550199' });
  await a.create('client', { name: '100% Juice', status: 'active' });

  const names = async (qs) => {
    const r = await getJson(base, `/api/crm/clients?${qs}`);
    assert.equal(r.status, 200, `${qs}: ${JSON.stringify(r.body)}`);
    return r.body.clients.map((c) => c.name);
  };
  assert.deepEqual(await names(''), ['100% Juice', 'Ana’s Bakery', 'Mike Leduc'], 'by name');
  assert.deepEqual(await names('q=leduc'), ['Mike Leduc'], 'client name');
  assert.deepEqual(await names('q=cloud%20nine'), ['Mike Leduc'], 'an account name');
  assert.deepEqual(await names('q=dana'), ['Mike Leduc'], 'a contact name');
  assert.deepEqual(await names('q=ANA%40BAKERY.CA'), ['Ana’s Bakery'], 'an email, any case');
  assert.deepEqual(await names(`q=${encodeURIComponent('+1 (519) 555-0100')}`), ['Mike Leduc'], 'a phone, typed any way');
  assert.deepEqual(await names('q=555-0199'), ['Ana’s Bakery'], 'part of a phone');
  assert.deepEqual(await names('q=100%25'), ['100% Juice'], '% is literal');
  assert.deepEqual(await names('q=zzz'), []);
  assert.deepEqual(await names(`business=${CONSULTING}`), ['Mike Leduc']);
  assert.deepEqual(await names(`business=${BUSINESS_IDS.save_point}`), []);
  assert.deepEqual(await names('status=closed'), ['Ana’s Bakery']);
  assert.deepEqual(await names('limit=1&offset=1'), ['Ana’s Bakery']);
  assert.equal((await getJson(base, '/api/crm/clients?limit=1')).body.total, 3);

  // A relationship deleted: the client no longer shows under that business.
  assert.equal((await a.one(a.step('delete', 'relationship', x.consulting))).status, 'applied');
  assert.deepEqual(await names(`business=${CONSULTING}`), []);

  for (const bad of ['limit=0', 'limit=500', 'offset=-1', 'limit=abc', 'business=nope', 'status=maybe', 'q=a&q=b', `q=${'x'.repeat(201)}`]) {
    assert.equal((await getJson(base, `/api/crm/clients?${bad}`)).status, 400, bad);
  }
  assert.equal((await getJson(base, '/api/crm/clients/nope')).status, 404);
  assert.equal((await getJson(base, `/api/crm/clients/${newId()}`)).status, 404);
  assert.equal((await getJson(base, `/api/crm/clients/${newId()}/activities`)).status, 404);
  assert.equal((await getJson(base, `/api/crm/clients/${x.client}/activities?type=fax`)).status, 400);
  // Signed in only.
  const anon = await getJson(base, '/api/crm/clients', null);
  assert.deepEqual([anon.status, anon.body.code], [401, 'not_signed_in']);
  // Read-only: there is nothing to write to here.
  const post = await fetch(`${base}/api/crm/clients`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: apps.get(base).observer.cookie, origin: base }, body: '{}',
  });
  assert.equal(post.status, 404);
});

test('the read API stays quick with 5,000 clients (search, business filter, paging)', async (t) => {
  const { base, db, ctx } = await setup(t);
  const sync = ctx.services.sync;
  const ours = [W, AGENCY, CONSULTING];
  const made = [];
  db.transaction(() => {
    for (let i = 0; i < 5000; i += 1) {
      const local = (entity, fields) => sync.applyLocal({ entity, op: 'create', fields }).recordId;
      const m = {
        name: `Client ${String(i).padStart(4, '0')}`, status: i % 10 ? 'active' : 'closed', business: ours[i % 3],
        shop: `Shop ${i}`, person: `Person ${i}`, email: `p${i}@example.ca`, phone: `519555${String(i).padStart(4, '0')}`,
      };
      made.push(m);
      const c = local('client', { name: m.name, status: m.status });
      const acc = local('account', { client_id: c, name: m.shop });
      local('contact', { client_id: c, account_id: acc, name: m.person, email: m.email, phone: m.phone });
      local('relationship', { account_id: acc, business_id: m.business, kind: 'wholesale', status: 'active' });
    }
  })();
  const has = (text, part) => text.toLowerCase().includes(part.toLowerCase());
  const cases = [
    ['', () => true],
    [`business=${CONSULTING}`, (m) => m.business === CONSULTING],
    ['q=person%2042', (m) => has(m.person, 'person 42')],
    [`business=${W}&q=shop%201`, (m) => m.business === W && has(m.shop, 'shop 1')],
    [`q=${encodeURIComponent('(519) 555-0042')}`, (m) => m.phone === '5195550042'],
    ['q=p4999%40example', (m) => has(m.email, 'p4999@example')],
    [`status=closed&business=${AGENCY}&offset=100`, (m) => m.status === 'closed' && m.business === AGENCY],
  ];
  for (const [qs, match] of cases) {
    const t0 = performance.now();
    const r = await getJson(base, `/api/crm/clients?${qs}`);
    const ms = performance.now() - t0;
    assert.equal(r.status, 200, qs);
    assert.equal(r.body.total, made.filter(match).length, qs);
    assert.ok(ms < 250, `${qs || 'all'}: ${ms.toFixed(0)} ms (was seconds when each filter ran per client)`);
  }
  // The page is the right one: sorted by name, offset applied, counts filled in.
  const page = (await getJson(base, `/api/crm/clients?business=${CONSULTING}&limit=2&offset=1`)).body.clients;
  assert.deepEqual(page.map((c) => c.name), made.filter((m) => m.business === CONSULTING).slice(1, 3).map((m) => m.name));
  assert.deepEqual([page[0].accountCount, page[0].contactCount, page[0].businessIds], [1, 1, [CONSULTING]]);
});
