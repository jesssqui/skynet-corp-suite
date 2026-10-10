// The overview's words (D11): each section's items as lines with a link to where they are dealt with, its state when it
// can't be read (not connected, paused, Stockroom not read…), counts and summaries, paging ("Show N more", "and N
// more"), the headline total (with this device's own changes it couldn't save), and the sales tiles' notes; and the
// words of sales entered by hand (the form, its checks, the body sent, amounts that count down).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import {
  SECTIONS, itemLine, stateNote, countText, summaryText, shownCount, moreText, restText, attentionTotal, totalOnlyNote, storesNote,
  FIRST_ITEMS, MORE_ITEMS, UNMATCHED_MISSING, unmatchedLine, suggestedLine, URGENT,
} from '../src/modules/overview/logic.js';
import {
  newEntryForm, entryToForm, entryProblem, entryBody, entryAmountText, sumsText, KIND_OPTIONS, stateText,
} from '../src/modules/sales/logic.js';

const date = (d) => `[${d}]`;

test('every section has a title, a link (when there is a page for it) and words for "nothing"', () => {
  assert.deepEqual(Object.keys(SECTIONS), ['overdue', 'balances', 'renewals', 'lowStock', 'support', 'payments', 'noNextStep', 'quiet']);
  for (const [id, s] of Object.entries(SECTIONS)) {
    assert.ok(s.title, id);
    if (id !== 'support') assert.ok(s.link?.startsWith('/') && s.empty, id);
  }
  assert.equal(SECTIONS.lowStock.link, `/tasks?business=${BUSINESS_IDS.wholesale}`);
});

test('item lines: overdue tasks, balances, renewals, low stock, payments, no next step, quiet clients', () => {
  assert.deepEqual(itemLine('overdue', { id: 't1', title: 'Call the accountant', whose: 'partner', dueDate: '2026-10-10', dueTime: null, business: 'Personal' }, { date }), {
    key: 't1', text: 'Call the accountant', link: '/tasks?open=t1', tone: 'danger', detail: 'Due [2026-10-10] · Your partner’s · Personal',
  });
  assert.equal(itemLine('overdue', { id: 't2', title: 'x', whose: 'shared', dueDate: '2026-10-10', dueTime: '09:30' }, { date }).detail, 'Due [2026-10-10] 09:30 · Shared list');
  const bal = itemLine('balances', { id: 'c1', name: 'Northwind', overdueCents: 12690, orders: 2, oldestDate: '2026-08-30', clientId: 'cl1' }, { date });
  assert.deepEqual([bal.text, bal.link, bal.detail], ['Northwind: $126.90', '/crm/clients/cl1', '2 orders over 30 days · the oldest from [2026-08-30]']);
  assert.equal(itemLine('balances', { id: 'c2', name: 'Bay', overdueCents: 100, orders: 1, oldestDate: '2026-08-30', clientId: null }, { date }).link, '/wholesale');
  const svc = itemLine('renewals', { kind: 'service', id: 's1', name: 'Hosting', accountName: 'Lefty’s', clientId: 'cl1', date: '2026-10-24', amountCents: 48000, period: 'yearly', business: 'Great White North Design' }, { date });
  assert.deepEqual([svc.text, svc.link, svc.detail], ['Hosting for Lefty’s', '/crm/clients/cl1', 'Renews [2026-10-24] · $480/yr · Great White North Design']);
  const cost = itemLine('renewals', { kind: 'cost', id: 'k1', name: 'Domain', date: '2026-10-19', amountCents: 2000, currency: 'USD', period: 'yearly', autoRenews: true }, { date });
  assert.deepEqual([cost.text, cost.link, cost.detail], ['Domain (our cost)', '/costs?open=k1', 'Renews [2026-10-19] · US$20 USD/yr · on its own']);
  const low = itemLine('lowStock', { id: 'ZYN', sku: 'ZYN', name: 'Zyn Cool Mint', suggestedQty: 50, daysLeft: 3.4, runsOutOn: '2026-10-17', supplier: 'Swedish Match' }, { date });
  assert.deepEqual([low.text, low.detail, low.tone, low.link], ['Zyn Cool Mint (ZYN)', 'Order 50 tins · 3 days left (runs out [2026-10-17]) · Swedish Match', 'danger', null]);
  assert.equal(itemLine('lowStock', { id: 'x', name: 'Out', suggestedQty: 1, daysLeft: null, status: 'out' }, { date }).detail, 'Order 1 tin · out of stock');
  const pay = itemLine('payments', { id: 'c3', name: 'Bayview', unusedCents: 5000, clientId: null, lastPaymentAt: '2026-09-20T15:00:00.000Z' }, { date });
  assert.equal(pay.text, 'Bayview: $50 paid beyond every order');
  assert.equal(pay.link, '/wholesale', 'not linked: the Wholesale page (its Waiting tab)');
  assert.match(pay.detail, /last paid \[2026-09-20\].*not linked to a client/);
  assert.equal(unmatchedLine(null), null);
  assert.deepEqual(unmatchedLine({ count: 0, at: '2026-10-09T12:00:00.000Z' }, { date }), { text: 'No e-Transfers waiting unmatched in the Order Manager', detail: 'as of [2026-10-09]', tone: null });
  const u = { count: 3, totalCents: 45000, oldestAt: '2026-10-02T13:00:00.000Z', page: '/customers/etransfers', at: '2026-10-09T12:00:00.000Z', suggestedCount: 2, suggestedTotalCents: 7000 };
  assert.deepEqual(unmatchedLine(u, { date }), {
    text: '3 e-Transfers with no matching order in the Order Manager: $450',
    detail: 'Record or dismiss them there: Customers → E-transfers (/customers/etransfers) · the oldest from [2026-10-02] · as of [2026-10-09]', tone: 'danger',
  });
  assert.equal(suggestedLine(u), '2 more with a suggested match waiting to be recorded there ($70)');
  assert.equal(suggestedLine({ ...u, suggestedCount: 0 }), '');
  assert.equal(suggestedLine({ ...u, suggestedCount: null }), '', 'an older Order Manager sends none');
  assert.deepEqual(unmatchedLine({ ...u, stopped: true }, { date }), {
    text: 'The Order Manager stopped sending its unmatched e-Transfer count (switched off there)', detail: 'Last count 3 on [2026-10-09]', tone: null,
  });
  assert.equal(suggestedLine({ ...u, stopped: true }), '');
  assert.deepEqual(itemLine('noNextStep', { kind: 'lead', id: 'l1', name: 'Maple Dental', stage: 'talking', business: 'GWND' }), { key: 'lead:l1', text: 'Lead: Maple Dental', link: '/crm/leads/l1', detail: 'GWND · Talking' });
  assert.deepEqual(itemLine('noNextStep', { kind: 'relationship', id: 'r1', accountName: 'Lefty’s Vape Shop', clientId: 'cl1', clientName: 'Lefty’s', business: 'GWND' }).detail, 'GWND · Lefty’s');
  assert.equal(itemLine('quiet', { id: 'cl1', name: 'Lefty’s', since: '2026-07-01' }, { date }).detail, 'Nothing since [2026-07-01]');
  assert.equal(itemLine('quiet', { id: 'cl2', name: 'New', since: null }, { date }).detail, 'Nothing logged yet');
});

test('states: not connected (the helpdesk names D14), paused, not read, revoked, an error', () => {
  assert.equal(stateNote({ id: 'overdue', state: 'ok' }), null);
  assert.equal(stateNote({ id: 'support', state: 'not_connected', comesWith: 'the helpdesk (D14)' }), 'Not connected yet · comes with the helpdesk (D14).');
  assert.match(stateNote({ id: 'balances', state: 'not_connected' }), /Order Manager is set up on System → Connections/);
  assert.match(stateNote({ id: 'lowStock', state: 'not_connected' }), /Stockroom is set up/);
  assert.match(stateNote({ id: 'payments', state: 'paused' }), /last figures it sent/);
  assert.match(stateNote({ id: 'lowStock', state: 'paused' }), /last answer/);
  assert.match(stateNote({ id: 'lowStock', state: 'not_read' }), /hasn’t been read/);
  assert.match(stateNote({ id: 'lowStock', state: 'revoked' }), /new code/);
  assert.match(stateNote({ id: 'quiet', state: 'error' }), /try again/);
  assert.match(UNMATCHED_MISSING, /Send unmatched e-Transfer count to the suite/);
});

test('counts, summaries, paging and the headline total', () => {
  assert.equal(countText({ count: 1234 }), '1,234');
  assert.equal(countText({ count: null }), '—');
  assert.equal(summaryText({ id: 'balances', count: 2, totalCents: 26690 }), '$266.90 owed on orders more than 30 days old');
  assert.equal(summaryText({ id: 'renewals', count: 3, services: 2, costs: 1 }), '2 client services, 1 of our costs');
  assert.equal(summaryText({ id: 'noNextStep', count: 2, relationships: 1, leads: 1 }), '1 relationship, 1 lead');
  assert.equal(summaryText({ id: 'overdue', count: 0 }), '');
  assert.deepEqual([shownCount(0), shownCount(1), shownCount(2)], [FIRST_ITEMS, FIRST_ITEMS + MORE_ITEMS, FIRST_ITEMS + 2 * MORE_ITEMS]);
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
  assert.equal(moreText({ items, count: 130 }, 5), 'Show 20 more');
  assert.equal(moreText({ items: items.slice(0, 8), count: 8 }, 5), 'Show 3 more');
  assert.equal(moreText({ items: items.slice(0, 5), count: 5 }, 5), null);
  assert.equal(restText({ items, count: 130 }, 5), null, 'not before what was sent is shown');
  assert.equal(restText({ items, count: 130 }, 105), 'and 30 more');
  const attention = [
    { id: 'overdue', state: 'ok', count: 3 }, { id: 'support', state: 'not_connected', count: null }, { id: 'quiet', state: 'ok', count: 9300 },
    { id: 'noNextStep', state: 'ok', count: 4100 }, { id: 'balances', state: 'paused', count: 1 },
  ];
  assert.equal(attentionTotal(attention), 4, 'quiet clients and no next step have their own counts, not in the headline');
  assert.equal(attentionTotal(attention, 2), 6, 'with this device’s changes it couldn’t save');
  assert.ok(!URGENT.includes('quiet') && !URGENT.includes('noNextStep'));
});

test('sales tiles: entered by hand, stores that can’t be read', () => {
  assert.equal(totalOnlyNote({ today: [], week: [{ currency: 'CAD', total: 1, totalOnly: true }], month: [] }), 'Includes sales entered by hand');
  assert.equal(totalOnlyNote({ today: [], week: [{ currency: 'CAD', total: 1 }] }), '');
  assert.equal(storesNote([{ name: 'Tins Xpress', state: 'failing' }, { name: 'eBay', state: 'not_set_up' }, { name: 'OM', state: 'paused' }]), 'Tins Xpress can’t be read right now · OM is paused');
  assert.equal(storesNote([]), '');
});

test('sales entered by hand: the form, its checks, the body, amounts that count down', () => {
  assert.deepEqual(KIND_OPTIONS.map((o) => o.label), ['Sale', 'Refund', 'Credit note']);
  const f = newEntryForm({ today: '2026-10-14', businessId: 'b1' });
  assert.deepEqual(f, { kind: 'sale', day: '2026-10-14', businessId: 'b1', amount: '', currency: 'CAD', orders: '', note: '' });
  assert.deepEqual(entryProblem(f), { field: 'amount', text: 'The amount' });
  assert.deepEqual(entryProblem({ ...f, amount: '12.505' }), { field: 'amount', text: 'Type the amount like 1234.56' });
  assert.equal(summaryText({ id: 'payments', count: 4, customers: 1 }), '1 customer paid beyond their orders (regular depositors left out)');
  assert.deepEqual(entryProblem({ ...f, businessId: '' }), { field: 'businessId', text: 'Pick the business' });
  assert.deepEqual(entryProblem({ ...f, amount: '0' }), { field: 'amount', text: 'Type the amount like 1234.56' });
  assert.deepEqual(entryProblem({ ...f, amount: '1500', orders: '1.5' }), { field: 'orders', text: 'Orders is a whole number' });
  assert.equal(entryProblem({ ...f, amount: '$1,500.00', orders: '2' }), null);
  assert.deepEqual(entryBody({ ...f, amount: '$1,500.00', orders: '2', note: '  Invoice 31 ' }), { businessId: 'b1', day: '2026-10-14', kind: 'sale', amount: 150000, currency: 'CAD', orders: 2, note: 'Invoice 31' });
  assert.equal(entryBody({ ...f, kind: 'refund', amount: '50', orders: '3' }).orders, null, 'a refund has no orders');
  assert.deepEqual(entryToForm({ kind: 'credit_note', day: '2026-10-12', businessId: 'b1', amount: -20000, currency: 'USD', orders: null, note: null }),
    { kind: 'credit_note', day: '2026-10-12', businessId: 'b1', amount: '200.00', currency: 'USD', orders: '', note: '' });
  assert.equal(entryAmountText({ amount: -20000, currency: 'CAD' }), '−$200');
  assert.equal(entryAmountText({ amount: 150050, currency: 'USD' }), 'US$1,500.50 USD');
  assert.equal(sumsText([{ currency: 'CAD', total: 175000 }, { currency: 'USD', total: -500 }]), '$1,750 + −US$5 USD');
  assert.equal(sumsText([]), '$0');
});

test('store states (D11): the Order Manager with nothing yet; "or enter a month by hand" only where a month can be', () => {
  assert.match(stateText({ state: 'nothing_yet' }).text, /Nothing received from the Order Manager/);
  assert.equal(stateText({ state: 'by_hand' }), null);
  assert.doesNotMatch(stateText({ state: 'not_set_up' }).text, /by hand/);
  assert.match(stateText({ state: 'not_set_up', manualStore: 'ebay' }).text, /or enter a month by hand/);
});

test('sales by hand: not for businesses whose sales come from a connection, Personal or archived ones', async () => {
  const { byHandAllowed, NOT_BY_HAND, BY_HAND_WARNING } = await import('@suite/shared/sales');
  assert.equal(byHandAllowed({ id: BUSINESS_IDS.retail }), true, 'retail: allowed, with a warning');
  assert.match(BY_HAND_WARNING[BUSINESS_IDS.retail], /not connected to WooCommerce/);
  for (const id of [BUSINESS_IDS.wholesale, BUSINESS_IDS.save_point, BUSINESS_IDS.personal]) {
    assert.ok(NOT_BY_HAND[id]);
    assert.equal(byHandAllowed({ id }), false);
  }
  assert.equal(byHandAllowed({ id: BUSINESS_IDS.consulting }), true);
  assert.equal(byHandAllowed({ id: BUSINESS_IDS.agency, archived: true }), false);
});
