// The planner (C4a) in the browser, on an iPhone and on a Mac: Today shows overdue first with the
// shared list mixed in and the partner's own tasks left out; an item captured during an outage
// becomes a task in two taps and reaches the server once it is back; the morning plan picks a top
// 3 and moves one task to tomorrow; logging a call with a next step clears a relationship's
// "No next step". Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { weekStart } from '@suite/shared/planner';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const PERSONAL = BUSINESS_IDS.personal;

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Tasks and a client made on the server (as if by each person's devices earlier). */
function seed(ctx) {
  const today = localDate(); // the browser runs in the same time zone here
  const sync = ctx.services.sync;
  const make = (actor, entity, fields) => {
    const r = sync.applyLocal({ actor, entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const task = (actor, fields) => make(actor, 'task', { business_id: PERSONAL, ...fields });
  const monday = weekStart(today);
  const goal = (business_id, title) => make('owner', 'goal', { kind: 'week', period: monday, business_id, title, owner: 'owner' });
  const goals = { agency: goal(BUSINESS_IDS.agency, 'Ship the Q4 plans'), wholesale: goal(W, 'Refresh the price list'), personal: goal(PERSONAL, 'Paperwork') };
  const ids = {
    overdue: task('owner', { title: 'Renew the business licence', owner: 'owner', due_date: addDays(today, -3), estimate_minutes: 30 }),
    shared: task('partner', { title: 'Water the office plants', owner: 'shared', due_date: today, estimate_minutes: 10 }),
    timed: task('owner', { title: 'Call the bank', owner: 'owner', business_id: W, due_date: today, due_time: '10:30', estimate_minutes: 20 }),
    partnerOverdue: task('partner', { title: 'List the Zelda lot', owner: 'partner', business_id: BUSINESS_IDS.save_point, due_date: addDays(today, -2) }),
    partnerToday: task('partner', { title: 'Photograph the new arrivals', owner: 'partner', due_date: today }),
    // C4b: undated tasks are proposed by the morning plan when they belong to this week's goals.
    draft: task('owner', { title: 'Draft the Q4 social plan', owner: 'owner', business_id: BUSINESS_IDS.agency, estimate_minutes: 120, goal_id: goals.agency }),
    prices: task('owner', { title: 'Update the price sheet', owner: 'owner', business_id: W, estimate_minutes: 60, goal_id: goals.wholesale }),
    receipts: task('owner', { title: 'Sort the receipts', owner: 'owner', estimate_minutes: 45, goal_id: goals.personal }),
    later: task('owner', { title: 'Book the trade show booth', owner: 'owner', due_date: addDays(today, 5) }),
  };
  ids.client = make('owner', 'client', { name: 'Northwind Holdings', status: 'active' });
  ids.account = make('owner', 'account', { client_id: ids.client, name: 'Cloud Vape Co' });
  ids.rel = make('owner', 'relationship', { account_id: ids.account, business_id: W, kind: 'wholesale', status: 'active' });
  return { today, ids };
}

const rowTitles = (loc) => loc.locator('[data-task-id] .planner-task-title').allInnerTexts();

/** The rows' titles, once they are `want` (a filter re-renders after the click). */
async function titlesBecome(loc, want) {
  const end = Date.now() + WAIT.timeout;
  let got;
  while (Date.now() < end) {
    got = await rowTitles(loc);
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(got, want, `${loc.page().url()}\n${(await loc.page().locator('main').innerText()).slice(0, 1500)}`);
}
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** 2. Today: overdue first, then due today (timed first); shared marked; the partner's own not shown. */
async function checkToday(page, ids) {
  await page.getByTestId('overdue').waitFor(WAIT);
  const all = page.getByTestId('today-tasks');
  assert.deepEqual(await rowTitles(all), ['Renew the business licence', 'Call the bank', 'Water the office plants'], 'overdue first, then today in time order');
  assert.deepEqual(await rowTitles(page.getByTestId('overdue')), ['Renew the business licence']);
  const shared = all.locator(`[data-task-id="${ids.shared}"]`);
  assert.equal(await shared.getAttribute('data-owner'), 'shared');
  await shared.getByText('Shared', { exact: true }).waitFor(WAIT);
  await all.locator(`[data-task-id="${ids.timed}"]`).getByText('You', { exact: true }).waitFor(WAIT);
  assert.equal(await all.locator('[data-owner="partner"]').count(), 0, 'the partner’s own tasks are theirs');
  assert.equal(await page.getByText('List the Zelda lot').count(), 0);
  await page.getByTestId('no-next-step-summary').filter({ hasText: '1 active relationship has no dated next step' }).waitFor(WAIT);
}

/** 1. Capture during an outage; Task + Save (two taps) on the item; the server has it once back. */
async function captureOffline(page, context, server, label) {
  const text = `Order the ${label} window decal`;
  await airplane(context, server, true);
  await barSays(page, 'Offline');
  await page.getByLabel('Capture', { exact: true }).fill(text);
  await page.getByTestId('capture').getByRole('button', { name: 'Add' }).click();
  await barSays(page, 'Offline · 1 change waiting');
  await page.getByTestId('capture').getByText('Saved to the inbox').waitFor(WAIT);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click(); // the visible nav; its name includes the count
  const item = page.locator('[data-inbox-id]', { hasText: text });
  await item.waitFor(WAIT);
  // Tap 1: Task. The sheet opens pre-filled: the text, me, a business (Personal by default).
  await item.getByRole('button', { name: `Make a task: ${text}` }).click();
  const sheet = page.getByTestId('task-form');
  await sheet.waitFor(WAIT);
  assert.equal(await sheet.locator('#task-title').inputValue(), text);
  assert.equal(await sheet.locator('#task-business').inputValue(), PERSONAL);
  assert.equal(await sheet.getByRole('radio', { name: 'Mine' }).getAttribute('aria-checked'), 'true');
  assert.equal(await sheet.locator('#task-date').inputValue(), '', 'no date');
  return { text, sheet, item };
}

async function finishCapture(page, context, server, { text, sheet, item }) {
  // Tap 2: Save.
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  await item.waitFor({ state: 'detached', ...WAIT });
  await page.getByText('Inbox is clear').waitFor(WAIT);
  await barSays(page, 'Offline · 3 changes waiting');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE title = ?').get(text).n, 0, 'not on the server yet');
  await airplane(context, server, false);
  await barSays(page, 'All changes saved');
  const task = await until(() => server.db.prepare('SELECT * FROM planner_tasks WHERE title = ?').get(text), 'the task on the server');
  assert.deepEqual([task.owner, task.business_id, task.due_date, task.created_by], ['owner', PERSONAL, null, 'owner']);
  const inbox = server.db.prepare('SELECT * FROM planner_inbox_items WHERE text = ?').get(text);
  assert.deepEqual([inbox.became_entity, inbox.became_id, inbox.created_by], ['task', task.id, 'owner']);
  assert.ok(inbox.cleared_at);
  return task;
}

/** 3. Plan my day: three top picks (a fourth can't be picked), one task moved to tomorrow. */
async function planDay(page, server, { today, ids }, { screenshot }) {
  await page.getByRole('link', { name: 'Today' }).first().click();
  await page.getByRole('button', { name: 'Plan my day' }).click();
  const plan = page.getByTestId('plan-sheet');
  await plan.waitFor(WAIT);
  const row = (id) => plan.locator(`[data-plan-task="${id}"]`);
  for (const id of [ids.overdue, ids.shared, ids.timed, ids.draft, ids.prices, ids.receipts]) await row(id).waitFor(WAIT);
  assert.equal(await row(ids.partnerOverdue).count(), 0, 'not the partner’s');
  assert.equal(await row(ids.later).count(), 0, 'not what is due later');
  await plan.getByTestId('plan-load').getByText('Today: 1 h of 8 h').waitFor(WAIT);
  for (const id of [ids.timed, ids.draft, ids.prices]) await row(id).getByRole('button', { name: /^Pick for today’s top 3/ }).click();
  await plan.getByTestId('top-count').filter({ hasText: 'Top 3: 3 of 3 picked' }).waitFor(WAIT);
  assert.equal(await row(ids.receipts).getByRole('button', { name: /^Pick for today’s top 3/ }).isDisabled(), true, 'three at most');
  // The undated picks are on today now: 30 + 10 + 20 + 120 + 60 minutes.
  await plan.getByTestId('plan-load').getByText('Today: 4 h of 8 h').waitFor(WAIT);
  await row(ids.overdue).getByRole('button', { name: /^Move to another day/ }).click();
  await row(ids.overdue).getByRole('button', { name: 'Tomorrow' }).click();
  await row(ids.overdue).getByText(/Moved to tomorrow/).waitFor(WAIT);
  await plan.getByTestId('plan-load').getByText('Today: 3 h 30 min of 8 h').waitFor(WAIT);
  if (screenshot) await shot(page, screenshot, { fullPage: false });
  await plan.getByRole('button', { name: 'Done', exact: true }).click();
  await plan.waitFor({ state: 'detached', ...WAIT });

  // Today now: nothing overdue; the undated picks listed after what's due today, starred.
  await page.getByTestId('overdue').waitFor({ state: 'detached', ...WAIT });
  await titlesBecome(page.getByTestId('picked'), ['Draft the Q4 social plan', 'Update the price sheet']);
  await page.getByTestId('today-top').filter({ hasText: 'Top 3: 3 of 3 picked' }).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  const t = (id) => server.db.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id);
  assert.deepEqual([ids.timed, ids.draft, ids.prices].map((id) => t(id).top_on_owner), [today, today, today]);
  assert.equal(t(ids.receipts).top_on_owner, null);
  assert.equal(t(ids.overdue).due_date, addDays(today, 1), 'moved to tomorrow');
}

/** 4. Logging a call with a next step clears the relationship's "No next step". */
async function nextStepFromCall(page, server, { today, ids }, label) {
  await page.getByRole('link', { name: 'Today' }).first().click();
  await page.getByTestId('no-next-step').getByRole('link', { name: 'Northwind Holdings' }).click();
  await page.getByTestId('client-name').waitFor(WAIT);
  const rel = page.locator(`.crm-rel[data-relationship-id="${ids.rel}"]`);
  await rel.getByTestId('no-next-step-flag').waitFor(WAIT);
  await shot(page, `c4a-client-${label}`);
  await page.getByRole('button', { name: 'Log call' }).first().click();
  const sheet = page.getByTestId('activity-form');
  await sheet.waitFor(WAIT);
  await sheet.locator('#act-body').fill('Wants 40 tins for Friday');
  await sheet.locator('#act-account').selectOption({ label: 'Cloud Vape Co' });
  await sheet.locator('#act-business').selectOption({ label: 'Wholesale' });
  assert.equal(await sheet.locator('#act-next-rel').inputValue(), ids.rel, 'the relationship follows the call’s account and business');
  await sheet.locator('#act-next-title').fill('Confirm the Friday delivery');
  await sheet.locator('#act-next-date').fill(addDays(today, 2));
  await shot(page, `c4a-call-next-step-${label}`, { fullPage: false });
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  await rel.getByTestId('no-next-step-flag').waitFor({ state: 'detached', ...WAIT });
  await page.getByTestId('client-tasks').getByText('Confirm the Friday delivery').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  const task = await until(() => server.db.prepare('SELECT * FROM planner_tasks WHERE title = ?').get('Confirm the Friday delivery'), 'the next step on the server');
  assert.deepEqual([task.relationship_id, task.account_id, task.client_id, task.business_id, task.owner, task.due_date],
    [ids.rel, ids.account, ids.client, W, 'owner', addDays(today, 2)]);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM crm_activities WHERE type = 'call'").get().n, 1);
  await page.getByRole('link', { name: 'Today' }).first().click();
  await page.getByTestId('today-inbox').waitFor(WAIT);
  assert.equal(await page.getByTestId('no-next-step').count(), 0, 'Today no longer lists it');
}

/**
 * 11. The partner's side: their Today has their own tasks and the shared list (never the owner's
 * own), and none of the owner's top picks; their star on a shared task is theirs alone.
 */
async function partnerSide(browser, server, { today, ids }, ownerPage) {
  const ctx = await browser.newContext(iphone());
  const errors = await watch(ctx);
  const p = await ctx.newPage();
  await signIn(p, server.base, 'sam', server.users.partner.totpSecret);
  await barSays(p, 'All changes saved');
  await p.getByTestId('overdue').waitFor(WAIT);
  await titlesBecome(p.getByTestId('today-tasks'), ['List the Zelda lot', 'Water the office plants', 'Photograph the new arrivals']);
  assert.equal(await p.getByTestId('today-tasks').locator('[data-owner="owner"]').count(), 0, 'the owner’s own tasks are the owner’s');
  await p.getByTestId('today-tasks').locator(`[data-task-id="${ids.shared}"]`).getByText('Shared', { exact: true }).waitFor(WAIT);
  await p.getByTestId('today-tasks').locator(`[data-task-id="${ids.partnerOverdue}"]`).getByText('You', { exact: true }).waitFor(WAIT);
  assert.equal(await p.getByTestId('today-top').innerText(), 'Top 3: 0 of 3 picked', 'the owner’s three picks are not the partner’s');
  assert.equal(await p.getByTestId('picked').count(), 0);
  await shot(p, 'c4a-today-partner-phone', { fullPage: false });

  // The partner picks the shared task: one of their three; the owner's picks are untouched.
  await p.getByRole('button', { name: 'Plan my day' }).click();
  const plan = p.getByTestId('plan-sheet');
  await plan.getByTestId('top-count').filter({ hasText: 'Top 3: 0 of 3 picked' }).waitFor(WAIT);
  assert.equal(await plan.locator(`[data-plan-task="${ids.timed}"]`).count(), 0, 'not the owner’s tasks');
  await plan.locator(`[data-plan-task="${ids.shared}"]`).getByRole('button', { name: /^Pick for today’s top 3/ }).click();
  await plan.getByTestId('top-count').filter({ hasText: 'Top 3: 1 of 3 picked' }).waitFor(WAIT);
  await plan.getByRole('button', { name: 'Done', exact: true }).click();
  await barSays(p, 'All changes saved');
  const shared = server.db.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(ids.shared);
  assert.deepEqual([shared.top_on_partner, shared.top_on_owner], [today, null]);
  // The owner still has exactly their own three, and the shared task isn't starred for them.
  await ownerPage.reload();
  await barSays(ownerPage, 'All changes saved');
  await ownerPage.getByTestId('today-top').filter({ hasText: 'Top 3: 3 of 3 picked' }).waitFor(WAIT);
  await ownerPage.getByRole('button', { name: 'Plan my day' }).click();
  const ownerPlan = ownerPage.getByTestId('plan-sheet');
  assert.equal(await ownerPlan.locator(`[data-plan-task="${ids.shared}"] .planner-star`).getAttribute('aria-pressed'), 'false');
  await ownerPlan.getByRole('button', { name: 'Done', exact: true }).click();
  assert.deepEqual(errors, []);
  await ctx.close();
}

test('iPhone: Today’s order, capture offline → task in two taps, Plan my day, a call’s next step', async (t) => {
  const server = await startServer(t);
  const data = seed(server.ctx);
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  await checkToday(page, data.ids);
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Today');
  // The capture field sits above the tab bar, full height, without scrolling.
  const capture = await page.getByTestId('capture').boundingBox();
  const tabbar = await page.locator('.shell-tabbar').boundingBox();
  assert.ok(capture.y + capture.height <= tabbar.y + 1 && capture.y > 0, `capture placed ${JSON.stringify(capture)} above ${JSON.stringify(tabbar)}`);
  assert.ok((await page.getByLabel('Capture', { exact: true }).boundingBox()).height >= 44);
  assert.ok((await page.locator('.planner-tick').first().boundingBox()).height >= 44, 'ticks are full tap targets');
  await shot(page, 'c4a-today-phone', { fullPage: false });
  await shot(page, 'c4a-today-phone-full');

  const captured = await captureOffline(page, phone, server, 'iPhone');
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the sheet open');
  await shot(page, 'c4a-inbox-task-sheet-phone', { fullPage: false });
  await finishCapture(page, phone, server, captured);

  await planDay(page, server, data, { screenshot: 'c4a-plan-phone' });
  await nextStepFromCall(page, server, data, 'phone');

  // Tick a task on Today, then undo it (same session).
  const row = page.locator(`[data-task-id="${data.ids.shared}"]`);
  await row.getByRole('checkbox', { name: /^Done: / }).click();
  await row.getByRole('checkbox', { name: /^Not done: / }).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  assert.ok(server.db.prepare('SELECT done_at FROM planner_tasks WHERE id = ?').get(data.ids.shared).done_at);
  await row.getByRole('checkbox', { name: /^Not done: / }).click();
  await row.getByRole('checkbox', { name: /^Done: / }).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  assert.equal(server.db.prepare('SELECT done_at FROM planner_tasks WHERE id = ?').get(data.ids.shared).done_at, null);

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('Mac: Today’s order, capture offline → task in two taps, Plan my day, a call’s next step; the Tasks page and a handoff', async (t) => {
  const server = await startServer(t);
  const data = seed(server.ctx);
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  await checkToday(page, data.ids);
  // Wide screen: tasks left, the inbox and "No next step" beside them.
  const tasks = await page.getByTestId('today-tasks').boundingBox();
  const side = await page.getByTestId('no-next-step').boundingBox();
  assert.ok(side.x > tasks.x + tasks.width - 1, 'the side column sits beside the tasks');
  await shot(page, 'c4a-today-mac');

  const captured = await captureOffline(page, mac, server, 'Mac');
  await finishCapture(page, mac, server, captured);
  await planDay(page, server, data, { screenshot: 'c4a-plan-mac' });
  await nextStepFromCall(page, server, data, 'mac');
  await shot(page, 'c4a-today-mac-after');
  await partnerSide(browser, server, data, page);

  // The Tasks page: whose / due filters; a handoff is one field.
  await page.getByRole('link', { name: 'Tasks' }).first().click();
  const list = page.getByTestId('task-list');
  await list.waitFor(WAIT);
  await list.getByText('List the Zelda lot').waitFor(WAIT);
  await page.getByRole('radio', { name: 'Mine' }).click();
  await list.getByText('List the Zelda lot').waitFor({ state: 'detached', ...WAIT });
  await page.getByRole('radio', { name: 'Partner’s' }).click();
  await titlesBecome(list, ['List the Zelda lot', 'Photograph the new arrivals']);
  await page.getByRole('radio', { name: 'All' }).click();
  await page.locator('#tasks-due').selectOption({ label: 'No date' });
  await titlesBecome(list, ['Draft the Q4 social plan', 'Update the price sheet', 'Sort the receipts', 'Order the Mac window decal']);
  await page.locator('#tasks-due').selectOption({ label: 'All open' });
  await shot(page, 'c4a-tasks-mac');
  await list.locator(`[data-task-id="${data.ids.receipts}"]`).getByRole('button', { name: /Sort the receipts/ }).click();
  const sheet = page.getByTestId('task-form');
  await sheet.getByRole('radio', { name: 'Partner’s' }).click();
  await shot(page, 'c4a-task-sheet-mac', { fullPage: false });
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  await list.locator(`[data-task-id="${data.ids.receipts}"][data-owner="partner"]`).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  const handed = server.db.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(data.ids.receipts);
  assert.deepEqual([handed.owner, handed.updated_by, handed.estimate_minutes], ['partner', 'owner', 45], 'only the owner changed');

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('Today pages long lists: 50 tasks and 5 relationships without a next step at first, more on request', async (t) => {
  const server = await startServer(t);
  const sync = server.ctx.services.sync;
  const today = localDate();
  const make = (entity, fields) => sync.applyLocal({ actor: 'owner', entity, op: 'create', fields }).recordId;
  for (let i = 0; i < 120; i += 1) make('task', { title: `Overdue chore ${String(i).padStart(3, '0')}`, owner: 'owner', business_id: PERSONAL, due_date: addDays(today, -1) });
  const client = make('client', { name: 'Many Shops Ltd', status: 'active' });
  for (let i = 0; i < 60; i += 1) {
    const account = make('account', { client_id: client, name: `Shop ${i}` });
    make('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  }
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await mac.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  const overdue = page.getByTestId('overdue');
  await overdue.waitFor(WAIT);
  assert.equal(await overdue.locator('[data-task-id]').count(), 50);
  await page.getByTestId('overdue-count').filter({ hasText: '120' }).waitFor(WAIT);
  await page.getByTestId('overdue-more').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="overdue"] [data-task-id]').length === 100, null, WAIT);
  const flags = page.getByTestId('no-next-step');
  assert.equal(await flags.locator('[data-relationship-id]').count(), 5);
  await page.getByTestId('no-next-step-more').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="no-next-step"] [data-relationship-id]').length === 55, null, WAIT);
});
