import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db/open.js';
import { createApp } from '../src/app.js';
import { APP_VERSION, loadConfig } from '../src/config.js';
import { isId } from '@suite/shared/ids';
import { tmpDir, testConfig, quietLog } from './helpers.js';

async function startApp(t, config) {
  const db = openDb(config.dbPath);
  const { app } = await createApp({ config, db, log: quietLog });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(() => { db.close(); resolve(); })));
  return { db, base: `http://127.0.0.1:${server.address().port}` };
}

test('defaults: localhost only, port 3100, nightly backup off outside production', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3100);
  assert.equal(c.backup.enabled, false);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).backup.enabled, true);
  assert.throws(() => loadConfig({ BACKUP_TIME: '3am' }), /HH:MM/);
});

test('GET /api/health reports version and a working database', async (t) => {
  const config = testConfig(tmpDir(t));
  const { base } = await startApp(t, config);
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, APP_VERSION);
  assert.equal(body.db.ok, true);
  assert.equal(body.db.journalMode, 'wal');
  assert.equal(body.db.foreignKeys, true);
  assert.ok(body.db.migrations >= 1);
  assert.ok(isId(body.db.instanceId));
  assert.equal(body.backup.ok, false); // no backup made yet
  assert.equal(body.backup.lastSuccessAt, null);
  assert.ok(res.headers.get('content-security-policy'));
});

test('the database keeps its instance id across restarts', async (t) => {
  const config = testConfig(tmpDir(t));
  const first = await startApp(t, config);
  const a = await (await fetch(`${first.base}/api/health`)).json();
  const second = await startApp(t, config);
  const b = await (await fetch(`${second.base}/api/health`)).json();
  assert.equal(a.db.instanceId, b.db.instanceId);
});

test('unknown API routes give a JSON 404', async (t) => {
  const { base } = await startApp(t, testConfig(tmpDir(t)));
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /No API route/);
});

test('serves the built client with a fallback for client-side routes', async (t) => {
  const dir = tmpDir(t);
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>suite</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  const { base } = await startApp(t, testConfig(dir, { CLIENT_DIST: dist }));

  const page = await fetch(`${base}/some/client/route`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>suite/);
  const asset = await fetch(`${base}/assets/app.js`);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});
