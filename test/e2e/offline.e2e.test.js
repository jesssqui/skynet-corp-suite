// End-to-end: the built app in Chromium with iPhone emulation against a real suite server.
// "Offline" here is a real outage: the proxy in front of the server is cut (so the service worker
// can't reach it either) and, for airplane mode, the browser also reports offline.
//
//   npm run test:e2e        (builds the client first; needs a Chromium for playwright-core —
//                            here PLAYWRIGHT_BROWSERS_PATH, on a Mac `npx playwright-core install chromium`)
//
// E2E_SCREENSHOTS=<dir> keeps screenshots of the phone at each stage, E2E_DEBUG=1 shows the pages' console.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAIT, shot, startServer, launch, watch, signIn, until, barSays, swControls, cacheNames, airplane, iphone, deployNewVersion,
} from './helpers.js';

test('iPhone in airplane mode: the app opens, a task is ticked and a note added, and both reach the Mac', async (t) => {
  const server = await startServer(t);
  const { base, direct, db, users } = server;
  const browser = await launch(t);

  // The Mac (partner, straight to the server) makes an item to work on (it stands in for a task until C4a).
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const macErrors = await watch(mac);
  const macPage = await mac.newPage();
  await signIn(macPage, direct, 'sam', users.partner.totpSecret);
  await macPage.goto(`${direct}/sync/data/item`);
  await macPage.getByRole('button', { name: 'Add' }).click();
  await macPage.getByLabel('Title').fill('Lefty’s — follow up');
  await macPage.getByRole('button', { name: 'Save' }).click();
  const itemId = await macPage.locator('[data-record-id]').first().getAttribute('data-record-id', WAIT);
  await until(() => db.prepare('SELECT title FROM syncdemo_items WHERE id = ?').get(itemId), 'the Mac’s item on the server');
  await barSays(macPage, 'All changes saved');

  // The iPhone (owner, through the proxy) signs in once with a connection; the service worker installs.
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
  await airplane(phone, server, true);
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
  await airplane(phone, server, false);
  await barSays(page, 'All changes saved');
  await shot(page, '3-back-online');
  assert.equal(db.prepare('SELECT done FROM syncdemo_items WHERE id = ?').get(itemId).done, 1);
  const note = db.prepare('SELECT * FROM syncdemo_notes').get();
  assert.deepEqual([note.item_id, note.body, note.created_by], [itemId, 'Called — wants a quote by Friday', 'owner']);

  // The Mac sees both.
  await macPage.reload();
  await macPage.waitForFunction((id) => document.querySelector(`[data-record-id="${id}"] input[type=checkbox]`)?.checked, itemId, WAIT);
  await macPage.goto(`${direct}/sync/data/note`);
  await macPage.getByText('Called — wants a quote by Friday').waitFor(WAIT);
  await shot(macPage, '4-mac');

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
  const oldCaches = await cacheNames(page);
  assert.equal(oldCaches.length, 1);

  deployNewVersion(dist);
  // The app notices (as it does when coming back to the foreground) and offers to reload.
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.getByText('A new version of the suite is ready.').waitFor(WAIT);
  // Meanwhile the open app still works on its own version, with no connection too.
  await airplane(phone, server, true);
  await page.goto(`${base}/sync`);
  await page.getByRole('heading', { name: 'Offline data' }).waitFor(WAIT);
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="suite-build"]')), null, 'still the old shell');
  await airplane(phone, server, false);

  await page.getByText('A new version of the suite is ready.').waitFor(WAIT);
  await Promise.all([page.waitForEvent('load', WAIT), page.getByRole('button', { name: 'Reload' }).click()]);
  await page.waitForFunction(() => document.querySelector('meta[name="suite-build"]')?.content === 'v2', null, WAIT);
  const newCaches = await cacheNames(page);
  assert.equal(newCaches.length, 1);
  assert.notEqual(newCaches[0], oldCaches[0], 'the old version’s cache is gone');
});

test('signing out keeps the app shell: after switching person (with an update waiting) it still opens in an outage', async (t) => {
  const server = await startServer(t);
  const { base, users, dist } = server;
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await watch(mac);
  const page = await mac.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await swControls(page);
  deployNewVersion(dist);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await page.getByText('A new version of the suite is ready.').waitFor(WAIT);
  assert.equal((await cacheNames(page)).length, 2, 'the running version’s cache and the waiting one’s');

  // Sign out: the offline copy goes, the public app shell (both versions) stays.
  await page.goto(`${base}/account`);
  await page.getByRole('button', { name: /Sign out of this device/ }).click();
  await page.getByText('Signed out').waitFor(WAIT);
  assert.equal((await cacheNames(page)).length, 2);
  assert.deepEqual(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)), []);

  // The other person signs in and takes the new version.
  await signIn(page, base, 'sam', users.partner.totpSecret, { from: null });
  await page.getByRole('button', { name: 'Reload' }).waitFor(WAIT);
  await Promise.all([page.waitForEvent('load', WAIT), page.getByRole('button', { name: 'Reload' }).click()]);
  await page.waitForFunction(() => document.querySelector('meta[name="suite-build"]')?.content === 'v2', null, WAIT);
  await barSays(page, 'All changes saved');

  // A real outage (the server is gone; the browser still thinks it is online): it opens from the cache.
  server.proxy.down();
  const reopened = await page.reload();
  assert.equal(reopened.fromServiceWorker(), true);
  await page.locator('.shell').waitFor(WAIT);
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="suite-build"]')?.content), 'v2');
  await barSays(page, 'Offline');
  server.proxy.up();

  // Whatever empties the shell cache (the browser, by hand), the next load with a connection refills it.
  await page.evaluate(async () => {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) await cache.delete(req);
    }
  });
  await page.reload();
  await page.locator('.shell').waitFor(WAIT);
  server.proxy.down();
  assert.equal((await page.reload()).fromServiceWorker(), true);
  await page.locator('.shell').waitFor(WAIT);
  server.proxy.up();
});

test('a sign-out in one tab takes the other tab to the sign-in screen at once, records gone', async (t) => {
  const server = await startServer(t);
  const { base, users } = server;
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await watch(mac);
  const tab1 = await mac.newPage();
  await signIn(tab1, base, 'sam', users.partner.totpSecret);
  await tab1.goto(`${base}/sync/data/item`);
  await tab1.getByRole('button', { name: 'Add' }).click();
  await tab1.getByLabel('Title').fill('Private item');
  await tab1.getByRole('button', { name: 'Save' }).click();
  await until(() => server.db.prepare("SELECT 1 FROM syncdemo_items WHERE title = 'Private item'").get(), 'the item on the server');
  await barSays(tab1, 'All changes saved');
  const tab2 = await mac.newPage();
  await tab2.goto(`${base}/sync/data/item`);
  await tab2.getByText('Private item').waitFor(WAIT);

  // Signed out from tab 1 during an outage (the server never hears of it): tab 2 follows anyway.
  server.proxy.down();
  await tab1.goto(`${base}/account`);
  await tab1.getByRole('button', { name: /Sign out of this device/ }).click();
  await tab1.getByText('Signed out').waitFor(WAIT);
  await tab2.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 5000 });
  assert.equal(await tab2.getByText('Private item').count(), 0);

  // The server never heard of that sign-out and the cookie is still there: once it can be reached,
  // the sign-out is sent first — the old session doesn't quietly come back.
  const deviceId = server.db.prepare("SELECT d.id FROM auth_devices d JOIN auth_users u ON u.id = d.user_id WHERE u.username = 'sam'").get().id;
  server.proxy.up();
  await tab1.reload();
  await until(() => server.db.prepare('SELECT signed_out_at FROM auth_devices WHERE id = ?').get(deviceId).signed_out_at, 'the sign-out on the server');
  await tab1.getByRole('heading', { name: 'Sign in' }).waitFor(WAIT);
  await tab1.waitForTimeout(500);
  assert.equal(await tab1.locator('.shell').count(), 0, 'still signed out');
});

test('the sign-in screen warns before someone else signs in over unsent changes', async (t) => {
  const server = await startServer(t);
  const { base, db, users } = server;
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await watch(mac);
  const page = await mac.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await page.goto(`${base}/sync/data/item`);
  await barSays(page, 'All changes saved');
  server.proxy.down();
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByLabel('Title').fill('Jessy’s unsent item');
  await page.getByRole('button', { name: 'Save' }).click();
  await barSays(page, '1 change waiting');
  // The session ends meanwhile; back online the app asks for a sign-in and keeps the change.
  db.prepare("UPDATE auth_sessions SET ended_at = ?, end_reason = 'expired' WHERE ended_at IS NULL").run(new Date().toISOString());
  server.proxy.up();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText('Your session ended').waitFor(WAIT);

  await page.getByLabel('Username').fill('sam');
  await page.getByText('Jessy has 1 change on this device that hasn’t been sent').waitFor(WAIT);
  await page.getByLabel('Username').fill('jessy');
  assert.equal(await page.getByText('hasn’t been sent').count(), 0, 'no warning for the same person');
  await signIn(page, base, 'jessy', users.owner.totpSecret, { from: null });
  await until(() => db.prepare("SELECT 1 FROM syncdemo_items WHERE title = 'Jessy’s unsent item'").get(), 'the kept change sent');
});

test('a device clock far off shows in the sync bar', async (t) => {
  const server = await startServer(t);
  const { base, users } = server;
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  await watch(phone);
  await phone.clock.install({ time: Date.now() + 2 * 3_600_000 });
  await phone.clock.resume();
  const page = await phone.newPage();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await page.goto(`${base}/sync/data/item`);
  await page.getByRole('button', { name: 'Add' }).click();
  await page.getByLabel('Title').fill('From the future');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByTestId('clock-warning').waitFor(WAIT);
  assert.match(await page.getByTestId('clock-warning').textContent(), /clock is off/);
});
