// C7: the CSV reader, and the shared intake logic (cleaning, matching, plans, fingerprints,
// accounting column mapping) used by the quick-add brain dump and the CSV import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, readTable, detectDelimiter, CsvError } from '../csv.js';
import {
  nameKey, similarNames, cleanRow, buildMatchIndex, findMatch, flagRows, planRow, actionsFor, fingerprintText, rowKey,
  detectMapping, checkMapping, rowFromCells, MAPPING_KEYS,
} from '../intake.js';
import { BUSINESS_IDS } from '../crm.js';
import { newId } from '../ids.js';

const AGENCY = BUSINESS_IDS.agency;
const CONSULTING = BUSINESS_IDS.consulting;

// ---------------------------------------------------------------- CSV

test('csv: quotes, embedded commas, quotes and line breaks; both line-ending styles', () => {
  const text = 'Name,Notes,Phone\r\n"Lefty\'s, Inc.","Said ""call me""\r\nafter 5",519-555-0100\r\nPlain Co,ok,\n"Last","x"';
  assert.deepEqual(parseCsv(text).records, [
    ['Name', 'Notes', 'Phone'],
    ["Lefty's, Inc.", 'Said "call me"\r\nafter 5', '519-555-0100'],
    ['Plain Co', 'ok', ''],
    ['Last', 'x'],
  ]);
  assert.deepEqual(parseCsv('a,b\rc,d\r').records, [['a', 'b'], ['c', 'd']], 'old Mac line ends');
  assert.deepEqual(parseCsv('a,b\n\n\nc,d\n\n').records, [['a', 'b'], ['c', 'd']], 'blank lines left out');
});

test('csv: a byte-order mark, ";" and tab separators, spaces around values, empty quoted fields', () => {
  const bom = '﻿Customer;Email\n"Café Nord" ; nord@x.ca\n';
  const { records, delimiter } = parseCsv(bom);
  assert.equal(delimiter, ';');
  assert.deepEqual(records, [['Customer', 'Email'], ['Café Nord', 'nord@x.ca']]);
  assert.equal(detectDelimiter('a\tb\tc\n1,2\t3'), '\t');
  assert.equal(detectDelimiter('"a;b",c'), ',', 'separators inside quotes don’t count');
  assert.equal(detectDelimiter('just one column'), ',');
  assert.deepEqual(parseCsv('a,"",c\n').records, [['a', '', 'c']]);
  assert.deepEqual(parseCsv('"  spaced  ",x').records, [['  spaced  ', 'x']], 'quoted spaces are kept');
  assert.deepEqual(parseCsv('ab"c,d').records, [['ab"c', 'd']], 'a stray quote mid-field is text');
});

test('csv: readTable pads short rows, names blank headers, and stops at the row limit', () => {
  const t = readTable('Name,,Email\nA\nB,x,b@x.ca,extra\n');
  assert.deepEqual(t.headers, ['Name', 'Column 2', 'Email', 'Column 4']);
  assert.deepEqual(t.rows, [['A', '', '', ''], ['B', 'x', 'b@x.ca', 'extra']]);
  assert.deepEqual(readTable(''), { headers: [], rows: [], delimiter: ',' });
  const many = `Name\n${Array.from({ length: 11 }, (_, i) => `C${i}`).join('\n')}`;
  assert.equal(readTable(many, { maxRows: 11 }).rows.length, 11);
  assert.throws(() => readTable(many, { maxRows: 10 }), (e) => e instanceof CsvError && e.code === 'too_many_rows');
});

// ---------------------------------------------------------------- names

test('names: keys drop accents, apostrophes, punctuation and legal words; similar names', () => {
  assert.equal(nameKey('The Lefty’s Café Inc.'), 'leftys cafe');
  assert.equal(nameKey('Smith & Sons Ltd'), 'smith and sons');
  assert.equal(nameKey('  '), '');
  assert.equal(nameKey('The Co'), 'the co', 'only legal words: keep them rather than nothing');
  assert.ok(similarNames("Lefty's", 'Leftys Cannabis Dispensary'), 'the plan’s example');
  assert.ok(similarNames('Green Leaf', 'The Green Leaf Dispensary'));
  assert.ok(similarNames('Northwind', 'North Wind'));
  assert.ok(similarNames('Cloud Vape Co.', 'cloud vape'));
  assert.ok(!similarNames('Mike', "Mike's Plumbing"), 'mike ≠ mikes');
  assert.ok(!similarNames('Al', 'Al Rossi Holdings'), 'too short to say');
  assert.ok(!similarNames('Leaf Green', 'Green Leaf Dispensary'), 'words in another order');
  assert.ok(!similarNames('', 'x'));
});

// ---------------------------------------------------------------- cleaning

test('cleanRow: clean emails and phones, defaults, and what can’t be stored goes to notes with a warning', () => {
  const r = cleanRow({
    client: { name: '  Lefty’s   Cannabis ', tags: '#vip, retainer, VIP' },
    account: { postal_code: 'n3y4k3' },
    relationships: [{ business_id: AGENCY, kind: 'website' }, { business_id: AGENCY, kind: 'website' }, { business_id: 'x', kind: 'website' }],
    contact: { email: ' Mike@Leftys.CA ', phone: '+1 (519) 555-0100 ext. 22' },
  });
  assert.equal(r.client.name, 'Lefty’s Cannabis');
  assert.equal(r.client.tags, 'vip, retainer');
  assert.equal(r.account.name, 'Lefty’s Cannabis', 'account defaults to the client’s name');
  assert.equal(r.account.postal_code, 'N3Y 4K3');
  assert.deepEqual(r.relationships, [{ business_id: AGENCY, kind: 'website', notes: null }], 'one per business and kind; bad ones dropped');
  assert.deepEqual([r.contact.name, r.contact.email, r.contact.phone, r.contact.notes], ['Lefty’s Cannabis', 'mike@leftys.ca', '5195550100', 'Ext. 22']);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.problems, []);

  const local = cleanRow({ client: { name: 'Corner Store' }, contact: { name: 'Pat', phone: '555-0100', email: 'pat@corner' } });
  assert.equal(local.contact.phone, null);
  assert.equal(local.contact.email, null);
  assert.equal(local.contact.notes, 'Email as typed: pat@corner\nPhone as typed: 555-0100');
  assert.equal(local.warnings.length, 2);
  assert.match(local.warnings[1], /555-0100.*needs the area code.*notes as typed/);
  const foreign = cleanRow({ client: { name: 'Shanghai Trading' }, contact: { phone: '138 0013 8000' } });
  assert.match(foreign.warnings[0], /country code/);
  assert.equal(foreign.contact.notes, 'Phone as typed: 138 0013 8000');

  const bad = cleanRow({ client: { name: '' }, account: { postal_code: '!!' } });
  assert.deepEqual(bad.problems, ['Needs a client name']);
  assert.equal(bad.account.notes, 'Postal code as typed: !!');
  assert.equal(cleanRow({ client: { name: 'No contact' } }).contact, null);
  assert.equal(cleanRow({ client: { name: 'x'.repeat(300) } }).client.name.length, 200, 'clipped to fit');
});

// ---------------------------------------------------------------- matching

function existing() {
  const ids = { lefty: newId(), north: newId(), dup: newId() };
  const index = buildMatchIndex({
    clients: [{ id: ids.lefty, name: 'Lefebvre Holdings' }, { id: ids.north, name: 'Northwind Group' }],
    accounts: [{ client_id: ids.lefty, name: "Lefty's Cannabis Dispensary" }, { client_id: 'gone', name: 'Ghost Shop' }],
    contacts: [
      { client_id: ids.lefty, email: 'mike@leftys.ca', phone: '5195550100' },
      { client_id: ids.north, email: null, phone: '+4312345678' },
      { client_id: 'gone', email: 'ghost@x.ca', phone: null },
    ],
  });
  return { ids, index };
}

test('matching: same email or phone = already here; similar client or account name = maybe; records of deleted clients ignored', () => {
  const { ids, index } = existing();
  const row = (name, contact) => cleanRow({ client: { name }, contact });
  assert.deepEqual(findMatch(row('Anything', { email: 'MIKE@leftys.ca' }), index), { state: 'same', by: 'email', clientId: ids.lefty, clientName: 'Lefebvre Holdings' });
  assert.deepEqual(findMatch(row('Anything', { phone: '519.555.0100' }), index), { state: 'same', by: 'phone', clientId: ids.lefty, clientName: 'Lefebvre Holdings' });
  assert.equal(findMatch(row('Vienna', { phone: '0043 1 2345678' }), index).clientId, ids.north);
  const m = findMatch(row("Lefty's"), index);
  assert.deepEqual([m.state, m.clientId, m.name], ['similar', ids.lefty, "Lefty's Cannabis Dispensary"], 'via the account name');
  assert.equal(findMatch(row('northwind group inc'), index).state, 'similar');
  assert.equal(findMatch(row('Ghost Shop', { email: 'ghost@x.ca' }), index), null, 'under a deleted client');
  assert.equal(findMatch(row('Brand New Bakery', { email: 'new@bakery.ca' }), index), null);
  assert.equal(findMatch(row('Anything', { email: 'mike@leftys.ca' }), index, { exclude: new Set([ids.lefty]) }), null, 'its own client');
});

test('flagRows: invalid, same, similar, duplicates within the batch (email, phone or name), new', () => {
  const { index } = existing();
  const rows = [
    { client: { name: 'Fresh Bakery' }, contact: { email: 'a@fresh.ca' } },
    { client: { name: 'Other name' }, contact: { email: 'A@Fresh.ca' } },
    { client: { name: 'Third' }, contact: { phone: '226 555 0199' } },
    { client: { name: 'Fourth' }, contact: { phone: '(226) 555-0199' } },
    { client: { name: 'fresh bakery inc' } },
    { client: { name: 'Lefty’s' } },
    { client: { name: 'X' }, contact: { email: 'mike@leftys.ca' } },
    { client: { name: '' } },
  ].map(cleanRow);
  const flags = flagRows(rows, index);
  assert.deepEqual(flags.map((f) => f.state), ['new', 'duplicate', 'new', 'duplicate', 'duplicate', 'similar', 'same', 'invalid']);
  assert.deepEqual(flags.map((f) => f.duplicateOf ?? null), [null, 0, null, 2, 0, null, null, null]);
  assert.deepEqual(actionsFor('new'), ['create', 'skip']);
  assert.deepEqual(actionsFor('same'), ['skip', 'add', 'create']);
  assert.deepEqual(actionsFor('duplicate'), ['skip', 'create']);
  assert.deepEqual(actionsFor('invalid'), ['skip']);
});

// ---------------------------------------------------------------- plans

test('planRow create: client, account, a relationship per business and kind, contact — ids from makeId', () => {
  const row = cleanRow({
    client: { name: 'Port Dover Marina', tags: 'seasonal' },
    account: { name: 'Dover Docks Ltd' },
    relationships: [{ business_id: AGENCY, kind: 'website' }, { business_id: AGENCY, kind: 'social', notes: 'social retainer' }, { business_id: CONSULTING, kind: 'consulting' }],
    contact: { name: 'Sam Lee', email: 'sam@dover.test' },
  });
  const made = new Map();
  const makeId = (key) => { if (!made.has(key)) made.set(key, newId()); return made.get(key); };
  const plan = planRow(row, { action: 'create', makeId });
  assert.deepEqual(plan.ops.map((o) => o.entity), ['client', 'account', 'relationship', 'relationship', 'relationship', 'contact']);
  const [client, account, web, social, , contact] = plan.ops;
  assert.deepEqual(client.fields, { name: 'Port Dover Marina', status: 'active', tags: 'seasonal' });
  assert.deepEqual(account.fields, { client_id: client.id, name: 'Dover Docks Ltd' });
  assert.deepEqual(web.fields, { account_id: account.id, business_id: AGENCY, kind: 'website', status: 'active' });
  assert.equal(social.fields.notes, 'social retainer');
  assert.deepEqual(contact.fields, { client_id: client.id, account_id: account.id, name: 'Sam Lee', email: 'sam@dover.test' });
  // The same ids again: a retry makes the same records, never new ones.
  assert.deepEqual(planRow(row, { action: 'create', makeId }).ops.map((o) => o.id), plan.ops.map((o) => o.id));
});

test('planRow add: only what is missing on the existing client; nothing existing changes', () => {
  const clientId = newId();
  const shop = { id: newId(), client_id: clientId, name: 'Lefty’s Cannabis Dispensary' };
  const target = {
    client: { id: clientId, name: 'Lefebvre Holdings' },
    accounts: [shop],
    contacts: [{ id: newId(), client_id: clientId, name: 'Mike', email: 'mike@leftys.ca', phone: null }],
    relationships: [{ id: newId(), account_id: shop.id, business_id: AGENCY, kind: 'website' }],
  };
  const makeId = () => newId();
  // Same email, the website already there: only the social relationship is new, on the existing account.
  let plan = planRow(cleanRow({
    client: { name: 'Leftys' },
    relationships: [{ business_id: AGENCY, kind: 'website' }, { business_id: AGENCY, kind: 'social' }],
    contact: { name: 'Mike L', email: 'mike@leftys.ca' },
  }), { action: 'add', target, makeId });
  assert.deepEqual(plan.ops.map((o) => [o.entity, o.fields.kind ?? null]), [['relationship', 'social']]);
  assert.equal(plan.ops[0].fields.account_id, shop.id);
  assert.deepEqual(plan.summary, {
    client: 'existing', account: 'existing', contact: 'existing',
    relationships: [{ business_id: AGENCY, kind: 'website', state: 'existing' }, { business_id: AGENCY, kind: 'social', state: 'new' }],
  });
  // A new person: a new contact on the existing account.
  plan = planRow(cleanRow({ client: { name: 'Leftys' }, contact: { name: 'Jo', phone: '226 555 0142' } }), { action: 'add', target, makeId });
  assert.deepEqual(plan.ops.map((o) => o.entity), ['contact']);
  assert.deepEqual([plan.ops[0].fields.client_id, plan.ops[0].fields.account_id], [clientId, shop.id]);
  // A business of their own the client doesn't have yet: a new account, its relationship there.
  plan = planRow(cleanRow({ client: { name: 'Leftys' }, account: { name: 'Cloud Vape Co' }, relationships: [{ business_id: AGENCY, kind: 'website' }] }), { action: 'add', target, makeId });
  assert.deepEqual(plan.ops.map((o) => o.entity), ['account', 'relationship']);
  assert.equal(plan.ops[1].fields.account_id, plan.ops[0].id);
  // Nothing missing: nothing to do.
  plan = planRow(cleanRow({ client: { name: 'Leftys' }, contact: { email: 'mike@leftys.ca' } }), { action: 'add', target, makeId });
  assert.deepEqual(plan.ops, []);
  assert.throws(() => planRow(cleanRow({ client: { name: 'x' } }), { action: 'add', makeId }), /target/);
});

// ---------------------------------------------------------------- fingerprints and mapping

test('fingerprints: same values = same text; any edited value changes it; the business picked doesn’t', () => {
  const base = { client: { name: 'Acme Signs' }, account: { city: 'Simcoe' }, contact: { email: 'a@acme.ca', phone: '519 555 0100' } };
  const fp = fingerprintText(cleanRow(base));
  assert.equal(fingerprintText(cleanRow({ ...base, client: { name: '  ACME SIGNS inc ' }, contact: { email: 'A@ACME.CA', phone: '(519) 555-0100' } })), fp, 'typed differently, same values');
  assert.equal(fingerprintText(cleanRow({ ...base, relationships: [{ business_id: AGENCY, kind: 'website' }] })), fp);
  assert.notEqual(fingerprintText(cleanRow({ ...base, account: { city: 'Delhi' } })), fp);
  assert.equal(rowKey(cleanRow({ ...base, account: { city: 'Delhi' } })), rowKey(cleanRow(base)), 'still the same customer');
});

test('mapping: common headers from QuickBooks, Wave, Xero and FreshBooks exports are recognised', () => {
  const pick = (headers) => {
    const { mapping, source } = detectMapping(headers);
    return { source, ...Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== null).map(([k, v]) => [k, headers[v]])) };
  };
  assert.deepEqual(pick(['Customer', 'Company name', 'Street Address', 'City', 'Province/State', 'Country', 'Postal code/ZIP', 'Phone', 'Email', 'Open Balance', 'Notes']), {
    source: 'QuickBooks', name: 'Customer', company: 'Company name', street: 'Street Address', city: 'City', region: 'Province/State',
    country: 'Country', postal: 'Postal code/ZIP', phone: 'Phone', email: 'Email', notes: 'Notes',
  });
  assert.deepEqual(pick(['Customer', 'Company', 'First Name', 'Last Name', 'Main Phone', 'Mobile', 'Main Email', 'Bill to 1', 'Bill to 2']), {
    source: 'QuickBooks', name: 'Customer', company: 'Company', first: 'First Name', last: 'Last Name', phone: 'Main Phone', mobile: 'Mobile',
    email: 'Main Email', street: 'Bill to 1', street2: 'Bill to 2',
  });
  assert.deepEqual(pick(['Customer Name', 'Email', 'Phone', 'Contact First Name', 'Contact Last Name', 'Address Line 1', 'Address Line 2', 'City', 'Province/State', 'Postal Code/Zip Code', 'Country', 'Website', 'Mobile']), {
    source: 'Wave', name: 'Customer Name', email: 'Email', phone: 'Phone', first: 'Contact First Name', last: 'Contact Last Name',
    street: 'Address Line 1', street2: 'Address Line 2', city: 'City', region: 'Province/State', postal: 'Postal Code/Zip Code',
    country: 'Country', website: 'Website', mobile: 'Mobile',
  });
  assert.deepEqual(pick(['*ContactName', 'EmailAddress', 'FirstName', 'LastName', 'POAddressLine1', 'POAddressLine2', 'POCity', 'PORegion', 'POPostalCode', 'POCountry', 'PhoneNumber', 'MobileNumber', 'Website']), {
    source: 'Xero', name: '*ContactName', email: 'EmailAddress', first: 'FirstName', last: 'LastName', street: 'POAddressLine1',
    street2: 'POAddressLine2', city: 'POCity', region: 'PORegion', postal: 'POPostalCode', country: 'POCountry', phone: 'PhoneNumber', mobile: 'MobileNumber', website: 'Website',
  });
  assert.deepEqual(pick(['First Name', 'Last Name', 'Organization', 'Email', 'Phone', 'Mobile', 'Street', 'Street 2', 'City', 'Province', 'Country', 'Postal Code', 'Notes']), {
    source: 'FreshBooks', first: 'First Name', last: 'Last Name', company: 'Organization', email: 'Email', phone: 'Phone', mobile: 'Mobile',
    street: 'Street', street2: 'Street 2', city: 'City', region: 'Province', country: 'Country', postal: 'Postal Code', notes: 'Notes',
  });
  assert.deepEqual(pick(['Foo', 'Bar']), { source: null });
  assert.deepEqual(checkMapping({ name: 0, email: 7, phone: -1, nonsense: 1 }, 3), { ...Object.fromEntries(MAPPING_KEYS.map((k) => [k, null])), name: 0 });
});

test('rowFromCells: client from the customer name (else company, else person); a second number in notes', () => {
  const headers = ['First Name', 'Last Name', 'Organization', 'Email', 'Phone', 'Mobile', 'Street', 'Street 2', 'Notes'];
  const { mapping } = detectMapping(headers);
  const row = cleanRow(rowFromCells(['Jo', 'Park', 'Park Bakery', 'jo@park.test', '519 555 0123', '226-555-0124', '1 Main St', 'Unit 2', 'Pays net 30\nLikes email'], mapping, {
    relationships: [{ business_id: CONSULTING, kind: 'consulting' }],
  }));
  assert.deepEqual([row.client.name, row.account.name, row.account.street, row.client.notes], ['Park Bakery', 'Park Bakery', '1 Main St, Unit 2', 'Pays net 30\nLikes email']);
  assert.deepEqual([row.contact.name, row.contact.email, row.contact.phone, row.contact.notes], ['Jo Park', 'jo@park.test', '5195550123', 'Mobile: 226-555-0124']);
  assert.equal(row.relationships[0].kind, 'consulting');
  const person = cleanRow(rowFromCells(['Ann', 'Lee', '', '', '', '', '', '', ''], mapping));
  assert.deepEqual([person.client.name, person.contact.name], ['Ann Lee', 'Ann Lee']);
});
