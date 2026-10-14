// Sales by channel on the client: the page's pure logic (periods, typed amounts, the entry list)
// and two devices against the real engine and server — a day's sales typed offline on the phone
// (for a past day) reach the Mac when it reconnects, an edit and a delete come back, and the totals
// are the same on both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { totalsByChannel } from '@suite/shared/sales';
import { startServer, makeDevice } from './helpers.js';
import { PERIODS, periodRange, parseAmount, money, listEntries, sameDayTotal } from '../src/modules/sales/logic.js';

const SPS = BUSINESS_IDS.save_point;

test('periods: this week runs Monday to Sunday, months handle year ends and leap days', () => {
  assert.deepEqual(PERIODS.map((p) => p.value), ['week', 'month', 'last_month', 'all']);
  assert.deepEqual(periodRange('week', '2026-10-14'), { from: '2026-10-12', to: '2026-10-18' });
  assert.deepEqual(periodRange('month', '2026-10-14'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(periodRange('last_month', '2026-10-14'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(periodRange('last_month', '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(periodRange('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodRange('all', '2026-10-14'), { from: null, to: null });
});

test('typed amounts: dollars and cents, with $ and commas allowed; nothing else', () => {
  assert.deepEqual(parseAmount('182.50'), { value: 182.5 });
  assert.deepEqual(parseAmount(' $1,200 '), { value: 1200 });
  assert.deepEqual(parseAmount('0'), { value: 0 });
  for (const bad of ['', '  ', 'abc', '-5', '12.345', '1.2.3', '5,00x', '2000000']) {
    assert.ok(parseAmount(bad).error, `“${bad}” is refused`);
  }
  assert.equal(money(1234.5).replace(/ /g, ' '), '$1,234.50');
});

test('the entry list: one business, inside the range, newest day first; same-day totals ignore the entry being edited', () => {
  const r = (id, business_id, channel, sale_date, amount) => ({ id, business_id, channel, sale_date, amount });
  const rows = [
    r('a', SPS, 'whatnot', '2026-10-01', 10),
    r('b', SPS, 'poshmark', '2026-10-13', 20),
    r('c', SPS, 'whatnot', '2026-10-13', 30),
    r('d', SPS, 'whatnot', '2026-10-13', 5.5),
    r('e', BUSINESS_IDS.wholesale, 'whatnot', '2026-10-13', 999),
    r('f', SPS, 'whatnot', '2026-09-30', 1),
  ];
  const ids = (x) => x.map((e) => e.id).join('');
  assert.equal(ids(listEntries(rows, { businessId: SPS, from: '2026-10-01', to: '2026-10-31' })), 'bcda');
  assert.equal(ids(listEntries(rows, { businessId: SPS })), 'bcdaf');
  assert.equal(sameDayTotal(rows, { businessId: SPS, date: '2026-10-13', channel: 'whatnot' }), 35.5);
  assert.equal(sameDayTotal(rows, { businessId: SPS, date: '2026-10-13', channel: 'whatnot', excludeId: 'c' }), 5.5);
  assert.equal(sameDayTotal(rows, { businessId: SPS, date: '2026-10-12', channel: 'whatnot' }), null);
});

test('a past day typed offline on the phone reaches the Mac; an edit and a delete come back; totals match', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  await mac.engine.syncNow();
  await phone.engine.syncNow();

  phone.online = false; // no signal at the show
  const whatnot = await phone.engine.create('sale_day', { business_id: SPS, channel: 'whatnot', sale_date: '2026-10-09', amount: 182.5, notes: 'Friday show' });
  const posh = await phone.engine.create('sale_day', { business_id: SPS, channel: 'poshmark', sale_date: '2026-10-10', amount: 40 });
  const missed = await phone.engine.create('sale_day', { business_id: SPS, channel: 'facebook_marketplace', sale_date: '2026-08-02', amount: 75 }); // a day that was forgotten
  assert.equal((await phone.engine.list('sale_day')).length, 3, 'the phone shows them at once');
  phone.online = true;
  await phone.engine.syncNow();
  await mac.engine.syncNow();

  const onMac = await mac.engine.list('sale_day');
  assert.equal(onMac.length, 3);
  const totals = (rows, range) => totalsByChannel(rows.filter((r) => r.business_id === SPS), range);
  const october = periodRange('month', '2026-10-14');
  assert.deepEqual(totals(onMac, october).byChannel, {
    whatnot: { total: 182.5, days: 1 }, poshmark: { total: 40, days: 1 }, facebook_marketplace: { total: 0, days: 0 },
  });
  assert.equal(totals(onMac, { from: null, to: null }).total, 297.5, 'the forgotten August day counts in all-time');

  await mac.engine.update('sale_day', whatnot, { amount: 190.25 });
  await mac.engine.remove('sale_day', missed);
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  const onPhone = await phone.engine.list('sale_day');
  assert.deepEqual(onPhone.map((r) => r.id).sort(), [whatnot, posh].sort());
  assert.equal(totals(onPhone, october).total, 230.25);
  assert.equal(totals(onPhone, october).total, totals(await mac.engine.list('sale_day'), october).total, 'same totals on both devices');
});

test('an amount with three decimals is refused by the server and never stored', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const phone = await makeDevice(t, server, 'partner');
  await phone.engine.syncNow();
  // The page's parseAmount stops this first; this is the server's rule as the last line of defence
  // (the device checks field types only, so the step is queued and then refused).
  await phone.engine.create('sale_day', { business_id: SPS, channel: 'whatnot', sale_date: '2026-10-09', amount: 12.345 });
  await phone.engine.syncNow();
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sales_days').get().n, 0, 'the server never stored it');
});
