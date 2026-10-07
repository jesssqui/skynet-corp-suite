// Shared by the end-to-end tests: a real suite server (with the test-only syncdemo module standing
// in for the CRM's record types) on a copy of the built client, behind a proxy that can be cut
// (a real outage: the service worker can't reach the server either), and Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';
import { modules } from '../../server/src/modules/index.js';
import syncdemo from '../../server/test/fixtures/syncdemo/index.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, TEST_PASSWORD } from '../../server/test/helpers.js';
import { totpCode } from '../../server/src/modules/auth/crypto.js';
import { startProxy } from './proxy.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = path.join(ROOT, 'client', 'dist');
const SHOTS = process.env.E2E_SCREENSHOTS || null;
export const WAIT = { timeout: 20_000 };

export async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/**
 * A server on a copy of the built client (so a test can change the files under it), with a proxy
 * in front: `base` is the proxy's address, `direct` the server's; `outage()` / `restored()` cut and
 * restore the proxy.
 */
export async function startServer(t) {
  assert.ok(fs.existsSync(path.join(DIST, 'sw.js')), 'build the client first (npm run build)');
  const dir = tmpDir(t, 'suite-e2e-');
  const dist = path.join(dir, 'dist');
  fs.cpSync(DIST, dist, { recursive: true });
  const config = testConfig(dir, { CLIENT_DIST: dist });
  const env = await startApp(t, config, { modules: [...modules, syncdemo] });
  const users = await ensureTestUsers(env.ctx);
  const proxy = await startProxy(env.base);
  t.after(() => proxy.close());
  return { ...env, direct: env.base, base: proxy.base, proxy, users, dist };
}

export async function launch(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return browser;
}

/** Records CSP violations and page errors (helmet's CSP must keep working with the service worker). */
export async function watch(context) {
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

// TOTP steps are usable once per account: sign the same person in again with the next step.
const lastStep = new Map();
function nextCode(secret) {
  const step = Math.max(Math.floor(Date.now() / 30_000), (lastStep.get(secret) ?? -1) + 1);
  lastStep.set(secret, step);
  return totpCode(secret, step * 30_000);
}

export async function signIn(page, base, username, secret, { from = `${base}/` } = {}) {
  if (from) await page.goto(from);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Code').fill(nextCode(secret));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.shell').waitFor(WAIT); // the app (whatever page it was on)
}

/** Poll until fn() is truthy (server-side state), or fail after WAIT. */
export async function until(fn, what) {
  const end = Date.now() + WAIT.timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const barSays = (page, text) => page.locator('[data-testid="sync-bar-text"]', { hasText: text }).waitFor(WAIT);
export const swControls = (page) => page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, WAIT);
export const cacheNames = (page) => page.evaluate(() => caches.keys());

/** Airplane mode: the browser reports offline and the server really can't be reached. */
export async function airplane(context, server, on) {
  if (on) {
    server.proxy.down();
    await context.setOffline(true);
  } else {
    server.proxy.up();
    await context.setOffline(false);
  }
}

export function iphone() {
  const { defaultBrowserType, ...descriptor } = devices['iPhone 13'];
  return descriptor;
}

/** Make a new build appear on the server (a different index.html, so a different service-worker version). */
export function deployNewVersion(dist) {
  const indexFile = path.join(dist, 'index.html');
  fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('<head>', '<head><meta name="suite-build" content="v2">'));
  const swFile = path.join(dist, 'sw.js');
  fs.writeFileSync(swFile, fs.readFileSync(swFile, 'utf8').replace(/"version":"([0-9a-f]+)"/, '"version":"$1-v2"'));
}
