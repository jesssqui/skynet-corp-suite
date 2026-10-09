// The Costs page (D6) without React: filters, grouping by business with the monthly/yearly totals,
// where each cost stands, the resold-relationship picker, the form's fields (money in dollars, only
// what changed sent on an edit), and against a real server with two devices: a cost added offline
// syncs, an open edit sheet doesn't undo the other person's change, and the Friday review lists
// costs renewing in 30 days. Invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { startServer, makeDevice, row } from './helpers.js';
import { valuesFrom, editChanges, isDirty } from '../src/modules/crm/formFields.js';
import {
  filterCosts, groupCosts, totalsText, resoldTotalsText, renewalLabel, resoldLine, costRenewalsDue, relationshipOptions, costForm, compareCosts,
} from '../src/modules/costs/logic.js';
import { reviewLists } from '../src/modules/planner/plan.js';

const AGENCY = BUSINESS_IDS.agency;
const PERSONAL = BUSINESS_IDS.personal;
const TODAY = '2026-10-09';
const businesses = [
  { id: PERSONAL, name: 'Personal', position: 6 },
  { id: AGENCY, name: 'Great White North Design', position: 2 },
];
const cost = (id, over) => ({ id, name: id, business_id: AGENCY, period: 'yearly', amount_cents: 12000, next_renewal: '2026-12-01', status: 'active', ...over });

test('filters, grouping by business (our order), soonest first with cancelled last, and the totals', () => {
  const costs = [
    cost('Domain', { next_renewal: '2026-11-30', vendor: 'Namecheap' }),
    cost('Hosting', { amount_cents: 3500, period: 'monthly', next_renewal: '2026-10-15', auto_renews: true, relationship_id: 'r1', resold_amount_cents: 5000 }),
    cost('Old app', { status: 'cancelled', next_renewal: '2026-10-10' }),
    cost('Insurance', { business_id: PERSONAL, amount_cents: 120000, next_renewal: '2027-03-01', payment_method: 'Chequing' }),
    cost('Figma', { amount_cents: 1500, period: 'quarterly', currency: 'USD', next_renewal: '2026-12-01' }),
    cost('Logo', { amount_cents: 50000, period: 'once', next_renewal: '2026-10-01' }),
  ];
  assert.deepEqual(filterCosts(costs).map((c) => c.id).sort(), ['Domain', 'Figma', 'Hosting', 'Insurance', 'Logo']);
  assert.deepEqual(filterCosts(costs, { status: 'cancelled' }).map((c) => c.id), ['Old app']);
  assert.equal(filterCosts(costs, { status: 'all' }).length, 6);
  assert.deepEqual(filterCosts(costs, { business: PERSONAL }).map((c) => c.id), ['Insurance']);
  assert.deepEqual(filterCosts(costs, { q: 'namecheap' }).map((c) => c.id), ['Domain']);
  assert.deepEqual(filterCosts(costs, { q: 'cheq' }).map((c) => c.id), ['Insurance'], 'payment method too');

  const { groups, overall } = groupCosts(costs, businesses);
  assert.deepEqual(groups.map((g) => g.business.name), ['Great White North Design', 'Personal'], 'by position, not by the list’s order');
  assert.deepEqual(groups[0].costs.map((c) => c.id), ['Logo', 'Hosting', 'Domain', 'Figma', 'Old app'], 'soonest first, cancelled last');
  assert.equal(totalsText(groups[0].totals), '$45/mo · $540/yr · US$5/mo · US$60/yr', '$420 + $120 a year; once and cancelled left out');
  assert.equal(totalsText(groups[1].totals), '$100/mo · $1,200/yr');
  assert.equal(totalsText(overall), '$145/mo · $1,740/yr · US$5/mo · US$60/yr');
  assert.equal(resoldTotalsText(overall), '$50/mo · $600/yr');
  assert.equal(totalsText(new Map()), '');
  assert.ok(compareCosts(cost('a', { next_renewal: '2026-01-01', status: 'cancelled' }), cost('b', { next_renewal: '2027-01-01' })) > 0);
});

test('where a cost stands on its row; resold lines; renewing in 30 days', () => {
  assert.deepEqual(renewalLabel(cost('x', { next_renewal: '2026-10-10' }), TODAY), { text: 'Renews tomorrow', tone: 'accent' });
  assert.deepEqual(renewalLabel(cost('x', { next_renewal: '2026-10-20' }), TODAY), { text: 'Renews in 11 days', tone: 'accent' });
  assert.deepEqual(renewalLabel(cost('x', { next_renewal: TODAY }), TODAY), { text: 'Renews today', tone: 'warn' });
  assert.equal(renewalLabel(cost('x', { next_renewal: '2026-10-01' }), TODAY).text, 'Overdue — renewed? (was due Oct 1, 2026)');
  assert.match(renewalLabel(cost('x', { next_renewal: '2026-10-01', auto_renews: true }), TODAY).text, /^Renewed on its own Oct 1, 2026 · the suite moves it/);
  assert.equal(renewalLabel(cost('x', { next_renewal: '2026-10-01', period: 'once' }), TODAY).text, 'Paid once · Oct 1, 2026');
  assert.equal(renewalLabel(cost('x', { status: 'cancelled' }), TODAY).text, 'Cancelled');
  assert.equal(renewalLabel(cost('x', { next_renewal: '2026-12-01' }), TODAY).text, 'Renews Dec 1, 2026');
  assert.equal(resoldLine(cost('Hosting', { amount_cents: 30000, resold_amount_cents: 48000 })), 'Hosting — we pay $300/yr, they pay $480/yr');
  assert.equal(resoldLine(cost('SSL', { amount_cents: null, resold_amount_cents: null })), 'SSL');
  const list = [cost('a', { next_renewal: '2026-11-08' }), cost('b', { next_renewal: '2026-11-09' }), cost('c', { next_renewal: TODAY }), cost('d', { next_renewal: '2026-10-20', status: 'cancelled' })];
  assert.deepEqual(costRenewalsDue(list, TODAY).map((c) => c.id), ['c', 'a']);
  const lists = reviewLists({ tasks: [], today: TODAY, goals: [], services: [], clients: [], accounts: [], relationships: [], lastActivity: new Map(), costs: list });
  assert.deepEqual(lists.costRenewals.map((c) => c.id), ['c', 'a'], 'the Friday review lists them');
});

test('resold on: relationships of live clients, grouped by client; closed clients and ended relationships only when already chosen', () => {
  const data = {
    businesses,
    clients: [{ id: 'c1', name: 'Lefty’s', status: 'active' }, { id: 'c2', name: 'Closed Co', status: 'closed' }],
    accounts: [{ id: 'a1', client_id: 'c1', name: 'Lefty’s' }, { id: 'a2', client_id: 'c1', name: 'Lefty’s Annex' }, { id: 'a3', client_id: 'c2', name: 'Closed Co' }],
    relationships: [
      { id: 'r1', account_id: 'a1', business_id: AGENCY, kind: 'website', status: 'active' },
      { id: 'r2', account_id: 'a2', business_id: AGENCY, kind: 'social', status: 'active' },
      { id: 'r3', account_id: 'a3', business_id: AGENCY, kind: 'website', status: 'active' },
      { id: 'r4', account_id: 'a1', business_id: AGENCY, kind: 'website', status: 'ended' },
      { id: 'r5', account_id: 'gone', business_id: AGENCY, kind: 'website', status: 'active' },
    ],
  };
  assert.deepEqual(relationshipOptions(data), [
    { value: 'r1', group: 'Lefty’s', label: 'Great White North Design · Website' },
    { value: 'r2', group: 'Lefty’s', label: 'Lefty’s Annex — Great White North Design · Social media' },
  ]);
  assert.deepEqual(relationshipOptions(data, 'r3').map((o) => o.value), ['r3', 'r1', 'r2']);
  assert.deepEqual(relationshipOptions(data, 'r9').map((o) => o.value), ['r1', 'r2', 'r9'], 'one this device doesn’t have is kept');
});

test('the form: dollars to cents, CAD by default, problems stop the save, an edit sends only what changed', () => {
  const fresh = valuesFrom(costForm, null);
  assert.deepEqual([fresh.currency, fresh.period, fresh.status, fresh.auto_renews], ['CAD', 'yearly', 'active', false]);
  const r = costForm.toFields({ ...fresh, name: ' Domain ', business_id: AGENCY, amount: '19.99', next_renewal: '2026-11-30' });
  assert.deepEqual(r.problems, {});
  assert.deepEqual(r.fields, {
    name: 'Domain', business_id: AGENCY, vendor: null, amount_cents: 1999, currency: 'CAD', period: 'yearly', next_renewal: '2026-11-30',
    payment_method: null, auto_renews: false, status: 'active', notes: null, relationship_id: null, resold_amount_cents: null,
  });
  const bad = costForm.toFields({ ...fresh, amount: 'lots' });
  assert.deepEqual(Object.keys(bad.problems).sort(), ['amount', 'business_id', 'name', 'next_renewal']);
  // Resold amount only with a relationship.
  assert.equal(costForm.toFields({ ...fresh, resold: '50' }).fields.resold_amount_cents, null);
  assert.equal(costForm.toFields({ ...fresh, relationship_id: 'r1', resold: '50' }).fields.resold_amount_cents, 5000);

  const record = cost('Hosting', { amount_cents: 3500, period: 'monthly', auto_renews: true, currency: null, status: null, relationship_id: 'r1', resold_amount_cents: 5000 });
  const start = valuesFrom(costForm, record);
  assert.deepEqual([start.amount, start.resold, start.currency, start.status, start.auto_renews], ['35', '50', 'CAD', 'active', true]);
  assert.deepEqual(editChanges(costForm, start, start), { fields: {}, problems: {} }, 'opening and saving sends nothing (null status/currency read as active/CAD)');
  assert.equal(isDirty(start, start), false);
  assert.deepEqual(editChanges(costForm, start, { ...start, amount: '35.00' }).fields, {});
  assert.deepEqual(editChanges(costForm, start, { ...start, next_renewal: '2026-11-01', status: 'cancelled' }).fields, { next_renewal: '2026-11-01', status: 'cancelled' });
  assert.deepEqual(editChanges(costForm, start, { ...start, relationship_id: '' }).fields, { relationship_id: null, resold_amount_cents: null }, 'not resold any more');
});

test('two devices: a cost added offline syncs; an open edit sheet keeps the other person’s change; cancelling and deleting', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');

  // The phone, offline, adds the home insurance.
  phone.online = false;
  const id = await phone.engine.create('recurring_cost', costForm.toFields({
    ...valuesFrom(costForm, null), name: 'Home insurance', business_id: PERSONAL, amount: '1400', next_renewal: '2027-03-01', auto_renews: true,
  }).fields);
  assert.equal((await phone.engine.get('recurring_cost', id)).name, 'Home insurance', 'shown at once, offline');
  await phone.engine.syncNow();
  assert.equal(row(server.db, 'costs_recurring', id), undefined, 'not on the server yet');
  phone.online = true;
  await phone.engine.syncNow();
  const saved = row(server.db, 'costs_recurring', id);
  assert.deepEqual([saved.amount_cents, saved.currency, saved.status, saved.auto_renews, saved.created_by], [140000, 'CAD', 'active', 1, 'partner']);

  // The Mac opens its edit sheet; meanwhile the phone changes the amount; the Mac changes only the date.
  await mac.engine.syncNow();
  const start = valuesFrom(costForm, await mac.engine.get('recurring_cost', id));
  await phone.engine.update('recurring_cost', id, { amount_cents: 145000 });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const edit = editChanges(costForm, start, { ...start, next_renewal: '2027-03-15' });
  assert.deepEqual(edit.fields, { next_renewal: '2027-03-15' });
  await mac.engine.update('recurring_cost', id, edit.fields);
  await mac.engine.syncNow();
  const after = row(server.db, 'costs_recurring', id);
  assert.deepEqual([after.amount_cents, after.next_renewal], [145000, '2027-03-15'], 'both changes survive');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);

  // Cancel (the normal way), then delete (a mistake).
  await mac.engine.update('recurring_cost', id, { status: 'cancelled' });
  await mac.engine.remove('recurring_cost', id);
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  assert.equal(await phone.engine.get('recurring_cost', id), null);
  assert.ok(row(server.db, 'costs_recurring', id).deleted_at);
  // A negative amount passes the device's field checks but is the module's rule: refused by the
  // server, it lands in Needs attention (nothing written).
  const bad = await phone.engine.create('recurring_cost', { name: 'X', business_id: AGENCY, period: 'yearly', next_renewal: '2026-12-01', amount_cents: -5 });
  await phone.engine.syncNow();
  assert.equal(row(server.db, 'costs_recurring', bad), undefined);
  const attention = await phone.engine.attentionList();
  assert.ok(attention.some((a) => a.step.recordId === bad && a.code === 'invalid_value'), JSON.stringify(attention));
});
