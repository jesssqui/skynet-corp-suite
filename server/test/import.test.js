// C7: the accounting CSV import — preview flags, commit through sync.applyLocal (in the sync log,
// pulled by devices), idempotent re-imports, edited files, never overwriting, the guard, limits,
// and big files in chunks while the server keeps answering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '@suite/shared/ids';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { CRM_ENTITIES } from '../src/modules/crm/entities.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from './helpers.js';

const AGENCY = BUSINESS_IDS.agency;
const CONSULTING = BUSINESS_IDS.consulting;

async function setup(t, env = {}) {
  const app = await startApp(t, testConfig(tmpDir(t), env));
  const users = await ensureTestUsers(app.ctx);
  const owner = sessionFor(app.ctx, users.owner);
  const partner = sessionFor(app.ctx, users.partner);
  const call = async (method, path, body, who = owner) => {
    const res = await fetch(`${app.base}${path}`, {
      method,
      headers: { cookie: who.cookie, origin: app.base, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const preview = async (text, opts = {}) => {
    const r = await call('POST', '/api/crm/import/preview', { text, fileName: 'customers.csv', business: AGENCY, kind: 'website', ...opts });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  /** Commit and wait until it has finished; returns the finished batch. */
  const commit = async (text, opts = {}, who = owner) => {
    const r = await call('POST', '/api/crm/import/commit', { batchId: newId(), text, fileName: 'customers.csv', business: AGENCY, kind: 'website', ...opts }, who);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    return waitFor(r.body.batch.id);
  };
  const waitFor = async (id) => {
    for (let i = 0; i < 600; i += 1) {
      const { body } = await call('GET', `/api/crm/import/batches/${id}`);
      if (body.batch.status !== 'running') return body.batch;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('import never finished');
  };
  const count = (table, where = 'deleted_at IS NULL') => app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get().n;
  return { ...app, users, owner, partner, call, preview, commit, waitFor, count };
}

// A Wave-style export, with the messy bits real files have: a BOM, quotes, commas and a line break
// inside fields, a 7-digit phone, a bad email, CRLF line ends.
const WAVE = [
  '﻿Customer Name,Email,Phone,Contact First Name,Contact Last Name,Address Line 1,City,Province/State,Postal Code/Zip Code,Country,Website',
  'Harbour Lights Bakery,orders@harbourlights.test,(519) 555-0101,Ada,Moss,12 Main St,Port Dover,ON,n0a1n0,Canada,harbourlights.test',
  '"Birch & Bark, Inc.",hello@birchbark.test,519.555.0102,Ben,Cole,"4 Pine Rd, Unit 2",Simcoe,ON,N3Y 4K3,Canada,',
  'Kettle Creek Outfitters,,555-0103,Cy,Dunn,,Delhi,ON,,Canada,',
  '"Lakeview Dental","front desk @ lakeview",+44 (0)20 7946 0958,Dee,"Eve\nOffice manager",,,,,UK,',
].join('\r\n');

test('preview: rows flagged and cleaned, nothing written; the mapping is detected (Wave)', async (t) => {
  const s = await setup(t);
  const before = s.count('sync_steps', '1 = 1');
  const p = await s.preview(WAVE);
  assert.equal(s.count('sync_steps', '1 = 1'), before, 'a preview writes nothing');
  assert.equal(p.source, 'Wave');
  assert.equal(p.total, 4);
  assert.deepEqual(p.counts, { new: 4, same: 0, similar: 0, changed: 0, imported: 0, duplicate: 0, invalid: 0 });
  const [harbour, birch, kettle, lake] = p.rows;
  assert.deepEqual([harbour.row, harbour.client.name, harbour.contact.name, harbour.contact.email, harbour.contact.phone],
    [2, 'Harbour Lights Bakery', 'Ada Moss', 'orders@harbourlights.test', '5195550101']);
  assert.equal(harbour.account.address, '12 Main St · Port Dover, ON · N0A 1N0 · Canada');
  assert.deepEqual(harbour.relationships, [{ business_id: AGENCY, kind: 'website' }]);
  assert.deepEqual([harbour.action, harbour.actions], ['create', ['create', 'skip']]);
  assert.equal(birch.client.name, 'Birch & Bark, Inc.');
  assert.equal(birch.account.address, '4 Pine Rd, Unit 2 · Simcoe, ON · N3Y 4K3 · Canada');
  assert.equal(kettle.contact.phone, null);
  assert.match(kettle.warnings[0], /555-0103.*area code/);
  assert.equal(lake.contact.phone, '+442079460958');
  assert.equal(lake.contact.name, 'Dee Eve Office manager', 'a line break inside a quoted field');
  assert.match(lake.warnings[0], /front desk @ lakeview/);
});

test('commit: clients, accounts, contacts and relationships through applyLocal — in the sync log, pulled by a device', async (t) => {
  const s = await setup(t);
  const batch = await s.commit(WAVE);
  assert.deepEqual([batch.status, batch.totalRows, batch.processed, batch.createdClients, batch.addedTo, batch.skipped, batch.failed],
    ['done', 4, 4, 4, 0, 0, 0]);
  assert.equal(batch.records, 4 * 5, 'client, account, relationship, contact and a timeline note per row');
  assert.deepEqual([batch.fileName, batch.source, batch.actor, batch.businessId, batch.kind], ['customers.csv', 'Wave', 'owner', AGENCY, 'website']);
  assert.equal(s.count('crm_clients'), 4);
  assert.equal(s.count('crm_relationships', `business_id = '${AGENCY}' AND kind = 'website' AND status = 'active'`), 4);
  const c = s.db.prepare("SELECT c.*, a.name AS account, a.city, a.postal_code, a.website FROM crm_contacts c JOIN crm_accounts a ON a.id = c.account_id WHERE c.email = 'orders@harbourlights.test'").get();
  assert.deepEqual([c.name, c.phone, c.account, c.city, c.postal_code, c.website, c.created_by], ['Ada Moss', '5195550101', 'Harbour Lights Bakery', 'Port Dover', 'N0A 1N0', 'harbourlights.test', 'owner']);
  assert.equal(s.db.prepare("SELECT notes FROM crm_contacts WHERE name = 'Cy Dunn'").get().notes, 'Phone as typed: 555-0103');
  const note = s.db.prepare("SELECT * FROM crm_activities WHERE body LIKE 'Imported from%' LIMIT 1").get();
  assert.deepEqual([note.type, note.business_id, note.created_by, note.body], ['note', AGENCY, 'owner', 'Imported from “customers.csv” (accounting customer list).']);
  // Every record is a step in the sync log, made by the person who imported.
  const steps = s.db.prepare("SELECT entity, actor, count(*) AS n FROM sync_steps WHERE entity IN ('client','account','contact','relationship','activity') GROUP BY entity, actor ORDER BY entity").all();
  assert.deepEqual(steps.map((r) => [r.entity, r.actor, r.n]), [['account', 'owner', 4], ['activity', 'owner', 4], ['client', 'owner', 4], ['contact', 'owner', 4], ['relationship', 'owner', 4]]);
  // The partner's phone pulls them like anything else.
  const phone = await fetch(`${s.base}/api/sync/pull?limit=1000`, { headers: { cookie: s.partner.cookie } }).then((r) => r.json());
  const pulled = phone.changes.filter((ch) => ch.entity === 'client').map((ch) => ch.fields.name).sort();
  assert.deepEqual(pulled, ['Birch & Bark, Inc.', 'Harbour Lights Bakery', 'Kettle Creek Outfitters', 'Lakeview Dental']);
  assert.equal(phone.changes.find((ch) => ch.entity === 'client').meta.createdBy, 'owner');
  // The batch is listed for the page.
  const list = (await s.call('GET', '/api/crm/import/batches')).body;
  assert.deepEqual([list.batches.length, list.batches[0].id, list.running], [1, batch.id, null]);
});

test('the same file twice creates nothing new: every row is "imported before" (even for another business)', async (t) => {
  const s = await setup(t);
  await s.commit(WAVE);
  const before = { clients: s.count('crm_clients'), steps: s.count('sync_steps', '1 = 1') };
  const p = await s.preview(WAVE);
  assert.deepEqual(p.counts, { new: 0, same: 0, similar: 0, changed: 0, imported: 4, duplicate: 0, invalid: 0 });
  assert.ok(p.rows.every((r) => r.action === 'skip' && r.previous.fileName === 'customers.csv' && r.previous.live));
  const again = await s.commit(WAVE);
  assert.deepEqual([again.createdClients, again.addedTo, again.skipped, again.records], [0, 0, 4, 0]);
  const other = await s.commit(WAVE, { business: CONSULTING, kind: 'consulting' });
  assert.deepEqual([other.createdClients, other.records], [0, 0]);
  assert.deepEqual({ clients: s.count('crm_clients'), steps: s.count('sync_steps', '1 = 1') }, before);
  // Typed differently (case, spacing, phone punctuation, ; separator): still the same rows.
  const retyped = WAVE.replace('(519) 555-0101', '519 555 0101').replace('orders@harbourlights.test', 'ORDERS@HarbourLights.test')
    .replace(/,/g, ';').replace('"Birch & Bark; Inc."', '"Birch & Bark, Inc."').replace('"4 Pine Rd; Unit 2"', '"4 Pine Rd, Unit 2"');
  assert.deepEqual((await s.preview(retyped)).counts.imported, 4);
  // A retried commit (same batch id) finds the batch instead of importing again.
  const id = newId();
  const first = await s.call('POST', '/api/crm/import/commit', { batchId: id, text: 'Name,Email\nRetry Co,r@retry.test' });
  assert.equal(first.status, 202);
  await s.waitFor(id);
  const second = await s.call('POST', '/api/crm/import/commit', { batchId: id, text: 'Name,Email\nRetry Co,r@retry.test' });
  assert.deepEqual([second.status, second.body.batch.id, second.body.batch.createdClients], [200, id, 1]);
  assert.equal(s.count('crm_clients', "name = 'Retry Co'"), 1);
});

test('an edited file adds only the new rows; changed rows are flagged and not applied', async (t) => {
  const s = await setup(t);
  await s.commit(WAVE);
  const edited = `${WAVE.replace('Port Dover,ON', 'Port Rowan,ON').replace('hello@birchbark.test,519.555.0102', 'sales@birchbark.test,519.555.0177')}\r\nNorth Shore Kayaks,paddle@northshore.test,226-555-0105,Fay,Gill,,,,,,`;
  const p = await s.preview(edited);
  assert.deepEqual(p.counts, { new: 1, same: 0, similar: 0, changed: 2, imported: 2, duplicate: 0, invalid: 0 });
  const harbour = p.rows.find((r) => r.client.name === 'Harbour Lights Bakery');
  assert.equal(harbour.status, 'changed');
  assert.deepEqual(harbour.actions, ['skip', 'add', 'create']);
  assert.equal(harbour.previous.clientName, 'Harbour Lights Bakery');
  assert.deepEqual(harbour.adds, { account: false, contact: false, relationships: [] }, 'nothing missing: the address changed, which is never applied');
  const birch = p.rows.find((r) => r.client.name.startsWith('Birch'));
  assert.deepEqual(birch.adds, { account: false, contact: true, relationships: [] }, 'a new email and phone: a new contact');
  const batch = await s.commit(edited);
  assert.deepEqual([batch.createdClients, batch.addedTo, batch.skipped], [1, 0, 4]);
  assert.equal(s.count('crm_clients'), 5);
  assert.equal(s.db.prepare("SELECT city FROM crm_accounts WHERE name = 'Harbour Lights Bakery'").get().city, 'Port Dover', 'not overwritten');
  assert.equal(s.count('crm_contacts', "email = 'sales@birchbark.test'"), 0);
  // Choosing "add only what's missing" for the changed Birch row adds the new contact to that client.
  const choices = { [birch.row]: { action: 'add', status: 'changed' } };
  const added = await s.commit(edited, { choices });
  assert.deepEqual([added.createdClients, added.addedTo], [0, 1]);
  const sales = s.db.prepare("SELECT c.*, k.name AS client FROM crm_contacts c JOIN crm_clients k ON k.id = c.client_id WHERE c.email = 'sales@birchbark.test'").get();
  assert.equal(sales.client, 'Birch & Bark, Inc.');
  assert.match(s.db.prepare('SELECT body FROM crm_activities WHERE client_id = ? ORDER BY at DESC LIMIT 1').get(sales.client_id).body, /^Added from “customers.csv”.*contact Ben Cole/);
  // A choice made for another state than the row is in now is ignored (the row was imported since).
  const third = await s.commit(edited, { choices });
  assert.deepEqual([third.createdClients, third.addedTo, third.records], [0, 0, 0]);
});

test('existing records are never overwritten: same email = already here; add only what is missing; similar names', async (t) => {
  const s = await setup(t);
  const { sync } = s.ctx.services;
  const make = (entity, fields) => sync.applyLocal({ actor: 'partner', entity, op: 'create', fields }).recordId;
  const client = make('client', { name: 'Lefebvre Holdings', status: 'active', notes: 'Pays on time' });
  const shop = make('account', { client_id: client, name: 'Lefty’s Cannabis Dispensary', city: 'Simcoe' });
  const mike = make('contact', { client_id: client, account_id: shop, name: 'Mike Lefebvre', email: 'mike@leftys.test', phone: '5195550100', role: 'Owner' });
  make('relationship', { account_id: shop, business_id: AGENCY, kind: 'website', status: 'paused' });
  const snapshot = () => JSON.stringify(['crm_clients', 'crm_accounts', 'crm_contacts', 'crm_relationships'].map((tb) => s.db.prepare(`SELECT * FROM ${tb} ORDER BY id`).all()));
  const before = snapshot();

  const csv = [
    'Customer,Company,Email,Phone,City,Notes',
    'Mike L.,Leftys,MIKE@leftys.test,519-555-0199,Delhi,New notes', // same email
    'Someone,,other@x.test,(519) 555-0100,,', // same phone
    'Leftys,,,,,', // similar name (the account)
    'Brand New Co,,new@brand.test,,,',
  ].join('\n');
  const p = await s.preview(csv);
  assert.deepEqual(p.rows.map((r) => [r.status, r.match?.by ?? null, r.match?.clientName ?? null]), [
    ['same', 'email', 'Lefebvre Holdings'], ['same', 'phone', 'Lefebvre Holdings'], ['similar', 'name', 'Lefebvre Holdings'], ['new', null, null],
  ]);
  assert.deepEqual(p.rows[0].adds, { account: false, contact: false, relationships: [] }, 'the website relationship exists (paused); the contact is known');
  await s.commit(csv);
  assert.equal(s.count('crm_clients'), 2, 'only Brand New Co is new');
  // Add only what's missing for the similar-name row, with consulting: one new relationship, nothing else touched.
  const add = await s.commit(csv, { business: CONSULTING, kind: 'consulting', choices: { 4: { action: 'add', status: 'similar' } } });
  assert.deepEqual([add.addedTo, add.createdClients], [1, 0]);
  const after = s.db.prepare('SELECT * FROM crm_relationships WHERE account_id = ? ORDER BY id').all(shop);
  assert.deepEqual(after.map((r) => [r.business_id, r.kind, r.status]), [[AGENCY, 'website', 'paused'], [CONSULTING, 'consulting', 'active']]);
  // Everything that was there is exactly as it was (apart from the new relationship row).
  const now = JSON.parse(snapshot());
  const was = JSON.parse(before);
  assert.deepEqual(now[0].find((r) => r.id === client), was[0].find((r) => r.id === client));
  assert.deepEqual(now[1].find((r) => r.id === shop), was[1].find((r) => r.id === shop));
  assert.deepEqual(now[2].find((r) => r.id === mike), was[2].find((r) => r.id === mike));
  assert.equal(s.count('sync_steps', `entity = 'contact' AND op = 'update'`), 0);
  assert.equal(s.count('sync_steps', "op = 'update'"), 0, 'an import never updates anything');
});

test('the guard is still in place after an import; import tables are the module’s own', async (t) => {
  const s = await setup(t);
  await s.commit(WAVE);
  for (const { table } of CRM_ENTITIES) {
    assert.throws(() => s.db.prepare(`INSERT INTO ${table} (id) VALUES (?)`).run(newId()), /written only through the sync module/, table);
    if (!s.count(table, '1 = 1')) continue; // UPDATE/DELETE triggers fire per row
    assert.throws(() => s.db.prepare(`UPDATE ${table} SET deleted_at = 'x'`).run(), /written only through the sync module/, table);
    assert.throws(() => s.db.prepare(`DELETE FROM ${table}`).run(), /written only through the sync module/, table);
  }
  for (const table of ['crm_clients', 'crm_accounts', 'crm_contacts', 'crm_relationships', 'crm_activities']) assert.ok(s.count(table) > 0, table);
  assert.equal(s.count('crm_import_rows', '1 = 1'), 4);
  assert.equal(s.count('crm_clients', 'deleted_at IS NOT NULL'), 0);
});

test('requests: signed in only, JSON only, limits on size and rows, a name column, our businesses, one import at a time', async (t) => {
  const s = await setup(t, {});
  const anon = await fetch(`${s.base}/api/crm/import/preview`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.base }, body: '{"text":"a"}' });
  assert.equal(anon.status, 401);
  const form = await fetch(`${s.base}/api/crm/import/preview`, { method: 'POST', headers: { cookie: s.owner.cookie, origin: s.base, 'content-type': 'text/csv' }, body: 'Name\nx' });
  assert.equal(form.status, 415);
  // Bigger than the app's usual 1 MB body: fine here (a 2 MB file).
  const big = `Name,Notes\n${Array.from({ length: 2000 }, (_, i) => `Big ${i},${'x'.repeat(1000)}`).join('\n')}`;
  assert.ok(JSON.stringify({ text: big }).length > 1_100_000);
  assert.equal((await s.call('POST', '/api/crm/import/preview', { text: big })).status, 200);
  const tooBig = await s.call('POST', '/api/crm/import/preview', { text: 'x'.repeat(5 * 1024 * 1024 + 1) });
  assert.deepEqual([tooBig.status, tooBig.body.code], [413, 'too_big']);
  const tooMany = await s.call('POST', '/api/crm/import/preview', { text: `Name\n${Array.from({ length: 10_001 }, (_, i) => `C${i}`).join('\n')}` });
  assert.deepEqual([tooMany.status, tooMany.body.code], [413, 'too_many_rows']);
  const noName = await s.call('POST', '/api/crm/import/preview', { text: 'Foo,Bar\n1,2' });
  assert.deepEqual([noName.status, noName.body.code], [400, 'no_name_column']);
  // A mapping picked by the person replaces the guess.
  const mapped = await s.call('POST', '/api/crm/import/preview', { text: 'Foo,Bar\nAcme,a@acme.test', mapping: { name: 0, email: 1 } });
  assert.deepEqual([mapped.body.rows[0].client.name, mapped.body.rows[0].contact.email], ['Acme', 'a@acme.test']);
  assert.equal((await s.call('POST', '/api/crm/import/preview', { text: WAVE, business: newId(), kind: 'website' })).status, 400);
  assert.equal((await s.call('POST', '/api/crm/import/preview', { text: WAVE, business: AGENCY, kind: 'nope' })).status, 400);
  assert.equal((await s.call('POST', '/api/crm/import/commit', { batchId: 'x', text: WAVE })).status, 400);
  // One at a time: a second commit while one runs is refused.
  const one = await s.call('POST', '/api/crm/import/commit', { batchId: newId(), text: big });
  const two = await s.call('POST', '/api/crm/import/commit', { batchId: newId(), text: WAVE });
  assert.deepEqual([one.status, two.status, two.body.code], [202, 409, 'import_running']);
  await s.waitFor(one.body.batch.id);
  // Rows without a name are left out (and say why).
  const p = await s.preview('Name,Email\n,lost@x.test\nKept,');
  assert.deepEqual(p.rows.map((r) => [r.status, r.problems]), [['invalid', ['Needs a client name']], ['new', []]]);
});

test('a big file goes in chunks: the server answers other requests while it runs; a restart marks it interrupted', async (t) => {
  const s = await setup(t);
  const rows = Array.from({ length: 2500 }, (_, i) => `Client ${String(i).padStart(4, '0')},c${i}@chunk.test,${2265550000 + i}`);
  const text = `Customer,Email,Phone\n${rows.join('\n')}`;
  const start = await s.call('POST', '/api/crm/import/commit', { batchId: newId(), text, fileName: 'big.csv' });
  assert.equal(start.status, 202);
  assert.equal(start.body.batch.processed, 0, 'answered before the first chunk');
  // While it runs, other requests are answered, and progress moves a chunk at a time.
  const seen = new Set();
  let answeredWhileRunning = false;
  for (;;) {
    const t0 = Date.now();
    const health = await fetch(`${s.base}/api/health`);
    const { batch } = (await s.call('GET', `/api/crm/import/batches/${start.body.batch.id}`)).body;
    if (batch.status !== 'running') {
      assert.equal(batch.status, 'done');
      assert.deepEqual([batch.processed, batch.createdClients, batch.failed], [2500, 2500, 0]);
      break;
    }
    assert.equal(health.status, 200);
    answeredWhileRunning = true;
    assert.ok(Date.now() - t0 < 2000, 'answered promptly');
    seen.add(batch.processed);
    assert.equal(batch.processed % 100, 0, 'whole chunks');
  }
  assert.ok(answeredWhileRunning && seen.size >= 2, `progress seen at ${[...seen]}`);
  assert.equal(s.count('crm_clients'), 2500);
  assert.equal(s.count('crm_import_rows', '1 = 1'), 2500);
  // Re-importing it is quick and makes nothing.
  assert.equal((await s.preview(text)).counts.imported, 2500);
  // A batch left "running" (the server stopped mid-way) is marked interrupted at the next start.
  s.db.prepare("UPDATE crm_import_batches SET status = 'running' WHERE id = ?").run(start.body.batch.id);
  s.ctx.services.crm.imports.markInterrupted();
  assert.equal(s.db.prepare('SELECT status FROM crm_import_batches WHERE id = ?').get(start.body.batch.id).status, 'interrupted');
});
