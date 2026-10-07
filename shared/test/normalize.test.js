import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail, isEmail, normalizePhone, isPhone, formatPhone, normalizePostalCode, isPostalCode, normalizeTags, parseTags, FORMATS,
} from '../normalize.js';
import { checkFieldValue, normalizeFieldValue } from '../fields.js';
import { newId } from '../ids.js';
import {
  OUR_BUSINESSES, BUSINESS_IDS, latestConsents, hasConsent, consentStatus, consentExpiresOn, addMonths, OWNERS, SHARED,
} from '../crm.js';
import { ACTORS } from '../actors.js';
import { isId } from '../ids.js';

test('emails: NFC, invisible characters gone, trimmed and lowercase; empty is null', () => {
  assert.equal(normalizeEmail('  Bob.Smith@Example.COM '), 'bob.smith@example.com');
  assert.equal(normalizeEmail('bo\u200bb@exam\u00adple.com\ufeff'), 'bob@example.com', 'zero-width and soft hyphen');
  assert.equal(normalizeEmail('Jose\u0301@x.ca'), 'jos\u00e9@x.ca', 'one encoding for accented letters (NFC)');
  assert.equal(normalizeEmail('   '), null);
  assert.equal(normalizeEmail(null), null);
  assert.ok(isEmail('bob@example.com'));
  for (const bad of ['bob', 'bob@', '@x.com', 'bob@x', 'bob smith@x.com', `${'a'.repeat(250)}@x.com`]) assert.equal(isEmail(bad), false, bad);
});

test('phones: North America as 10 digits, elsewhere + and the country code, nothing guessed', () => {
  const same = ['(519) 555-0100', '519.555.0100', '+1 519 555 0100', '1-519-555-0100', '5195550100', ' 519 555 0100 ext. 22', '519-555-0100 x22', '+1 (519) 555-0100 #4'];
  for (const typed of same) assert.equal(normalizePhone(typed), '5195550100', typed);
  // Outside North America: "+", "00" or "011" in front, kept with the country code.
  for (const typed of ['+43 1 2345678', '0043 1 2345678', '011 43 1 2345678']) assert.equal(normalizePhone(typed), '+4312345678', typed);
  assert.equal(normalizePhone('+86 138 0013 8000'), '+8613800138000');
  // Two different numbers never share a spelling.
  assert.equal(normalizePhone('(431) 234-5678'), '4312345678', 'North American');
  assert.notEqual(normalizePhone('(431) 234-5678'), normalizePhone('+43 1 2345678'));
  assert.equal(normalizePhone('138 0013 8000'), '13800138000', 'not turned into "380 013 8000"');
  assert.equal(normalizePhone(' - '), null);
  assert.ok(isPhone('5195550100'));
  assert.ok(isPhone('+4312345678'));
  for (const bad of [
    '5550100', // 7 digits: the same in every area code
    '13800138000', // no country code, not North American
    '442079460958', // a UK number without its +
    '+15195550100', // North America is stored without +1
    '0195550100', '5191550100', // area code / exchange can't start with 0 or 1
    '+1234', '+0123456789', '+1234567890123456', '555', '',
  ]) assert.equal(isPhone(bad), false, bad);
  assert.equal(formatPhone('5195550100'), '(519) 555-0100', 'for reading');
  assert.equal(formatPhone('+4312345678'), '+4312345678');
  assert.equal(formatPhone(null), null);
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
  assert.match(checkFieldValue(phone, '519-555-0100'), /not stored as a clean phone number \(10 digits for North America/);
  assert.match(checkFieldValue(phone, '5550100'), /not a valid phone number \(10 digits for North America, "\+" and the country code/);
  assert.match(checkFieldValue(phone, '15195550100'), /not stored as a clean phone number/);
  assert.equal(checkFieldValue(phone, '+4312345678'), null);
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

test('consent: the latest per business counts (date; same day a withdrawal; then the later id)', () => {
  const [a, b] = [newId(), newId()];
  const id1 = newId();
  const id2 = newId();
  const id3 = newId();
  const today = '2026-10-07';
  const rows = [
    { id: id2, business_id: a, withdrawn: true, date: '2026-05-01' },
    { id: id1, business_id: a, withdrawn: false, date: '2026-01-10', kind: 'express' },
    { id: id3, business_id: b, withdrawn: false, date: '2026-03-01', kind: 'express' },
  ];
  const latest = latestConsents(rows);
  assert.equal(latest.get(a).id, id2);
  assert.equal(hasConsent(rows, a, today), false, 'withdrawn in May');
  assert.equal(hasConsent(rows, b, today), true);
  assert.equal(hasConsent(rows, newId(), today), false, 'never asked: no');
  // Recorded later with an older date (a form found in a drawer): the withdrawal still stands.
  const old = { id: newId(), business_id: a, withdrawn: false, date: '2026-02-01', kind: 'express' };
  assert.equal(hasConsent([...rows, old], a, today), false);
  // Same day: the withdrawal wins, whichever was recorded later.
  const again = { id: newId(), business_id: a, withdrawn: false, date: '2026-05-01', kind: 'express' };
  assert.equal(hasConsent([...rows, again], a, today), false);
  assert.equal(latestConsents([again, rows[0]]).get(a).id, id2);
  // A later day's sign-up does count again.
  const later = { id: newId(), business_id: a, withdrawn: false, date: '2026-05-02', kind: 'express' };
  assert.equal(hasConsent([...rows, later], a, today), true);
});

test('consent: implied consent lapses (2 years after a purchase, 6 months after an inquiry); express doesn\'t', () => {
  const biz = newId();
  const row = (fields) => ({ id: newId(), business_id: biz, withdrawn: false, ...fields });
  assert.equal(consentExpiresOn({ kind: 'implied_purchase', date: '2026-10-07' }), '2028-10-07');
  assert.equal(consentExpiresOn({ kind: 'implied_inquiry', date: '2026-08-31' }), '2027-02-28', 'end of month clamps');
  assert.equal(consentExpiresOn({ kind: 'implied_purchase', date: '2024-02-29' }), '2026-02-28');
  assert.equal(consentExpiresOn({ kind: 'express', date: '2026-10-07' }), null);
  assert.equal(consentExpiresOn({ kind: 'implied_inquiry', date: '2026-10-07', withdrawn: true }), null);
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');

  const purchase = [row({ kind: 'implied_purchase', date: '2024-10-01' })];
  assert.deepEqual(consentStatus(purchase, biz, '2026-09-30'), { given: true, withdrawn: false, expired: false, expiresOn: '2026-10-01', row: purchase[0] });
  assert.equal(hasConsent(purchase, biz, '2026-10-01'), false, 'lapses on its expiry day');
  assert.equal(consentStatus(purchase, biz, '2026-10-01').expired, true);
  // expires_on as stored wins over the computed one (set by hand for another implied ground).
  const handSet = [row({ kind: 'implied_inquiry', date: '2026-01-01', expires_on: '2030-01-01' })];
  assert.equal(hasConsent(handSet, biz, '2029-12-31'), true);
  assert.equal(hasConsent([row({ kind: 'express', date: '2020-01-01' })], biz, '2030-01-01'), true, 'express never lapses');
  assert.equal(hasConsent([row({ kind: null, date: '2020-01-01' })], biz, '2030-01-01'), true, 'no kind counts as express');
});
