// End-to-end: the built app in Chromium with iPhone emulation against a real suite server
// (with the test-only syncdemo module standing in for the CRM's record types).
//
//   npm run test:e2e        (builds the client first; needs a Chromium for playwright-core —
//                            here PLAYWRIGHT_BROWSERS_PATH, on a Mac `npx playwright-core install chromium`)
//
// Set E2E_SCREENSHOTS=<dir> to keep screenshots of the phone at each stage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { modules } from '../../server/src/modules/index.js';
import syncdemo from '../../server/test/fixtures/syncdemo/index.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, TEST_PASSWORD } from '../../server/test/helpers.js';
import { totpCode } from '../../server/src/modules/auth/crypto.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = path.join(ROOT, 'client', 'dist');
const SHOTS = process.env.E2E_SCREENSHOTS || null;
const WAIT = { timeout: 20_000 };

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** A server on a copy of the built client (so a test can change the files under it). */
async function startServer(t) {
  assert.ok(fs.existsSync(path.join(DIST, 'sw.js')), 'build the client first (npm run build)');
  const dir = tmpDir(t, 'suite-e2e-');
  const dist = path.join(dir, 'dist');
  fs.cpSync(DIST, dist, { recursive: true });
  const config = testConfig(dir, { CLIENT_DIST: dist });
  const env = await startApp(t, config, { modules: [...modules, syncdemo] });
  const users = await ensureTestUsers(env.ctx);
  return { ...env, users, dist };
}

async function launch(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return browser;
}

/** Records CSP violations and page errors (helmet's CSP must keep working with the service worker). */
async function watch(context) {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));
  if (process.env.E2E_DEBUG) {
    context.on('console', (m) => console.log(`[console ${m.type()}] ${m.text()}`));
    context.on('serviceworker', (w) => console.log(`[service worker] ${w.url()}`));
  }
  return errors;
}

async function signIn(page, base, username, secret) {
  await page.goto(`${base}/`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code').fill(totpCode(secret, Date.now()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Today' }).waitFor(WAIT);
}

/** Poll until fn() is truthy (server-side state), or fail after WAIT. */
async function until(fn, what) {
  const end = Date.now() + WAIT.timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const barSays = (page, text) => page.locator('[data-testid="sync-bar-text"]', { hasText: text }).waitFor(WAIT);
const swControls = (page) => page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, WAIT);

function iphone() {
  const { defaultBrowserType, ...descriptor } = devices['iPhone 13'];
  return descriptor;
}

test('iPhone in airplane mode: the app opens, a task is ticked and a note added, and both reach the Mac', async (t) => {
  const server = await startServer(t);
  const { base, db, users } = server;
  const browser = await launch(t);

  // The Mac (partner) makes an item to work on (it stands in for a task until C4a).
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const macErrors = await watch(mac);
  const macPage = await mac.newPage();
  await signIn(macPage, base, 'sam', users.partner.totpSecret);
  await macPage.goto(`${base}/sync/data/item`);
  await macPage.getByRole('button', { name: 'Add' }).click();
  await macPage.getByLabel('Title').fill('Lefty’s — follow up');
  await macPage.getByRole('button', { name: 'Save' }).click();
  const itemId = await macPage.locator('[data-record-id]').first().getAttribute('data-record-id', WAIT);
  await until(() => db.prepare('SELECT title FROM syncdemo_items WHERE id = ?').get(itemId), 'the Mac’s item on the server');
  await barSays(macPage, 'All changes saved');

  // The iPhone (owner) signs in once with a connection; the service worker installs.
  const phone = await browser.newContext(iphone());
  const phoneErrors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await swControls(page);
  await page.goto(`${base}/sync/data/item`);
  const row = page.locator(`[data-record-id="${itemId}"]`);
  await row.waitFor(WAIT);
  await barSays(page, 'All changes saved');
  await shot(page, '1-online');

  // Airplane mode, and the app is opened again: the shell comes from the service worker,
  // the session from memory, the records from IndexedDB.
  await phone.setOffline(true);
  const reopened = await page.reload();
  assert.equal(reopened.fromServiceWorker(), true, 'the page came from the service worker');
  await row.waitFor(WAIT);
  await barSays(page, 'Offline');
  assert.equal(await page.evaluate(() => navigator.onLine), false);

  // Tick it, and add a note.
  await row.getByLabel('Done').check();
  await barSays(page, 'Offline · 1 change waiting');
  await page.goto(`${base}/sync/data/note`); // a navigation while offline: also served by the service worker
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByLabel('Item').selectOption({ label: 'item · Lefty’s — follow up' });
  await page.getByLabel('Body').fill('Called — wants a quote by Friday');
  await page.getByRole('button', { name: 'Save' }).click();
  await barSays(page, 'Offline · 2 changes waiting');
  await page.getByText('Waiting to sync').first().waitFor(WAIT);
  await shot(page, '2-offline-waiting');

  // Closed and opened again, still offline: the changes are still here and still waiting.
  await page.reload();
  await barSays(page, 'Offline · 2 changes waiting');
  await page.getByText('Called — wants a quote by Friday').waitFor(WAIT);
  assert.equal(db.prepare('SELECT count(*) AS n FROM syncdemo_notes').get().n, 0, 'nothing reached the server yet');
  assert.equal(db.prepare('SELECT done FROM syncdemo_items WHERE id = ?').get(itemId).done, null);

  // Back online: sent without touching anything.
  await phone.setOffline(false);
  await barSays(page, 'All changes saved');
  await shot(page, '3-back-online');
  assert.equal(db.prepare('SELECT done FROM syncdemo_items WHERE id = ?').get(itemId).done, 1);
  const note = db.prepare('SELECT * FROM syncdemo_notes').get();
  assert.deepEqual([note.item_id, note.body, note.created_by], [itemId, 'Called — wants a quote by Friday', 'owner']);

  // The Mac sees both.
  await macPage.reload();
  await macPage.locator(`[data-record-id="${itemId}"]`).getByLabel('Done').waitFor(WAIT);
  await macPage.waitForFunction((id) => document.querySelector(`[data-record-id="${id}"] input[type=checkbox]`)?.checked, itemId, WAIT);
  await macPage.goto(`${base}/sync/data/note`);
  await macPage.getByText('Called — wants a quote by Friday').waitFor(WAIT);
  if (SHOTS) await macPage.screenshot({ path: path.join(SHOTS, '4-mac.png'), fullPage: true });

  for (const p of [page, macPage]) assert.deepEqual(await p.evaluate(() => window.__cspViolations), [], 'no CSP violations');
  assert.deepEqual([...phoneErrors, ...macErrors], [], 'no page errors');
});

test('a new version waits for "Reload": the open app keeps its own files, then switches and drops the old cache', async (t) => {
  const server = await startServer(t);
  const { base, users, dist } = server;
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  await watch(phone);
  const page = await phone.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await swControls(page);
  const oldCaches = await page.evaluate(() => caches.keys());
  assert.equal(oldCaches.length, 1);

  // Deploy a "new version": different index.html, so a different service worker version.
  const indexFile = path.join(dist, 'index.html');
  fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('<head>', '<head><meta name="suite-build" content="v2">'));
  const swFile = path.join(dist, 'sw.js');
  fs.writeFileSync(swFile, fs.readFileSync(swFile, 'utf8').replace(/"version":"([0-9a-f]+)"/, '"version":"$1-v2"'));

  // The app notices (as it does when coming back to the foreground) and offers to reload.
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  if (process.env.E2E_DEBUG) {
    await new Promise((r) => setTimeout(r, 2000));
    console.log(await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return JSON.stringify({ installing: r.installing?.state, waiting: r.waiting?.state, active: r.active?.state, caches: await caches.keys() });
    }));
  }
  await page.getByText('A new version of the suite is ready.').waitFor(WAIT);
  // Meanwhile the open app still works on its own version, offline too.
  await phone.setOffline(true);
  await page.goto(`${base}/sync`);
  await page.getByRole('heading', { name: 'Offline data' }).waitFor(WAIT);
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="suite-build"]')), null, 'still the old shell');
  await phone.setOffline(false);

  await page.getByText('A new version of the suite is ready.').waitFor(WAIT);
  await Promise.all([page.waitForEvent('load', WAIT), page.getByRole('button', { name: 'Reload' }).click()]);
  await page.waitForFunction(() => document.querySelector('meta[name="suite-build"]')?.content === 'v2', null, WAIT);
  const newCaches = await page.evaluate(() => caches.keys());
  assert.equal(newCaches.length, 1);
  assert.notEqual(newCaches[0], oldCaches[0], 'the old version’s cache is gone');
});
