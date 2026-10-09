// D1 on a device: the Order Manager's records (sent to the suite's receiver, linked to a client)
// are pulled like any CRM record, shown on the client's timeline beside its notes — filterable as
// Orders, by account and by our wholesale business — with the account's and client's figures, and
// still there offline. Devices can't write them. Plus the timeline/figure logic on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { startServer, makeDevice } from './helpers.js';
import { postEvents, sampleStream } from '../../server/test/fixtures/wom.js';
import { sessionFor } from '../../server/test/helpers.js';
import { cachedLists, lastActivityOf } from '../src/modules/crm/data.js';
import { reviewLastActivity } from '../src/modules/planner/data.js';
import { SyncError } from '../src/sync/engine.js';
import { filterTimeline } from '../src/modules/crm/logic.js';
import {
  wholesaleItems, activityItem, sumCards, orderItem, entryItem, lastOrderByClient, mergeLastActivity,
  isQuietRegular, quietRegularText, quietFromByClient, daysBetween, noteItem, nextFollowUp, NOTE_LABELS,
} from '../src/modules/wholesale/logic.js';
import { buildClientIndex } from '../src/modules/crm/logic.js';
import { womKit } from '../../server/test/fixtures/wom.js';
import { localDate } from '@suite/shared/time';
import { addDays } from '@suite/shared/planner';

test('a device pulls a linked customer’s orders, payments, returns and refunds and shows them on the timeline, offline too', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const secret = server.ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const phone = await makeDevice(t, server, 'partner');
  const e = phone.engine;

  // The client and its account are made on the phone; the owner links the Order Manager customer.
  const clientId = await e.create('client', { name: 'Lefty’s', status: 'active' });
  const vape = await e.create('account', { client_id: clientId, name: 'Lefty’s Vape Shop' });
  const parent = await e.create('account', { client_id: clientId, name: 'Lefty Holdings' });
  await e.create('activity', { client_id: clientId, account_id: parent, type: 'note', body: 'Met at the trade show', at: '2026-09-01T15:00:00.000Z' });
  await e.syncNow();
  const { events, customer } = sampleStream();
  const posted = await postEvents(server.base, secret, events);
  assert.equal(posted.status, 200);
  const res = await fetch(`${server.base}/api/wholesale/customers/${customer.customer_uid}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, cookie: sessionFor(server.ctx, server.users.owner).cookie },
    body: JSON.stringify({ clientId, accountId: vape }),
  });
  assert.equal(res.status, 200);

  await e.syncNow();
  const [orders, entries, cards, activities, accounts] = await cachedLists(e, ['wholesale_order', 'wholesale_entry', 'wholesale_customer', 'activity', 'account']);
  assert.equal(orders.where('client_id', clientId).length, 5);
  assert.equal(entries.where('client_id', clientId).length, 8);
  assert.equal(cards.records.length, 1);
  // The account the phone made is age-restricted now (set by the suite when it was linked).
  assert.equal(accounts.byId().get(vape).age_restricted, true);

  // The timeline: its note and the Order Manager's 13 records in one list, newest first.
  const items = [...activities.where('client_id', clientId).map(activityItem), ...wholesaleItems(orders.where('client_id', clientId), entries.where('client_id', clientId))];
  const all = filterTimeline(items, {});
  assert.equal(all.length, 14);
  assert.equal(all.at(-1).source, 'activity', 'the oldest: the note');
  assert.equal(filterTimeline(items, { type: 'order' }).length, 13, 'Orders');
  assert.equal(filterTimeline(items, { business: BUSINESS_IDS.wholesale }).length, 13, 'our wholesale business');
  assert.equal(filterTimeline(items, { account: vape }).length, 13, 'their vape shop');
  assert.equal(filterTimeline(items, { account: parent }).length, 1, 'their holding company: the note');
  const o3 = all.find((x) => x.source === 'wholesale_order' && x.record.status === 'cancelled');
  assert.deepEqual([o3.status, o3.struck], ['Cancelled', true]);
  const shipped = all.find((x) => x.source === 'wholesale_order' && x.record.packing === 'shipped');
  assert.match(shipped.title, /^Order #1$/);
  assert.equal(shipped.facts, '$113 · paid · $7.91 given back');
  assert.equal(shipped.body, '10 × Zyn Cool Mint 6mg, 5 × ALP Mango (15 units)');
  assert.equal(shipped.packing, 'Gone out');

  // The account's (and client's) figures.
  const f = sumCards(cards.where('account_id', vape));
  assert.deepEqual([f.orders, f.spendCents, f.paidCents, f.creditCents, f.lastOrderDate], [4, 12458, 13673, 1130, '2026-10-05']);
  // The client list's "last activity" counts its latest order.
  const last = mergeLastActivity(lastActivityOf(activities), lastOrderByClient(orders.records));
  assert.equal(last.get(clientId), orders.where('client_id', clientId).map((o) => o.at).sort().at(-1));
  // …and so does the Friday review's "quiet clients" (the same rule as the server's automation).
  assert.equal(reviewLastActivity(activities, orders).get(clientId), last.get(clientId));

  // Offline: everything is still there (the device's own copy).
  phone.online = false;
  const again = await e.listMany(['wholesale_order', 'wholesale_entry']);
  assert.equal(again.wholesale_order.length + again.wholesale_entry.length, 13);
  phone.online = true;

  // A device can't write them: /info says they are read-only, so the store refuses at once (the
  // server would too) and /sync/data offers no add, edit or delete.
  assert.equal(e.definition('wholesale_entry').readOnly, true);
  assert.equal(e.definition('wholesale_entry').ops.size, 0);
  await assert.rejects(
    e.create('wholesale_entry', { account_id: vape, client_id: clientId, customer_uid: customer.customer_uid, uid: customer.customer_uid, kind: 'payment', at: '2026-10-06T12:00:00.000Z', status: 'live' }),
    (err) => err instanceof SyncError && err.code === 'op_not_allowed',
  );
  const someOrder = orders.where('client_id', clientId)[0];
  await assert.rejects(e.update('wholesale_order', someOrder.id, { total_cents: 1 }), (err) => err.code === 'op_not_allowed');
  await assert.rejects(e.remove('wholesale_order', someOrder.id), (err) => err.code === 'op_not_allowed');
});

test('timeline items and figures, on their own', () => {
  const o = orderItem({ id: 'x', account_id: 'a', at: '2026-10-01T12:00:00.000Z', order_date: '2026-10-01', number: 7, reference: 'PO-9', status: 'deleted', history_only: true, total_cents: 2260, paid_cents: 1000, returned_cents: 0, items: '2 × Zyn', item_count: 2, packing: 'history' });
  assert.deepEqual([o.title, o.facts, o.status, o.packing, o.struck, o.type, o.business_id], ['Past order #7 · PO-9', '$22.60 · $10 paid', 'Deleted in the Order Manager', null, true, 'order', BUSINESS_IDS.wholesale]);
  const moved = entryItem({ id: 'y', kind: 'payment', amount_cents: 4520, method: 'etransfer', order_number: 7, status: 'removed', removed_reason: 'order_deleted', moved_to: 'store_credit' });
  assert.deepEqual([moved.title, moved.facts, moved.status, moved.struck], ['Payment', '$45.20 · e-Transfer · order #7', 'Kept as store credit when its order was deleted', true]);
  const used = entryItem({ id: 'z', kind: 'credit_applied', amount_cents: -500, status: 'live' });
  assert.deepEqual([used.title, used.facts, used.status], ['Store credit used', '$5', null]);
  assert.equal(entryItem({ kind: 'credit_note', number: 'CN-0002', amount_cents: 1130, status: 'live' }).title, 'Credit note CN-0002');
  assert.equal(sumCards([]), null);
  assert.deepEqual(sumCards([
    { order_count: 2, spend_cents: 100, paid_cents: 50, credit_cents: 0, last_order_date: '2026-01-02', first_order_date: '2025-01-01', gone: false },
    { order_count: 1, spend_cents: 10, paid_cents: 0, credit_cents: 5, last_order_date: '2026-03-01', first_order_date: '2026-03-01', gone: true },
  ]), { customers: 2, orders: 3, spendCents: 110, paidCents: 50, creditCents: 5, lastOrderDate: '2026-03-01', firstOrderDate: '2025-01-01', gone: false });
  const m = mergeLastActivity(new Map([['c1', '2026-01-01T00:00:00.000Z']]), new Map([['c1', '2026-02-01T00:00:00.000Z'], ['c2', '2026-01-05T00:00:00.000Z']]));
  assert.deepEqual([...m], [['c1', '2026-02-01T00:00:00.000Z'], ['c2', '2026-01-05T00:00:00.000Z']]);
});

// ---- D3: the "Quiet regular" flag ---------------------------------------------------------------

test('quiet regular: the card’s quiet_from against the device’s today; per client the earliest; deleted customers never', () => {
  const card = { id: 'c1', client_id: 'k1', usual_gap_days: 14, quiet_from: '2026-10-04', last_order_date: '2026-09-12', gone: false };
  assert.equal(isQuietRegular(card, '2026-10-03'), false);
  assert.equal(isQuietRegular(card, '2026-10-04'), true);
  assert.equal(quietRegularText(card, '2026-10-14'), 'Usually orders every 14 days; none for 32');
  assert.equal(quietRegularText(card, '2026-10-01'), null);
  assert.equal(isQuietRegular({ ...card, gone: true }, '2026-10-14'), false, 'deleted in the Order Manager');
  assert.equal(isQuietRegular({ ...card, quiet_from: null, usual_gap_days: null }, '2026-10-14'), false, 'not a regular');
  const m = quietFromByClient([card, { ...card, id: 'c2', quiet_from: '2026-10-01' }, { ...card, id: 'c3', client_id: 'k2', gone: true }]);
  assert.deepEqual([...m], [['k1', '2026-10-01']]);
  const index = buildClientIndex({ clients: [{ id: 'k1', name: 'A', status: 'active' }, { id: 'k2', name: 'B', status: 'active' }], quietFrom: m });
  assert.deepEqual(index.map((r) => [r.client.id, r.quietFrom]), [['k1', '2026-10-01'], ['k2', null]]);
  const closed = buildClientIndex({ clients: [{ id: 'k1', name: 'A', status: 'closed' }], quietFrom: m });
  assert.equal(closed[0].quietFrom, null, 'never on a closed client (check-ins skip them too)');
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2);
});

test('a device gets the quiet-regular flag for a regular past their usual gap, and loses it after a new order', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const secret = server.ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const mac = await makeDevice(t, server, 'owner');
  const e = mac.engine;
  const clientId = await e.create('client', { name: 'Corner Store', status: 'active' });
  const accountId = await e.create('account', { client_id: clientId, name: 'Corner Store' });
  await e.syncNow();
  // A weekly regular whose last order was 30 days ago (quiet after 14 days).
  const today = localDate();
  const om = womKit();
  const c = om.customer({ business_name: 'Corner Store' });
  const order = (d) => om.order(c, [{ name: 'Zyn', quantity: 1, unit_price_cents: 500 }], { order_date: d });
  const days = [51, 44, 37, 30].map((n) => addDays(today, -n));
  assert.equal((await postEvents(server.base, secret, [om.customerCreated(c), ...days.map((d) => om.orderPlaced(order(d)))])).status, 200);
  const res = await fetch(`${server.base}/api/wholesale/customers/${c.customer_uid}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base, cookie: sessionFor(server.ctx, server.users.owner).cookie },
    body: JSON.stringify({ clientId, accountId }),
  });
  assert.equal(res.status, 200);
  await e.syncNow();
  let [cards] = await cachedLists(e, ['wholesale_customer']);
  let [card] = cards.records;
  assert.deepEqual([card.usual_gap_days, card.quiet_from], [7, addDays(today, -30 + 14 + 1)]);
  assert.equal(isQuietRegular(card, today), true);
  assert.equal(quietFromByClient(cards.records).get(clientId), card.quiet_from, 'the client list row');
  // A new order today: the card is sent again with quiet_from moved on — no flag.
  assert.equal((await postEvents(server.base, secret, [om.orderPlaced(order(today))])).status, 200);
  await e.syncNow();
  [cards] = await cachedLists(e, ['wholesale_customer']);
  [card] = cards.records;
  assert.equal(card.last_order_date, today);
  assert.equal(isQuietRegular(card, today), false);
  assert.equal(card.quiet_from, addDays(today, 15));
});

// ---- D5: notes and follow-ups from the Order Manager -------------------------------------------------

test('notes as timeline items: their own type (a follow-up done under Notes), business wholesale, who wrote it; the next follow-up', () => {
  const call = noteItem({ id: 'n1', account_id: 'a', type: 'call', body: 'Wants 3mg', at: '2026-10-01T14:00:00.000Z', written_by: 'sam' });
  assert.deepEqual([call.source, call.type, call.title, call.body, call.by, call.business_id, call.struck], ['wholesale_note', 'call', 'Call', 'Wants 3mg', 'sam', BUSINESS_IDS.wholesale, false]);
  const done = noteItem({ id: 'n2', account_id: 'a', type: 'follow_up', body: 'Followed up', at: '2026-10-02T14:00:00.000Z', written_by: null });
  assert.deepEqual([done.type, done.title, done.by], ['note', NOTE_LABELS.follow_up, null]);
  assert.equal(NOTE_LABELS.follow_up, 'Follow-up done');
  const items = [...wholesaleItems([], [], [{ id: 'n1', account_id: 'a', type: 'call', body: 'x', at: '2026-10-01T14:00:00.000Z' }, { id: 'n2', account_id: 'b', type: 'follow_up', body: 'y', at: '2026-10-02T14:00:00.000Z' }]),
    activityItem({ id: 'mine', client_id: 'k', type: 'note', body: 'mine', at: '2026-09-01T00:00:00.000Z' })];
  assert.deepEqual(filterTimeline(items, { type: 'note' }).map((x) => x.id), ['n2', 'mine'], 'Notes: a follow-up done there and our own');
  assert.deepEqual(filterTimeline(items, { type: 'call' }).map((x) => x.id), ['n1']);
  assert.deepEqual(filterTimeline(items, { business: BUSINESS_IDS.wholesale }).map((x) => x.id), ['n2', 'n1']);
  assert.deepEqual(filterTimeline(items, { account: 'b' }).map((x) => x.id), ['n2']);
  assert.equal(nextFollowUp([]), null);
  assert.equal(nextFollowUp([{ follow_up_date: '2026-10-20' }, { follow_up_date: '2026-10-12', gone: true }, { follow_up_date: '2026-10-15' }, { follow_up_date: null }]), '2026-10-15');
});

test('a device pulls a linked customer’s notes and follow-up: on the timeline, offline too; a deleted note goes; unlinking takes them off', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const secret = server.ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const phone = await makeDevice(t, server, 'partner');
  const e = phone.engine;
  const clientId = await e.create('client', { name: 'Lefty’s', status: 'active' });
  const accountId = await e.create('account', { client_id: clientId, name: 'Lefty’s Vape Shop' });
  await e.create('activity', { client_id: clientId, type: 'note', body: 'Our own note', at: '2026-09-01T15:00:00.000Z' });
  await e.syncNow();
  const om = womKit();
  const c = om.customer();
  const call = om.note(c, { type: 'call', body: 'Asked about Velo', at: '2026-10-01T14:00:00.000Z', written_by: 'sam' });
  const email = om.note(c, { type: 'email', body: 'Sent the price list', at: '2026-10-03T14:00:00.000Z' });
  assert.equal((await postEvents(server.base, secret, [om.customerCreated(c), om.noteAdded(call), om.noteAdded(email), om.followUpChanged(c, '2026-10-20')])).status, 200);
  const owner = sessionFor(server.ctx, server.users.owner).cookie;
  const post = (path) => fetch(`${server.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, cookie: owner }, body: JSON.stringify({ clientId, accountId }) });
  assert.equal((await post(`/api/wholesale/customers/${c.customer_uid}/link`)).status, 200);
  await e.syncNow();
  let [notes, activities, cards, tasks] = await cachedLists(e, ['wholesale_note', 'activity', 'wholesale_customer', 'task']);
  assert.equal(notes.where('client_id', clientId).length, 2);
  const items = [...activities.where('client_id', clientId).map(activityItem), ...wholesaleItems([], [], notes.where('client_id', clientId))];
  assert.deepEqual(filterTimeline(items, {}).map((x) => x.body), ['Sent the price list', 'Asked about Velo', 'Our own note']);
  assert.equal(nextFollowUp(cards.records), '2026-10-20', 'the account card’s next follow-up');
  assert.deepEqual(tasks.records.filter((x) => /^Follow up with/.test(x.title)).map((x) => [x.due_date, x.client_id]), [['2026-10-20', clientId]]);
  // The list's and the review's "last activity" count the notes.
  assert.equal(reviewLastActivity(activities, (await cachedLists(e, ['wholesale_order']))[0], notes).get(clientId), '2026-10-03T14:00:00.000Z');
  // Offline: still there.
  phone.online = false;
  assert.equal((await e.listMany(['wholesale_note'])).wholesale_note.length, 2);
  phone.online = true;
  // Read-only on devices.
  assert.equal(e.definition('wholesale_note').readOnly, true);
  await assert.rejects(e.update('wholesale_note', notes.records[0].id, { body: 'x' }), (err) => err instanceof SyncError && err.code === 'op_not_allowed');
  // Deleted there → gone from the device.
  assert.equal((await postEvents(server.base, secret, [om.noteDeleted(call)])).status, 200);
  await e.syncNow();
  [notes] = await cachedLists(e, ['wholesale_note']);
  assert.deepEqual(notes.records.map((n) => n.body), ['Sent the price list']);
  // Unlinked → off the device; the follow-up task is finished.
  assert.equal((await post(`/api/wholesale/customers/${c.customer_uid}/unlink`)).status, 200);
  await e.syncNow();
  [notes, tasks] = await cachedLists(e, ['wholesale_note', 'task']);
  assert.equal(notes.records.length, 0);
  assert.ok(tasks.records.find((x) => /^Follow up with/.test(x.title)).done_at);
});
