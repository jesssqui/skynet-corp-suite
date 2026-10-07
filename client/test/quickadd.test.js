// The quick-add brain dump's logic (C7), without a browser: the forgiving line parser, rows
// flagged against the device's copy, choices, edits and lines already added this session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { cleanRow, planRow } from '@suite/shared/intake';
import { newId } from '@suite/shared/ids';
import {
  parseLine, splitLines, buildRows, targetFrom, saveCounts, editRow, toggleRelationship, EXAMPLE, RELATIONSHIP_CHOICES, choiceId,
} from '../src/modules/crm/quickAdd.js';

const { wholesale: W, agency: A, consulting: C } = BUSINESS_IDS;
const DEFAULT = [{ business_id: A, kind: 'website' }];

/** parseLine -> cleanRow, summarised. */
function parsed(line, defaults = DEFAULT) {
  const typed = parseLine(line, { defaults });
  const r = cleanRow(typed);
  return {
    client: r.client.name,
    account: r.account.name,
    rels: r.relationships.map((x) => `${choiceId(x)}${x.notes ? ` (${x.notes})` : ''}`),
    contact: r.contact ? [r.contact.name, r.contact.email, r.contact.phone].filter(Boolean).join(' | ') : null,
    tags: r.client.tags,
    notes: r.client.notes,
    contactNotes: r.contact?.notes ?? null,
    role: r.contact?.role ?? null,
    warnings: r.warnings,
    usedDefault: typed.usedDefault,
  };
}

test('the plan’s example lines: our businesses and kinds from keywords, extra words in the relationship’s notes', () => {
  assert.deepEqual(parsed('Cannabis dispensary | website, social retainer').rels, ['agency:website', 'agency:social (social retainer)']);
  assert.deepEqual(parsed('Vape shop | wholesale customer').rels, ['wholesale:wholesale (wholesale customer)']);
  assert.deepEqual(parsed('Parent company — growth consulting').rels, ['consulting:consulting (growth consulting)']);
  const r = parsed('Northwind Holdings (Green Leaf Dispensary) - web + social media - wholesale');
  assert.deepEqual([r.client, r.account, r.rels], ['Northwind Holdings', 'Green Leaf Dispensary', ['agency:website', 'agency:social', 'wholesale:wholesale']]);
  assert.equal(r.usedDefault, false);
});

test('every example on the page parses as it says', () => {
  const rows = EXAMPLE.split('\n').map((l) => parsed(l));
  assert.deepEqual(rows.map((r) => [r.client, r.account, r.rels, r.contact]), [
    ['Harbour Lights Bakery', 'Harbour Lights Bakery', ['agency:website', 'agency:social (social retainer)'], 'Ada Moss | ada@harbourlights.test | 5195550101'],
    ['Birch & Bark', 'Birch & Bark', ['consulting:consulting'], 'Ben Cole | 5195550102'],
    ['Northwind Holdings', 'Green Leaf Dispensary', ['agency:website'], 'Robin Ortega | robin@greenleaf.test'],
    ['Kettle Creek Outfitters', 'Kettle Creek Outfitters', ['agency:website'], null],
    ['Lakeview Dental', 'Lakeview Dental', ['agency:website'], null],
  ]);
  assert.equal(rows[2].role, 'Owner');
  assert.deepEqual([rows[3].tags, rows[3].notes], ['referral', 'wants a quote before spring']);
  assert.equal(rows[4].usedDefault, true, 'no keyword: the page’s default business');
});

test('separators: " - ", em and en dashes, commas, semicolons, pipes and tabs all work; hyphens inside words don’t split', () => {
  const lines = [
    'Coca-Cola Bottlers - consulting - Sam Lee',
    'Coca-Cola Bottlers — consulting — Sam Lee',
    'Coca-Cola Bottlers–consulting–Sam Lee',
    'Coca-Cola Bottlers, consulting, Sam Lee',
    'Coca-Cola Bottlers; consulting; Sam Lee',
    'Coca-Cola Bottlers | consulting | Sam Lee',
    'Coca-Cola Bottlers\tconsulting\tSam Lee',
    '  - Coca-Cola Bottlers -- consulting -- Sam Lee',
    '3. Coca-Cola Bottlers | consulting | Sam Lee',
  ];
  for (const l of lines) {
    const r = parsed(l);
    assert.deepEqual([r.client, r.rels, r.contact], ['Coca-Cola Bottlers', ['consulting:consulting'], 'Sam Lee'], JSON.stringify(l));
  }
});

test('emails and phones anywhere in the line; the words beside them are the contact', () => {
  const cases = [
    ['ada@x.test Harbour Lights', 'Harbour Lights', 'Harbour Lights | ada@x.test'],
    ['Harbour Lights 519-555-0101', 'Harbour Lights', 'Harbour Lights | 5195550101'],
    ['Harbour Lights - Ada Moss (519) 555-0101 ada@x.test', 'Harbour Lights', 'Ada Moss | ada@x.test | 5195550101'],
    ['Harbour Lights - 519.555.0101 - Ada Moss - ADA@X.TEST', 'Harbour Lights', 'Ada Moss | ada@x.test | 5195550101'],
    ['Harbour Lights | email: ada@x.test | phone: +1 519 555 0101', 'Harbour Lights', 'Harbour Lights | ada@x.test | 5195550101'],
    ['Harbour Lights, mailto:ada@x.test, cell 226 555 0199', 'Harbour Lights', 'Harbour Lights | ada@x.test | 2265550199'],
    ['Vienna Coffee | +43 1 2345678 | Anna', 'Vienna Coffee', 'Anna | +4312345678'],
  ];
  for (const [line, client, contact] of cases) {
    const r = parsed(line);
    assert.deepEqual([r.client, r.contact], [client, contact], line);
  }
  const two = parsed('Harbour Lights - ada@x.test, bo@x.test - 519-555-0101 / 519-555-0199 x22');
  assert.equal(two.contact, 'Harbour Lights | ada@x.test | 5195550101');
  assert.equal(two.contactNotes, 'Also: bo@x.test\nAlso: 519-555-0199 x22');
  // Not phones: a date, a short number in a name.
  const notPhone = parsed('Studio 54 - started 2026-03-01');
  assert.equal(notPhone.contact, null);
  assert.equal(notPhone.client, 'Studio 54');
});

test('phones the normaliser refuses go into the contact’s notes as typed, and the row says so', () => {
  const local = parsed('Corner Store - Pat - 555-0100');
  assert.equal(local.contact, 'Pat');
  assert.equal(local.contactNotes, 'Phone as typed: 555-0100');
  assert.match(local.warnings[0], /555-0100.*needs the area code/);
  const foreign = parsed('Shanghai Trading | 138 0013 8000');
  assert.match(foreign.warnings[0], /country code/);
  const ext = parsed('Desk Co - 519 555 0100 ext. 4');
  assert.deepEqual([ext.contact, ext.contactNotes, ext.warnings], ['Desk Co | 5195550100', 'Ext. 4', []]);
});

test('labels, hashtags, tags and notes; leftovers become a contact, tags or notes', () => {
  const r = parsed('Bayside Bakery | account: Bayside Café | contact: Jo Park | role: Manager | #vip | tags: bread, retail | notes: met at the market, call in May');
  assert.deepEqual([r.client, r.account, r.contact, r.role, r.tags, r.notes],
    ['Bayside Bakery', 'Bayside Café', 'Jo Park', 'Manager', 'vip, bread, retail', 'met at the market, call in May']);
  const left = parsed('Bayside Bakery - Jo Park - Simcoe - prefers texts after lunch on weekdays');
  assert.deepEqual([left.contact, left.tags, left.notes, left.contactNotes], ['Jo Park', 'Simcoe', null, 'prefers texts after lunch on weekdays']);
});

test('a line with only a name: client and account by that name, the default relationship, no contact', () => {
  const r = parsed('Lakeview Dental');
  assert.deepEqual([r.client, r.account, r.rels, r.contact, r.tags], ['Lakeview Dental', 'Lakeview Dental', ['agency:website'], null, null]);
  assert.deepEqual(parsed('Lakeview Dental', []).rels, [], 'no default: no relationship');
  assert.deepEqual(parsed('Lakeview Dental', [{ business_id: C, kind: 'consulting' }]).rels, ['consulting:consulting']);
});

test('lines: blank and punctuation-only lines are skipped; identical lines are separate rows with stable keys', () => {
  const lines = splitLines('A Co\n\n  \n---\nB Co\r\nA Co\n');
  assert.deepEqual(lines.map((l) => [l.number, l.text]), [[1, 'A Co'], [5, 'B Co'], [6, 'A Co']]);
  assert.notEqual(lines[0].key, lines[2].key);
  assert.equal(splitLines('x\nA Co\nB Co\nA Co')[1].key, lines[0].key, 'a key doesn’t depend on where the line is');
});

function device() {
  const lefty = newId();
  const shop = newId();
  return {
    lefty,
    shop,
    data: {
      clients: [{ id: lefty, name: 'Lefebvre Holdings', status: 'active' }],
      accounts: [{ id: shop, client_id: lefty, name: 'Lefty’s Cannabis Dispensary' }],
      contacts: [{ id: newId(), client_id: lefty, name: 'Mike', email: 'mike@leftys.test', phone: '5195550100' }],
      relationships: [{ id: newId(), account_id: shop, business_id: A, kind: 'website' }],
    },
  };
}

test('rows are flagged against the device’s copy: already here, maybe the same, same as an earlier line', () => {
  const { data, lefty } = device();
  const text = ['Brand New Bakery - x@new.test', 'Someone - MIKE@leftys.test', "Lefty's - social", 'Brand New Bakery', 'Nobody - 519 555 0100', ' - , '].join('\n');
  const rows = buildRows(text, { data, defaults: DEFAULT });
  assert.deepEqual(rows.map((r) => [r.line, r.status, r.action]), [
    [1, 'new', 'create'], [2, 'same', 'skip'], [3, 'similar', 'skip'], [4, 'duplicate', 'skip'], [5, 'same', 'skip'],
  ]);
  assert.deepEqual([rows[1].match.by, rows[1].match.clientId, rows[4].match.by], ['email', lefty, 'phone']);
  assert.equal(rows[3].duplicateOf, 1);
  assert.deepEqual(saveCounts(rows), { create: 1, add: 0, skip: 4 });
  // A choice counts while the row is in the state it was made for.
  const choices = new Map([[rows[2].key, { action: 'add', status: 'similar' }], [rows[0].key, { action: 'add', status: 'similar' }]]);
  const chosen = buildRows(text, { data, defaults: DEFAULT, choices });
  assert.deepEqual([chosen[2].action, chosen[0].action], ['add', 'create']);
  // Add only what's missing: the social relationship, on the existing account.
  const plan = planRow(chosen[2].clean, { action: 'add', target: targetFrom(data, lefty), makeId: () => newId() });
  assert.deepEqual(plan.ops.map((o) => [o.entity, o.fields.kind, o.fields.account_id]), [['relationship', 'social', data.accounts[0].id]]);
});

test('edits replace a row; rows already added this session are done, and their own records don’t flag them', () => {
  const { data } = device();
  const text = 'Harbour Lights - ada@x.test\nBirch & Bark';
  const [first] = buildRows(text, { data, defaults: DEFAULT });
  let typed = editRow(first.typed, 'client.name', 'Harbour Lights Bakery');
  typed = toggleRelationship(typed, RELATIONSHIP_CHOICES.find((c) => c.id === 'consulting:consulting'), true);
  typed = toggleRelationship(typed, RELATIONSHIP_CHOICES.find((c) => c.id === 'agency:website'), false);
  const edits = new Map([[first.key, typed]]);
  const rows = buildRows(text, { data, defaults: DEFAULT, edits });
  assert.deepEqual([rows[0].clean.client.name, rows[0].clean.relationships.map(choiceId), rows[0].edited], ['Harbour Lights Bakery', ['consulting:consulting'], true]);

  // Created (partly, then fully): the row's own client is on the device now.
  const ids = { client: newId() };
  const withOwn = {
    ...data,
    clients: [...data.clients, { id: ids.client, name: 'Harbour Lights Bakery', status: 'active' }],
    contacts: [...data.contacts, { id: newId(), client_id: ids.client, name: 'Harbour Lights Bakery', email: 'ada@x.test', phone: null }],
  };
  const partly = buildRows(text, { data: withOwn, defaults: DEFAULT, edits, session: new Map([[first.key, { ids, done: false }]]) });
  assert.deepEqual([partly[0].status, partly[0].action], ['new', 'create'], 'its own client doesn’t make it "already here": a retry finishes it');
  const done = buildRows(text, { data: withOwn, defaults: DEFAULT, edits, session: new Map([[first.key, { ids, done: true, clientId: ids.client }]]) });
  assert.deepEqual([done[0].status, done[0].actions, done[0].clientId], ['done', [], ids.client]);
  assert.deepEqual(saveCounts(done), { create: 1, add: 0, skip: 0 });
  // Pasted again in a new session: already here.
  assert.equal(buildRows(text, { data: withOwn, defaults: DEFAULT })[0].status, 'same');
});

test('wholesale is still selectable per row, and as the default', () => {
  assert.ok(RELATIONSHIP_CHOICES.some((c) => c.business_id === W && c.kind === 'wholesale'));
  assert.deepEqual(parsed('Cloud Vape Co', [{ business_id: W, kind: 'wholesale' }]).rels, ['wholesale:wholesale']);
});
