// The Admin page's business form without React: the name and owner rules, the colour, and where a
// new business lands in the list (after every existing one, archived ones included).
// Invented names only.

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessForm, nextBusinessPosition, BUSINESS_NAME_MAX } from '../src/modules/crm/formFields.js';

const base = { name: 'Lefty’s Consulting', color: '#2f7d4f', default_owner: 'partner' };

test('a new business: the name is trimmed, the colour and owner are kept', () => {
  const r = businessForm.toFields({ ...base, name: '   Harbour Pantry  ' });
  assert.deepEqual(r.problems, {});
  assert.deepEqual(r.fields, { name: 'Harbour Pantry', color: '#2f7d4f', default_owner: 'partner' });
});

test('a name is needed, and not longer than the field allows', () => {
  assert.equal(businessForm.toFields({ ...base, name: '   ' }).problems.name, 'Give the business a name.');
  const long = 'x'.repeat(BUSINESS_NAME_MAX + 1);
  assert.match(businessForm.toFields({ ...base, name: long }).problems.name, /Up to 100 characters/);
  assert.deepEqual(businessForm.toFields({ ...base, name: 'x'.repeat(BUSINESS_NAME_MAX) }).problems, {});
});

test('the owner must be one of the three; the colour must be a #rrggbb value', () => {
  for (const owner of ['owner', 'partner', 'shared']) {
    assert.deepEqual(businessForm.toFields({ ...base, default_owner: owner }).problems, {});
  }
  assert.ok(businessForm.toFields({ ...base, default_owner: 'someone' }).problems.default_owner);
  assert.ok(businessForm.toFields({ ...base, color: 'green' }).problems.color);
  assert.ok(businessForm.toFields({ ...base, color: '#abc' }).problems.color);
});

test('the defaults start a new business as you (owner) in the default teal', () => {
  assert.deepEqual(businessForm.defaults, { name: '', color: '#1d5f78', default_owner: 'owner' });
});

test('a new business lands after every existing one, archived ones included, and positions are never reused', () => {
  assert.equal(nextBusinessPosition([]), 1);
  assert.equal(nextBusinessPosition([{ position: 1 }, { position: 2 }, { position: 6, archived: true }]), 7);
  // A missing position doesn't count as a place in the list.
  assert.equal(nextBusinessPosition([{ position: null }, { position: 3 }]), 4);
});
