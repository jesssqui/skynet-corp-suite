// The Sales page's and the WooCommerce cards' words (D12): period figures per currency, a store's state, the order
// lookup box (number or email), WooCommerce statuses, an order's money lines, the Add a store form's own checks,
// connection ids → store ids, and the prefix panels on Connections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodText, ordersText, stateText, updatedText, lookupQuery, orderStatus, trackingText, orderMoneyLines, addStoreProblem, backfillText, monthText, parseAmount, monthLine } from '../src/modules/sales/logic.js';
import { storeIdOf, businessChoices, KEY_STEPS, READ_ONLY_NOTE } from '../src/modules/woocommerce/logic.js';
import { registerConnectionPanel, connectionPanel } from '../src/modules/connections/panels.js';

const KEY = `ck_${'0123456789'.repeat(4)}`;
const SECRET = `cs_${'abcdef0123'.repeat(4)}`;

test('periodText / ordersText: total sales per currency (never added across), orders counted', () => {
  assert.equal(periodText([]), '$0');
  assert.equal(periodText(undefined), '$0');
  assert.equal(periodText([{ currency: 'CAD', total: 123450, net: 1, orders: 3 }]), '$1,234.50', 'D13: total sales is the headline');
  assert.match(periodText([{ currency: 'CAD', total: 1000, orders: 1 }, { currency: 'USD', total: 500, orders: 2 }]), /^\$10 \+ .*5 USD$/);
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
  assert.match(backfillText({ backfill: { error: 'The store didn’t answer within 20 s', chunkDays: 45, before: '2026-05-01' } }), /didn’t answer.*45 days at a time \(back to 2026-05-01/);
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

test('D13: months — their names, amounts typed, and which figure a month shows', () => {
  assert.equal(monthText('2026-10'), 'October 2026');
  assert.equal(parseAmount('$1,234.56'), 123456);
  assert.equal(parseAmount('1234'), 123400);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('-3'), null);
  assert.equal(parseAmount('1.234'), null);
  assert.equal(parseAmount(''), null);
  assert.deepEqual(monthLine({ shown: 'real', real: [{ currency: 'CAD', total: 7000 }], replaced: true }), { figure: '$70', from: 'From eBay (replaces the month entered by hand)' });
  assert.deepEqual(monthLine({ shown: 'manual', manual: { currency: 'CAD', total: 123456, orders: 31 } }), { figure: '$1,234.56', from: 'Entered by hand · 31 orders' });
  assert.deepEqual(monthLine({ shown: null }), { figure: '—', from: 'Nothing yet' });
  assert.match(monthLine({ shown: 'real', partial: true, real: [{ currency: 'CAD', total: 500 }] }).from, /Read in part.*enter the month by hand/);
  assert.match(monthLine({ shown: 'real', partial: true, replaced: true, real: [{ currency: 'CAD', total: 500 }] }).from, /replaced: save it again/);
  assert.match(monthLine({ shown: 'manual', partial: true, manual: { currency: 'CAD', total: 900, orders: null } }).from, /Entered by hand \(eBay read it only in part\)/);
  assert.match(stateText({ state: 'not_set_up' }).text, /enter a month by hand/);
  assert.equal(stateText({ state: 'signed_out' }).tone, 'danger');
});

test('D13b: the eBay breakdown — Items, Shipping, Before tax, Tax, Total after tax; a hand-entered period or month has its total only', async () => {
  const { BREAKDOWN_LINES, breakdownOf, periodBreakdown, monthBreakdown } = await import('../src/modules/sales/logic.js');
  assert.deepEqual(BREAKDOWN_LINES.map(([, l]) => l), ['Items', 'Shipping', 'Before tax', 'Tax', 'Total (after tax)']);
  // Sept's eBay days (server/test/ebay.test.js): net = total − tax − shipping, so Before tax = Items + Shipping = total − tax.
  const f = { currency: 'CAD', total: 9214, tax: 1014, shipping: 1000, net: 7200, orders: 1 };
  assert.deepEqual(breakdownOf(f), { items: 7200, shipping: 1000, beforeTax: 8200, tax: 1014, total: 9214 });
  assert.deepEqual(periodBreakdown([f]), [{ currency: 'CAD', lines: [['Items', '$72'], ['Shipping', '$10'], ['Before tax', '$82'], ['Tax', '$10.14'], ['Total (after tax)', '$92.14']] }]);
  // A refund-only day: negative, refunds off Items and their estimated tax.
  assert.deepEqual(periodBreakdown([{ currency: 'CAD', total: -3390, tax: -390, shipping: 0, net: -3000 }])[0].lines.map(([, v]) => v), ['-$30', '$0', '-$30', '-$3.90', '-$33.90']);
  // Nothing yet: zeros in CAD. Two currencies: each on its own, never added.
  assert.equal(periodBreakdown([])[0].lines.at(-1)[1], '$0');
  const two = periodBreakdown([f, { currency: 'USD', total: 1000, tax: 0, shipping: 0, net: 1000 }]);
  assert.deepEqual(two.map((p) => p.currency), ['CAD', 'USD']);
  // This month filled by a month entered by hand: total only, no breakdown (never eBay's lines beside a hand total).
  assert.equal(periodBreakdown([{ currency: 'CAD', total: 123456, tax: 0, shipping: 0, net: 0, orders: 31, totalOnly: true }]), null);
  // The months list: eBay's own month → its lines; a hand-entered month → total only; a replaced one → eBay's lines.
  assert.equal(monthBreakdown({ shown: 'real', real: [f] }), 'Items $72 · Shipping $10 · Before tax $82 · Tax $10.14');
  assert.equal(monthBreakdown({ shown: 'real', replaced: true, real: [f], manual: { total: 5, currency: 'CAD' } }), 'Items $72 · Shipping $10 · Before tax $82 · Tax $10.14');
  assert.equal(monthBreakdown({ shown: 'manual', real: [f], manual: { total: 99900, currency: 'CAD' }, partial: true }), 'Entered by hand: total only', 'eBay’s part-read days never lend their breakdown to a hand total');
  assert.equal(monthBreakdown({ shown: null, real: null }), '');
  assert.equal(monthBreakdown({ shown: 'real', real: [{ currency: 'CAD', total: 0, tax: 0, shipping: 0, net: 0 }] }), '', 'a month with no sales: no row of $0s');
  assert.match(monthBreakdown({ shown: 'real', real: [f, { currency: 'USD', total: 1000, tax: 0, shipping: 0, net: 1000 }] }), /^CAD: Items \$72 .* — USD: Items US\$10/);
});
