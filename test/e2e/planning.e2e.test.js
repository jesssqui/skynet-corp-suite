// Planning (C4b) in the browser, on an iPhone and on a Mac: set the week's goals on the Monday plan
// (carry one over from last week, add one), sort a task with no day and no goal onto a goal (on
// the iPhone during an outage), overbook today and accept a suggestion until it fits, run the
// Friday review (a goal marked done, a task handed over), and focus through two tasks with the
// client's details beside them. The Mac also adds a task from a goal's card and a month priority.
// Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate, nowIso } from '@suite/shared/time';
import { weekStart, monthStart, addDays, WORKDAY_IDS } from '@suite/shared/planner';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, until, shot, airplane } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;
const NEW_GOAL = 'Follow up 5 quiet wholesale customers';

/** Clients, goals and tasks made on the server (as if by each person's devices earlier). */
function seed(ctx) {
  const today = localDate(); // the browser runs in the same time zone here
  const monday = weekStart(today);
  const sync = ctx.services.sync;
  const make = (actor, entity, fields) => {
    const r = sync.applyLocal({ actor, entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const daysAgo = (n) => nowIso(new Date(Date.now() - n * 86_400_000));
  const ids = {};
  ids.client = make('owner', 'client', { name: 'Maple Row Holdings', status: 'active' });
  ids.account = make('owner', 'account', { client_id: ids.client, name: 'Maple Row Dispensary', city: 'Simcoe' });
  make('owner', 'contact', { client_id: ids.client, account_id: ids.account, name: 'Dana Pike', role: 'Owner', phone: '5195550142', email: 'dana@maplerow.example' });
  make('owner', 'activity', { client_id: ids.client, type: 'note', body: 'Wants the homepage live before November', at: daysAgo(3) });
  ids.rel = make('owner', 'relationship', { account_id: ids.account, business_id: AGENCY, kind: 'website', status: 'active' });
  make('owner', 'service', { relationship_id: ids.rel, name: 'Website care plan', status: 'active', billing: 'flat', amount_cents: 12000, period: 'monthly', renewal_date: addDays(today, 12) });
  make('owner', 'task', { title: 'Send the Maple Row proofs', owner: 'owner', business_id: AGENCY, client_id: ids.client, relationship_id: ids.rel, due_date: addDays(today, 3) });
  ids.quiet = make('owner', 'client', { name: 'Quiet Pines Co', status: 'active' });
  make('owner', 'activity', { client_id: ids.quiet, type: 'call', body: 'Said they’d reorder in spring', at: daysAgo(75) });

  ids.lastWeek = make('owner', 'goal', { kind: 'week', period: addDays(monday, -7), business_id: W, title: 'Count the back-room stock', owner: 'owner', target: 3, progress: 1 });
  ids.priority = make('owner', 'goal', { kind: 'month', period: monthStart(today), business_id: AGENCY, title: 'Sign two new retainers', owner: 'owner', target: 2, progress: 1 });

  const task = (actor, fields) => make(actor, 'task', { business_id: PERSONAL, owner: actor, ...fields });
  // Today, in Today's order: overdue, timed, untimed, shared (made last: pushed first).
  ids.overdue = task('owner', { title: 'Call the label printer', business_id: W, due_date: addDays(today, -1), estimate_minutes: 60 });
  ids.timed = task('owner', {
    title: 'Draft the Maple Row homepage', business_id: AGENCY, client_id: ids.client, account_id: ids.account, due_date: today, due_time: '10:30',
    estimate_minutes: 180, notes: 'Hero, menu and opening hours',
  });
  ids.untimed = task('owner', { title: 'Pack the Cedar Lane order', business_id: W, due_date: today, estimate_minutes: 120 });
  ids.shared = task('partner', { title: 'Water the office plants', owner: 'shared', due_date: today, estimate_minutes: 15 });
  ids.unplanned = task('owner', { title: 'Call Cedar Lane about reorders', estimate_minutes: 30 });
  ids.handoff = task('owner', { title: 'Photograph the new arrivals', business_id: BUSINESS_IDS.save_point, due_date: addDays(today, 6) });
  ids.partnerOverdue = task('partner', { title: 'List the board game lot', business_id: BUSINESS_IDS.save_point, due_date: addDays(today, -2) });
  return { today, monday, ids };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const goal = (db, where, ...args) => db.prepare(`SELECT * FROM planner_goals WHERE ${where}`).get(...args);
const taskRow = (db, id) => db.prepare('SELECT * FROM planner_tasks WHERE id = ?').get(id);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

/** 1. The Monday plan: carry last week's unfinished goal over, add a new one. */
async function setWeekGoals(page, server, { monday, ids }, label) {
  await nav(page, 'Plan');
  await page.waitForURL(/\/plan\/week/, WAIT);
  const carry = page.getByTestId('carry-over');
  await carry.getByText('Count the back-room stock').waitFor(WAIT);
  await carry.getByRole('button', { name: 'Carry over: Count the back-room stock' }).click();
  await carry.waitFor({ state: 'detached', ...WAIT });
  const goals = page.getByTestId('week-goals');
  await goals.locator('[data-goal-id]', { hasText: 'Count the back-room stock' }).getByText('1 of 3').waitFor(WAIT);
  const carried = await until(() => goal(server.db, 'carried_from = ?', ids.lastWeek), 'the carried goal on the server');
  assert.deepEqual([carried.period, carried.business_id, carried.progress, carried.target], [monday, W, 1, 3]);
  assert.equal(goal(server.db, 'id = ?', ids.lastWeek).period, addDays(monday, -7), 'last week’s goal left as it was');

  await page.getByRole('button', { name: 'Add a week goal for Wholesale' }).click();
  const sheet = page.getByTestId('goal-form');
  await sheet.locator('#goal-title').fill(NEW_GOAL);
  await sheet.locator('#goal-target').fill('5');
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the goal sheet open');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  const item = goals.locator('[data-goal-id]', { hasText: NEW_GOAL });
  await item.getByText('0 of 5').waitFor(WAIT);
  // The new goal is last in Wholesale; move it up above the carried one.
  await item.getByRole('button', { name: `Move up: ${NEW_GOAL}` }).click();
  // Only Wholesale has goals here: the first goal on the page is the first of Wholesale's.
  await page.waitForFunction((title) => document.querySelector('[data-testid="week-goals"] [data-goal-id] .planner-task-title span')?.textContent === title, NEW_GOAL, WAIT);
  const made = await until(() => goal(server.db, 'title = ?', NEW_GOAL), 'the new goal on the server');
  assert.deepEqual([made.kind, made.period, made.business_id, made.target, made.owner, made.created_by], ['week', monday, W, 5, 'owner', 'owner']);
  await until(() => goal(server.db, 'title = ?', NEW_GOAL).position === 0, 'the new order on the server');
  if (label === 'iPhone') {
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the Monday plan');
    assert.ok((await item.getByRole('checkbox').boundingBox()).height >= 44, 'the goal tick is a full tap target');
    assert.ok((await item.getByRole('button', { name: `Move down: ${NEW_GOAL}` }).boundingBox()).height >= 44);
  }
  return made.id;
}

/** 2. To sort: a task with no day and no goal is filed under the new goal (two taps: open the list, pick). */
async function sortOntoGoal(page, context, server, { ids }, goalId, { offline }) {
  const list = page.getByTestId('to-sort');
  const row = list.locator(`[data-sort-task="${ids.unplanned}"]`);
  await row.waitFor(WAIT);
  assert.equal(await page.getByTestId('to-sort-count').innerText(), '1');
  if (offline) {
    await airplane(context, server, true);
    await barSays(page, 'Offline');
  }
  await row.locator(`#sort-goal-${ids.unplanned}`).selectOption({ label: `Wholesale — ${NEW_GOAL}` });
  await row.waitFor({ state: 'detached', ...WAIT });
  await page.getByTestId('to-sort-sorted').getByText(`Call Cedar Lane about reorders → goal “${NEW_GOAL}”`).waitFor(WAIT);
  await page.getByTestId('to-sort-empty').waitFor(WAIT);
  // It now hangs off the goal.
  await page.getByTestId(`goal-tasks-${goalId}`).getByText('Call Cedar Lane about reorders').waitFor(WAIT);
  if (offline) {
    await barSays(page, 'Offline ·');
    assert.equal(taskRow(server.db, ids.unplanned).goal_id, null, 'not on the server yet');
    await airplane(context, server, false);
  }
  await barSays(page, 'All changes saved');
  const t = await until(() => (taskRow(server.db, ids.unplanned).goal_id === goalId ? taskRow(server.db, ids.unplanned) : null), 'the sorted task on the server');
  assert.equal(t.business_id, W, 'its business follows the goal');
}

/** 3. Overbook today (a 6-hour day in Plan my day), then accept a suggestion and see it fit. */
async function overbookAndFix(page, server, { today, ids }, label) {
  await nav(page, 'Today');
  await page.getByRole('button', { name: 'Plan my day' }).click();
  const plan = page.getByTestId('plan-sheet');
  await plan.getByTestId('plan-day-summary').filter({ hasText: 'Today: 6 h 15 min of 8 h' }).waitFor(WAIT);
  await plan.getByRole('button', { name: 'Change your day length' }).click();
  await plan.locator('#day-length').selectOption('360');
  await plan.getByTestId('plan-day-over').filter({ hasText: 'Overbooked by 15 min' }).waitFor(WAIT);
  await plan.getByTestId('plan-day-suggestions').locator(`[data-suggest-task="${ids.shared}"]`).waitFor(WAIT);
  await plan.getByRole('button', { name: 'Done', exact: true }).click();
  await plan.waitFor({ state: 'detached', ...WAIT });

  // Today warns, and suggests the shared, untimed, most recently made task: one tap moves it.
  const warn = page.getByTestId('today-load');
  await warn.getByTestId('today-load-over').filter({ hasText: 'Overbooked by 15 min' }).waitFor(WAIT);
  const suggestions = warn.getByTestId('today-load-suggestions');
  assert.equal(await suggestions.locator('[data-suggest-task]').count(), 1, 'just enough to fit');
  const move = suggestions.getByRole('button', { name: /^Move “Water the office plants” to / });
  if (label === 'iPhone') {
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling with the warning');
    assert.ok((await move.boundingBox()).height >= 44);
    await shot(page, 'c4b-today-overbooked-iphone', { fullPage: false });
    await shot(page, 'c4b-today-overbooked-iphone-full');
  } else {
    await shot(page, 'c4b-today-overbooked-mac', { fullPage: false });
  }
  await move.click();
  await warn.getByTestId('today-load-fits').waitFor(WAIT);
  await warn.getByTestId('today-load-summary').filter({ hasText: 'Today: 6 h of 6 h' }).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  assert.equal(taskRow(server.db, ids.shared).due_date, addDays(today, 1), 'moved to tomorrow (it has room)');
  assert.equal(server.db.prepare('SELECT day_minutes FROM planner_workdays WHERE id = ?').get(WORKDAY_IDS.owner).day_minutes, 360);
  // Undo puts it back; moving again leaves it fitting.
  await warn.getByRole('button', { name: 'Undo' }).click();
  await warn.getByTestId('today-load-over').waitFor(WAIT);
  await warn.getByTestId('today-load-suggestions').getByRole('button', { name: /^Move “Water the office plants”/ }).click();
  await warn.getByTestId('today-load-fits').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  assert.equal(taskRow(server.db, ids.shared).due_date, addDays(today, 1));
}

/** 4. The Friday review: the lists, a goal marked done, a task handed to the partner, a step ticked. */
async function fridayReview(page, server, { ids }, goalId, label) {
  await nav(page, 'Plan');
  await page.getByRole('link', { name: 'Friday review' }).click();
  const review = page.getByTestId('review');
  await review.waitFor(WAIT);
  const overdue = review.getByTestId('review-overdue');
  await overdue.getByText('List the board game lot').waitFor(WAIT); // the partner's
  await overdue.getByText('Call the label printer').waitFor(WAIT);
  await review.getByTestId('review-renewals').getByText('Website care plan').waitFor(WAIT);
  await review.getByTestId('review-renewals').getByRole('link', { name: /Maple Row Holdings/ }).waitFor(WAIT);
  await review.getByTestId('review-quiet').getByRole('link', { name: 'Quiet Pines Co' }).waitFor(WAIT);
  assert.equal(await review.getByTestId('review-quiet').getByText('Maple Row Holdings').count(), 0, 'in touch 3 days ago');
  assert.equal(await review.getByTestId('review-not-connected').count(), 2, 'duplicate matches and order entry: not connected yet');

  const goals = review.getByTestId('review-goals');
  const g = goals.locator(`[data-goal-id="${goalId}"]`);
  await g.getByTestId('goal-state').filter({ hasText: 'Not done' }).waitFor(WAIT);
  await g.getByRole('checkbox', { name: `Done: ${NEW_GOAL}` }).click();
  await g.getByTestId('goal-state').filter({ hasText: 'Done' }).waitFor(WAIT);

  const handoff = review.getByRole('region', { name: 'Hand work to the other person' });
  await handoff.getByRole('button', { name: 'Give to partner: Photograph the new arrivals' }).click();
  await handoff.getByText('Handed to your partner').waitFor(WAIT);
  await review.getByRole('checkbox', { name: 'Reviewed: Clear anything overdue' }).check();
  await page.getByText('1 of 8 reviewed').waitFor(WAIT);
  await barSays(page, 'All changes saved');
  assert.ok(goal(server.db, 'id = ?', goalId).done_at, 'the goal is done');
  assert.deepEqual([taskRow(server.db, ids.handoff).owner, taskRow(server.db, ids.handoff).updated_by], ['partner', 'owner']);
  if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the review');
  else await shot(page, 'c4b-review-mac');
}

/** 5. Focus: one task at a time in Today's order; Done moves on; the client's details beside it. */
async function focusThroughTwo(page, server, { ids }, label) {
  await nav(page, 'Today');
  await page.getByRole('button', { name: 'Focus' }).click();
  const focus = page.getByTestId('focus');
  await page.getByTestId('focus-title').filter({ hasText: 'Call the label printer' }).waitFor(WAIT);
  assert.equal(await focus.getByTestId('focus-client').count(), 0, 'no client: nothing beside it');
  await focus.getByRole('button', { name: 'Done' }).click();
  await page.getByTestId('focus-title').filter({ hasText: 'Draft the Maple Row homepage' }).waitFor(WAIT);
  await focus.getByTestId('focus-notes').filter({ hasText: 'Hero, menu and opening hours' }).waitFor(WAIT);
  const client = focus.getByTestId('focus-client');
  await client.getByText('Dana Pike').waitFor(WAIT);
  assert.equal(await client.getByRole('link', { name: '(519) 555-0142' }).getAttribute('href'), 'tel:5195550142');
  assert.equal(await client.getByRole('link', { name: 'dana@maplerow.example' }).getAttribute('href'), 'mailto:dana@maplerow.example');
  await client.getByTestId('focus-timeline').getByText('Wants the homepage live before November').waitFor(WAIT);
  if (label === 'iPhone') {
    assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Focus');
    const task = await page.getByTestId('focus-title').boundingBox();
    const beside = await client.boundingBox();
    assert.ok(beside.y > task.y, 'the client is below the task on a phone');
    assert.ok((await focus.getByRole('button', { name: 'Done' }).boundingBox()).height >= 44);
    await shot(page, 'c4b-focus-iphone', { fullPage: false });
    await shot(page, 'c4b-focus-iphone-full');
  } else {
    const task = await page.getByTestId('focus-title').boundingBox();
    const beside = await client.boundingBox();
    assert.ok(beside.x > task.x + task.width, 'beside the task on a wide screen');
    await shot(page, 'c4b-focus-mac');
  }
  // Skip it this time; the next of today's tasks comes up.
  await focus.getByRole('button', { name: 'Skip' }).click();
  await page.getByTestId('focus-title').filter({ hasText: 'Pack the Cedar Lane order' }).waitFor(WAIT);
  await focus.getByRole('button', { name: 'Done' }).click();
  await page.getByText(/That’s today’s list done/).waitFor(WAIT);
  await page.getByRole('button', { name: /Go back to the 1 skipped/ }).click();
  await page.getByTestId('focus-title').filter({ hasText: 'Draft the Maple Row homepage' }).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  assert.ok(taskRow(server.db, ids.overdue).done_at);
  assert.ok(taskRow(server.db, ids.untimed).done_at);
  assert.equal(taskRow(server.db, ids.timed).done_at, null, 'skipped, not done');
}

test('iPhone: week goals, a task sorted onto a goal offline, an overbooked day fixed, the Friday review, Focus', async (t) => {
  const server = await startServer(t);
  const data = seed(server.ctx);
  const browser = await launch(t);
  const phone = await browser.newContext(iphone());
  const errors = await watch(phone);
  const page = await phone.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  // Today counts the task to sort.
  await page.getByTestId('today-to-sort').filter({ hasText: '1 to sort' }).waitFor(WAIT);
  assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Today (with Focus in the header)');
  const tab = await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan', exact: true }).boundingBox();
  assert.ok(tab.height >= 44 && tab.width >= 44, 'the Plan tab is a full tap target');

  const goalId = await setWeekGoals(page, server, data, 'iPhone');
  await shot(page, 'c4b-week-iphone', { fullPage: false });
  await sortOntoGoal(page, phone, server, data, goalId, { offline: true });
  await overbookAndFix(page, server, data, 'iPhone');
  await fridayReview(page, server, data, goalId, 'iPhone');
  await focusThroughTwo(page, server, data, 'iPhone');

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('Mac: week goals and a task from a goal’s card, sorting, an overbooked day fixed, the monthly plan, the Friday review, Focus', async (t) => {
  const server = await startServer(t);
  const data = seed(server.ctx);
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');

  const goalId = await setWeekGoals(page, server, data, 'Mac');
  // A task added from the goal's card is part of it (and its business) from the start.
  const card = page.getByTestId('week-goals').locator(`[data-goal-id="${goalId}"]`);
  await card.getByRole('button', { name: `Add a task to ${NEW_GOAL}` }).click();
  const sheet = page.getByTestId('task-form');
  assert.equal(await sheet.locator('#task-goal').inputValue(), goalId);
  assert.equal(await sheet.locator('#task-business').inputValue(), W);
  await sheet.locator('#task-title').fill('Email Birch & Co about the fall catalogue');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.waitFor({ state: 'detached', ...WAIT });
  await page.getByTestId(`goal-tasks-${goalId}`).getByText('Email Birch & Co about the fall catalogue').waitFor(WAIT);
  await sortOntoGoal(page, mac, server, data, goalId, { offline: false });
  // The week strip: today's load; the Monday plan side by side on a wide screen.
  await page.getByTestId('week-days').locator(`[data-day="${data.today}"]`).waitFor(WAIT);
  const goalsBox = await page.getByTestId('week-goals').boundingBox();
  const daysBox = await page.getByTestId('week-days').boundingBox();
  assert.ok(daysBox.x > goalsBox.x + goalsBox.width - 1, 'the week and To sort sit beside the goals');
  await shot(page, 'c4b-week-mac');
  const added = server.db.prepare('SELECT * FROM planner_tasks WHERE title = ?').get('Email Birch & Co about the fall catalogue');
  assert.deepEqual([added.goal_id, added.business_id, added.due_date], [goalId, W, null]);

  await overbookAndFix(page, server, data, 'Mac');

  // The monthly plan: this month's priority with its progress, the month's week goals, a new priority.
  await nav(page, 'Plan');
  await page.getByRole('link', { name: 'Month', exact: true }).click();
  const month = page.getByTestId('month-priorities');
  const agency = month.locator(`[data-goal-id="${data.ids.priority}"]`);
  await agency.getByText('1 of 2').waitFor(WAIT);
  // This week's goals are under this month (unless this week belongs to the next or last month).
  if (monthStart(addDays(data.monday, 3)) === monthStart(data.today)) await month.getByTestId(`month-weeks-${W}`).getByText(NEW_GOAL).waitFor(WAIT);
  await page.getByRole('button', { name: 'Add a priority for Wholesale' }).click();
  const pSheet = page.getByTestId('goal-form');
  await pSheet.locator('#goal-title').fill('Open 3 new stores');
  await pSheet.locator('#goal-target').fill('3');
  await pSheet.getByRole('button', { name: 'Save', exact: true }).click();
  await pSheet.waitFor({ state: 'detached', ...WAIT });
  await month.locator('[data-goal-id]', { hasText: 'Open 3 new stores' }).waitFor(WAIT);
  await barSays(page, 'All changes saved');
  const priority = goal(server.db, 'title = ?', 'Open 3 new stores');
  assert.deepEqual([priority.kind, priority.period, priority.business_id, priority.target], ['month', monthStart(data.today), W, 3]);
  await shot(page, 'c4b-month-mac');

  await fridayReview(page, server, data, goalId, 'Mac');
  await focusThroughTwo(page, server, data, 'Mac');

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('at scale: 3,000 tasks and 300 goals — Today, the Monday plan, the monthly plan, the review and Focus stay quick', async (t) => {
  const server = await startServer(t);
  const sync = server.ctx.services.sync;
  const today = localDate();
  const monday = weekStart(today);
  const businesses = Object.values(BUSINESS_IDS);
  const make = (entity, fields) => sync.applyLocal({ actor: 'owner', entity, op: 'create', fields }).recordId;
  // 300 goals over 30 weeks and months; 3,000 tasks: some today, many dated, many on goals, some to sort.
  const goals = [];
  for (let i = 0; i < 300; i += 1) {
    const week = i % 2 === 0;
    const period = week ? addDays(monday, -7 * (i % 15)) : monthStart(addDays(today, -31 * (i % 15)));
    goals.push(make('goal', { kind: week ? 'week' : 'month', period, business_id: businesses[i % businesses.length], title: `Goal ${i}`, owner: 'owner', target: 5, progress: i % 6 }));
  }
  for (let i = 0; i < 3000; i += 1) {
    const fields = { title: `Chore ${String(i).padStart(4, '0')}`, owner: ['owner', 'partner', 'shared'][i % 3], business_id: businesses[i % businesses.length], estimate_minutes: 15 + (i % 8) * 15 };
    if (i % 5 === 0) fields.goal_id = goals[i % goals.length];
    else if (i % 7 === 0) { /* no day, no goal: to sort */ } else fields.due_date = addDays(today, (i % 40) - 10);
    if (i % 4 === 0) fields.done_at = nowIso();
    make('task', fields);
  }
  const browser = await launch(t);
  const mac = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(mac);
  const page = await mac.newPage();
  await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
  await barSays(page, 'All changes saved');
  const timed = async (what, fn) => {
    const start = Date.now();
    await fn();
    const ms = Date.now() - start;
    console.log(`# scale: ${what} ${ms} ms`);
    assert.ok(ms < 5000, `${what} took ${ms} ms`);
  };
  await timed('Today (overbooked)', async () => {
    await page.goto(`${server.base}/`);
    await page.getByTestId('today-load').waitFor(WAIT);
  });
  await timed('the Monday plan', async () => {
    await nav(page, 'Plan');
    await page.getByTestId('to-sort').locator('[data-sort-task]').first().waitFor(WAIT);
  });
  await timed('sorting one task', async () => {
    const first = page.getByTestId('to-sort').locator('[data-sort-task]').first();
    const id = await first.getAttribute('data-sort-task');
    await first.getByRole('button', { name: /^Tomorrow: / }).click();
    await page.locator(`[data-sort-task="${id}"]`).waitFor({ state: 'detached', ...WAIT });
  });
  await timed('the monthly plan', async () => {
    await page.getByRole('link', { name: 'Month', exact: true }).click();
    await page.getByTestId('month-priorities').waitFor(WAIT);
  });
  await timed('the Friday review', async () => {
    await page.getByRole('link', { name: 'Friday review' }).click();
    await page.getByTestId('review-overdue').waitFor(WAIT);
  });
  await timed('Focus', async () => {
    await page.goto(`${server.base}/focus`);
    await page.getByTestId('focus-title').waitFor(WAIT);
  });
  await timed('Focus: Done to the next', async () => {
    const before = await page.getByTestId('focus-title').innerText();
    await page.getByTestId('focus').getByRole('button', { name: 'Done' }).click();
    await page.waitForFunction((b) => document.querySelector('[data-testid="focus-title"]')?.textContent !== b, before, WAIT);
  });
  assert.deepEqual(errors, []);
});
