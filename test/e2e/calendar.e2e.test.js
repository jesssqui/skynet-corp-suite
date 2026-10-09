// The task calendar feed (C6a) in the browser: Account → Calendar makes the link (shown once), a
// calendar app (here: a plain fetch with no cookie) reads it, a finished task drops out, Replace
// stops the old link at once, Turn off stops it all — on a Mac and on an iPhone. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { WAIT, startServer, launch, watch, signIn, iphone, shot } from './helpers.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** A calendar app: no cookie, no Origin. */
const fetchFeed = async (url) => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
};

function makeTask(server, fields) {
  const r = server.ctx.services.sync.applyLocal({
    actor: 'owner', entity: 'task', op: 'create', fields: { business_id: BUSINESS_IDS.agency, owner: 'owner', ...fields },
  });
  assert.equal(r.status, 'applied');
  return r.recordId;
}

const inDays = (n) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('Mac: make the link on Account → Calendar, a calendar reads it, a finished task drops out, replace and turn off', async (t) => {
  const server = await startServer(t);
  const quote = makeTask(server, { title: 'Send the Northwind quote', due_date: inDays(2), due_time: '10:00', estimate_minutes: 45 });
  makeTask(server, { title: 'Renew the domain', owner: 'shared', business_id: BUSINESS_IDS.personal, due_date: inDays(5) });
  makeTask(server, { title: 'Sam’s own errand', owner: 'partner', due_date: inDays(3) });
  const browser = await launch(t);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Account', exact: true }).click();
  await page.getByRole('radio', { name: 'Calendar' }).click();
  await page.waitForURL(/\/account\/calendar$/, WAIT);
  await page.getByTestId('calendar-state').filter({ hasText: 'Off' }).waitFor(WAIT);
  // Opened at the Mac's own address (the test server's 127.0.0.1): the page says the link only works here.
  await page.getByTestId('calendar-reach').filter({ hasText: 'only works on this Mac' }).waitFor(WAIT);
  await page.getByRole('button', { name: 'Make my calendar link' }).click();
  const url = (await page.getByTestId('calendar-url').textContent()).trim();
  assert.match(url, new RegExp(`^${server.base}/api/calendar/feed/[A-Za-z0-9_-]{43}\\.ics$`));
  assert.equal(await page.getByTestId('calendar-webcal').getAttribute('href'), url.replace(/^http:/, 'webcal:'));
  await page.getByTestId('calendar-state').filter({ hasText: 'On' }).waitFor(WAIT);
  await shot(page, 'c6a-calendar-made-mac');
  assert.equal(await noSideways(page), 0);

  // A calendar app reads it: the owner's task (timed) and the shared list's, not the partner's.
  let feed = await fetchFeed(url);
  assert.equal(feed.status, 200);
  assert.match(feed.type, /^text\/calendar/);
  assert.ok(feed.text.includes('SUMMARY:Send the Northwind quote'));
  assert.ok(feed.text.includes('SUMMARY:[Shared] Renew the domain'));
  assert.ok(!feed.text.includes('Sam’s own errand'));
  assert.match(feed.text, /DTSTART;TZID=America\/Toronto:\d{8}T100000/);
  await page.reload();
  await page.getByTestId('calendar-state').filter({ hasText: 'last read by a calendar' }).waitFor(WAIT);
  assert.equal(await page.getByTestId('calendar-url').count(), 0, 'never shown again');

  // Finished in the suite → gone at the next refresh.
  server.ctx.services.sync.applyLocal({ actor: 'owner', entity: 'task', op: 'update', recordId: quote, fields: { done_at: new Date().toISOString() } });
  feed = await fetchFeed(url);
  assert.ok(!feed.text.includes('Send the Northwind quote'));

  // Replace: the old link stops at once, the new one works.
  await page.getByRole('button', { name: 'Replace link…' }).click();
  await page.getByRole('button', { name: 'Replace the link' }).click();
  const next = (await page.getByTestId('calendar-url').textContent()).trim();
  assert.notEqual(next, url);
  assert.equal((await fetchFeed(url)).status, 404);
  assert.equal((await fetchFeed(next)).status, 200);

  // Turn off: 404 from now on.
  await page.getByRole('button', { name: 'Turn off…' }).click();
  await page.getByRole('button', { name: 'Turn it off' }).click();
  await page.getByTestId('calendar-state').filter({ hasText: 'Off' }).waitFor(WAIT);
  assert.equal((await fetchFeed(next)).status, 404);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('iPhone: the partner makes their own link; it fits the screen and lists their tasks', async (t) => {
  const server = await startServer(t);
  makeTask(server, { title: 'Pack the Save Point order', owner: 'partner', business_id: BUSINESS_IDS.save_point, due_date: inDays(1) });
  makeTask(server, { title: 'Jessy’s own call', owner: 'owner', due_date: inDays(1) });
  const browser = await launch(t);
  const context = await browser.newContext(iphone());
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'sam', server.users.partner.totpSecret);
  await page.goto(`${server.base}/account/calendar`);
  await page.getByRole('button', { name: 'Make my calendar link' }).click();
  const url = (await page.getByTestId('calendar-url').textContent()).trim();
  await page.getByText('Add Subscribed Calendar').waitFor(WAIT);
  await shot(page, 'c6a-calendar-made-iphone');
  assert.equal(await noSideways(page), 0);
  const feed = await fetchFeed(url);
  assert.ok(feed.text.includes('SUMMARY:Pack the Save Point order'));
  assert.ok(!feed.text.includes('Jessy’s own call'));
  assert.ok(feed.text.includes('X-WR-CALNAME:Suite tasks · Sam'));
  assert.deepEqual(errors, []);
});
