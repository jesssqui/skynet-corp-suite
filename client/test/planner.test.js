// The planner screens' logic (C4a), without React or a server: Today's order, the morning plan,
// the "no next step" rule, the defaults for a new task, the tasks page's filters, a call's next
// step, and the task form's "only what changed". Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { automatedTaskOwner } from '@suite/shared/planner';
import {
  addDays, weekBounds, dueState, dueLabel, dueTimeOf, buildToday, proposePlan, planLoad, topChange, moveChange,
  filterTasks, defaultBusinessId, relationshipsWithoutNextStep, nextStepFields, nextStepWarning, guessRelationship, openInbox,
  captureFields, saveCapture, clearedFields, titleFromText, formatMinutes, estimateOptions, ownerLabel, compareDue, isTop,
} from '../src/modules/planner/logic.js';
import { taskForm, taskValues, editChanges, isDirty, linkChange } from '../src/modules/planner/taskForm.js';

const TODAY = '2026-10-07'; // a Wednesday
const W = BUSINESS_IDS.wholesale;
const PERSONAL = BUSINESS_IDS.personal;

let seq = 0;
/** A task with an id that sorts by creation (like a UUIDv7). */
function task(fields) {
  seq += 1;
  return { id: `t-${String(seq).padStart(4, '0')}`, title: `Task ${seq}`, owner: 'owner', business_id: W, done_at: null, top_on_owner: null, top_on_partner: null, due_date: null, due_time: null, ...fields };
}
const titles = (rows) => rows.map((t) => t.title);

// ---- dates -----------------------------------------------------------------------------------

test('dates: calendar arithmetic, the week (Monday–Sunday), due states and labels; a time needs a date', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(weekBounds(TODAY), { start: '2026-10-05', end: '2026-10-11' });
  assert.deepEqual(weekBounds('2026-10-11'), { start: '2026-10-05', end: '2026-10-11' }, 'Sunday ends the week');
  assert.deepEqual(weekBounds('2026-10-12'), { start: '2026-10-12', end: '2026-10-18' }, 'Monday starts one');
  assert.equal(dueState(task({ due_date: '2026-10-06' }), TODAY), 'overdue');
  assert.equal(dueState(task({ due_date: TODAY }), TODAY), 'today');
  assert.equal(dueState(task({ due_date: '2026-10-08' }), TODAY), 'upcoming');
  assert.equal(dueState(task({}), TODAY), 'none');
  assert.equal(dueLabel(task({ due_date: '2026-10-08' }), TODAY), 'Tomorrow');
  assert.equal(dueLabel(task({ due_date: '2026-10-06' }), TODAY), 'Yesterday');
  assert.match(dueLabel(task({ due_date: TODAY, due_time: '09:30' }), TODAY), /^Today · 9:30/);
  assert.equal(dueTimeOf(task({ due_time: '09:30' })), null, 'a time left without a date is ignored');
  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(90), '1 h 30 min');
  assert.equal(formatMinutes(120), '2 h');
  assert.ok(estimateOptions('50').some((o) => o.value === '50'), 'a record’s own estimate stays pickable');
  assert.equal(ownerLabel('shared', 'owner'), 'Shared');
  assert.equal(ownerLabel('owner', 'owner'), 'You');
  assert.equal(ownerLabel('owner', 'partner'), 'Partner');
});

// ---- Today -------------------------------------------------------------------------------------

test('Today: overdue first (oldest first), then due today with timed ones in time order; shared mixed in, the partner’s own left out', () => {
  const tasks = [
    task({ title: 'Today untimed (mine)', due_date: TODAY }),
    task({ title: 'Today 14:00 (shared)', due_date: TODAY, due_time: '14:00', owner: 'shared' }),
    task({ title: 'Overdue yesterday (shared)', due_date: '2026-10-06', owner: 'shared' }),
    task({ title: 'Today 09:15 (mine)', due_date: TODAY, due_time: '09:15' }),
    task({ title: 'Overdue last week (mine)', due_date: '2026-09-30', due_time: '16:00' }),
    task({ title: 'Partner’s own, overdue', due_date: '2026-10-01', owner: 'partner' }),
    task({ title: 'Partner’s own, today', due_date: TODAY, owner: 'partner' }),
    task({ title: 'Tomorrow (mine)', due_date: '2026-10-08' }),
    task({ title: 'No date (mine)' }),
    task({ title: 'Done yesterday', due_date: '2026-10-06', done_at: '2026-10-06T20:00:00.000Z' }),
  ];
  const view = buildToday({ tasks, me: 'owner', today: TODAY });
  assert.deepEqual(titles(view.overdue), ['Overdue last week (mine)', 'Overdue yesterday (shared)']);
  assert.deepEqual(titles(view.dueToday), ['Today 09:15 (mine)', 'Today 14:00 (shared)', 'Today untimed (mine)']);
  assert.deepEqual(view.picked, []);
  assert.equal(view.total, 5);

  // The partner sees their own and the shared ones, never mine.
  const theirs = buildToday({ tasks, me: 'partner', today: TODAY });
  assert.deepEqual(titles(theirs.overdue), ['Partner’s own, overdue', 'Overdue yesterday (shared)']);
  assert.deepEqual(titles(theirs.dueToday), ['Today 14:00 (shared)', 'Partner’s own, today']);
});

test('Today: top picks show once — marked where they are due, the rest listed after; a tick stays shown this session', () => {
  const overdueTop = task({ title: 'Overdue top', due_date: '2026-10-01', top_on_owner: TODAY });
  const todayTop = task({ title: 'Untimed top', due_date: TODAY, top_on_owner: TODAY });
  const plain = task({ title: 'Untimed plain', due_date: TODAY });
  const undatedTop = task({ title: 'Undated top', top_on_owner: TODAY });
  const staleTop = task({ title: 'Picked yesterday', top_on_owner: '2026-10-06' });
  const laterTop = task({ title: 'Due Friday, top today', due_date: '2026-10-09', top_on_owner: TODAY });
  const done = task({ title: 'Ticked just now', due_date: TODAY, done_at: '2026-10-07T15:00:00.000Z' });
  const tasks = [plain, todayTop, overdueTop, undatedTop, staleTop, laterTop, done];
  const view = buildToday({ tasks, me: 'owner', today: TODAY });
  assert.deepEqual(titles(view.overdue), ['Overdue top']);
  assert.deepEqual(titles(view.dueToday), ['Untimed top', 'Untimed plain'], 'top picks first among the untimed');
  assert.deepEqual(titles(view.picked), ['Due Friday, top today', 'Undated top']);
  assert.equal(view.topCount, 4);
  const kept = buildToday({ tasks, me: 'owner', today: TODAY, keep: new Set([done.id]) });
  assert.ok(titles(kept.dueToday).includes('Ticked just now'), 'kept in place so the tick can be undone');
});

// ---- the morning plan -----------------------------------------------------------------------------

test('the morning plan proposes overdue + due today (mine and shared); undated ones that belong nowhere are to sort; load against the day', () => {
  const tasks = [
    task({ title: 'Overdue mine', due_date: '2026-10-05', estimate_minutes: 60 }),
    task({ title: 'Overdue shared', due_date: '2026-10-06', owner: 'shared', estimate_minutes: 30 }),
    task({ title: 'Today mine', due_date: TODAY, estimate_minutes: 240 }),
    task({ title: 'Undated mine', estimate_minutes: 120 }),
    task({ title: 'Undated shared', owner: 'shared' }),
    task({ title: 'Undated partner', owner: 'partner' }),
    task({ title: 'Next week', due_date: '2026-10-14' }),
    task({ title: 'Undated done', done_at: '2026-10-07T08:00:00.000Z' }),
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const p = proposePlan({ tasks, me: 'owner', today: TODAY });
  const names = (ids) => ids.map((id) => byId.get(id).title);
  assert.deepEqual(names(p.overdue), ['Overdue mine', 'Overdue shared']);
  assert.deepEqual(names(p.dueToday), ['Today mine']);
  // C4b: undated tasks that belong to no goal aren't proposed as today's any more: they're counted
  // to sort (mine and the shared list's, never the partner's own). See plan.test.js for goal tasks.
  assert.deepEqual(p.forGoals, []);
  assert.equal(p.toSort, 2);

  let load = planLoad({ tasks, me: 'owner', today: TODAY });
  assert.deepEqual([load.minutes, load.count, load.over], [330, 3, false]);
  // Picking the undated one as top puts it on today: 7 h 30 min of 8 h.
  const undated = tasks.find((t) => t.title === 'Undated mine');
  Object.assign(undated, topChange(undated, TODAY, true, 'owner'));
  assert.equal(undated.top_on_owner, TODAY);
  load = planLoad({ tasks, me: 'owner', today: TODAY });
  assert.deepEqual([load.minutes, load.count, load.over], [450, 4, false]);
  Object.assign(tasks[0], { estimate_minutes: 120 });
  assert.equal(planLoad({ tasks, me: 'owner', today: TODAY }).over, true, 'more than a day');
  assert.equal(planLoad({ tasks: [task({ due_date: TODAY })], me: 'owner', today: TODAY }).unestimated, 1);

  // Unpicking clears only today's pick; another day's pick is left alone.
  assert.deepEqual(topChange(undated, TODAY, false, 'owner'), { top_on_owner: null });
  assert.deepEqual(topChange(task({ top_on_owner: '2026-10-06' }), TODAY, false, 'owner'), { top_on_owner: '2026-10-06' });

  // Moving to tomorrow: the date changes (the time stays), a top pick stops being one; undo restores.
  const timedTop = task({ due_date: TODAY, due_time: '10:00', top_on_owner: TODAY });
  const { change, undo } = moveChange(timedTop, '2026-10-08', TODAY, 'owner');
  assert.deepEqual(change, { due_date: '2026-10-08', top_on_owner: null });
  assert.deepEqual(undo, { due_date: TODAY, top_on_owner: TODAY });
  assert.deepEqual(moveChange(task({}), '2026-10-08', TODAY, 'owner'), { change: { due_date: '2026-10-08' }, undo: { due_date: null } });
});

// ---- the "no next step" rule -------------------------------------------------------------------------

test('no next step: active relationships only; an open, dated task for it clears the flag; done or undated ones don’t; deleted parents aren’t flagged', () => {
  const clients = [{ id: 'c1', name: 'Northwind Holdings' }];
  const accounts = [{ id: 'a1', client_id: 'c1' }, { id: 'a2', client_id: 'c1' }, { id: 'aX', client_id: 'gone' }];
  const rel = (id, status, account = 'a1') => ({ id, account_id: account, business_id: W, kind: 'wholesale', status });
  const relationships = [
    rel('r-active', 'active'), rel('r-paused', 'paused'), rel('r-ended', 'ended'),
    rel('r-covered', 'active'), rel('r-done-only', 'active'), rel('r-undated', 'active', 'a2'),
    rel('r-deleted-account', 'active', 'a-deleted'), rel('r-deleted-client', 'active', 'aX'),
  ];
  const tasks = [
    task({ relationship_id: 'r-covered', due_date: '2026-10-20', owner: 'partner' }),
    task({ relationship_id: 'r-done-only', due_date: '2026-10-01', done_at: '2026-10-02T10:00:00.000Z' }),
    task({ relationship_id: 'r-undated' }),
    task({ due_date: TODAY, client_id: 'c1', account_id: 'a1' }), // about the client, not the relationship
  ];
  const flagged = relationshipsWithoutNextStep({ relationships, accounts, clients, tasks }).map((r) => r.id);
  assert.deepEqual(flagged, ['r-active', 'r-done-only', 'r-undated']);
  // An overdue next step still counts as a next step (it shows as overdue instead).
  const overdue = [...tasks, task({ relationship_id: 'r-active', due_date: '2026-09-01' })];
  assert.ok(!relationshipsWithoutNextStep({ relationships, accounts, clients, tasks: overdue }).some((r) => r.id === 'r-active'));
});

// ---- defaults ----------------------------------------------------------------------------------------

test('defaults: the business in context, else the last one used here, else Personal; automated tasks go to the business’s owner', () => {
  const businesses = [
    { id: W, name: 'Wholesale', position: 1, default_owner: 'owner' },
    { id: BUSINESS_IDS.agency, name: 'Great White North Design', position: 2, archived: true },
    { id: PERSONAL, name: 'Personal', position: 6, default_owner: 'shared' },
  ];
  assert.equal(defaultBusinessId({ context: W, lastUsed: PERSONAL, businesses }), W);
  assert.equal(defaultBusinessId({ context: BUSINESS_IDS.agency, businesses }), BUSINESS_IDS.agency, 'the context, even archived');
  assert.equal(defaultBusinessId({ context: 'not-a-business', lastUsed: W, businesses }), W);
  assert.equal(defaultBusinessId({ lastUsed: BUSINESS_IDS.agency, businesses }), PERSONAL, 'an archived last-used is skipped');
  assert.equal(defaultBusinessId({ businesses }), PERSONAL);
  assert.equal(defaultBusinessId({ businesses: businesses.filter((b) => b.id !== PERSONAL) }), W, 'no Personal: the first one');
  assert.equal(defaultBusinessId({ businesses: [] }), '');
  assert.equal(automatedTaskOwner(businesses[0]), 'owner');
  assert.equal(automatedTaskOwner(businesses[2]), 'shared');
  assert.equal(automatedTaskOwner({ id: 'x' }), 'shared');
});

// ---- the tasks page --------------------------------------------------------------------------------------

test('tasks page filters: whose, business, client, due (overdue / today / this week / no date / done)', () => {
  const tasks = [
    task({ title: 'Mine overdue', due_date: '2026-10-02', client_id: 'c1' }),
    task({ title: 'Mine Monday', due_date: '2026-10-05' }),
    task({ title: 'Shared Sunday', due_date: '2026-10-11', owner: 'shared', business_id: PERSONAL }),
    task({ title: 'Partner today', due_date: TODAY, owner: 'partner', client_id: 'c1' }),
    task({ title: 'Mine next Monday', due_date: '2026-10-12' }),
    task({ title: 'Mine undated' }),
    task({ title: 'Done early', done_at: '2026-10-01T10:00:00.000Z' }),
    task({ title: 'Done late', done_at: '2026-10-06T10:00:00.000Z' }),
  ];
  const ctx = { me: 'owner', today: TODAY };
  assert.deepEqual(titles(filterTasks(tasks, {}, ctx)), ['Mine overdue', 'Mine Monday', 'Partner today', 'Shared Sunday', 'Mine next Monday', 'Mine undated'], 'all open, due order, no date last');
  assert.deepEqual(titles(filterTasks(tasks, { owner: 'mine' }, ctx)), ['Mine overdue', 'Mine Monday', 'Mine next Monday', 'Mine undated']);
  assert.deepEqual(titles(filterTasks(tasks, { owner: 'partner' }, ctx)), ['Partner today']);
  assert.deepEqual(titles(filterTasks(tasks, { owner: 'shared' }, ctx)), ['Shared Sunday']);
  assert.deepEqual(titles(filterTasks(tasks, { owner: 'mine' }, { me: 'partner', today: TODAY })), ['Partner today'], 'from the partner’s side');
  assert.deepEqual(titles(filterTasks(tasks, { due: 'overdue' }, ctx)), ['Mine overdue', 'Mine Monday']);
  assert.deepEqual(titles(filterTasks(tasks, { due: 'today' }, ctx)), ['Partner today']);
  assert.deepEqual(titles(filterTasks(tasks, { due: 'week' }, ctx)), ['Mine Monday', 'Partner today', 'Shared Sunday']);
  assert.deepEqual(titles(filterTasks(tasks, { due: 'none' }, ctx)), ['Mine undated']);
  assert.deepEqual(titles(filterTasks(tasks, { due: 'done' }, ctx)), ['Done late', 'Done early'], 'newest first');
  assert.deepEqual(titles(filterTasks(tasks, { client: 'c1' }, ctx)), ['Mine overdue', 'Partner today']);
  assert.deepEqual(titles(filterTasks(tasks, { business: PERSONAL }, ctx)), ['Shared Sunday']);
  const ticked = tasks.find((t) => t.title === 'Done late');
  assert.ok(titles(filterTasks(tasks, {}, { ...ctx, keep: new Set([ticked.id]) })).includes('Done late'));
  assert.equal([...tasks].sort(compareDue).at(-1).due_date, null);
});

// ---- inbox and next steps ---------------------------------------------------------------------------------

test('inbox: captures are trimmed, newest first; what clearing writes; a long capture becomes title + notes', () => {
  assert.equal(captureFields('   ', { source: 'phone', now: 'x' }), null);
  assert.deepEqual(captureFields(' Call the sign maker ', { source: 'phone', now: '2026-10-07T12:00:00.000Z' }),
    { text: 'Call the sign maker', source: 'phone', captured_at: '2026-10-07T12:00:00.000Z' });
  const items = [
    { id: 'i1', captured_at: '2026-10-06T10:00:00.000Z' },
    { id: 'i2', captured_at: '2026-10-07T10:00:00.000Z' },
    { id: 'i3', captured_at: '2026-10-07T11:00:00.000Z', cleared_at: '2026-10-07T11:05:00.000Z' },
  ];
  assert.deepEqual(openInbox(items).map((i) => i.id), ['i2', 'i1']);
  assert.deepEqual(clearedFields({ entity: 'task', id: 't1', now: 'n' }), { cleared_at: 'n', became_entity: 'task', became_id: 't1' });
  assert.deepEqual(clearedFields({ now: 'n' }), { cleared_at: 'n', became_entity: null, became_id: null }, 'dismissed');
  assert.deepEqual(titleFromText('Order labels\nThe 2x3 ones, 500'), { title: 'Order labels', notes: 'The 2x3 ones, 500' });
  const long = titleFromText('x'.repeat(320), 300);
  assert.equal(long.title.length, 300);
  assert.equal(long.notes.length, 320, 'the whole line is kept in the notes');
});

test('a call’s next step: title and date together; the relationship sets account and business; guessed from the call', () => {
  const rels = [
    { id: 'r1', account_id: 'a1', business_id: W, status: 'active' },
    { id: 'r2', account_id: 'a2', business_id: BUSINESS_IDS.agency, status: 'active' },
    { id: 'r3', account_id: 'a2', business_id: BUSINESS_IDS.agency, status: 'active' },
    { id: 'r4', account_id: 'a1', business_id: BUSINESS_IDS.consulting, status: 'ended' },
  ];
  const ctx = { clientId: 'c1', me: 'partner', relationshipsById: new Map(rels.map((r) => [r.id, r])), fallbackBusiness: PERSONAL };
  assert.deepEqual(nextStepFields({ title: ' ', date: '' }, ctx), { fields: null, problems: {} }, 'no next step');
  assert.deepEqual(Object.keys(nextStepFields({ title: 'Send samples', date: '' }, ctx).problems), ['date']);
  assert.deepEqual(Object.keys(nextStepFields({ title: '', date: TODAY }, ctx).problems), ['title']);
  assert.deepEqual(nextStepFields({ title: 'Send samples', date: '2026-10-09', relationshipId: 'r1', accountId: 'a2', businessId: BUSINESS_IDS.agency }, ctx).fields, {
    title: 'Send samples', owner: 'partner', business_id: W, client_id: 'c1', account_id: 'a1', relationship_id: 'r1', due_date: '2026-10-09',
  });
  assert.deepEqual(nextStepFields({ title: 'Book a call', date: '2026-10-09', relationshipId: '', accountId: '', businessId: '' }, ctx).fields.business_id, PERSONAL);
  assert.equal(guessRelationship(rels, { accountId: 'a1', businessId: W }), 'r1');
  assert.equal(guessRelationship(rels, { accountId: 'a1' }), 'r1', 'the ended one doesn’t count');
  assert.equal(guessRelationship(rels, { accountId: 'a2' }), '', 'two on that account: the person picks');
  assert.equal(guessRelationship(rels, { accountId: 'a3' }), '', 'nothing matches the call: none');
  assert.equal(guessRelationship(rels, {}), '', 'several active, nothing picked: none');
  assert.equal(guessRelationship([rels[0]], {}), 'r1', 'the client’s only active relationship');
  // The guess failed (several active, nothing picked): the sheet warns, and the step falls back.
  assert.match(nextStepWarning({ title: 'Book a call', relationshipId: '', activeCount: 3 }), /won’t clear a “No next step” flag/);
  assert.equal(nextStepWarning({ title: 'Book a call', relationshipId: 'r1', activeCount: 3 }), null);
  assert.equal(nextStepWarning({ title: '', relationshipId: '', activeCount: 3 }), null, 'no next step typed: nothing to say');
  assert.equal(nextStepWarning({ title: 'Book a call', relationshipId: '', activeCount: 0 }), null, 'no relationships: nothing to clear');
});

// ---- the task form ----------------------------------------------------------------------------------------

test('the task form: a new task saves every field; an edit sends only what changed; the time goes with the date', () => {
  const fresh = taskValues(null, { today: TODAY, initial: { owner: 'owner', business_id: PERSONAL, title: 'Renew the domain' } });
  assert.equal(isDirty(fresh, { ...fresh }), false, 'pre-filled values are not "typed"');
  assert.deepEqual(taskForm.toFields(fresh).fields, {
    title: 'Renew the domain', notes: null, owner: 'owner', business_id: PERSONAL, client_id: null, account_id: null, relationship_id: null,
    goal_id: null, due_date: null, due_time: null, estimate_minutes: null, done_at: null, top_on_owner: null,
  });
  // A record pulled before C4b has no goal_id at all: opening and saving it doesn't send one.
  const old = taskValues({ id: 't0', title: 'Old', owner: 'owner', business_id: W }, { today: TODAY });
  assert.deepEqual(editChanges(taskForm, old, { ...old, title: 'Old task' }).fields, { title: 'Old task' });
  assert.ok(!('top_on_partner' in taskForm.toFields(fresh).fields), 'only the maker’s own pick field');
  assert.deepEqual(Object.keys(taskForm.toFields({ ...fresh, title: ' ', business_id: '' }).problems).sort(), ['business_id', 'title']);
  assert.deepEqual(Object.keys(taskForm.toFields({ ...fresh, due_time: '09:00' }).problems), ['due_time']);
  assert.deepEqual(Object.keys(taskForm.toFields({ ...fresh, estimate: '2.5' }).problems), ['estimate']);

  const record = {
    id: 't', title: 'Pack the order', notes: null, owner: 'owner', business_id: W, client_id: 'c1', account_id: null, relationship_id: null,
    due_date: TODAY, due_time: '10:00', estimate_minutes: 30, done_at: null, top_on_owner: '2026-10-06',
  };
  const start = taskValues(record, { today: TODAY });
  assert.equal(start.estimate, '30');
  assert.equal(start.top, false, 'yesterday’s pick isn’t today’s');
  assert.deepEqual(editChanges(taskForm, start, start), { fields: {}, problems: {} });
  assert.deepEqual(editChanges(taskForm, start, { ...start, owner: 'partner' }).fields, { owner: 'partner' }, 'the handoff is one field');
  assert.deepEqual(editChanges(taskForm, start, { ...start, top: true }).fields, { top_on_owner: TODAY });
  assert.deepEqual(editChanges(taskForm, start, { ...start, estimate: '45' }).fields, { estimate_minutes: 45 });
  const cleared = linkChange(start, 'due_date', '', { accountsById: new Map(), relationshipsById: new Map() });
  assert.deepEqual(editChanges(taskForm, start, cleared).fields, { due_date: null, due_time: null }, 'clearing the date clears the time');
  const done = editChanges(taskForm, start, { ...start, done: true }).fields;
  assert.deepEqual(Object.keys(done), ['done_at']);
  assert.match(done.done_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  // Ticked today: unticking clears it.
  const top = taskValues({ ...record, top_on_owner: TODAY }, { today: TODAY });
  assert.equal(top.top, true);
  assert.deepEqual(editChanges(taskForm, top, { ...top, top: false }).fields, { top_on_owner: null });
});

test('the task form keeps client, account and relationship consistent', () => {
  const accountsById = new Map([['a1', { id: 'a1', client_id: 'c1' }], ['a2', { id: 'a2', client_id: 'c2' }]]);
  const relationshipsById = new Map([['r1', { id: 'r1', account_id: 'a1', business_id: BUSINESS_IDS.agency }]]);
  const look = { accountsById, relationshipsById };
  const v = { client_id: '', account_id: '', relationship_id: '', business_id: PERSONAL, due_date: '', due_time: '' };
  const withRel = linkChange(v, 'relationship_id', 'r1', look);
  assert.deepEqual([withRel.client_id, withRel.account_id, withRel.business_id], ['c1', 'a1', BUSINESS_IDS.agency]);
  const otherClient = linkChange(withRel, 'client_id', 'c2', look);
  assert.deepEqual([otherClient.account_id, otherClient.relationship_id], ['', '']);
  const otherAccount = linkChange(withRel, 'account_id', 'a9', look);
  assert.equal(otherAccount.relationship_id, '');
});

test('top picks are per person: one person’s star on a shared task never fills the other’s three', () => {
  const shared = task({ title: 'Water the office plants', owner: 'shared', due_date: TODAY });
  const mine = [1, 2, 3].map((n) => task({ title: `Owner pick ${n}`, top_on_owner: TODAY }));
  const theirs = task({ title: 'Partner undated', owner: 'partner' });
  const tasks = [shared, ...mine, theirs];
  // The owner picks the shared task too: four picks would be over the limit, but the partner sees none.
  Object.assign(shared, topChange(shared, TODAY, true, 'owner'));
  assert.equal(buildToday({ tasks, me: 'owner', today: TODAY }).topCount, 4);
  const p = buildToday({ tasks, me: 'partner', today: TODAY });
  assert.equal(p.topCount, 0, 'the owner’s picks are the owner’s');
  assert.deepEqual(p.picked, [], 'and don’t show up as the partner’s');
  // The partner picks the same shared task and their own: only their field changes.
  assert.deepEqual(topChange(shared, TODAY, true, 'partner'), { top_on_partner: TODAY });
  Object.assign(shared, topChange(shared, TODAY, true, 'partner'));
  Object.assign(theirs, topChange(theirs, TODAY, true, 'partner'));
  assert.equal(shared.top_on_owner, TODAY, 'the owner’s pick stays');
  const p2 = buildToday({ tasks, me: 'partner', today: TODAY });
  assert.equal(p2.topCount, 2);
  assert.deepEqual(titles(p2.picked), ['Partner undated']);
  assert.ok(isTop(shared, TODAY, 'partner') && isTop(shared, TODAY, 'owner'));
  assert.equal(planLoad({ tasks: [task({ title: 'x', estimate_minutes: 60, top_on_partner: TODAY })], me: 'owner', today: TODAY }).count, 0,
    'the partner’s pick isn’t on my day');
  // Moving a shared task clears only the mover's pick; unticking in the form likewise.
  assert.deepEqual(moveChange(shared, '2026-10-08', TODAY, 'partner').change, { due_date: '2026-10-08', top_on_partner: null });
  const start = taskValues(shared, { today: TODAY, me: 'partner' });
  assert.equal(start.top, true);
  assert.deepEqual(editChanges(taskForm, start, { ...start, top: false }).fields, { top_on_partner: null });
  assert.equal(taskValues(shared, { today: TODAY, me: 'owner' }).top, true);
});

test('the capture field keeps what is typed while the last item saves, and puts the text back if saving fails', async () => {
  let field = 'Call the sign maker';
  const setText = (v) => { field = typeof v === 'function' ? v(field) : v; };
  // Typing the next thought while the first one is being saved.
  const ok = await saveCapture(field, { setText, save: async () => { assert.equal(field, ''); field += 'Book the dentist'; } });
  assert.equal(ok, true);
  assert.equal(field, 'Book the dentist', 'not wiped when the save finishes');
  // A failed save restores the text when the field is still empty…
  field = 'Order labels';
  await assert.rejects(saveCapture(field, { setText, save: async () => { throw new Error('storage_full'); } }));
  assert.equal(field, 'Order labels');
  // …and never overwrites something typed since.
  field = 'Order labels';
  await assert.rejects(saveCapture(field, { setText, save: async () => { field = 'New thought'; throw new Error('x'); } }));
  assert.equal(field, 'New thought');
});
