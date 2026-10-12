// Meetings from Apple Calendar (C6b) in the browser, against a fake iCloud: on a Mac, the owner connects on
// Account → Calendar (the form, checked with iCloud), then Today lists the day's meetings in time order and
// the overbooked warning counts them — suggesting a task to move, never a meeting; a meeting added in Apple
// Calendar shows at the next read; leaving a calendar out takes its meetings off. On an iPhone, Today and
// Plan my day show them, offline too. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { WAIT, startServer, launch, watch, signIn, iphone, shot, airplane } from './helpers.js';
import { startFakeCaldav, ics, APPLE_ID, APP_PASSWORD } from '../../server/test/fixtures/caldavFake.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
/** "20261012T140000Z" for a local wall time today (the browser runs in the same zone here). */
const todayAt = (hm) => new Date(`${localDate()}T${hm}:00`).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

async function setup(t) {
  const dav = await startFakeCaldav(t);
  const server = await startServer(t);
  server.ctx.config.calendar.apple.baseUrl = dav.url;
  dav.put('work', 'workshop', ics(['UID:ws', 'SUMMARY:Northwind workshop', `DTSTART:${todayAt('10:00')}`, `DTEND:${todayAt('12:30')}`]));
  dav.put('home', 'dentist', ics(['UID:dn', 'SUMMARY:Dentist', `DTSTART:${todayAt('16:00')}`, `DTEND:${todayAt('17:00')}`]));
  dav.put('home', 'holiday', ics(['UID:hd', 'SUMMARY:School holiday', `DTSTART;VALUE=DATE:${localDate().replace(/-/g, '')}`]));
  const r = server.ctx.services.sync.applyLocal({
    actor: 'owner', entity: 'task', op: 'create',
    fields: { title: 'Write the Q4 proposal', owner: 'owner', business_id: BUSINESS_IDS.agency, due_date: localDate(), estimate_minutes: 300 },
  });
  assert.equal(r.status, 'applied');
  return { dav, server, apple: server.ctx.services.calendar.apple, taskId: r.recordId };
}

test('Mac: connect Apple Calendar, then Today shows the meetings and counts them in the day’s load; a new one shows at the next read', async (t) => {
  const { dav, server, apple, taskId } = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);

  await page.goto(`${server.base}/account/calendar`);
  const card = page.getByTestId('apple-card');
  await card.waitFor(WAIT);
  await page.getByTestId('apple-state').filter({ hasText: 'Not connected' }).waitFor(WAIT);
  await page.getByLabel('Apple ID').fill(APPLE_ID);
  await page.getByLabel('App-specific password').fill('my real password');
  await page.getByTestId('apple-connect').click();
  await page.getByRole('alert').filter({ hasText: 'four groups of four letters' }).waitFor(WAIT);
  await page.getByLabel('App-specific password').fill(APP_PASSWORD.toUpperCase().replace(/-/g, ' '));
  await page.getByTestId('apple-connect').click();
  await page.getByTestId('apple-state').filter({ hasText: '3 meetings' }).waitFor(WAIT);
  await page.getByTestId('apple-calendars').getByText('Home').waitFor(WAIT);
  assert.ok(!(await page.content()).includes(APP_PASSWORD), 'the password is never shown again');
  await shot(page, 'c6b-apple-connected-mac');
  assert.equal(await noSideways(page), 0);

  // Today: the meetings in time order (all-day first), and the load: 5 h of tasks + 3 h 30 min of meetings > 8 h.
  await page.goto(`${server.base}/`);
  const list = page.getByTestId('today-meetings-list');
  await list.waitFor(WAIT);
  assert.deepEqual(await list.locator('[data-meeting-id] span:nth-child(2)').allInnerTexts(), ['School holiday', 'Northwind workshop', 'Dentist']);
  assert.equal(await list.locator('[data-meeting-id]').first().getByTestId('meeting-time').innerText(), 'All day');
  await page.getByTestId('today-load-summary').filter({ hasText: 'Today: 8 h 30 min of 8 h' }).waitFor(WAIT);
  await page.getByTestId('today-load-over').filter({ hasText: 'Overbooked by 30 min' }).waitFor(WAIT);
  await page.getByTestId('today-load-meetings').filter({ hasText: 'Includes 3 h 30 min of meetings' }).waitFor(WAIT);
  const suggestions = page.getByTestId('today-load-suggestions');
  assert.deepEqual(await suggestions.locator('[data-suggest-task]').evaluateAll((els) => els.map((e) => e.getAttribute('data-suggest-task'))), [taskId]);
  assert.equal(await suggestions.getByText('Northwind workshop').count(), 0, 'a meeting is never suggested');
  await shot(page, 'c6b-today-meetings-mac');

  // Added in Apple Calendar → at the next read (forced here) and the page's next sync, it is on Today.
  dav.put('work', 'call', ics(['UID:call', 'SUMMARY:Call with Cloud Vape', `DTSTART:${todayAt('13:00')}`, `DTEND:${todayAt('13:30')}`]));
  await apple.pullRound({ force: true });
  await page.reload();
  await list.getByText('Call with Cloud Vape').waitFor(WAIT);
  await page.getByTestId('today-load-summary').filter({ hasText: 'Today: 9 h of 8 h' }).waitFor(WAIT);

  // Leaving "Home" out takes the dentist and the holiday off.
  await page.goto(`${server.base}/account/calendar`);
  const home = page.getByTestId('apple-calendars').getByLabel(/Home/);
  await home.click(); // saved on the server, then shown unticked
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="apple-calendars"] input')].some((i) => i.id.includes('/home/') && !i.checked), null, WAIT);
  await page.goto(`${server.base}/`);
  await list.getByText('Call with Cloud Vape').waitFor(WAIT);
  await page.waitForFunction(() => !document.querySelector('[data-testid="today-meetings-list"]')?.innerText.includes('Dentist'), null, WAIT);
  assert.equal(await list.getByText('School holiday').count(), 0);

  // Plan my day lists them too.
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await page.getByTestId('plan-meetings-list').getByText('Northwind workshop').waitFor(WAIT);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('iPhone: Today and Plan my day show the meetings, in airplane mode too', async (t) => {
  const { server, apple } = await setup(t);
  await apple.connect('owner', { appleId: APPLE_ID, password: APP_PASSWORD });
  const browser = await launch(t);
  const context = await browser.newContext(iphone());
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  const list = page.getByTestId('today-meetings-list');
  await list.getByText('Northwind workshop').waitFor(WAIT);
  await page.getByTestId('today-load-over').waitFor(WAIT);
  assert.equal(await noSideways(page), 0);
  await shot(page, 'c6b-today-meetings-iphone');
  await airplane(context, server, true);
  await page.reload();
  await list.getByText('Northwind workshop').waitFor(WAIT);
  await page.getByRole('button', { name: 'Plan my day' }).click();
  await page.getByTestId('plan-meetings-list').getByText('Dentist').waitFor(WAIT);
  assert.equal(await noSideways(page), 0);
  await airplane(context, server, false);
  assert.deepEqual(errors, []);
});
