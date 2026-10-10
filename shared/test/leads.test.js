import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS as B } from '../crm.js';
import {
  LEAD_STAGES, OPEN_LEAD_STAGES, isOpenLead, leadsWithoutNextStep, firstYearValue, pipelineTotals, CROSS_SELL_PAIRS,
  crossSellList, LOST_COOLDOWN_DAYS,
} from '../leads.js';

const TODAY = '2026-10-09';

test('stages: three open, then won or lost', () => {
  assert.deepEqual(LEAD_STAGES, ['lead', 'talking', 'quoted', 'won', 'lost']);
  assert.deepEqual(OPEN_LEAD_STAGES, ['lead', 'talking', 'quoted']);
  assert.equal(isOpenLead({ stage: 'quoted' }), true);
  assert.equal(isOpenLead({ stage: 'won' }), false);
  assert.equal(isOpenLead(null), false);
});

test('no next step: an open lead with no open task naming it that has a day', () => {
  const leads = [
    { id: 'a', stage: 'lead' }, { id: 'b', stage: 'talking' }, { id: 'c', stage: 'quoted' }, { id: 'd', stage: 'won' },
    { id: 'e', stage: 'lost' }, { id: 'f', stage: 'lead' }, { id: 'g', stage: 'lead' },
  ];
  const tasks = [
    { id: 't1', lead_id: 'a', due_date: '2026-10-20', done_at: null }, // dated, open: covered
    { id: 't2', lead_id: 'b', due_date: null, done_at: null }, // no day: doesn't count
    { id: 't3', lead_id: 'c', due_date: '2026-10-01', done_at: '2026-10-02T10:00:00.000Z' }, // done
    { id: 't4', lead_id: 'f', due_date: '2026-09-01', done_at: null }, // overdue still counts
    { id: 't5', lead_id: 'g', due_date: '2026-10-10', done_at: null, deleted_at: '2026-10-09T00:00:00.000Z' },
  ];
  assert.deepEqual(leadsWithoutNextStep({ leads, tasks }).map((l) => l.id), ['b', 'c', 'g'], 'won and lost leads are never flagged');
});

test('value: the first year, per currency, never added across currencies', () => {
  assert.equal(firstYearValue({ value_cents: 250000, value_period: 'once' }), 250000);
  assert.equal(firstYearValue({ value_cents: 30000, value_period: 'monthly' }), 360000);
  assert.equal(firstYearValue({ value_cents: 30000, value_period: 'quarterly' }), 120000);
  assert.equal(firstYearValue({ value_cents: 30000 }), 30000, 'no period = once');
  assert.equal(firstYearValue({ value_cents: null }), null);
  const t = pipelineTotals([
    { stage: 'lead', value_cents: 100000 },
    { stage: 'lead', value_cents: 50000, value_period: 'monthly', currency: 'USD' },
    { stage: 'lead' },
    { stage: 'talking', value_cents: 20000, value_period: 'monthly' },
    { stage: 'won', value_cents: 300000, closed_at: '2026-10-02T15:00:00.000Z' },
    { stage: 'won', value_cents: 900000, closed_at: '2026-09-02T15:00:00.000Z' },
    { stage: 'lost', closed_at: '2026-10-05T15:00:00.000Z' },
  ], { today: TODAY });
  assert.equal(t.stages.lead.count, 3);
  assert.deepEqual([...t.stages.lead.value], [['CAD', 100000], ['USD', 600000]]);
  assert.deepEqual([...t.stages.talking.value], [['CAD', 240000]]);
  assert.equal(t.wonThisMonth, 1);
  assert.equal(t.lostThisMonth, 1);
  assert.deepEqual([...t.wonValueThisMonth], [['CAD', 300000]]);
});

// ---- cross-sell ------------------------------------------------------------------------------------

function world() {
  const clients = [
    { id: 'c1', name: 'Brantford Auto Body', status: 'active' },
    { id: 'c2', name: 'Lefty’s', status: 'active' },
    { id: 'c3', name: 'Closed Co', status: 'closed' },
    { id: 'c4', name: 'Coach Pat', status: 'active' },
  ];
  const accounts = [
    { id: 'a1', client_id: 'c1', name: 'Brantford Auto Body' },
    { id: 'a2', client_id: 'c2', name: 'Lefty’s Vape Shop', age_restricted: true },
    { id: 'a2b', client_id: 'c2', name: 'Lefty’s Garage' },
    { id: 'a3', client_id: 'c3', name: 'Closed Co' },
    { id: 'a4', client_id: 'c4', name: 'Coach Pat' },
  ];
  const relationships = [
    { id: 'r1', account_id: 'a1', business_id: B.agency, kind: 'website', status: 'active' },
    // the vape shop: wholesale + a website from us; never selected for consulting (no relationship there)
    { id: 'r2', account_id: 'a2', business_id: B.wholesale, kind: 'wholesale', status: 'active' },
    { id: 'r2w', account_id: 'a2', business_id: B.agency, kind: 'website', status: 'active' },
    { id: 'r2g', account_id: 'a2b', business_id: B.agency, kind: 'website', status: 'active' },
    { id: 'r3', account_id: 'a3', business_id: B.agency, kind: 'website', status: 'active' },
    { id: 'r4', account_id: 'a4', business_id: B.consulting, kind: 'consulting', status: 'active' },
  ];
  const contacts = [
    { id: 'p1', client_id: 'c1', account_id: 'a1', name: 'Sam', email: 'sam@bab.ca' },
    { id: 'p2', client_id: 'c2', account_id: 'a2', name: 'Pat Vape', email: 'pat@leftys.ca' },
    { id: 'p2b', client_id: 'c2', account_id: 'a2b', name: 'Gary', email: null },
    { id: 'p2c', client_id: 'c2', account_id: null, name: 'Owner Lefty', email: 'owner@leftys.ca' }, // client-wide
    { id: 'p4', client_id: 'c4', account_id: null, name: 'Pat', email: 'pat@coach.ca' },
  ];
  const consents = [
    { id: 'k1', contact_id: 'p1', business_id: B.agency, withdrawn: false, date: '2026-09-01', kind: 'express' },
    { id: 'k2', contact_id: 'p4', business_id: B.consulting, withdrawn: false, date: '2026-09-01', kind: 'express' }, // not agency
  ];
  return { clients, accounts, relationships, contacts, consents, leads: [] };
}

test('cross-sell: the pairs table never names wholesale', () => {
  for (const p of CROSS_SELL_PAIRS) {
    assert.notEqual(p.from.business, B.wholesale);
    assert.notEqual(p.to.business, B.wholesale);
    assert.ok(p.why);
  }
  assert.equal(new Set(CROSS_SELL_PAIRS.map((p) => p.id)).size, CROSS_SELL_PAIRS.length);
});

test('cross-sell: active clients with one service and not the other; closed clients never', () => {
  const list = crossSellList({ ...world(), today: TODAY });
  const keys = list.map((e) => e.key).sort();
  assert.deepEqual(keys, [
    'a1:website-consulting', 'a1:website-social',
    'a2:website-social', // the vape shop already works with the agency: the agency may offer it social
    'a2b:website-consulting', 'a2b:website-social',
    'a4:consulting-website',
  ].sort());
  assert.ok(!keys.some((k) => k.startsWith('a3:')), 'a closed client is never listed');
});

test('cross-sell: the age-restricted rule — never for a business with no relationship with that account', () => {
  const list = crossSellList({ ...world(), today: TODAY });
  assert.ok(!list.some((e) => e.account.id === 'a2' && e.pair.to.business === B.consulting), 'consulting has nothing with the vape shop');
  // Without its website, the vape shop is on no list at all (wholesale is never a `from`).
  const w = world();
  w.relationships = w.relationships.filter((r) => r.id !== 'r2w');
  assert.ok(!crossSellList({ ...w, today: TODAY }).some((e) => e.account.id === 'a2'));
  // The garage (not age-restricted) is listed for consulting, but its client's people with no account are
  // left out: the client has an age-restricted account consulting doesn't work with.
  const garage = crossSellList({ ...world(), today: TODAY }).find((e) => e.key === 'a2b:website-consulting');
  assert.deepEqual(garage.contacts.map((p) => p.contact.id), ['p2b']);
  // For the agency (which works with the vape shop) the client-wide contact may be listed.
  const garageSocial = crossSellList({ ...world(), today: TODAY }).find((e) => e.key === 'a2b:website-social');
  assert.deepEqual(garageSocial.contacts.map((p) => p.contact.id).sort(), ['p2b', 'p2c']);
  // The vape shop's own contact never shows on another account's line.
  assert.ok(!crossSellList({ ...world(), today: TODAY }).some((e) => e.account.id !== 'a2' && e.contacts.some((p) => p.contact.id === 'p2')));
});

test('cross-sell: email consent is the selling business’s own', () => {
  const list = crossSellList({ ...world(), today: TODAY });
  const bab = list.find((e) => e.key === 'a1:website-social');
  assert.equal(bab.contacts[0].emailConsent, true, 'express consent for the agency');
  const babConsulting = list.find((e) => e.key === 'a1:website-consulting');
  assert.equal(babConsulting.contacts[0].emailConsent, false, 'the agency’s consent is not consulting’s');
  const coach = list.find((e) => e.key === 'a4:consulting-website');
  assert.equal(coach.contacts[0].emailConsent, false, 'consulting’s consent is not the agency’s');
});

test('cross-sell: an open lead, or one lost within the cooldown, takes the line off; any relationship counts as "has it"', () => {
  const w = world();
  w.leads = [
    { id: 'l1', stage: 'talking', business_id: B.agency, kind: 'social', account_id: 'a1', client_id: 'c1' },
    { id: 'l2', stage: 'lost', business_id: B.consulting, kind: 'consulting', account_id: null, client_id: 'c2', closed_at: '2026-08-01T12:00:00.000Z' },
    { id: 'l3', stage: 'lost', business_id: B.agency, kind: 'website', account_id: 'a4', client_id: 'c4', closed_at: '2026-01-01T12:00:00.000Z' },
  ];
  w.relationships.push({ id: 'r5', account_id: 'a1', business_id: B.consulting, kind: 'consulting', status: 'ended' });
  const keys = crossSellList({ ...w, today: TODAY }).map((e) => e.key);
  assert.ok(!keys.includes('a1:website-social'), 'open lead');
  assert.ok(!keys.includes('a1:website-consulting'), 'an ended relationship is a "no thanks"');
  assert.ok(!keys.includes('a2b:website-consulting'), 'lost for the client (no account) within the cooldown');
  assert.ok(keys.includes('a4:consulting-website'), `lost more than ${LOST_COOLDOWN_DAYS} days ago: back on the list`);
});
