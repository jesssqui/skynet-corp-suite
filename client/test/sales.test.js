// The Sales page's and the WooCommerce cards' words (D12): period figures per currency, a store's state, the order
// lookup box (number or email), WooCommerce statuses, an order's money lines, the Add a store form's own checks,
// connection ids → store ids, and the prefix panels on Connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodText, ordersText, stateText, updatedText, lookupQuery, orderStatus, trackingText, orderMoneyLines, addStoreProblem, backfillText } from '../src/modules/sales/logic.js';
import { storeIdOf, businessChoices, KEY_STEPS, READ_ONLY_NOTE } from '../src/modules/woocommerce/logic.js';
import { registerConnectionPanel, connectionPanel } from '../src/modules/connections/panels.js';

const KEY = `ck_${'0123456789'.repeat(4)}`;
const SECRET = `cs_${'abcdef0123'.repeat(4)}`;

test('periodText / ordersText: net sales per currency (never added across), orders counted', () => {
  assert.equal(periodText([]), '$0');
  assert.equal(periodText(undefined), '$0');
  assert.equal(periodText([{ currency: 'CAD', net: 123450, orders: 3 }]), '$1,234.50');
  assert.match(periodText([{ currency: 'CAD', net: 1000, orders: 1 }, { currency: 'USD', net: 500, orders: 2 }]), /^\$10 \+ .*5 USD$/);
  assert.equal(ordersText([{ orders: 1 }]), '1 order');
  assert.equal(ordersText([{ orders: 2 }, { orders: 3 }]), '5 orders');
  assert.equal(ordersText(undefined), '0 orders');
});

test('stateText / updatedText / backfillText', () => {
  assert.equal(stateText({ state: 'on' }), null);
  assert.equal(stateText({ state: 'paused' }).tone, 'warn');
  assert.match(stateText({ state: 'failing', lastError: 'The store answered 500' }).text, /answered 500/);
  assert.match(stateText({ state: 'removed' }).text, /removed/);
  assert.match(stateText({ state: 'unreadable' }).text, /replace the key/);
  assert.equal(updatedText({ lastFetchedAt: 'x' }, (s) => `[${s}]`), 'Updated [x]');
  assert.equal(updatedText({}, String), 'Not read yet');
  assert.equal(backfillText({ backfill: { doneAt: 'x', target: '2025-09-13' } }), 'Totals from 2025-09-13 on');
  assert.match(backfillText({ backfill: { before: '2026-05-01', target: '2025-09-13' } }), /back to 2026-05-01/);
  assert.equal(backfillText({ backfill: {} }), 'Older totals not read yet');
});

test('lookupQuery: an order number (with or without #) or an email; anything else is named', () => {
  assert.deepEqual(lookupQuery(''), { problem: '' });
  assert.deepEqual(lookupQuery(' #1042 '), { number: '1042' });
  assert.deepEqual(lookupQuery('TX-500'), { number: 'TX-500' });
  assert.deepEqual(lookupQuery(' Kim@Example.com '), { email: 'kim@example.com' });
  assert.match(lookupQuery('kim@').problem, /isn’t complete/);
  assert.match(lookupQuery('1042; drop').problem, /order number/);
});

test('orderStatus / trackingText / orderMoneyLines', () => {
  assert.deepEqual(orderStatus('on-hold'), { text: 'On hold', tone: 'warn' });
  assert.deepEqual(orderStatus('completed'), { text: 'Completed', tone: 'ok' });
  assert.deepEqual(orderStatus('awaiting-shipment'), { text: 'Awaiting shipment', tone: 'neutral' });
  assert.equal(trackingText({ provider: 'Canada Post', number: '7023', shippedOn: '2026-10-12' }), 'Canada Post 7023 · shipped 2026-10-12');
  assert.equal(trackingText({ provider: null, number: 'CP1' }), 'CP1');
  assert.deepEqual(orderMoneyLines({ currency: 'CAD', total: 3425, discount: 200, shipping: 800, tax: 325, refunded: 0 }),
    [['Discount', '−$2'], ['Shipping', '$8'], ['Tax', '$3.25'], ['Total', '$34.25']]);
  assert.deepEqual(orderMoneyLines({ currency: 'CAD', total: 1000, refunded: 1000 }), [['Total', '$10'], ['Refunded', '−$10']]);
});

test('addStoreProblem: https address, ck_/cs_ keys, and the Read confirmation', () => {
  const ok = { url: 'tinsxpress.com', key: KEY, secret: SECRET, confirmed: true };
  assert.equal(addStoreProblem(ok), null);
  assert.match(addStoreProblem({ ...ok, url: '' }), /address/);
  assert.match(addStoreProblem({ ...ok, url: 'http://tinsxpress.com' }), /https/);
  assert.equal(addStoreProblem({ ...ok, url: 'http://127.0.0.1:8080' }), null, 'a store on this machine (tests)');
  assert.match(addStoreProblem({ ...ok, key: 'ck_1' }), /consumer key/);
  assert.match(addStoreProblem({ ...ok, secret: KEY }), /consumer secret/);
  assert.match(addStoreProblem({ ...ok, confirmed: false }), /Read/);
  assert.match(READ_ONLY_NOTE, /doesn’t tell the suite/);
  assert.ok(KEY_STEPS.some((s) => /Permissions: Read/.test(s)));
});

test('storeIdOf / businessChoices / prefix panels', () => {
  assert.equal(storeIdOf('woo-01a1163c1a0470059cd7b9f83f986c43'), '01a1163c-1a04-7005-9cd7-b9f83f986c43');
  assert.equal(storeIdOf('woocommerce'), null);
  assert.equal(storeIdOf('woo-xyz'), null);
  assert.deepEqual(businessChoices([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', archived: true }]), [{ value: 'a', label: 'A' }]);
  assert.equal(businessChoices([{ id: 'b', name: 'B', archived: true }], 'b').length, 1);
  const Hub = () => null;
  const Store = () => null;
  registerConnectionPanel('test-hub', Hub);
  registerConnectionPanel('test-hub-*', Store);
  assert.equal(connectionPanel('test-hub'), Hub, 'exact id first');
  assert.equal(connectionPanel('test-hub-abc'), Store);
  assert.equal(connectionPanel('test-other'), null);
});
