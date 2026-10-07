// The client screens' logic (C3b), without a browser: search over the device's copy (names,
// emails, phones typed any way), list rows, timeline filters, money, consent wording, errors,
// and the date helpers for datetime inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { SyncError } from '../src/sync/engine.js';
import {
  buildClientIndex, filterClients, parseQuery, fold, filterTimeline, sortTimeline, formatMoney, parseDollars, centsToInput,
  billingSummary, consentView, errorText, businessColor, businessShortName, pickableBusinesses, actorLabel, websiteHref,
  addressLines, defaultKindFor,
} from '../src/modules/crm/logic.js';
import { toDateTimeInput, fromDateTimeInput, formatDate } from '../src/ui/format.js';

const { wholesale: W, agency: A, consulting: C } = BUSINESS_IDS;

// The plan's example, with invented names: one owner with three businesses.
function example() {
  const clients = [
    { id: 'c1', name: 'Northwind Holdings', status: 'active' },
    { id: 'c2', name: 'Bayside Bakery', status: 'active' },
    { id: 'c3', name: 'Zed’s Old Shop', status: 'closed' },
  ];
  const accounts = [
    { id: 'a1', client_id: 'c1', name: 'Green Leaf Dispensary' },
    { id: 'a2', client_id: 'c1', name: 'Cloud Vape Co' },
    { id: 'a3', client_id: 'c1', name: 'Northwind Holdings Inc' },
    { id: 'a4', client_id: 'c2', name: 'Bayside Bakery' },
  ];
  const contacts = [
    { id: 'p1', client_id: 'c1', account_id: 'a2', name: 'Robin Ortega', email: 'robin@cloudvape.test', phone: '5195550100' },
    { id: 'p2', client_id: 'c2', name: 'Café Owner', email: 'hello@bayside.test', phone: '+4412345678' },
  ];
  const relationships = [
    { id: 'r1', account_id: 'a1', business_id: A, kind: 'website', status: 'active' },
    { id: 'r2', account_id: 'a1', business_id: A, kind: 'social', status: 'active' },
    { id: 'r3', account_id: 'a2', business_id: W, kind: 'wholesale', status: 'active' },
    { id: 'r4', account_id: 'a3', business_id: C, kind: 'consulting', status: 'ended' },
  ];
  const activities = [
    { id: '01', client_id: 'c1', type: 'note', at: '2026-10-01T10:00:00.000Z', business_id: A, account_id: 'a1', body: 'Q4 social plan' },
    { id: '02', client_id: 'c1', type: 'call', at: '2026-10-03T10:00:00.000Z', business_id: W, account_id: 'a2', body: 'Wants 40 tins' },
    { id: '03', client_id: 'c1', type: 'note', at: '2026-10-02T10:00:00.000Z', business_id: null, account_id: null, body: 'General' },
    { id: '04', client_id: 'c1', type: 'meeting', at: '2026-10-02T10:00:00.000Z', business_id: C, account_id: 'a3', body: 'Growth plan' },
    { id: '05', client_id: 'c2', type: 'note', at: '2026-09-01T10:00:00.000Z', business_id: null, account_id: 'a4', body: 'Hi' },
  ];
  return { clients, accounts, contacts, relationships, activities };
}

const ids = (rows) => rows.map((r) => r.client.id);

test('the index: account names, the businesses they work with (any status), last activity, sorted by name', () => {
  const index = buildClientIndex(example());
  assert.deepEqual(ids(index), ['c2', 'c1', 'c3']);
  const c1 = index.find((r) => r.client.id === 'c1');
  assert.deepEqual(c1.accountNames, ['Cloud Vape Co', 'Green Leaf Dispensary', 'Northwind Holdings Inc']);
  assert.deepEqual(new Set(c1.businessIds), new Set([A, W, C]), 'an ended relationship still counts, as on the server');
  assert.equal(c1.lastActivityAt, '2026-10-03T10:00:00.000Z');
  assert.equal(index.find((r) => r.client.id === 'c3').lastActivityAt, null);
});

test('search: client, account and contact names, emails, any word order, accents and apostrophes ignored', () => {
  const index = buildClientIndex(example());
  const find = (q, status = 'all') => ids(filterClients(index, { q, status }));
  assert.deepEqual(find('northwind'), ['c1']);
  assert.deepEqual(find('dispens'), ['c1'], 'part of an account name');
  assert.deepEqual(find('ortega'), ['c1'], 'a contact name');
  assert.deepEqual(find('robin@cloud'), ['c1'], 'an email');
  assert.deepEqual(find('vape robin'), ['c1'], 'words in any order, across records');
  assert.deepEqual(find('cafe'), ['c2'], 'accents folded');
  assert.deepEqual(find('zeds'), ['c3'], 'apostrophes folded');
  assert.deepEqual(find('nothing like this'), []);
  assert.deepEqual(find(''), ['c2', 'c1', 'c3']);
  assert.equal(fold('Lefty’s CAFÉ'), 'leftys cafe');
});

test('search: a phone typed any way, in part or in full', () => {
  const index = buildClientIndex(example());
  const find = (q) => ids(filterClients(index, { q, status: 'all' }));
  for (const q of ['(519) 555', '519-555-0100', '+1 519 555 0100', '1 (519) 555-0100', '555 01', '519.555']) {
    assert.deepEqual(find(q), ['c1'], q);
  }
  assert.deepEqual(find('+44 1234'), ['c2'], 'international, with its country code');
  assert.deepEqual(find('0044 12345678'), ['c2']);
  assert.equal(parseQuery('51').phone, null, 'fewer than 3 digits is not a phone search');
  assert.equal(parseQuery('robin').phone, null);
  assert.equal(parseQuery('(519) 555').phone, '519555');
});

test('filters: our business (any relationship) and status (active by default)', () => {
  const index = buildClientIndex(example());
  assert.deepEqual(ids(filterClients(index)), ['c2', 'c1'], 'active only by default');
  assert.deepEqual(ids(filterClients(index, { status: 'closed' })), ['c3']);
  assert.deepEqual(ids(filterClients(index, { business: A })), ['c1']);
  assert.deepEqual(ids(filterClients(index, { business: C })), ['c1'], 'the ended consulting relationship still finds them');
  assert.deepEqual(ids(filterClients(index, { business: BUSINESS_IDS.save_point, status: 'all' })), []);
  assert.deepEqual(ids(filterClients(index, { business: W, q: '519 555' })), ['c1'], 'filters combine');
});

test('the index stays quick with a few thousand clients', () => {
  const n = 5000;
  const data = { clients: [], accounts: [], contacts: [], relationships: [], activities: [] };
  for (let i = 0; i < n; i++) {
    data.clients.push({ id: `c${i}`, name: `Client ${i}`, status: i % 7 ? 'active' : 'closed' });
    data.accounts.push({ id: `a${i}`, client_id: `c${i}`, name: `Store ${i}` });
    data.contacts.push({ id: `p${i}`, client_id: `c${i}`, name: `Person ${i}`, email: `p${i}@x.test`, phone: `519555${String(i).padStart(4, '0')}` });
    data.relationships.push({ id: `r${i}`, account_id: `a${i}`, business_id: i % 2 ? W : A });
    for (let k = 0; k < 4; k++) data.activities.push({ id: `t${i}-${k}`, client_id: `c${i}`, at: `2026-0${1 + k}-01T00:00:00.000Z` });
  }
  let t0 = performance.now();
  const index = buildClientIndex(data);
  const build = performance.now() - t0;
  t0 = performance.now();
  for (const q of ['s', 'st', 'sto', 'stor', 'store 4', '555 0042', 'p42@']) filterClients(index, { q, business: W, status: 'all' });
  const perKeystroke = (performance.now() - t0) / 7;
  assert.deepEqual(ids(filterClients(index, { q: '(519) 555-0042', status: 'all' })), ['c42']);
  assert.ok(build < 1000, `index built in ${build.toFixed(0)} ms`);
  assert.ok(perKeystroke < 50, `a keystroke filters in ${perKeystroke.toFixed(1)} ms`);
});

test('timeline: newest first; each filter matches only its own value, and items with none show only under All', () => {
  const { activities } = example();
  const mine = activities.filter((t) => t.client_id === 'c1');
  assert.deepEqual(sortTimeline(mine).map((t) => t.id), ['02', '04', '03', '01'], 'by time, then later-made first');
  const f = (filter) => filterTimeline(mine, filter).map((t) => t.id);
  assert.deepEqual(f({}), ['02', '04', '03', '01']);
  assert.deepEqual(f({ business: A }), ['01'], 'the agency only; the general note is not under it');
  assert.deepEqual(f({ account: 'a2' }), ['02'], 'the vape shop only');
  assert.deepEqual(f({ business: C, account: 'a3' }), ['04']);
  assert.deepEqual(f({ type: 'note' }), ['03', '01']);
  assert.deepEqual(f({ business: W, type: 'note' }), []);
});

test('money: cents shown as dollars, dollars typed as cents', () => {
  assert.equal(formatMoney(150000), '$1,500');
  assert.equal(formatMoney(12550), '$125.50');
  assert.equal(formatMoney(5), '$0.05');
  assert.equal(formatMoney(null), '');
  assert.equal(parseDollars('1,500'), 150000);
  assert.equal(parseDollars('$1500.5'), 150050);
  assert.equal(parseDollars(' 99.99 '), 9999);
  assert.equal(parseDollars('0.1'), 10);
  assert.equal(parseDollars(''), null);
  for (const bad of ['abc', '1.234', '-5', '1e3', '12.3.4']) assert.ok(Number.isNaN(parseDollars(bad)), bad);
  assert.equal(centsToInput(150000), '1500');
  assert.equal(centsToInput(150050), '1500.50');
  assert.equal(centsToInput(null), '');
});

test('billing summary of a service', () => {
  assert.equal(billingSummary({ billing: 'flat', amount_cents: 150000, period: 'monthly' }), '$1,500 / month');
  assert.equal(billingSummary({ billing: 'flat', amount_cents: 300000, period: 'once' }), '$3,000 one-off');
  assert.equal(billingSummary({ billing: 'hourly', rate_cents: 12000, sessions: 10 }), '$120 / hour · 10 sessions');
  assert.equal(billingSummary({ billing: 'hourly', rate_cents: 9550, amount_cents: 100000, period: 'quarterly' }), '$95.50 / hour · $1,000 / quarter');
  assert.equal(billingSummary({ billing: 'flat' }), 'Flat fee');
  assert.equal(billingSummary({ amount_cents: 50000, period: 'yearly', sessions: 1 }), '$500 / year · 1 session');
  assert.equal(billingSummary({}), '');
});

test('consent per business, as shown on the contact (the device’s local date)', () => {
  const rows = [
    { id: '1', business_id: W, withdrawn: false, date: '2026-01-10', kind: 'express' },
    { id: '2', business_id: A, withdrawn: false, date: '2026-01-10', kind: 'implied_inquiry' },
    { id: '3', business_id: C, withdrawn: false, date: '2026-01-10', kind: 'implied_purchase', expires_on: '2028-01-10' },
    { id: '4', business_id: C, withdrawn: true, date: '2026-05-01' },
  ];
  const today = '2026-10-07';
  assert.deepEqual(consentView(rows, W, today), {
    state: 'given', label: 'Given', tone: 'ok', kind: 'Express', date: '2026-01-10', until: null, source: null,
  });
  const inquiry = consentView(rows, A, today);
  assert.deepEqual([inquiry.state, inquiry.kind, inquiry.until], ['expired', 'Implied · inquiry', '2026-07-10'], '6 months, then it lapses');
  assert.equal(consentView(rows, A, '2026-07-09').state, 'given');
  assert.deepEqual([consentView(rows, C, today).state, consentView(rows, C, today).date], ['withdrawn', '2026-05-01']);
  assert.equal(consentView(rows, BUSINESS_IDS.save_point, today).state, 'none');
});

test('store errors in plain English', () => {
  const e = (code, msg) => errorText(new SyncError(code, msg));
  assert.equal(e('invalid_value', 'name is required'), 'Name is required.');
  assert.equal(e('invalid_value', 'business_id is required'), 'Our business is required.');
  assert.match(e('invalid_value', 'phone: not a valid phone number (10 digits for North America, "+" and the country code for others)'), /^Phone isn’t a phone number we can save: type all 10 digits/);
  assert.match(e('invalid_value', 'email: not a valid email address (trimmed, lowercase, NFC)'), /^Email isn’t an email address/);
  assert.equal(e('invalid_value', 'name: not a valid text'), 'Name is too long.');
  assert.equal(e('invalid_value', 'start_date: not a valid date'), 'Start date isn’t valid.');
  assert.match(e('not_ready', 'x'), /hasn’t connected/);
  assert.match(e('storage_full', 'x'), /out of storage/);
  assert.match(e('not_found', 'x'), /isn’t on this device/);
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText(null), null);
});

test('businesses: colours (own, then a default per seeded business), short names, pickers hide archived', () => {
  assert.equal(businessColor({ id: W, color: '#123abc' }), '#123abc');
  assert.match(businessColor({ id: W, color: null }), /^#[0-9a-f]{6}$/);
  assert.notEqual(businessColor({ id: W }), businessColor({ id: A }));
  assert.match(businessColor({ id: 'x-other', color: 'red' }), /^#[0-9a-f]{6}$/, 'not #rrggbb: a spare colour');
  assert.equal(businessShortName({ name: 'Wholesale' }), 'Wholesale');
  assert.equal(businessShortName({ name: 'Great White North Design' }), 'GWND');
  assert.equal(businessShortName({ name: 'Business consulting' }), 'BC');
  const list = [
    { id: '2', name: 'B', position: 2 }, { id: '1', name: 'A', position: 1 }, { id: '3', name: 'Old', position: 3, archived: true },
  ];
  assert.deepEqual(pickableBusinesses(list).map((b) => b.id), ['1', '2']);
  assert.deepEqual(pickableBusinesses(list, '3').map((b) => b.id), ['1', '2', '3'], 'the record’s own (archived) business stays pickable');
  assert.equal(defaultKindFor(W), 'wholesale');
  assert.equal(defaultKindFor(C), 'consulting');
  assert.equal(defaultKindFor(BUSINESS_IDS.personal), '');
});

test('small display helpers: who, websites, addresses', () => {
  assert.equal(actorLabel('owner', 'owner'), 'You');
  assert.equal(actorLabel('partner', 'owner'), 'Your partner');
  assert.equal(actorLabel('system', 'owner'), 'Automatic');
  assert.equal(actorLabel(null, 'owner'), null);
  assert.equal(websiteHref('greenleaf.test'), 'https://greenleaf.test');
  assert.equal(websiteHref('http://x.test/a'), 'http://x.test/a');
  assert.equal(websiteHref('javascript:alert(1)'), null, 'never a script link');
  assert.equal(websiteHref(''), null);
  assert.deepEqual(addressLines({ street: '12 Main St', city: 'Simcoe', region: 'ON', postal_code: 'N3Y 4K3', country: 'Canada' }), ['12 Main St', 'Simcoe, ON N3Y 4K3', 'Canada']);
  assert.deepEqual(addressLines({ city: 'Simcoe' }), ['Simcoe']);
});

test('dates: datetime inputs are local time and round-trip; calendar dates never shift a day', () => {
  const iso = '2026-10-07T18:05:00.000Z';
  const local = toDateTimeInput(iso);
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(fromDateTimeInput(local), iso);
  assert.equal(fromDateTimeInput('2026-10-07T09:30'), new Date(2026, 9, 7, 9, 30).toISOString());
  assert.equal(fromDateTimeInput(''), null);
  assert.equal(fromDateTimeInput('yesterday'), null);
  assert.match(formatDate('2026-10-07'), /7/);
  assert.match(formatDate('2026-01-01'), /2026/, 'Jan 1 stays in 2026 (no UTC shift)');
  assert.equal(formatDate(null), '');
});
