import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail, isEmail, normalizePhone, isPhone, normalizePostalCode, isPostalCode, normalizeTags, parseTags, FORMATS,
} from '../normalize.js';
import { checkFieldValue, normalizeFieldValue } from '../fields.js';
import { newId } from '../ids.js';
import { OUR_BUSINESSES, BUSINESS_IDS, latestConsents, hasConsent, OWNERS, SHARED } from '../crm.js';
import { ACTORS } from '../actors.js';
import { isId } from '../ids.js';

test('emails: trimmed and lowercase, empty is null', () => {
  assert.equal(normalizeEmail('  Bob.Smith@Example.COM '), 'bob.smith@example.com');
  assert.equal(normalizeEmail('   '), null);
  assert.equal(normalizeEmail(null), null);
  assert.ok(isEmail('bob@example.com'));
  for (const bad of ['bob', 'bob@', '@x.com', 'bob@x', 'bob smith@x.com', `${'a'.repeat(250)}@x.com`]) assert.equal(isEmail(bad), false, bad);
});

test('phones: digits only, one form for North American numbers, extensions dropped', () => {
  const same = ['(519) 555-0100', '519.555.0100', '+1 519 555 0100', '1-519-555-0100', '5195550100', ' 519 555 0100 ext. 22', '519-555-0100 x22'];
  for (const typed of same) assert.equal(normalizePhone(typed), '5195550100', typed);
  assert.equal(normalizePhone('+44 20 7946 0958'), '442079460958', 'other countries keep their digits');
  assert.equal(normalizePhone('555-0100'), '5550100');
  assert.equal(normalizePhone(' - '), null);
  assert.ok(isPhone('5195550100'));
  for (const bad of ['555', '519-555-0100', '1234567890123456', '']) assert.equal(isPhone(bad), false, bad);
});

test('postal codes: uppercase, Canadian ones as "A1A 1A1"', () => {
  assert.equal(normalizePostalCode('n3y4k3'), 'N3Y 4K3');
  assert.equal(normalizePostalCode(' n3y   4k3 '), 'N3Y 4K3');
  assert.equal(normalizePostalCode('14201-1234'), '14201-1234');
  assert.equal(normalizePostalCode(''), null);
  assert.ok(isPostalCode('N3Y 4K3'));
  assert.equal(isPostalCode('n3y 4k3'), false);
});

test('tags: one text, no empties or repeats, order kept', () => {
  assert.equal(normalizeTags(' VIP , referral,, vip ;  slow   payer\nreferral'), 'VIP, referral, slow payer');
  assert.equal(normalizeTags(['a', 'b, c', 'A']), 'a, b c');
  assert.equal(normalizeTags(' , ;'), null);
  assert.deepEqual(parseTags('VIP, referral'), ['VIP', 'referral']);
  assert.deepEqual(parseTags(null), []);
});

test('a formatted field accepts only its stored form; normalizeFieldValue makes it', () => {
  const email = { name: 'email', type: 'text', max: 254, format: 'email' };
  const phone = { name: 'phone', type: 'text', max: 20, format: 'phone' };
  assert.equal(checkFieldValue(email, 'bob@example.com'), null);
  assert.match(checkFieldValue(email, 'Bob@Example.com'), /not stored as a clean email address/);
  assert.match(checkFieldValue(email, ' bob@example.com'), /not stored as a clean/);
  assert.match(checkFieldValue(email, 'not an email'), /not a valid email address/);
  assert.equal(checkFieldValue(email, null), null, 'optional and empty is fine');
  assert.equal(checkFieldValue(phone, '5195550100'), null);
  assert.match(checkFieldValue(phone, '519-555-0100'), /not stored as a clean phone number \(digits only/);
  assert.match(checkFieldValue(phone, '555'), /not a valid phone number/);
  assert.match(checkFieldValue(phone, '15195550100'), /not stored as a clean phone number/);
  assert.match(checkFieldValue({ name: 'x', type: 'text', format: 'nope' }, 'a'), /unknown format/);

  assert.equal(normalizeFieldValue(email, ' Bob@Example.com '), 'bob@example.com');
  assert.equal(normalizeFieldValue(phone, '+1 (519) 555-0100'), '5195550100');
  assert.equal(normalizeFieldValue(phone, '  '), null);
  assert.equal(normalizeFieldValue({ name: 'n', type: 'text' }, ' As Typed '), ' As Typed ', 'no format: unchanged');
  assert.equal(normalizeFieldValue(email, null), null);
  for (const [name, f] of Object.entries(FORMATS)) {
    assert.equal(typeof f.normalize, 'function', name);
    assert.equal(typeof f.valid, 'function', name);
  }
});

test('our businesses: six fixed UUIDv7 ids, default owners from the plan', () => {
  assert.equal(OUR_BUSINESSES.length, 6);
  assert.equal(new Set(OUR_BUSINESSES.map((b) => b.id)).size, 6);
  for (const b of OUR_BUSINESSES) {
    assert.ok(isId(b.id), b.name);
    assert.ok(OWNERS.includes(b.default_owner), b.name);
  }
  const owner = (key) => OUR_BUSINESSES.find((b) => b.id === BUSINESS_IDS[key]).default_owner;
  assert.deepEqual(['wholesale', 'agency', 'consulting'].map(owner), ['owner', 'owner', 'owner']);
  assert.equal(owner('save_point'), 'partner');
  assert.equal(owner('retail'), SHARED);
  assert.equal(owner('personal'), SHARED);
  assert.ok(!ACTORS.includes(SHARED), '"shared" is never an actor');
});

test('consent: the latest per business counts (date, then the later id); withdrawn means no', () => {
  const [a, b] = [newId(), newId()];
  const id1 = newId();
  const id2 = newId();
  const id3 = newId();
  const rows = [
    { id: id2, business_id: a, withdrawn: true, date: '2026-05-01' },
    { id: id1, business_id: a, withdrawn: false, date: '2026-01-10' },
    { id: id3, business_id: b, withdrawn: false, date: '2026-03-01' },
  ];
  const latest = latestConsents(rows);
  assert.equal(latest.get(a).id, id2);
  assert.equal(hasConsent(rows, a), false, 'withdrawn in May');
  assert.equal(hasConsent(rows, b), true);
  assert.equal(hasConsent(rows, newId()), false, 'never asked: no');
  // Recorded later with an older date (a form found in a drawer): the withdrawal still stands.
  const old = { id: newId(), business_id: a, withdrawn: false, date: '2026-02-01' };
  assert.equal(hasConsent([...rows, old], a), false);
  // Same day: the one recorded later (larger UUIDv7) wins.
  const again = { id: newId(), business_id: a, withdrawn: false, date: '2026-05-01' };
  assert.equal(hasConsent([...rows, again], a), true);
});
