process.env.TZ = 'America/Toronto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTable } from '../csv.js';
import { leadRowsFromTable, cleanLeadRow, dayToIso } from '../leadImport.js';

const clean = (csv) => leadRowsFromTable(readTable(csv)).map((r) => cleanLeadRow(r.cells, { fileName: 'f.csv', rowNumber: r.rowNumber }));

test('rows: the header is row 1, a file needs company_name', () => {
  const rows = leadRowsFromTable(readTable('Company Name,city\nA,Guelph\nB,Brantford\n'));
  assert.deepEqual(rows.map((r) => r.rowNumber), [2, 3]);
  assert.equal(rows[0].cells.company_name, 'A');
  assert.throws(() => leadRowsFromTable(readTable('a,b\n1,2\n')), (e) => e.code === 'no_name_column');
});

test('a clean row: lead stage, value in cents, email and phone in stored forms, a follow-up task', () => {
  const [c] = clean('company_name,contact_email,business_phone,estimated_value,next_action_on\nAcme Paving,Info@Acme.ca,(519) 555-0100,595,2026-10-21\n');
  assert.equal(c.name, 'Acme Paving');
  assert.equal(c.fields.stage, 'lead');
  assert.equal(c.fields.source, 'scraped');
  assert.equal(c.fields.value_cents, 59500);
  assert.equal(c.email, 'info@acme.ca');
  assert.equal(c.phone, '5195550100');
  assert.deepEqual(c.problems, []);
  assert.equal(c.task.due_date, '2026-10-21');
  assert.equal(c.task.title, 'Follow up: Acme Paving');
});

test('what cannot be stored becomes a warning, never a guess', () => {
  const [c] = clean('company_name,contact_email,business_phone,estimated_value,next_action_on\nBad Co,nope,123,abc,someday\n');
  assert.equal(c.email, null);
  assert.equal(c.phone, null);
  assert.equal(c.fields.value_cents, undefined);
  assert.equal(c.task, null);
  assert.ok(c.warnings.length >= 1);
  assert.deepEqual(c.problems, []);
});

test('no name is a problem; excluded rows become lost / not a fit', () => {
  const [none, dne] = clean('company_name,contact_email,do_not_email\n,x@y.ca,\nNo Mail Ltd,n@m.ca,excluded\n');
  assert.deepEqual(none.problems, ['No business name']);
  assert.equal(dne.fields.stage, 'lost');
  assert.equal(dne.fields.lost_reason, 'not_a_fit');
  assert.ok(dne.activities.some((a) => a.type === 'stage' && a.stage_to === 'lost'));
});

test('dayToIso keeps the calendar day; junk is null', () => {
  assert.equal(dayToIso('2026-10-21'), '2026-10-21T16:00:00.000Z');
  assert.equal(dayToIso('2026-02-31'), null);
  assert.equal(dayToIso('soon'), null);
});
