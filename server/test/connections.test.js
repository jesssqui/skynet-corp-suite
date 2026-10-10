// Connections (C8): the registry and its page's API — the pause/resume contract (with the
// test-only conndemo connection), switches that survive a restart and a restore, the backup row
// from status.json, placeholders, who changed a switch, and the request rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modules } from '../src/modules/index.js';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup } from '../src/backup/restore.js';
import { backupDescription, PLACEHOLDERS } from '../src/modules/connections/service.js';
import conndemo from './fixtures/conndemo/index.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from './helpers.js';

/** A logger that keeps every line (errors and warnings to check "paused logs no errors"). */
function capturingLog(lines = []) {
  const make = (tag) => {
    const out = (level) => (...args) => lines.push({ level, tag, text: args.map(String).join(' ') });
    return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error'), child: (sub) => make(`${tag}:${sub}`) };
  };
  return Object.assign(make('test'), { lines });
}

/** createApp + listen with every module and conndemo, a capturing log, both accounts and an owner session. */
async function setup(t, config = testConfig(tmpDir(t)), { lines = [] } = {}) {
  const db = openDb(config.dbPath);
  const log = capturingLog(lines);
  const { app, ctx } = await createApp({ config, db, log, modules: [...modules, conndemo] });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    server.close(() => { db.close(); resolve(); });
  });
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = await ensureTestUsers(ctx);
  const owner = sessionFor(ctx, users.owner);
  const call = async (method, url, body, { session = owner, headers = {} } = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(session ? { cookie: session.cookie } : {}),
        origin: base,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { config, db, ctx, base, users, owner, call, close, lines, demo: ctx.services.conndemo };
}

const errors = (lines) => lines.filter((l) => l.level === 'error');
const row = (list, id) => list.find((c) => c.id === id);

test('the page lists the backup (always on), the placeholders (not connected yet) and registered connections', async (t) => {
  const { call } = await setup(t);
  const { status, body } = await call('GET', '/api/connections');
  assert.equal(status, 200);
  assert.deepEqual(body.connections.map((c) => c.id), ['backup', 'wom', 'calendar', 'stockroom', 'calendar-feed', 'woocommerce', 'ebay', 'conndemo']);
  // D12: the WooCommerce stores' row (each store added gets its own row under it).
  assert.deepEqual([row(body.connections, 'woocommerce').state, row(body.connections, 'woocommerce').queueLabel], ['always_on', 'No stores yet']);
  const backup = row(body.connections, 'backup');
  assert.equal(backup.state, 'always_on');
  assert.equal(backup.pausable, false);
  assert.match(backup.alwaysOnReason, /can’t pause/);
  // D1 registered the real Order Manager connection in the placeholder's slot; the others still wait
  const wom = row(body.connections, 'wom');
  assert.deepEqual([wom.state, wom.pausable, wom.module], ['on', true, 'wholesale']);
  // D16 did the same for Stockroom.
  const stockroom = row(body.connections, 'stockroom');
  assert.deepEqual([stockroom.state, stockroom.pausable, stockroom.module, stockroom.queueLabel], ['on', true, 'stockroom', 'Not set up']);
  for (const p of PLACEHOLDERS.filter((x) => !['wom', 'stockroom'].includes(x.id))) {
    const c = row(body.connections, p.id);
    assert.deepEqual([c.state, c.comesWith, c.pausable], ['not_connected', p.comesWith, false]);
  }
  assert.deepEqual(PLACEHOLDERS.map((p) => p.comesWith), ['D1', 'C6b', 'D16']);
  const demo = row(body.connections, 'conndemo');
  assert.deepEqual([demo.state, demo.pausable, demo.queueSize, demo.lastError, demo.changedBy], ['on', true, 0, null, null]);
});

test('pause → no work and no errors, the queue keeps building → resume → it catches up in order', async (t) => {
  const { call, demo, lines, db } = await setup(t);
  assert.deepEqual(demo.enqueue('a'), { sent: 1 });
  assert.deepEqual(demo.remote.received, ['a']);

  // Without the switch, a failing service is an error (and the job waits, in order).
  demo.remote.down = true;
  assert.equal(demo.enqueue('b').failed, true);
  assert.equal(errors(lines).length, 1, 'a real failure is logged');
  demo.remote.down = false;
  demo.work();
  assert.deepEqual(demo.remote.received, ['a', 'b']);

  // Switched off: nothing goes out, nothing is logged as a failure, the queue grows.
  const off = await call('PUT', '/api/connections/conndemo', { paused: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.connection.state, 'paused');
  assert.equal(off.body.connection.changedBy, 'owner');
  demo.remote.down = true; // even with the service down
  const calls = demo.remote.calls;
  const errorsBefore = errors(lines).length;
  for (const p of ['c', 'd', 'e']) assert.deepEqual(demo.enqueue(p), { sent: 0, paused: true });
  assert.equal(demo.remote.calls, calls, 'no outside call while paused');
  assert.equal(errors(lines).length, errorsBefore, 'no errors while paused');
  assert.equal(lines.filter((l) => l.level === 'warn' && l.tag.includes('conndemo')).length, 0);
  const listed = row((await call('GET', '/api/connections')).body.connections, 'conndemo');
  assert.deepEqual([listed.state, listed.queueSize], ['paused', 3], 'the page shows the queue building');

  // Switched on: it catches up, in order.
  demo.remote.down = false;
  const on = await call('PUT', '/api/connections/conndemo', { paused: false });
  assert.equal(on.body.connection.state, 'on');
  assert.deepEqual(demo.remote.received, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(on.body.connection.queueSize, 0);
  assert.equal(errors(lines).length, errorsBefore);

  // Who changed it, from which device, is kept (and logged).
  const changes = db.prepare('SELECT connection_id, paused, actor, device_id FROM connections_changes ORDER BY at, id').all();
  assert.equal(changes.length, 2);
  assert.deepEqual(changes.map((c) => [c.connection_id, c.paused, c.actor]), [['conndemo', 1, 'owner'], ['conndemo', 0, 'owner']]);
  assert.ok(changes.every((c) => c.device_id));
  assert.ok(lines.some((l) => l.level === 'info' && /conndemo switched off \(paused\) by owner/.test(l.text)));
  // Switching to the state it is in only answers.
  assert.equal((await call('PUT', '/api/connections/conndemo', { paused: false })).status, 200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM connections_changes').get().n, 2);
});

test('either person may switch; the backup and placeholders can’t be; bad requests are refused', async (t) => {
  const { call, ctx, users } = await setup(t);
  const partner = sessionFor(ctx, users.partner);
  const r = await call('PUT', '/api/connections/conndemo', { paused: true }, { session: partner });
  assert.equal(r.status, 200);
  assert.equal(r.body.connection.changedBy, 'partner');

  const backup = await call('PUT', '/api/connections/backup', { paused: true });
  assert.deepEqual([backup.status, backup.body.code], [409, 'not_pausable']);
  const calendar = await call('PUT', '/api/connections/calendar', { paused: true });
  assert.deepEqual([calendar.status, calendar.body.code], [409, 'not_connected']);
  assert.match(calendar.body.error, /comes with C6b/);
  assert.equal((await call('PUT', '/api/connections/nope', { paused: true })).status, 404);
  assert.equal((await call('PUT', '/api/connections/conndemo', { paused: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/api/connections/conndemo', {})).status, 400);
  // Signed in only; the Origin and JSON rules apply.
  assert.equal((await call('GET', '/api/connections', undefined, { session: null })).status, 401);
  assert.equal((await call('PUT', '/api/connections/conndemo', { paused: false }, { session: null })).status, 401);
  assert.equal((await call('PUT', '/api/connections/conndemo', { paused: false }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('PUT', '/api/connections/conndemo', 'paused=false', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal(ctx.services.connections.isPaused('conndemo'), true, 'none of those changed it');
});

test('a switched-off connection stays off across a restart (pause() at start) and a restore', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const first = await setup(t, config);
  // A backup taken while everything is on (and before the C8 switches were touched).
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  await first.call('PUT', '/api/connections/conndemo', { paused: true });
  await first.call('PUT', '/api/automations/no-next-step', { alert: true });
  first.demo.enqueue('waiting');
  await first.close();

  // Restart: the stored switch is read at registration and pause() is called before any work.
  const lines = [];
  const second = await setup(t, config, { lines });
  assert.equal(second.demo.state.paused, true, 'pause() was called at start');
  assert.equal(second.demo.isPaused(), true);
  assert.deepEqual(second.demo.work(), { sent: 0, paused: true });
  assert.ok(lines.some((l) => /conndemo starts paused/.test(l.text)));
  assert.equal(row(second.ctx.services.connections.list(), 'conndemo').queueSize, 1);
  await second.close();

  // Restore the backup from before the switch: the switches are kept (restore.js copies them).
  const restored = await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  assert.ok(restored.safetyCopy);
  const third = await setup(t, config);
  assert.equal(third.demo.isPaused(), true, 'still off after the restore');
  assert.equal(third.demo.state.paused, true);
  assert.equal(third.demo.queueSize(), 0, 'the data itself went back to the backup');
  const changes = third.db.prepare('SELECT actor, paused FROM connections_changes').all();
  assert.deepEqual(changes, [{ actor: 'owner', paused: 1 }], 'who switched it is kept too');
  assert.equal(third.ctx.services.automations.get('no-next-step').alert, true, 'automation switches are kept the same way');
  // On again, and it catches up.
  await third.call('PUT', '/api/connections/conndemo', { paused: false });
  assert.equal(third.demo.isPaused(), false);
});

test('the backup row comes from status.json: last success, last error, how far behind', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir, { BACKUP_ENABLED: 'true', BACKUP_TIME: '03:15' });
  const { call } = await setup(t, config);
  const status = (patch) => {
    fs.mkdirSync(config.backup.dir, { recursive: true });
    fs.writeFileSync(path.join(config.backup.dir, 'status.json'), JSON.stringify(patch));
  };
  const backupRow = async () => row((await call('GET', '/api/connections')).body.connections, 'backup');

  let b = await backupRow();
  assert.deepEqual([b.lastSuccessAt, b.queueSize, b.queueLabel], [null, null, 'No backup yet']);

  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  status({ lastSuccessAt: hourAgo, offsite: 'ok' });
  b = await backupRow();
  assert.deepEqual([b.lastSuccessAt, b.queueSize, b.queueLabel, b.lastError], [hourAgo, 0, 'Up to date', null]);
  assert.equal(b.detail, 'Nightly at 03:15');
  // A fresh local copy whose off-machine copy fails is not up to date.
  status({ lastSuccessAt: hourAgo, offsite: 'failed', lastError: 'share not mounted', lastErrorAt: hourAgo });
  b = await backupRow();
  assert.deepEqual([b.queueSize, b.queueLabel], [0, 'Off-machine copy failing']);

  const threeDays = new Date(Date.now() - 3 * 86_400_000 - 3600_000).toISOString();
  const errAt = new Date(Date.now() - 600_000).toISOString();
  status({ lastSuccessAt: threeDays, offsite: 'failed', lastError: 'Off-machine backup folder /offsite does not exist', lastErrorAt: errAt });
  b = await backupRow();
  assert.deepEqual([b.queueSize, b.queueLabel, b.lastErrorAt], [3, '3 days behind', errAt]);
  assert.match(b.lastError, /does not exist/);
  assert.match(b.detail, /off-machine copy: failed/);
  assert.equal(b.state, 'always_on');

  // The same rules without the server.
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(backupDescription({ lastSuccessAt: '2026-10-07T16:00:00Z' }, { now }).queueSize, 0, 'under 26 h is fresh');
  assert.equal(backupDescription({ lastSuccessAt: '2026-10-07T08:00:00Z' }, { now }).queueLabel, '1 day behind', '28 h');
  assert.equal(backupDescription({ lastSuccessAt: '2026-10-06T08:00:00Z' }, { now }).queueLabel, '2 days behind');
  assert.match(backupDescription(null, { now, offsiteConfigured: false, scheduled: false }).detail, /schedule off.*no off-machine folder/);
});

test('register() checks its arguments: ids, describe, pause/resume or a reason to be always on, no duplicates', async (t) => {
  const { ctx } = await setup(t);
  const c = ctx.services.connections;
  const base = { id: 'x1', name: 'X', module: 'x', describe: () => ({}), pause() {}, resume() {} };
  assert.throws(() => c.register({ ...base, id: 'Bad Id' }), /bad id/);
  assert.throws(() => c.register({ ...base, describe: undefined }), /describe/);
  assert.throws(() => c.register({ ...base, pause: undefined }), /pause\(\) and resume\(\)/);
  assert.throws(() => c.register({ ...base, pausable: false, pause: undefined }), /say why/);
  assert.throws(() => c.register({ ...base, id: 'conndemo' }), /already registered/);
  // A real connection takes its placeholder's place (and slot).
  c.register({ ...base, id: 'calendar', name: 'Apple Calendar', module: 'calendar', describe: () => ({ queueSize: 0 }) });
  const list = c.list();
  assert.deepEqual(list.map((x) => x.id).slice(0, 4), ['backup', 'wom', 'calendar', 'stockroom']);
  assert.equal(row(list, 'calendar').state, 'on');
  // A describe() that throws shows as the row's error, not a broken page.
  c.register({ ...base, id: 'broken', describe: () => { throw new Error('boom'); } });
  assert.match(row(c.list(), 'broken').lastError, /Could not read its status: boom/);
});

test('D12: rows registered `after` another go under it in order; unregister() takes a row off (its switch stays in the table)', async (t) => {
  const { ctx, call } = await setup(t);
  const c = ctx.services.connections;
  const base = { name: 'X', module: 'x', describe: () => ({}), pause() {}, resume() {} };
  c.register({ ...base, id: 'shop', pausable: false, alwaysOnReason: 'adds shops' });
  c.register({ ...base, id: 'later' });
  c.register({ ...base, id: 'shop-a', after: 'shop' });
  c.register({ ...base, id: 'shop-b', after: 'shop' });
  c.register({ ...base, id: 'lost', after: 'nowhere' });
  const ids = () => c.list().map((x) => x.id);
  assert.deepEqual(ids().slice(ids().indexOf('shop')), ['shop', 'shop-a', 'shop-b', 'later', 'lost']);
  assert.equal((await call('PUT', '/api/connections/shop-a', { paused: true })).status, 200);
  assert.equal(c.unregister('shop-a'), true);
  assert.ok(!ids().includes('shop-a'));
  assert.equal((await call('PUT', '/api/connections/shop-a', { paused: false })).status, 404);
  assert.equal(c.isPaused('shop-a'), true, 'the switch row stays (a store added again gets a new id)');
  assert.equal(c.unregister('calendar'), false, 'placeholders aren’t unregistered');
  assert.equal(c.unregister('nope'), false);
  c.register({ ...base, id: 'shop-c', after: 'shop' });
  assert.deepEqual(ids().slice(ids().indexOf('shop'), ids().indexOf('shop') + 3), ['shop', 'shop-b', 'shop-c']);
});

test('a restore still recovers a broken live database (zeroed header): the switches can’t be read, so they reset, with a warning', async (t) => {
  const dir = tmpDir(t);
  const config = testConfig(dir);
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const first = await setup(t, config);
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  await first.call('PUT', '/api/connections/conndemo', { paused: true });
  await first.close();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
  const fd = fs.openSync(config.dbPath, 'r+');
  fs.writeSync(fd, Buffer.alloc(100), 0, 100, 0); // the header is gone: "file is not a database"
  fs.closeSync(fd);

  await assert.rejects(restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir }), /Could not save the current database/,
    'without --force the safety-copy guard still stops it');
  const logged = [];
  const restored = await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir, force: true, log: (m) => logged.push(m) });
  assert.equal(restored.safetyCopy, null);
  assert.ok(logged.some((m) => /couldn't read the current settings .* switches reset/.test(m)), logged.join('\n'));
  const again = await setup(t, config);
  assert.equal(again.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(again.demo.isPaused(), false, 'the backup’s switches (on)');
});
