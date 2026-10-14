// Projects and playbooks (D9): the shared rules — step dates and their words, who a step's task goes to,
// the "offer" condition (D8's cross-sell rule), links (URLs now, D10's files later), a repeating run's
// months, and a step as a task. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '../crm.js';
import {
  stepDate, offsetText, stepOwner, offerSkipReason, hasOfferCondition, parseLinks, linkLine, dueCycles, cycleStart, cycleKey,
  monthLabel, stepTaskFields, stagesOf, isOffset, EXAMPLE_PLAYBOOKS, MONTH_LEAD_DAYS,
} from '../playbooks.js';

const AGENCY = BUSINESS_IDS.agency;

test('a step’s day: days, weeks, months and years after (or before) the start, on the calendar', () => {
  assert.equal(stepDate('2026-10-12', {}), '2026-10-12', 'no offset = the start day');
  assert.equal(stepDate('2026-10-12', { offset_amount: 3 }), '2026-10-15');
  assert.equal(stepDate('2026-10-12', { offset_amount: -2, offset_unit: 'days' }), '2026-10-10');
  assert.equal(stepDate('2026-10-12', { offset_amount: 2, offset_unit: 'weeks' }), '2026-10-26');
  assert.equal(stepDate('2026-01-31', { offset_amount: 1, offset_unit: 'months' }), '2026-02-28', 'clamped to the month’s end');
  assert.equal(stepDate('2028-02-29', { offset_amount: 1, offset_unit: 'years' }), '2029-02-28');
  assert.equal(stepDate('2026-10-12', { offset_amount: 1, offset_unit: 'years' }), '2027-10-12');
  assert.equal(stepDate('2026-10-12', { offset_amount: 400, offset_unit: 'years' }), '2036-10-12', 'clamped to ten years (a pair split by two devices)');
  assert.equal(offsetText({}), 'On the start day');
  assert.equal(offsetText({ offset_amount: 1 }), '1 day after the start');
  assert.equal(offsetText({ offset_amount: 3, offset_unit: 'weeks' }), '3 weeks after the start');
  assert.equal(offsetText({ offset_amount: -2 }), '2 days before the start');
  assert.equal(offsetText({ offset_amount: 1, offset_unit: 'years' }), '1 year after the start');
  assert.ok(isOffset(3650) && !isOffset(3651) && isOffset(-10, 'years') && !isOffset(11, 'years') && !isOffset(1.5));
});

test('who a step’s task goes to: the run’s choice, else the step’s rule', () => {
  const business = { default_owner: 'partner' };
  assert.equal(stepOwner({}, { runner: 'owner', business }), 'owner', 'no rule = whoever runs it');
  assert.equal(stepOwner({ owner: 'business' }, { runner: 'owner', business }), 'partner');
  assert.equal(stepOwner({ owner: 'business' }, { runner: 'owner', business: {} }), 'shared', 'a business with no default owner → shared list');
  assert.equal(stepOwner({ owner: 'shared' }, { runner: 'owner', business }), 'shared');
  assert.equal(stepOwner({ owner: 'partner' }, { runner: 'owner', business }), 'partner');
  assert.equal(stepOwner({ owner: 'partner' }, { runner: 'owner', business, override: 'shared' }), 'shared', 'the run’s choice wins');
  assert.equal(stepOwner({}, { runner: null, business }), 'shared', 'no runner known → shared list');
});

test('an offer step is skipped when the account already has it (any status), or is age-restricted with no tie to that business', () => {
  const step = { only_if_lacks_business: AGENCY, only_if_lacks_kind: 'social' };
  const account = { id: 'a1', age_restricted: false };
  const names = { businessName: () => 'GWND', kindLabel: (k) => (k === 'social' ? 'Social media' : k) };
  assert.ok(hasOfferCondition(step) && !hasOfferCondition({ only_if_lacks_kind: 'social' }));
  assert.equal(offerSkipReason({ title: 'x' }, { account: null }), null, 'no condition: always made');
  assert.equal(offerSkipReason(step, { account, relationships: [], ...names }), null, 'lacks it: made');
  assert.equal(
    offerSkipReason(step, { account, relationships: [{ account_id: 'a1', business_id: AGENCY, kind: 'social', status: 'ended' }], ...names }),
    'Already has GWND · Social media', 'an ended one was a “no thanks”',
  );
  assert.equal(offerSkipReason(step, { account, relationships: [{ account_id: 'a2', business_id: AGENCY, kind: 'social' }], ...names }), null, 'another account’s doesn’t count');
  const vape = { id: 'a1', age_restricted: true };
  assert.match(offerSkipReason(step, { account: vape, relationships: [{ account_id: 'a1', business_id: BUSINESS_IDS.wholesale, kind: 'wholesale' }], ...names }), /^Age-restricted/);
  assert.equal(offerSkipReason(step, { account: vape, relationships: [{ account_id: 'a1', business_id: AGENCY, kind: 'website' }], ...names }), null,
    'age-restricted but GWND already works with them: social may be offered');
  assert.match(offerSkipReason(step, { account: null, ...names }), /No client picked/);
});

test('links: web addresses with labels, suite files (the D10 seam) and plain words', () => {
  const links = parseLinks('Brand guide: https://example.com/guide.pdf\n\nwww.example.org/photos\nfile:01a2b3c4-0000-7000-8000-000000000001 Contract\nThe client’s shared folder');
  assert.deepEqual(links, [
    { kind: 'url', href: 'https://example.com/guide.pdf', label: 'Brand guide' },
    { kind: 'url', href: 'https://www.example.org/photos', label: null },
    { kind: 'file', id: '01a2b3c4-0000-7000-8000-000000000001', label: 'Contract' },
    { kind: 'text', text: 'The client’s shared folder' },
  ]);
  assert.equal(linkLine(links[0]), 'Brand guide: https://example.com/guide.pdf');
  assert.equal(linkLine(links[2]), 'File “Contract” (file:01a2b3c4-0000-7000-8000-000000000001)');
  assert.deepEqual(parseLinks(null), []);
});

test('a repeating run’s months: made a week ahead, never late, never past the end', () => {
  const run = { repeat: 'monthly', start_date: '2026-01-31' };
  assert.equal(cycleStart(run.start_date, 1), '2026-02-28');
  assert.equal(cycleStart(run.start_date, 2), '2026-03-31', 'counted from the start each time');
  assert.equal(cycleKey(run.start_date, 2), '2026-03');
  assert.equal(monthLabel('2026-11-05'), 'November 2026');
  assert.deepEqual(dueCycles(run, '2026-02-10'), [], 'February’s starts the 28th: not yet (more than a week ahead)');
  assert.deepEqual(dueCycles(run, '2026-02-21').map((c) => c.key), ['2026-02'], `${MONTH_LEAD_DAYS} days ahead`);
  assert.deepEqual(dueCycles(run, '2026-03-25').map((c) => c.key), ['2026-02', '2026-03'], 'February’s runs to Mar 30; March’s is a week ahead');
  assert.deepEqual(dueCycles(run, '2026-03-31').map((c) => c.key), ['2026-03'], 'February’s is over');
  assert.deepEqual(dueCycles({ ...run, start_date: '2026-10-01' }, '2026-10-28').map((c) => c.key), ['2026-11'], 'month 0 is the device’s');
  assert.deepEqual(dueCycles({ ...run, start_date: '2026-10-01' }, '2026-10-02'), []);
  assert.deepEqual(dueCycles({ ...run, start_date: '2026-10-01', end_date: '2026-10-31' }, '2026-10-28'), [], 'ends before November');
  assert.deepEqual(dueCycles({ repeat: 'once', start_date: '2026-10-01' }, '2026-12-01'), [], 'a one-off run never repeats');
  assert.deepEqual(dueCycles({ ...run, start_date: '2025-01-15' }, '2026-10-12').map((c) => c.key), ['2026-09', '2026-10'], 'a long-running one: September’s (to Oct 14) and October’s (from the 15th), none earlier');
});

test('a step as a task: the run’s client, the date, the owner, its links in the notes, the month in a repeating run’s title', () => {
  const run = { id: 'r', name: 'Website launch — Lefty’s', business_id: AGENCY, client_id: 'c', account_id: 'a', relationship_id: 'rel', start_date: '2026-10-12' };
  const step = { id: 's', title: 'Follow up', offset_amount: 2, offset_unit: 'weeks', estimate_minutes: 15, notes: 'Ask about forms.', links: 'https://example.com/checklist' };
  const t = stepTaskFields({ step, run, owner: 'owner', playbookName: 'Website launch' });
  assert.equal(t.title, 'Follow up');
  assert.equal(t.due_date, '2026-10-26');
  assert.equal(t.owner, 'owner');
  assert.deepEqual([t.business_id, t.client_id, t.account_id, t.relationship_id, t.run_id, t.run_step_id, t.estimate_minutes], [AGENCY, 'c', 'a', 'rel', 'r', 's', 15]);
  assert.match(t.notes, /Ask about forms\.\n\nFiles and links:\n- https:\/\/example\.com\/checklist\n\nFrom the playbook “Website launch”/);
  const m = stepTaskFields({ step: { ...step, offset_amount: 7, offset_unit: 'days' }, run, owner: 'shared', cycle: { start: '2026-11-12', label: 'November 2026' } });
  assert.equal(m.title, 'Follow up · November 2026');
  assert.equal(m.due_date, '2026-11-19');
});

test('stages in order of first appearance; the examples are well formed', () => {
  assert.deepEqual(stagesOf([{ id: '2', position: 2, stage: 'Launch' }, { id: '1', position: 1, stage: 'Build' }, { id: '3', position: 3, stage: 'Build' }, { id: '4', position: 4 }]), ['Build', 'Launch', '']);
  for (const p of EXAMPLE_PLAYBOOKS) {
    assert.ok(p.name && p.business_id && p.steps.length, p.key);
    for (const s of p.steps) assert.ok(s.title.length <= 300 && isOffset(s.offset_amount ?? 0, s.offset_unit ?? 'days'), `${p.key}: ${s.title}`);
  }
  const launch = EXAMPLE_PLAYBOOKS.find((p) => p.key === 'website_launch');
  assert.deepEqual(launch.steps.filter((s) => s.action === 'renewal').map((s) => s.service_name), ['Hosting', 'Domain']);
  assert.ok(EXAMPLE_PLAYBOOKS.find((p) => p.key === 'packing').steps.every((s) => s.owner === 'shared'));
  assert.equal(EXAMPLE_PLAYBOOKS.find((p) => p.key === 'onboarding').kind, null, 'onboarding adds no relationship');
});
