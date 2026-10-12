// The overview's business cards and goals scorecard in words (D15), without React: every card shows its figures or a
// plain "not connected"; each target shows actual against target with the pace; the monthly plan's target sheet (money
// in dollars, counts as whole numbers, an edit sends only what changed) — and against a real server with two devices:
// a target set offline syncs, the same one set on both devices offline survives on both and the newer one counts, and
// an open edit sheet doesn't undo the other person's change. Invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { startServer, makeDevice, row } from './helpers.js';
import { cardView, cardStateNote, allBusinessesView, targetLine, prioritiesText, priorityProgress, measureValue, longMonth, CARD_META } from '../src/modules/overview/cards.js';
import { targetValues, targetFields, newTargetFields, targetEditChanges, businessTargets, freeMeasure, measureOptionsFor } from '../src/modules/overview/targetForm.js';

const B = BUSINESS_IDS;
const TODAY = '2026-10-14';
const fmt = { date: (d) => `[${d}]`, dateTime: (d) => `[${d}]` };
const rows = (v) => Object.fromEntries(v.rows.map((r) => [r.key, r]));

test('every card shows a clear “not connected” when its source isn’t there', () => {
  const cases = [
    [{ id: 'wholesale', state: 'not_connected' }, /Order Manager is set up on System → Connections/],
    [{ id: 'stock', state: 'not_connected' }, /Stockroom is set up on System → Connections/],
    [{ id: 'stock', state: 'revoked' }, /Disconnected in Stockroom/],
    [{ id: 'savePoint', state: 'not_set_up' }, /eBay isn’t connected/],
    [{ id: 'retail', state: 'not_connected' }, /No WooCommerce store connected/],
    [{ id: 'clients', state: 'error' }, /Couldn’t be read just now/],
  ];
  for (const [card, re] of cases) {
    const v = cardView(card, fmt);
    assert.match(v.note.text, re, card.id);
    assert.deepEqual(v.rows, [], `${card.id}: no figures`);
  }
  assert.equal(cardStateNote({ id: 'web', state: 'ok' }), null);
  for (const id of ['wholesale', 'stock', 'web', 'consulting', 'savePoint', 'clients', 'allBusinesses', 'retail']) assert.ok(CARD_META[id].title);
  const retail = cardView({ id: 'retail', state: 'not_connected', stores: [], support: { state: 'not_connected', comesWith: 'the helpdesk (D14)' } }, fmt);
  assert.equal(retail.support, 'Open support tickets per store: not connected yet · comes with the helpdesk (D14).');
});

test('the cards in words: wholesale, stock, web and social, Save Point Shop, clients, retail', () => {
  const w = rows(cardView({
    id: 'wholesale', state: 'ok', month: [{ currency: 'CAD', total: 565000, orders: 3 }], lastMonth: [{ currency: 'CAD', total: 1130000, orders: 6 }],
    owing: { cents: 1395000, customers: 2 }, overdue: { cents: 830000, customers: 1 }, paidThisMonth: { cents: 200000, payments: 1 },
    quietRegulars: 1, toShip: { orders: 2, totalCents: 56500, oldestPackedAt: '2026-10-12T14:00:00.000Z' }, costs: [{ currency: 'CAD', monthlyCents: 2400, count: 1 }],
  }, fmt));
  assert.deepEqual([w.month.value, w.month.detail], ['$5,650', '3 orders · last month $11,300']);
  assert.deepEqual([w.overdue.value, w.overdue.tone, w.owing.value], ['$8,300', 'danger', '$13,950']);
  assert.equal(w.paid.detail, '1 payment, recorded in the Order Manager');
  assert.deepEqual([w.ship.value, w.ship.detail], ['2', '$565 · packed since [2026-10-12]']);
  assert.equal(w.costs.value, '$24 a month');

  const s = cardView({
    id: 'stock', state: 'paused', fetchedAt: '2026-10-14T13:00:00.000Z',
    counts: { lastFullCountAt: '2026-10-05T14:00:00.000Z', lastSpotCheckAt: null, due: true, overdue: false, pctMatched30Days: 97.5 },
    differences: { open: 2, valueCents: 3250, truncated: false }, reorder: { products: 3, suppliers: 2, out: 1 },
    deliveries: { expected: 2, tins: 300, overdue: 1, nextOn: '2026-10-10' },
  }, fmt);
  assert.match(s.note.text, /paused/, 'the last answers, marked');
  const sr = rows(s);
  assert.deepEqual([sr.full.value, sr.full.detail, sr.full.tone], ['[2026-10-05]', 'a count is due · 97.5 % matched in 30 days', 'warn']);
  assert.equal(sr.spot.value, 'None yet');
  assert.deepEqual([sr.diff.value, sr.diff.detail], ['2', 'worth $32.50']);
  assert.deepEqual([sr.reorder.value, sr.reorder.detail], ['3 products', 'from 2 suppliers · 1 out of stock']);
  assert.equal(sr.deliveries.detail, '300 tins · next [2026-10-10] · 1 late');

  const web = rows(cardView({
    id: 'web', state: 'ok', businessId: B.agency, relationships: { total: 3, byKind: { website: 2, social: 1 }, other: 0 },
    services: { active: 2, monthlyCents: 19000, hourly: 0 }, renewals: { count: 1, days: 30, next: { name: 'Hosting', accountName: 'Lefty’s', date: '2026-10-24' } },
    pipeline: { open: [{ stage: 'lead', count: 0 }, { stage: 'talking', count: 1 }, { stage: 'quoted', count: 1 }], openCount: 2, value: [{ currency: 'CAD', cents: 900000 }], wonThisMonth: 1 },
    month: [{ currency: 'CAD', total: 120000, totalOnly: true }], costs: [],
  }, fmt));
  assert.equal(web.rels.detail, '2 websites · 1 social');
  assert.equal(web.services.detail, '$190 a month in plans and retainers');
  assert.equal(web.renewals.detail, 'next: Hosting for Lefty’s, [2026-10-24]');
  assert.deepEqual([web.pipeline.value, web.pipeline.detail, web.pipeline.link], ['2 leads', '1 talking · 1 quoted · $9,000 first-year value · 1 won this month', `/crm/pipeline?business=${B.agency}`]);
  assert.equal(web.month.detail, 'includes sales entered by hand');
  assert.equal(web.costs.value, 'None set');
  const consulting = (invoicesConnected) => cardView({ id: 'consulting', state: 'ok', invoicesConnected, relationships: { total: 0, byKind: { consulting: 0 } }, pipeline: { open: [], openCount: 0, value: [] } }, fmt);
  assert.match(consulting(false).extra, /Invoices aren’t connected yet/);
  assert.equal(consulting(true).extra, null, 'once invoices are a sales source (D18), no note');

  const sp = cardView({ id: 'savePoint', state: 'not_set_up', month: [{ currency: 'CAD', total: 98700, orders: 21, totalOnly: true }], today: [], week: [], monthFromManual: true, toShip: null }, fmt);
  assert.match(sp.note.text, /enter a month by hand/);
  assert.deepEqual([rows(sp).month.value, rows(sp).month.detail], ['$987', '21 orders · entered by hand']);
  const sp2 = rows(cardView({ id: 'savePoint', state: 'ok', month: [], today: [], week: [], toShip: { orders: 3, nextShipBy: '2026-10-15T07:00:00.000Z', late: 1 } }, fmt));
  assert.deepEqual([sp2.ship.value, sp2.ship.detail, sp2.ship.tone], ['3', 'next ships by [2026-10-15] · 1 past the ship-by day', 'danger']);

  const cl = rows(cardView({ id: 'clients', state: 'ok', active: 2700, newThisMonth: 12, quiet: 40, quietDays: 60, openLeads: 5 }, fmt));
  assert.deepEqual([cl.active.value, cl.new.label, cl.new.value, cl.quiet.label, cl.quiet.value], ['2,700', 'Clients added this month', '12', 'Gone quiet (60 days)', '40']);

  const re = cardView({
    id: 'retail', state: 'ok', support: { state: 'ok', total: 4, unmatched: 1 }, costs: null,
    stores: [{ source: 'woo', store: 'tinsxpress.com', name: 'TinsXpress', state: 'failing', link: '/costs/sales/woo/1', today: [], week: [], month: [{ currency: 'CAD', total: 11170 }], tickets: 3 }],
  }, fmt);
  assert.deepEqual([re.rows[0].label, re.rows[0].value, re.rows[0].detail, re.rows[0].tone], ['TinsXpress', '$111.70', 'this month · today $0 · can’t be read right now · 3 open tickets', 'danger']);
  assert.equal(re.support, '4 open support tickets (1 not matched to a store)');
  assert.equal(cardView({ id: 'retail', state: 'ok', stores: [], support: { state: 'error' } }, fmt).support, 'Open support tickets per store couldn’t be read just now.');
});

test('all businesses: three months beside the recurring costs, less costs per month and currency; Personal apart', () => {
  const v = allBusinessesView({
    months: ['2026-08', '2026-09', '2026-10'],
    businesses: [
      { businessId: B.agency, name: 'Great White North Design', months: [{ month: '2026-08', sales: [{ currency: 'CAD', total: 100000 }] }, { month: '2026-09', sales: [] }, { month: '2026-10', sales: [{ currency: 'CAD', total: 200000, totalOnly: true }, { currency: 'USD', total: 5000 }] }], costs: [{ currency: 'CAD', monthlyCents: 10000 }] },
      { businessId: B.personal, name: 'Personal', personal: true, months: [{ month: '2026-08', sales: [] }, { month: '2026-09', sales: [] }, { month: '2026-10', sales: [] }], costs: [{ currency: 'CAD', monthlyCents: 9000 }] },
    ],
    together: { months: [{ month: '2026-08', sales: [{ currency: 'CAD', total: 100000 }] }, { month: '2026-09', sales: [] }, { month: '2026-10', sales: [] }], costs: [{ currency: 'CAD', monthlyCents: 10000 }] },
  }, TODAY);
  assert.deepEqual(v.months.map((m) => [m.label, m.lessLabel]), [['Aug', 'less today’s costs'], ['Sep', 'less today’s costs'], ['Oct (so far)', 'less costs for 13 of 31 days']]);
  const gwnd = v.rows[0];
  assert.deepEqual(gwnd.cells.map((c) => [c.sales, c.less, c.negative, c.handEntered]), [
    ['$1,000', '$900', false, false], ['$0', '−$100', true, false], ['$2,000 + US$50 USD', '$1,958.06 + US$50 USD', false, true],
  ]);
  assert.equal(gwnd.costs, '$100');
  assert.deepEqual(v.personal.map((r) => r.name), ['Personal']);
  assert.equal(v.together.cells[0].less, '$900');
});

test('the scorecard: actual against target with the pace and where the line is today; can’t tell; priorities', () => {
  const ahead = targetLine({ id: 't1', measure: 'sales', amount: 300000, currency: 'CAD', actual: 150000, pace: { status: 'ahead', pct: 50, expected: 125806, projected: 357692 } }, { month: '2026-10', today: TODAY });
  assert.deepEqual([ahead.label, ahead.value, ahead.pct, ahead.expectedPct, ahead.statusText, ahead.tone], ['Total sales', '$1,500 of $3,000', 50, 42, 'Ahead of pace · 50 %', 'good']);
  assert.equal(ahead.detail, '$1,258.06 expected by yesterday’s end · on course for $3,576.92');
  const early = targetLine({ id: 't5', measure: 'orders', amount: 40, actual: 0 }, { month: '2026-10', today: '2026-10-02' });
  assert.deepEqual([early.statusText, early.detail], ['Too early to tell · 0 %', '1 day of the month complete: the pace shows from the 4th.']);
  const net = targetLine({ id: 't2', measure: 'net_sales', amount: 200000, currency: 'USD', actual: null, reason: 'total_only', pace: { status: 'unknown', pct: null, expected: null, projected: null } }, { month: '2026-10', today: TODAY });
  assert.deepEqual([net.label, net.value, net.pct, net.statusText], ['Sales before tax and shipping (USD)', '— of US$2,000 USD', 0, 'Can’t tell']);
  assert.match(net.detail, /only have a total/);
  const orders = targetLine({ id: 't3', measure: 'orders', amount: 4, actual: 1, partial: true }, { month: '2026-10', today: TODAY });
  assert.deepEqual([orders.value, orders.status], ['1 of 4', 'behind'], 'pace worked out on the device when the server sent none');
  assert.match(orders.detail, /orders entered by hand may be left out/);
  const reached = targetLine({ id: 't4', measure: 'new_clients', amount: 2, actual: 2 }, { month: '2026-10', today: TODAY });
  assert.equal(reached.label, 'New clients (first relationship started)');
  assert.deepEqual([reached.statusText, reached.detail, reached.pct], ['Reached · 100 %', null, 100]);
  assert.equal(measureValue('won_leads', 3), '3');
  assert.equal(longMonth('2026-10'), 'October 2026');
  assert.equal(prioritiesText([{ done_at: 'x' }, { done_at: null }]), '1 of 2 priorities done');
  assert.equal(prioritiesText([]), 'No priorities this month');
  assert.deepEqual([priorityProgress({ target: 2, progress: 1 }), priorityProgress({ progress: 3 }), priorityProgress({})], ['1 of 2', '3 so far', '']);
});

test('the target sheet: dollars to cents, whole numbers for counts, CAD stored as none, an edit sends only what changed', () => {
  const v = { ...targetValues(null), amount: '12,000.50' };
  assert.deepEqual(newTargetFields(v, { businessId: B.agency, month: '2026-10-01' }).fields, { business_id: B.agency, month: '2026-10-01', measure: 'sales', amount: 1200050, currency: null, notes: null });
  assert.deepEqual(targetFields({ ...v, currency: 'USD' }).fields.currency, 'USD');
  assert.equal(targetFields({ ...v, amount: '0' }).problems.amount, 'An amount in dollars, like 12,000');
  assert.equal(targetFields({ measure: 'orders', amount: '4.5' }).problems.amount, 'A whole number above 0');
  assert.deepEqual(targetFields({ measure: 'orders', amount: '1,200', currency: 'USD' }).fields, { amount: 1200, currency: null, notes: null }, 'counts have no currency');
  const record = { id: 'x', measure: 'sales', amount: 1200050, currency: null, notes: 'Holiday push' };
  const start = targetValues(record);
  assert.deepEqual(start, { measure: 'sales', amount: '12000.50', currency: 'CAD', notes: 'Holiday push' });
  assert.deepEqual(targetEditChanges(start, { ...start, amount: '15000' }).fields, { amount: 1500000 });
  assert.deepEqual(targetEditChanges(start, start).fields, {});
  assert.deepEqual(targetEditChanges(start, { ...start, currency: 'USD', notes: '' }).fields, { notes: null }, 'the currency never changes on an edit');
  assert.equal(freeMeasure([{ measure: 'sales' }, { measure: 'orders' }]), 'net_sales');
  assert.equal(freeMeasure([], B.personal), 'new_clients', 'Personal: no sales measures');
  assert.deepEqual(measureOptionsFor(B.personal).map((o) => o.value), ['new_clients', 'won_leads']);
  // A change waiting to be sent is the newest; else pulled times; without times the ids.
  const recs = [
    { id: '01a', business_id: B.agency, month: '2026-10-01', measure: 'sales', amount: 1, _sync: { updatedAt: '2026-10-02T00:00:00.000Z' } },
    { id: '01b', business_id: B.agency, month: '2026-10-01', measure: 'sales', amount: 2, _sync: { updatedAt: '2026-10-01T00:00:00.000Z', pending: true } },
  ];
  assert.equal(businessTargets(recs, B.agency).current[0].id, '01b');
  assert.equal(businessTargets([recs[0], { ...recs[1], _sync: { local: true } }], B.agency).current[0].id, '01b', 'not pulled back yet: by id');
  assert.equal(businessTargets([{ ...recs[0], id: '01c' }, { ...recs[1], _sync: { local: true } }], B.agency).current[0].id, '01c');
});

test('two devices: a target set offline syncs; the same one set on both offline survives, the newer counts; an open sheet keeps the other’s change', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  await mac.engine.syncNow();
  await phone.engine.syncNow();

  phone.online = false;
  mac.online = false;
  const fields = (amount) => newTargetFields({ ...targetValues(null), amount }, { businessId: B.agency, month: '2026-10-01' }).fields;
  const onPhone = await phone.engine.create('target', fields('10000'));
  const onMac = await mac.engine.create('target', fields('12000'));
  assert.equal((await phone.engine.get('target', onPhone)).amount, 1000000, 'shown at once, offline');
  assert.equal(row(server.db, 'overview_targets', onPhone), undefined);
  phone.online = true;
  await phone.engine.syncNow();
  mac.online = true;
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM overview_targets WHERE deleted_at IS NULL').get().n, 2, 'both kept: nothing lost');
  const { current, extras } = businessTargets(await phone.engine.list('target'), B.agency);
  assert.equal(current.length, 1);
  assert.equal(extras.get(current[0].id).length, 1, 'the other is offered for removal');
  // Remove the extra; the Mac opens the sheet of the one kept, the phone meanwhile adds a note; the Mac changes the amount.
  await phone.engine.remove('target', extras.get(current[0].id)[0].id);
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const kept = current[0].id;
  const start = targetValues(await mac.engine.get('target', kept));
  await phone.engine.update('target', kept, { notes: 'Holiday push' });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const edit = targetEditChanges(start, { ...start, amount: '15000' });
  assert.deepEqual(edit.fields, { amount: 1500000 });
  await mac.engine.update('target', kept, edit.fields);
  await mac.engine.syncNow();
  const after = row(server.db, 'overview_targets', kept);
  assert.deepEqual([after.amount, after.notes], [1500000, 'Holiday push'], 'both changes survive');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);
  // Changing the measure is refused by the server (a new target instead): it lands in Needs attention.
  await mac.engine.update('target', kept, { measure: 'orders' });
  await mac.engine.syncNow();
  const attention = await mac.engine.attentionList();
  assert.ok(attention.some((a) => a.step.recordId === kept && a.code === 'invalid_value'), JSON.stringify(attention));
});
