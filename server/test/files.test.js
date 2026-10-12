// Files (D10): the synced `file` record type and its checks, uploads (limits before the body is read,
// types, retries), downloads (session, headers, never rendered in the app's origin), deletes and the
// purge of deleted files' bytes, nothing personal in the log — and the package's "done when": an
// uploaded file survives a backup and restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newId } from '@suite/shared/ids';
import { encodeHlc } from '@suite/shared/hlc';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { makeCheckFile, parseUploadInfo, CHUNK_BYTES } from '../src/modules/files/service.js';
import { contentDisposition } from '../src/modules/files/routes.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor, testClock, capturingLog } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PDF = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');

async function setup(t, { config = testConfig(tmpDir(t)), clock = testClock(), log } = {}) {
  const env = await startApp(t, config, { modules, now: clock.now, ...(log ? { log } : {}) });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const { sync } = env.ctx.services;
  const local = (entity, fields, actor = 'owner') => {
    const r = sync.applyLocal({ actor, entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const clientId = local('client', { name: 'Lefty’s', status: 'active' });
  const accountId = local('account', { client_id: clientId, name: 'Lefty’s Vape Shop' });
  const taskId = local('task', { title: 'Send the logo', owner: 'owner', business_id: BUSINESS_IDS.agency, client_id: clientId });

  /** POST the bytes as the upload button does. */
  const upload = (bytes, info, { session = owner, headers = {} } = {}) => fetch(`${env.base}/api/files/upload`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      origin: env.base,
      'x-file-info': encodeURIComponent(JSON.stringify(info)),
      ...(session ? { cookie: session.cookie } : {}),
      ...headers,
    },
    body: bytes,
  });
  const download = (id, { query = '', session = owner } = {}) => fetch(`${env.base}/api/files/${id}/download${query}`, {
    headers: session ? { cookie: session.cookie } : {},
  });
  /** A device's push of one step (saw nothing). */
  const push = async (step, session = owner) => {
    // Like a device: what it has seen is its last complete pull.
    let seen = null;
    for (;;) {
      const page = await (await fetch(`${env.base}/api/sync/pull?${seen ? `since=${encodeURIComponent(seen)}&` : ''}limit=1000`, { headers: { cookie: session.cookie } })).json();
      seen = page.cursor;
      if (!page.hasMore) break;
    }
    step = { seen, ...step };
    const res = await fetch(`${env.base}/api/sync/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie, origin: env.base },
      body: JSON.stringify({ steps: [{ key: newId(), hlc: encodeHlc({ ms: Date.now(), counter: 0, node: session.deviceId }), ...step }] }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).results[0];
  };
  const record = (id) => env.db.prepare('SELECT * FROM files_items WHERE id = ?').get(id);
  return { ...env, config, clock, users, owner, sync, local, clientId, accountId, taskId, upload, download, push, record };
}

test('check: exactly one owner; uploads only from the server; links clean; where a file is and its bytes never change', () => {
  const check = makeCheckFile((id) => id === 'blob-1');
  const c = newId();
  assert.equal(check({ op: 'create', fields: { kind: 'link', name: 'Drive', client_id: c, url: 'https://drive.google.com/x' }, server: false }), null);
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'Drive', client_id: c, account_id: c, url: 'https://x.ca/' } }).reason, /exactly one/);
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'Drive', url: 'https://x.ca/' } }).reason, /exactly one/);
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'Drive', client_id: c, url: 'javascript:alert(1)' } }).reason, /http/);
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'Drive', client_id: c, url: 'drive.google.com' } }).reason, /http/, 'stored clean (the device adds https://)');
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'Drive', client_id: c, url: 'https://me:pw@x.ca/' } }).reason, /password/);
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'Drive', client_id: c } }).reason, /address/);
  assert.equal(check({ op: 'create', fields: { kind: 'password', name: 'WordPress admin', task_id: c, vault: '1Password · Business', vault_item: 'Lefty’s WP' } }), null);
  assert.match(check({ op: 'create', fields: { kind: 'password', name: 'WP', task_id: c, vault: '1Password' } }).reason, /vault_item/);
  const upload = { kind: 'upload', name: 'logo.png', client_id: c, blob_id: 'blob-1', size: 3, content_type: 'image/png', sha256: 'x' };
  assert.equal(check({ op: 'create', fields: upload, server: false }).code, 'op_not_allowed', 'a device can never make an upload');
  assert.equal(check({ op: 'create', fields: upload, server: true }), null);
  assert.match(check({ op: 'create', fields: { ...upload, blob_id: 'nope' }, server: true }).reason, /stored file/);
  assert.match(check({ op: 'create', fields: { kind: 'link', name: 'x', client_id: c, url: 'https://x.ca/', size: 3 } }).reason, /Only uploads/);
  for (const k of ['kind', 'client_id', 'account_id', 'task_id', 'blob_id', 'size', 'content_type', 'sha256']) {
    assert.ok(check({ op: 'update', fields: { [k]: null }, current: { kind: 'upload' } }), k);
  }
  assert.equal(check({ op: 'update', fields: { name: 'Logo (final).png', notes: 'From Pat' }, current: { kind: 'upload' } }), null);
  assert.ok(check({ op: 'update', fields: { url: 'https://x.ca/' }, current: { kind: 'upload' } }));
  assert.ok(check({ op: 'update', fields: { url: null }, current: { kind: 'link' } }), 'a link keeps an address');
  assert.equal(check({ op: 'update', fields: { url: null }, current: { kind: 'password' } }), null, 'a pointer’s address is optional');
  assert.ok(check({ op: 'update', fields: { name: '   ' }, current: { kind: 'link' } }));
  assert.equal(check({ op: 'delete', fields: null }), null);
});

test('X-File-Info and Content-Disposition', () => {
  const id = newId();
  const ok = parseUploadInfo(encodeURIComponent(JSON.stringify({ id, name: 'Logo.png', accountId: newId(), notes: ' x ' })));
  assert.equal(ok.owner.field, 'account_id');
  assert.equal(ok.notes, 'x');
  for (const bad of [undefined, '%E0%A4%A', encodeURIComponent('[1]'), encodeURIComponent(JSON.stringify({ id: 'x', name: 'a.png', clientId: newId() })),
    encodeURIComponent(JSON.stringify({ id, name: 'a.png' })), encodeURIComponent(JSON.stringify({ id, name: 'a.png', clientId: newId(), taskId: newId() })),
    encodeURIComponent(JSON.stringify({ id, name: '  ', clientId: newId() }))]) {
    assert.throws(() => parseUploadInfo(bad), (e) => e.status === 400, String(bad));
  }
  assert.equal(contentDisposition('attachment', 'Café "menu" 100%.pdf'),
    'attachment; filename="Caf_ _menu_ 100_.pdf"; filename*=UTF-8\'\'Caf%C3%A9%20%22menu%22%20100%25.pdf');
});

test('links and password pointers are made on devices (offline) like any synced record; uploads never are', async (t) => {
  const env = await setup(t);
  const link = await env.push({ entity: 'file', recordId: newId(), op: 'create', fields: { kind: 'link', name: 'Brand folder', account_id: env.accountId, url: 'https://drive.google.com/drive/folders/abc' } });
  assert.equal(link.status, 'applied', JSON.stringify(link));
  const pointer = await env.push({ entity: 'file', recordId: newId(), op: 'create', fields: { kind: 'password', name: 'WordPress admin', client_id: env.clientId, vault: '1Password · Business', vault_item: 'Lefty’s — WP admin', url: 'https://leftys.ca/wp-admin' } });
  assert.equal(pointer.status, 'applied', JSON.stringify(pointer));
  const fake = await env.push({ entity: 'file', recordId: newId(), op: 'create', fields: { kind: 'upload', name: 'x.png', client_id: env.clientId, blob_id: newId(), size: 1, content_type: 'image/png', sha256: 'a' } });
  assert.equal(fake.status, 'rejected');
  assert.equal(fake.code, 'op_not_allowed');
  const orphan = await env.push({ entity: 'file', recordId: newId(), op: 'create', fields: { kind: 'link', name: 'x', client_id: newId(), url: 'https://x.ca/' } });
  assert.equal(orphan.code, 'not_found', 'an owner not here (yet) is parked on the device, like every soft ref');
  assert.deepEqual(env.ctx.services.files.counts(), { link: 1, password: 1 });
});

test('upload → a synced record (pulled by devices) and the bytes; download sends exactly them; a retry is the same upload', async (t) => {
  const env = await setup(t);
  const bytes = Buffer.concat([PNG, crypto.randomBytes(CHUNK_BYTES * 2 + 1234)]); // three pieces
  const id = newId();
  const res = await env.upload(bytes, { id, name: '../../etc/Logo‮gnp.exe  .png', clientId: env.clientId, notes: 'From Pat' });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.file.name, 'Logo gnp.exe.png', 'path, bidi override and doubled spaces taken out');
  assert.equal(body.file.size, bytes.length);
  assert.equal(body.file.content_type, 'image/png');
  const row = env.record(id);
  assert.equal(row.created_by, 'owner');
  assert.equal(row.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(env.db.prepare('SELECT chunks FROM files_blobs WHERE id = ?').pluck().get(row.blob_id), 3);

  // Devices pull it like any record.
  const pull = await (await fetch(`${env.base}/api/sync/pull?limit=1000`, { headers: { cookie: env.owner.cookie } })).json();
  const change = pull.changes.find((c) => c.id === id);
  assert.equal(change.entity, 'file');
  assert.equal(change.fields.kind, 'upload');

  const got = await env.download(id);
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes));
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.match(got.headers.get('content-disposition'), /^attachment; /, 'a download unless asked to show it');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(got.headers.get('cache-control'), 'private, no-store');
  assert.match(got.headers.get('content-security-policy'), /sandbox/);

  // The same upload again (its answer was lost): the same file, nothing stored twice.
  const again = await env.upload(bytes, { id, name: 'Logo.png', clientId: env.clientId });
  assert.equal(again.status, 200);
  assert.equal(env.db.prepare('SELECT count(*) FROM files_blobs').pluck().get(), 1);
  // Other bytes under that id: refused.
  const other = await env.upload(Buffer.concat([PNG, Buffer.from('x')]), { id, name: 'Logo.png', clientId: env.clientId });
  assert.equal(other.status, 409);
});

test('images and PDFs can be shown (?inline=1); SVG and everything else always download, sandboxed', async (t) => {
  const env = await setup(t);
  const up = async (bytes, name) => {
    const id = newId();
    const res = await env.upload(bytes, { id, name, taskId: env.taskId });
    assert.equal(res.status, 201, name);
    return id;
  };
  const png = await up(PNG, 'a.png');
  const pdf = await up(PDF, 'Contract.pdf');
  const svg = await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg');
  const txt = await up(Buffer.from('<html><script>alert(1)</script></html>'), 'notes.txt');
  let r = await env.download(png, { query: '?inline=1' });
  assert.match(r.headers.get('content-disposition'), /^inline; /);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  r = await env.download(pdf, { query: '?inline=1' });
  assert.match(r.headers.get('content-disposition'), /^inline; filename="Contract.pdf"/);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  r = await env.download(svg, { query: '?inline=1' });
  assert.match(r.headers.get('content-disposition'), /^attachment; /, 'an SVG is never shown in the app’s origin');
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  r = await env.download(txt, { query: '?inline=1' });
  assert.match(r.headers.get('content-disposition'), /^attachment; /);
  assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // A rename that loses the extension: the download keeps the type's.
  env.sync.applyLocal({ actor: 'owner', entity: 'file', op: 'update', recordId: pdf, fields: { name: 'Signed contract' } });
  r = await env.download(pdf);
  assert.match(r.headers.get('content-disposition'), /filename="Signed contract.pdf"/);
});

test('refusals: type, contents, size (before the body is read), space, owner, request shape', async (t) => {
  const config = testConfig(tmpDir(t), { FILES_MAX_MB: '1', FILES_MAX_TOTAL_MB: '2' });
  const env = await setup(t, { config });
  const info = (name, extra = {}) => ({ id: newId(), name, clientId: env.clientId, ...extra });
  let r = await env.upload(Buffer.from('<html></html>'), info('page.html'));
  assert.equal(r.status, 415);
  assert.equal((await r.json()).code, 'type_not_allowed');
  r = await env.upload(Buffer.from('<html>not a png</html>'), info('cat.png'));
  assert.equal(r.status, 422, 'an inline type must really be that type');
  r = await env.upload(Buffer.alloc(0), info('a.txt'));
  assert.equal(r.status, 400);
  r = await env.upload(Buffer.from('x'), info('a.txt', { clientId: newId() }));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'owner_not_found');

  // Too big: answered from the headers alone, before any of the body is read.
  const tooBig = await new Promise((resolve, reject) => {
    const req = http.request(`${env.base}/api/files/upload`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream', 'content-length': String(500 * 1024 * 1024), origin: env.base,
        cookie: env.owner.cookie, 'x-file-info': encodeURIComponent(JSON.stringify(info('huge.zip'))),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), connection: res.headers.connection }));
    });
    req.on('error', reject);
    req.write(Buffer.alloc(1024)); // a little of it, never the rest
  });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, 'too_big');
  assert.equal(tooBig.connection, 'close');

  // Space: 2 MB in all.
  for (let i = 0; i < 2; i++) assert.equal((await env.upload(crypto.randomBytes(900 * 1024), info(`part${i}.zip`))).status, 201);
  r = await env.upload(crypto.randomBytes(400 * 1024), info('more.zip'));
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'no_space');
  const usage = await (await fetch(`${env.base}/api/files/usage`, { headers: { cookie: env.owner.cookie } })).json();
  assert.equal(usage.usedBytes, 1800 * 1024);
  assert.equal(usage.maxTotalBytes, 2 * 1024 * 1024);

  // Request shape: JSON or text bodies, no length, another raw path.
  r = await env.upload(Buffer.from('x'), info('a.txt'), { headers: { 'content-type': 'text/plain' } });
  assert.equal(r.status, 415, 'the guard: only JSON — or octet-stream on the upload path');
  r = await fetch(`${env.base}/api/files/usage`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: env.base, cookie: env.owner.cookie }, body: 'x' });
  assert.equal(r.status, 415, 'octet-stream is let through on /api/files/upload only');
  r = await fetch(`${env.base}/api/sync/push`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: env.base, cookie: env.owner.cookie }, body: 'x' });
  assert.equal(r.status, 415);
  r = await env.upload(Buffer.from('x'), {}, { headers: { 'x-file-info': '' } });
  assert.equal(r.status, 400);
});

test('sign-in and origin: no session → 401 for upload, download and usage; another origin → 403', async (t) => {
  const env = await setup(t);
  const id = newId();
  assert.equal((await env.upload(PNG, { id, name: 'a.png', clientId: env.clientId })).status, 201);
  assert.equal((await env.upload(PNG, { id: newId(), name: 'a.png', clientId: env.clientId }, { session: null })).status, 401);
  assert.equal((await env.upload(PNG, { id: newId(), name: 'a.png', clientId: env.clientId }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await env.upload(PNG, { id: newId(), name: 'a.png', clientId: env.clientId }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await env.download(id, { session: null })).status, 401);
  assert.equal((await fetch(`${env.base}/api/files/usage`)).status, 401);
  // The other person can read it (two people, one business).
  const partner = sessionFor(env.ctx, env.users.partner);
  assert.equal((await env.download(id, { session: partner })).status, 200);
  assert.equal((await env.download('not-an-id')).status, 404);
  assert.equal((await env.download(newId())).status, 404);
});

test('deleted (or under a deleted client) → 404; the bytes are purged FILES_PURGE_DAYS later; a link’s record has none', async (t) => {
  const clock = testClock();
  const env = await setup(t, { clock });
  const a = newId();
  const b = newId();
  assert.equal((await env.upload(PNG, { id: a, name: 'a.png', accountId: env.accountId })).status, 201);
  assert.equal((await env.upload(PDF, { id: b, name: 'b.pdf', clientId: env.clientId })).status, 201);
  assert.equal((await env.push({ entity: 'file', recordId: a, op: 'delete' })).status, 'applied');
  assert.equal((await env.download(a)).status, 404);
  assert.ok(env.record(a).deleted_at, 'soft: the record stays as a tombstone');
  assert.equal(env.ctx.services.files.purge(), 0, 'bytes kept for 30 days (a delete undone through a clash still has them)');

  // The client deleted (a mistake): its files are hidden with it.
  env.sync.applyLocal({ actor: 'owner', entity: 'client', op: 'delete', recordId: env.clientId });
  assert.equal((await env.download(b)).status, 404);

  clock.advance(31 * 24 * 60 * 60 * 1000);
  assert.equal(env.ctx.services.files.purge(), 1);
  assert.equal(env.db.prepare('SELECT count(*) FROM files_blobs').pluck().get(), 1, 'b’s bytes stay: its record isn’t deleted');
  assert.equal(env.db.prepare('SELECT count(*) FROM files_chunks WHERE blob_id = ?').pluck().get(env.record(a).blob_id), 0, 'pieces go with it');
});

test('nothing about a file reaches the log: no name, no owner', async (t) => {
  const log = capturingLog();
  const env = await setup(t, { log });
  const id = newId();
  assert.equal((await env.upload(PNG, { id, name: 'Pat Smith passport scan.png', clientId: env.clientId })).status, 201);
  await env.download(id);
  await env.upload(PNG, { id: newId(), name: 'Pat Smith 2.html', clientId: env.clientId });
  const text = log.lines.map((l) => l.text).join('\n');
  assert.ok(text.includes(`file uploaded ${id}`));
  assert.ok(!/Pat|Smith|passport/.test(text), text);
  assert.ok(!text.includes(env.clientId));
});

test('DONE WHEN: an uploaded file survives a backup and restore (and what came after the backup goes with it)', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  const env = await setup(t, { config });
  const kept = newId();
  const bytes = Buffer.concat([PDF, crypto.randomBytes(CHUNK_BYTES + 77)]);
  assert.equal((await env.upload(bytes, { id: kept, name: 'Signed contract.pdf', clientId: env.clientId })).status, 201);
  const backup = await runBackup({ db: env.db, dir: config.backup.dir, offsiteDir: null, keepDays: 30 });

  // After the backup: the file deleted, another one uploaded.
  assert.equal((await env.push({ entity: 'file', recordId: kept, op: 'delete' })).status, 'applied');
  const later = newId();
  assert.equal((await env.upload(PNG, { id: later, name: 'later.png', clientId: env.clientId })).status, 201);
  await env.close();

  const restored = await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  assert.ok(fs.existsSync(restored.safetyCopy));
  assert.equal(path.dirname(restored.safetyCopy), config.backup.dir);

  const again = await startApp(t, config, { modules });
  const users = await ensureTestUsers(again.ctx);
  const session = sessionFor(again.ctx, users.owner);
  const res = await fetch(`${again.base}/api/files/${kept}/download`, { headers: { cookie: session.cookie } });
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes), 'the same bytes, every piece');
  assert.match(res.headers.get('content-disposition'), /Signed contract\.pdf/);
  assert.equal(again.db.prepare('SELECT deleted_at FROM files_items WHERE id = ?').pluck().get(kept), null, 'its record is back too');
  assert.equal((await fetch(`${again.base}/api/files/${later}/download`, { headers: { cookie: session.cookie } })).status, 404, 'what came after the backup is gone with it');
  // Devices pull the restored record from scratch (a new generation).
  const pull = await (await fetch(`${again.base}/api/sync/pull?limit=1000`, { headers: { cookie: session.cookie } })).json();
  assert.ok(pull.changes.some((c) => c.id === kept && c.entity === 'file' && !c.deleted));
});
