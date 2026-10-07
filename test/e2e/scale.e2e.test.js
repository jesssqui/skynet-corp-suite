// A phone holding 5,000 records: the plain records page stays small (pages of 50 rows) and a tick
// shows at once. Timings are printed; the limits asserted are generous (slow machines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone } from './helpers.js';

const N = 5000;

test(`${N} records: the records page shows 50 rows at a time and a tick stays quick`, async (t) => {
  const server = await startServer(t);
  const { base, users, ctx, db } = server;
  db.transaction(() => {
    for (let i = 0; i < N; i += 1) {
      ctx.services.sync.applyLocal({ actor: 'partner', entity: 'item', op: 'create', fields: { title: `Item ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`, qty: i, done: false } });
    }
  })();
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  await watch(phone);
  const page = await phone.newPage();
  let t0 = Date.now();
  await signIn(page, base, 'jessy', users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  console.log(`# first download of ${N} records: ${Date.now() - t0} ms`);

  t0 = Date.now();
  await page.goto(`${base}/sync/data/item`);
  await page.getByTestId('records-shown').waitFor(WAIT);
  console.log(`# records page: ${Date.now() - t0} ms`);
  assert.equal(await page.locator('[data-record-id]').count(), 50);
  assert.match(await page.getByTestId('records-shown').textContent(), new RegExp(`50 of ${N}`));
  const elements = await page.evaluate(() => document.getElementsByTagName('*').length);
  console.log(`# elements on the page: ${elements}`);
  assert.ok(elements < 3000, `${elements} elements`);

  // Ticks while offline: each shows at once and is counted.
  server.proxy.down();
  await phone.setOffline(true);
  await barSays(page, 'Offline');
  const boxes = page.locator('[data-record-id] input[type=checkbox]');
  t0 = Date.now();
  for (let i = 0; i < 10; i += 1) {
    await boxes.nth(i).check();
    await barSays(page, `Offline · ${i + 1} change${i ? 's' : ''} waiting`);
  }
  const perTick = (Date.now() - t0) / 10;
  console.log(`# tick until counted: ${perTick.toFixed(0)} ms each`);
  assert.ok(perTick < 1500, `${perTick} ms per tick`);

  await page.getByRole('button', { name: 'Show 50 more' }).click();
  assert.equal(await page.locator('[data-record-id]').count(), 100);

  server.proxy.up();
  await phone.setOffline(false);
  t0 = Date.now();
  await barSays(page, 'All changes saved');
  console.log(`# reconnect until saved: ${Date.now() - t0} ms`);
  assert.equal(db.prepare('SELECT count(*) AS n FROM syncdemo_items WHERE done = 1').get().n, 10);
});
