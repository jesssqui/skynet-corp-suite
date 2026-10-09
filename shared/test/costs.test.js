import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPeriods, rollForward, yearlyCents, costTotals, costState, wantsCostReminder, costsRenewingBetween, moneyText, costAmountText,
  daysFromTo, isCurrency, costCurrency, monthlyFromYearly,
} from '../costs.js';

test('periods: added on the calendar; once stays put', () => {
  assert.equal(addPeriods('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addPeriods('2028-01-31', 'monthly'), '2028-02-29', 'leap year');
  assert.equal(addPeriods('2026-11-15', 'quarterly'), '2027-02-15');
  assert.equal(addPeriods('2026-02-28', 'yearly', 2), '2028-02-28');
  assert.equal(addPeriods('2026-10-09', 'once'), '2026-10-09');
  assert.equal(daysFromTo('2026-10-09', '2026-11-08'), 30);
  assert.equal(daysFromTo('2026-11-01', '2026-11-02'), 1, 'across the DST change: whole days');
  assert.equal(daysFromTo('2026-10-09', '2026-10-01'), -8);
});

test('rollForward: the first renewal on or after today, counted from the old date in one go', () => {
  assert.equal(rollForward('2026-10-08', 'yearly', '2026-10-09'), '2027-10-08');
  assert.equal(rollForward('2026-10-09', 'yearly', '2026-10-09'), '2026-10-09', 'the renewal day itself: not passed yet');
  assert.equal(rollForward('2026-10-10', 'monthly', '2026-10-09'), '2026-10-10', 'not passed: unchanged');
  assert.equal(rollForward('2026-06-15', 'monthly', '2026-10-09'), '2026-10-15', 'months of downtime: one jump');
  assert.equal(rollForward('2026-01-31', 'monthly', '2026-03-01'), '2026-03-31', 'from the anchor: Jan 31 + 2 months');
  assert.equal(rollForward('2026-08-01', 'quarterly', '2026-11-01'), '2026-11-01');
  assert.equal(rollForward('2026-01-01', 'once', '2026-10-09'), '2026-01-01', 'a one-time cost never rolls');
  assert.equal(rollForward(null, 'yearly', '2026-10-09'), null);
});

test('totals: monthly equivalent = yearly ÷ 12, quarterly ÷ 3; once and cancelled left out; per business and currency', () => {
  const B1 = 'b1';
  const B2 = 'b2';
  const costs = [
    { id: '1', business_id: B1, amount_cents: 2000, period: 'monthly', status: 'active' }, // 240/yr
    { id: '2', business_id: B1, amount_cents: 12000, period: 'yearly' }, // null status = active: 120/yr
    { id: '3', business_id: B1, amount_cents: 3000, period: 'quarterly', status: 'active', relationship_id: 'r', resold_amount_cents: 4500 }, // 120/yr, resold 180/yr
    { id: '4', business_id: B1, amount_cents: 50000, period: 'once', status: 'active' },
    { id: '5', business_id: B1, amount_cents: 9900, period: 'monthly', status: 'cancelled' },
    { id: '6', business_id: B2, amount_cents: 1000, period: 'yearly', currency: 'USD', status: 'active' },
    { id: '7', business_id: B2, amount_cents: null, period: 'yearly', status: 'active' },
  ];
  const t = costTotals(costs);
  const b1 = t.byBusiness.get(B1).get('CAD');
  assert.deepEqual(b1, { count: 3, yearly_cents: 48000, monthly_cents: 4000, resold_yearly_cents: 18000, resold_monthly_cents: 1500 });
  assert.deepEqual([...t.byBusiness.get(B2).keys()].sort(), ['CAD', 'USD']);
  assert.equal(t.byBusiness.get(B2).get('USD').yearly_cents, 1000);
  assert.equal(t.overall.get('CAD').yearly_cents, 48000);
  assert.equal(t.overall.get('CAD').count, 4, 'a cost with no amount is counted, adding nothing');
  assert.equal(yearlyCents({ amount_cents: 999, period: 'quarterly' }), 3996);
  assert.equal(monthlyFromYearly(1000), 83);
});

test('where a cost stands; which costs get reminders; renewing in a window', () => {
  const today = '2026-10-09';
  const c = (over) => ({ id: 'x', period: 'yearly', status: 'active', next_renewal: '2026-12-01', ...over });
  assert.equal(costState(c({ status: 'cancelled' }), today), 'cancelled');
  assert.equal(costState(c({ next_renewal: '2026-10-01', period: 'once' }), today), 'past');
  assert.equal(costState(c({ next_renewal: '2026-10-01', auto_renews: true }), today), 'rolling');
  assert.equal(costState(c({ next_renewal: '2026-10-01', auto_renews: false }), today), 'overdue');
  assert.equal(costState(c({ next_renewal: today }), today), 'today');
  assert.equal(costState(c({ next_renewal: '2026-10-23' }), today), 'soon');
  assert.equal(costState(c({ next_renewal: '2026-10-24' }), today), 'upcoming');
  assert.equal(wantsCostReminder(c({ period: 'monthly', auto_renews: true })), false, 'monthly and automatic: no monthly task');
  assert.equal(wantsCostReminder(c({ period: 'monthly', auto_renews: false })), true);
  assert.equal(wantsCostReminder(c({ period: 'yearly', auto_renews: true })), true);
  assert.equal(wantsCostReminder(c({ status: 'cancelled' })), false);
  const list = [c({ id: 'b', next_renewal: '2026-11-08' }), c({ id: 'a', next_renewal: '2026-10-09' }), c({ id: 'z', next_renewal: '2026-11-09' }),
    c({ id: 'y', next_renewal: '2026-10-20', status: 'cancelled' })];
  assert.deepEqual(costsRenewingBetween(list, today, '2026-11-08').map((x) => x.id), ['a', 'b']);
});

test('money: CAD with $, other currencies named; amounts per period', () => {
  assert.equal(moneyText(12000), '$120');
  assert.equal(moneyText(12050), '$120.50');
  assert.equal(moneyText(12000, 'USD'), 'US$120');
  assert.equal(moneyText(null), '');
  assert.equal(costAmountText({ amount_cents: 2000, period: 'monthly' }), '$20/mo');
  assert.equal(costAmountText({ amount_cents: 50000, period: 'once', currency: 'USD' }), 'US$500 once');
  assert.equal(costAmountText({ amount_cents: 6000, period: 'quarterly', resold_amount_cents: 9000 }, 'resold_amount_cents'), '$90/qtr');
  assert.equal(costAmountText({ period: 'yearly' }), '');
  assert.equal(isCurrency('CAD'), true);
  assert.equal(isCurrency('cad'), false);
  assert.equal(costCurrency({ currency: null }), 'CAD');
});
