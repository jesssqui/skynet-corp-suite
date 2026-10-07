import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, loadConfig } from '../src/config.js';
import { isId } from '@suite/shared/ids';
import { tmpDir, testConfig, startApp, ensureTestUsers, sessionFor } from './helpers.js';

async function signedIn(ctx) {
  const users = await ensureTestUsers(ctx);
  return { cookie: sessionFor(ctx, users.owner).cookie };
}

test('defaults: localhost only, port 3100, nightly backup off outside production', () => {
  const c = loadConfig({});
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3100);
  assert.equal(c.auth.trustProxy, 'loopback');
  assert.equal(loadConfig({ TRUST_PROXY: 'off' }).auth.trustProxy, false);
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'https://x.ts.net/path' }), /scheme/);
  assert.throws(() => loadConfig({ AUTH_SCRYPT_N: '1000' }), /power of two/);
  assert.equal(c.backup.enabled, false);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).backup.enabled, true);
  assert.throws(() => loadConfig({ BACKUP_TIME: '3am' }), /HH:MM/);
});

test('GET /api/health: minimal for anyone, details only when signed in', async (t) => {
  const config = testConfig(tmpDir(t));
  const { base, ctx } = await startApp(t, config);
  const anon = await fetch(`${base}/api/health`);
  assert.equal(anon.status, 200, 'Docker\'s healthcheck works without a session');
  const minimal = await anon.json();
  assert.deepEqual(Object.keys(minimal).sort(), ['name', 'ok', 'time', 'version']);
  assert.equal(minimal.ok, true);
  assert.doesNotMatch(JSON.stringify(minimal), /backup|offsite|instanceId/i, 'no paths, errors or ids for strangers');

  const res = await fetch(`${base}/api/health`, { headers: await signedIn(ctx) });
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

test('no Strict-Transport-Security header (it would leak to other apps on the same ts.net host)', async (t) => {
  const { base } = await startApp(t, testConfig(tmpDir(t)));
  for (const url of [`${base}/api/health`, `${base}/api/nope`]) {
    const res = await fetch(url);
    assert.equal(res.headers.get('strict-transport-security'), null, url);
  }
});

test('the database keeps its instance id across restarts', async (t) => {
  const config = testConfig(tmpDir(t));
  const first = await startApp(t, config);
  const a = await (await fetch(`${first.base}/api/health`, { headers: await signedIn(first.ctx) })).json();
  const second = await startApp(t, config);
  const b = await (await fetch(`${second.base}/api/health`, { headers: await signedIn(second.ctx) })).json();
  assert.ok(isId(a.db.instanceId));
  assert.equal(a.db.instanceId, b.db.instanceId);
});

test('unknown API routes: 401 without a session, JSON 404 with one', async (t) => {
  const { base, ctx } = await startApp(t, testConfig(tmpDir(t)));
  const anon = await fetch(`${base}/api/nope`);
  assert.equal(anon.status, 401);
  assert.equal((await anon.json()).code, 'not_signed_in');
  const res = await fetch(`${base}/api/nope`, { headers: await signedIn(ctx) });
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
  assert.equal((await fetch(`${base}/api/nope`)).status, 401, 'the page is public, the API is not');
});
