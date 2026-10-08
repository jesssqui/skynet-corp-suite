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
} from '../src/modules/wholesale/logic.js';

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
