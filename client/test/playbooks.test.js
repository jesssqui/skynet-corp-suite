// Projects and playbooks (D9) on devices: the forms (an edit sends only what changed), reordering steps,
// running a playbook (planRun → applyRun: the run, its copy of the steps, tasks with owners and dates,
// the renewal dates on the client's services, the relationship when missing, the offer left out when they
// have it), ids made once (a retry after a failure part-way never runs it twice), a run's checklist by
// stage — and against a real server with two devices, the plan's "done when": the packing playbook puts
// its tasks on the shared list, a test website launch makes its renewals and follow-up task on the right
// dates, and editing a playbook changes only future runs. Invented names only.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { newId } from '@suite/shared/ids';
import { EXAMPLE_PLAYBOOKS } from '@suite/shared/playbooks';
import { startServer, makeDevice, row } from './helpers.js';
import { valuesFrom, editChanges } from '../src/modules/crm/formFields.js';
import {
  playbookForm, stepForm, runForm, exampleRecords, reorderChanges, planRun, applyRun, keptRunIds, forgetRunIds, runChecklist, progressText,
  defaultRunName, relationshipLine, stepSummary, nextPosition, clientRuns, keptRunFor, runsUnderWay, duplicateRuns, extraRunPlan, removeExtraRuns,
  runMade, latestChange,
} from '../src/modules/playbooks/logic.js';

const AGENCY = BUSINESS_IDS.agency;
const WHOLESALE = BUSINESS_IDS.wholesale;
const START = '2026-10-12';
const example = (key) => EXAMPLE_PLAYBOOKS.find((p) => p.key === key);
const businessesById = new Map([
  [AGENCY, { id: AGENCY, name: 'Great White North Design', default_owner: 'owner' }],
  [WHOLESALE, { id: WHOLESALE, name: 'Wholesale', default_owner: 'owner' }],
]);
/** An example as records (ids made here), like a device saving it. */
function asRecords(key) {
  const { playbook, steps } = exampleRecords(example(key));
  const pb = { id: newId(), ...playbook };
  return { playbook: pb, steps: steps.map((s) => ({ id: newId(), playbook_id: pb.id, ...s })) };
}
const ids = (pb, steps, choice) => keptRunIds(null, pb.id, choice, steps.map((s) => s.id), newId);

test('the forms: playbook and step fields, problems stop the save, an edit sends only what changed', () => {
  const p = playbookForm.toFields({ ...valuesFrom(playbookForm, null), name: ' Website launch ', business_id: AGENCY, kind: 'website' });
  assert.deepEqual(p.fields, { name: 'Website launch', business_id: AGENCY, repeat: 'once', for_client: true, kind: 'website', description: null, archived: false });
  assert.deepEqual(Object.keys(playbookForm.toFields(valuesFrom(playbookForm, null)).problems).sort(), ['business_id', 'name']);
  assert.equal(playbookForm.toFields({ ...valuesFrom(playbookForm, null), name: 'Packing', business_id: WHOLESALE, for_client: false, kind: 'website' }).fields.kind, null,
    'no client: no relationship kind');

  const s = stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'Follow up', offset_amount: '2', offset_unit: 'weeks', estimate_minutes: '15', links: 'https://example.com' });
  assert.deepEqual(s.problems, {});
  assert.deepEqual([s.fields.offset_amount, s.fields.offset_unit, s.fields.owner, s.fields.estimate_minutes, s.fields.action], [2, 'weeks', 'runner', 15, 'task']);
  const r = stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'Hosting', action: 'renewal', offset_amount: '1', offset_unit: 'years', service_name: 'Hosting', service_amount: '300' });
  assert.deepEqual([r.fields.service_name, r.fields.service_period, r.fields.service_amount_cents, r.fields.owner, r.fields.estimate_minutes], ['Hosting', 'yearly', 30000, null, null]);
  assert.ok(stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'x', offset_amount: '1.5' }).problems.offset_amount);
  assert.ok(stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'x', offset_amount: '11', offset_unit: 'years' }).problems.offset_amount);
  assert.ok(stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'x', action: 'renewal' }).problems.service_name);
  assert.ok(stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'x', offer: true }).problems.offer);
  const offer = stepForm.toFields({ ...valuesFrom(stepForm, null), title: 'Offer social', offer: true, only_if_lacks_business: AGENCY, only_if_lacks_kind: 'social' });
  assert.deepEqual([offer.fields.only_if_lacks_business, offer.fields.only_if_lacks_kind], [AGENCY, 'social']);

  const record = { id: 's', title: 'Follow up', offset_amount: 14, offset_unit: 'days', owner: 'runner', estimate_minutes: 15, position: 3 };
  const start = valuesFrom(stepForm, record);
  assert.deepEqual(editChanges(stepForm, start, { ...start, title: 'Follow up by phone' }).fields, { title: 'Follow up by phone' });
  assert.deepEqual(editChanges(stepForm, start, start).fields, {});
  const run = { name: 'Website launch — Lefty’s', start_date: START, end_date: null, notes: null };
  const rs = valuesFrom(runForm, run);
  assert.deepEqual(editChanges(runForm, rs, { ...rs, notes: 'Launch moved to Friday' }).fields, { notes: 'Launch moved to Friday' });
  assert.ok(runForm.toFields({ ...rs, end_date: '2026-10-01' }).problems.end_date);
});

test('examples become records; moving a step sends only the positions that change', () => {
  const { playbook, steps } = exampleRecords(example('website_launch'));
  assert.equal(playbook.name, 'Website launch');
  assert.deepEqual(steps.map((s) => s.position), [1, 2, 3, 4, 5, 6, 7, 8]);
  const list = [{ id: 'a', position: 1 }, { id: 'b', position: 2 }, { id: 'c', position: 3 }];
  assert.deepEqual(reorderChanges(list, 'c', 'up'), [{ id: 'c', position: 2 }, { id: 'b', position: 3 }]);
  assert.deepEqual(reorderChanges(list, 'a', 'up'), []);
  assert.deepEqual(reorderChanges([{ id: 'a', position: 1 }, { id: 'b', position: 1 }, { id: 'c', position: 5 }], 'a', 'down'),
    [{ id: 'b', position: 1 }, { id: 'a', position: 2 }, { id: 'c', position: 3 }].filter((c) => c.id !== 'b'), 'ties and gaps closed');
  assert.equal(nextPosition(list), 4);
  assert.equal(stepSummary({ offset_amount: 2, offset_unit: 'weeks', owner: 'shared' }), '2 weeks after the start · shared list');
  assert.equal(stepSummary({ action: 'renewal', offset_amount: 1, offset_unit: 'years', service_name: 'Hosting' }), '1 year after the start · renewal date of Hosting (yearly)');
  assert.equal(stepSummary({ offset_amount: 30, only_if_lacks_business: AGENCY, only_if_lacks_kind: 'social' }, { businessName: () => 'GWND' }),
    '30 days after the start · whoever runs it · only if they don’t have GWND · Social media');
});

test('planning a website launch: renewal dates on the services, the follow-up, the offer only when they lack social, the relationship', () => {
  const { playbook, steps } = asRecords('website_launch');
  const account = { id: 'acc', client_id: 'cli', name: 'Lefty’s Lounge', age_restricted: false };
  const rel = { id: 'rel', account_id: 'acc', business_id: AGENCY, kind: 'website', status: 'active' };
  const choice = { name: defaultRunName(playbook, account), startDate: START, clientId: 'cli', accountId: 'acc', owner: '' };
  const data = { businessesById, accountsById: new Map([['acc', account]]), relationships: [rel], services: [{ id: 'old', relationship_id: 'rel', name: 'hosting', status: 'active', renewal_date: '2026-11-01' }] };
  const k = ids(playbook, steps, choice);
  const plan = planRun({ playbook, steps, choice, me: 'partner', ids: k, data });
  assert.deepEqual(plan.problems, {});
  assert.equal(choice.name, 'Website launch — Lefty’s Lounge');
  const by = (entity) => plan.writes.filter((w) => w.entity === entity);
  assert.deepEqual(plan.writes.map((w) => w.entity).slice(0, 1), ['playbook_run'], 'the existing relationship is used as it is');
  assert.equal(latestChange([{ _sync: { updatedAt: '2026-10-01T00:00:00.000Z' } }, { _sync: { updatedAt: '2026-10-05T00:00:00.000Z' } }, {}]), '2026-10-05T00:00:00.000Z',
    'as of: the latest change to the playbook or a step');
  const run = by('playbook_run')[0].fields;
  assert.deepEqual([run.relationship_id, run.account_id, run.client_id, run.runner, run.repeat, run.start_date], ['rel', 'acc', 'cli', 'partner', 'once', START]);
  assert.equal(by('run_step').length, 8, 'every step is copied, skipped ones too');
  // Renewals: the existing Hosting service (any case) gets the date; Domain is added.
  assert.deepEqual(by('service').map((w) => [w.op, w.fields.name ?? w.id, w.fields.renewal_date]), [['update', 'old', '2027-10-12'], ['create', 'Domain', '2027-10-12']]);
  assert.match(by('task').find((w) => w.fields.title === 'Offer social media').fields.notes, /only if Great White North Design has their email consent/);
  assert.deepEqual(by('service')[1].fields, { relationship_id: 'rel', name: 'Domain', status: 'active', billing: null, amount_cents: null, period: 'yearly', start_date: START, renewal_date: '2027-10-12' });
  const tasks = by('task').map((w) => w.fields);
  assert.deepEqual(tasks.map((x) => [x.title, x.due_date, x.owner]), [
    ['Final checks: forms, links, speed and phone layout', START, 'partner'],
    ['Point the domain and go live', START, 'partner'],
    ['Send the client their logins and a how-to', '2026-10-13', 'partner'],
    ['Follow up: how is the new site working for them?', '2026-10-26', 'partner'],
    ['Ask for a review', '2026-11-02', 'partner'],
    ['Offer social media', '2026-11-11', 'partner'],
  ]);
  assert.ok(tasks.every((x) => x.run_id === k.run && x.relationship_id === 'rel' && x.client_id === 'cli' && x.business_id === AGENCY));
  assert.ok(plan.writes.findIndex((w) => w.entity === 'task') > plan.writes.findIndex((w) => w.entity === 'service'), 'services before tasks');
  assert.deepEqual(plan.preview.items.filter((i) => i.kind === 'renewal').map((i) => [i.service, i.date, i.existing, i.from]),
    [['Hosting', '2027-10-12', true, '2026-11-01'], ['Domain', '2027-10-12', false, null]], 'Hosting moves from Nov 1');
  const runW = plan.writes.find((w) => w.entity === 'playbook_run').fields;
  assert.equal(runW.status, 'starting');
  assert.deepEqual(plan.writes.at(-1), { op: 'update', entity: 'playbook_run', id: k.run, fields: { status: 'active' } }, 'active is the last write');
  assert.deepEqual(runMade(runW), [{ kind: 'renewal', entity: 'service', id: 'old', old: '2026-11-01' }, { kind: 'made', entity: 'service', id: k.steps[steps[4].id].service }]);
  // A later date already on their service is left alone, unless the person chooses to move it.
  const later = { ...data, services: [{ id: 'old', relationship_id: 'rel', name: 'Hosting', status: 'active', renewal_date: '2028-01-01' }] };
  const keep = planRun({ playbook, steps, choice, me: 'partner', ids: k, data: later });
  assert.ok(!keep.writes.some((w) => w.entity === 'service' && w.op === 'update'));
  assert.equal(keep.preview.items.find((i) => i.service === 'Hosting').keptLater, true);
  assert.match(keep.writes.find((w) => w.entity === 'run_step' && w.fields.title === 'Hosting').fields.outcome_note, /already renews on .* \(later\): left as it is/);
  const moved = planRun({ playbook, steps, choice: { ...choice, moveLaterRenewals: true }, me: 'partner', ids: k, data: later });
  assert.deepEqual(moved.writes.find((w) => w.entity === 'service' && w.op === 'update').fields, { renewal_date: '2027-10-12' });
  assert.equal(relationshipLine(plan.preview.relationship, () => 'GWND'), 'Works on the relationship GWND · Website');

  // They already have GWND social (even ended): the offer is left out, and says why.
  const withSocial = planRun({ playbook, steps, choice, me: 'partner', ids: k, data: { ...data, relationships: [rel, { id: 'soc', account_id: 'acc', business_id: AGENCY, kind: 'social', status: 'ended' }] } });
  assert.ok(!withSocial.writes.some((w) => w.entity === 'task' && w.fields.title === 'Offer social media'));
  const skipped = withSocial.writes.find((w) => w.entity === 'run_step' && w.fields.title === 'Offer social media').fields;
  assert.deepEqual([skipped.outcome, skipped.outcome_note], ['skipped', 'Already has Great White North Design · Social media']);

  // No GWND relationship yet: the run adds one (active, from the start day), and the renewals go on it.
  const fresh = planRun({ playbook, steps, choice, me: 'owner', ids: k, data: { ...data, relationships: [], services: [] } });
  assert.deepEqual(fresh.writes[0], { op: 'create', entity: 'relationship', id: k.relationship, fields: { account_id: 'acc', business_id: AGENCY, kind: 'website', status: 'active', start_date: START } });
  assert.equal(fresh.writes.filter((w) => w.entity === 'service').length, 2);
  // An ended one is made active again instead.
  const ended = planRun({ playbook, steps, choice, me: 'owner', ids: k, data: { ...data, relationships: [{ ...rel, status: 'ended' }] } });
  assert.deepEqual(ended.writes[0], { op: 'update', entity: 'relationship', id: 'rel', fields: { status: 'active' } });
  assert.equal(relationshipLine(ended.preview.relationship, () => 'GWND'), 'Makes the relationship GWND · Website active again');
  // Everything to the shared list when the runner says so.
  const shared = planRun({ playbook, steps, choice: { ...choice, owner: 'shared' }, me: 'owner', ids: k, data });
  assert.ok(shared.writes.filter((w) => w.entity === 'task').every((w) => w.fields.owner === 'shared'));
  // Problems.
  assert.ok(planRun({ playbook, steps, choice: { ...choice, clientId: '' }, me: 'owner', ids: k, data }).problems.client);
  assert.ok(planRun({ playbook, steps, choice: { ...choice, accountId: 'nope' }, me: 'owner', ids: k, data }).problems.account);
  assert.ok(planRun({ playbook, steps: [], choice, me: 'owner', ids: k, data }).problems.steps);
  assert.ok(planRun({ playbook, steps, choice: { ...choice, name: ' ' }, me: 'owner', ids: k, data }).problems.name);
});

test('a monthly retainer’s first month (titled with the month), an end date; ids kept per choice', () => {
  const { playbook, steps } = asRecords('content_retainer');
  const account = { id: 'acc', name: 'Lefty’s' };
  const choice = { name: 'Content — Lefty’s', startDate: '2026-11-01', clientId: 'cli', accountId: 'acc', owner: '', endDate: '2027-04-30' };
  const k = ids(playbook, steps, choice);
  const plan = planRun({ playbook, steps, choice, me: 'owner', ids: k, data: { businessesById, accountsById: new Map([['acc', account]]), relationships: [], services: [] } });
  assert.deepEqual(plan.writes[0].fields.kind, 'social', 'adds the GWND social relationship');
  const run = plan.writes.find((w) => w.entity === 'playbook_run').fields;
  assert.deepEqual([run.repeat, run.end_date], ['monthly', '2027-04-30']);
  assert.deepEqual(plan.writes.filter((w) => w.entity === 'task').map((w) => [w.fields.title, w.fields.due_date]), [
    ['Plan this month’s posts · November 2026', '2026-11-01'],
    ['Content due to the client for approval · November 2026', '2026-11-08'],
    ['Schedule the approved posts · November 2026', '2026-11-11'],
    ['Send the month’s report · November 2026', '2026-11-26'],
  ]);

  const storage = new Map();
  const ls = { getItem: (key) => storage.get(key) ?? null, setItem: (key, v) => storage.set(key, v), removeItem: (key) => storage.delete(key) };
  const a = keptRunIds(ls, playbook.id, choice, steps.map((s) => s.id), newId);
  const b = keptRunIds(ls, playbook.id, choice, steps.map((s) => s.id), newId);
  assert.deepEqual(a, b, 'the same choice: the same ids (a reload, a retry)');
  const c = keptRunIds(ls, playbook.id, { ...choice, startDate: '2026-12-01' }, steps.map((s) => s.id), newId);
  assert.notEqual(c.run, a.run, 'another choice: new ids');
  forgetRunIds(ls, playbook.id);
  assert.notEqual(keptRunIds(ls, playbook.id, { ...choice, startDate: '2026-12-01' }, steps.map((s) => s.id), newId).run, c.run, 'after a saved run: new ids');
});

test('a run’s checklist by stage: done and open, the current stage, the next task', () => {
  const runSteps = [
    { id: 'r1', position: 1, stage: 'Launch', title: 'Go live' },
    { id: 'r2', position: 2, stage: 'Renewals', title: 'Hosting', action: 'renewal', outcome: 'renewal' },
    { id: 'r3', position: 3, stage: 'After launch', title: 'Follow up' },
    { id: 'r4', position: 4, stage: 'After launch', title: 'Offer social media', outcome: 'skipped' },
  ];
  const tasks = [
    { id: 't1', run_step_id: 'r1', due_date: '2026-10-12', done_at: '2026-10-12T15:00:00.000Z' },
    { id: 't3', run_step_id: 'r3', due_date: '2026-10-26', done_at: null },
  ];
  const c = runChecklist(runSteps, tasks);
  assert.deepEqual(c.stages.map((g) => g.stage), ['Launch', 'Renewals', 'After launch']);
  assert.deepEqual([c.done, c.total, c.current, c.allDone, c.nextTask.id], [1, 2, 'After launch', false, 't3']);
  assert.equal(progressText(c), '1 of 2 done · now: After launch');
  assert.equal(progressText(runChecklist(runSteps, tasks.map((x) => ({ ...x, done_at: 'x' })))), 'All 2 done');
  assert.deepEqual(clientRuns([{ id: '1', client_id: 'c', start_date: '2026-01-01' }, { id: '2', client_id: 'c', start_date: '2026-05-01' }, { id: '3', client_id: 'x', start_date: '2026-06-01' }], 'c').map((r) => r.id), ['2', '1']);
});

/** A device saving an example playbook (as the Playbooks page does). */
async function saveExample(engine, key) {
  const { playbook, steps } = exampleRecords(example(key));
  const id = await engine.create('playbook', playbook);
  for (const s of steps) await engine.create('playbook_step', { playbook_id: id, ...s });
  return id;
}
/** What the run sheet reads, then plan + save. */
async function runOn(dev, playbookId, choice, { storage = null, writer = dev.engine } = {}) {
  const e = dev.engine;
  const playbook = await e.get('playbook', playbookId);
  const steps = await e.list('playbook_step', { where: { playbook_id: playbookId } });
  const k = keptRunIds(storage, playbookId, choice, steps.map((s) => s.id), newId);
  const accounts = await e.list('account');
  const data = {
    businessesById: new Map((await e.list('business')).map((b) => [b.id, b])),
    accountsById: new Map(accounts.map((a) => [a.id, a])),
    relationships: await e.list('relationship'),
    services: await e.list('service'),
  };
  const plan = planRun({ playbook, steps, choice, me: dev.actor, ids: k, data });
  assert.deepEqual(plan.problems, {});
  await applyRun(writer, plan);
  forgetRunIds(storage, playbookId); // as the Run sheet does once the run is saved
  return { plan, ids: k };
}

test('done when: the packing playbook puts its tasks on the shared list (run on the phone, offline)', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  const pb = await saveExample(mac.engine, 'packing');
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  phone.online = false;
  const { ids: k } = await runOn(phone, pb, { name: 'Packing — order #1042', startDate: START, owner: '' });
  const offline = await phone.engine.list('task', { where: { run_id: k.run } });
  assert.equal(offline.length, 4, 'shown at once, offline');
  phone.online = true;
  await phone.engine.syncNow();
  const tasks = server.db.prepare('SELECT title, owner, business_id, due_date, created_by FROM planner_tasks WHERE run_id = ? ORDER BY title').all(k.run);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((x) => x.owner === 'shared' && x.business_id === WHOLESALE && x.due_date === START && x.created_by === 'partner'), JSON.stringify(tasks));
  const run = row(server.db, 'playbooks_runs', k.run);
  assert.deepEqual([run.name, run.client_id, run.runner, run.status], ['Packing — order #1042', null, 'partner', 'active']);
  await mac.engine.syncNow();
  const onMac = await mac.engine.list('task', { where: { run_id: k.run } });
  assert.ok(onMac.every((x) => x.owner === 'shared'), 'on the Mac’s shared list too');
});

test('done when: launching a test website makes its renewals and follow-up task on the right dates; a retry never runs it twice', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const clientId = await mac.engine.create('client', { name: 'Test Bakery', status: 'active' });
  const accountId = await mac.engine.create('account', { client_id: clientId, name: 'Test Bakery' });
  const pb = await saveExample(mac.engine, 'website_launch');
  await mac.engine.syncNow();
  const choice = { name: 'Website launch — Test Bakery', startDate: START, clientId, accountId, owner: '' };
  // The first try fails after five writes (the phone ran out of space, say); the retry re-uses the ids.
  const storage = new Map();
  const ls = { getItem: (key) => storage.get(key) ?? null, setItem: (key, v) => storage.set(key, v), removeItem: (key) => storage.delete(key) };
  let writes = 0;
  const flaky = {
    create: (...a) => { writes += 1; if (writes > 5) throw Object.assign(new Error('full'), { code: 'storage_full' }); return mac.engine.create(...a); },
    update: (...a) => mac.engine.update(...a),
  };
  await assert.rejects(runOn(mac, pb, choice, { storage: ls, writer: flaky }));
  // Unfinished on the device: the run is there, `starting`, and its page can finish it from the kept choice.
  const partial = (await mac.engine.list('playbook_run'))[0];
  assert.equal(partial.status, 'starting', 'not under way until its last write');
  assert.equal(keptRunFor(ls, pb, partial.id).choice.accountId, accountId);
  // The retry and a double tap at once (the sheet's ref guard aside, the store makes nothing twice).
  const [{ ids: k }] = await Promise.all([runOn(mac, pb, choice, { storage: ls }), runOn(mac, pb, choice, { storage: ls })]);
  assert.equal(k.run, partial.id);
  assert.equal(keptRunFor(ls, pb, partial.id), null, 'forgotten once saved');
  await mac.engine.syncNow();
  assert.equal(row(server.db, 'playbooks_runs', k.run).status, 'active');
  assert.equal(row(server.db, 'playbooks_runs', k.run).playbook_name, 'Website launch');

  assert.equal(server.db.prepare('SELECT count(*) AS n FROM playbooks_runs WHERE deleted_at IS NULL').get().n, 1);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM playbooks_run_steps WHERE run_id = ?').get(k.run).n, 8);
  const rels = server.db.prepare('SELECT * FROM crm_relationships WHERE account_id = ? AND deleted_at IS NULL').all(accountId);
  assert.deepEqual(rels.map((r) => [r.business_id, r.kind, r.status, r.start_date]), [[AGENCY, 'website', 'active', START]], 'one relationship, made by the run');
  const services = server.db.prepare('SELECT name, status, period, start_date, renewal_date FROM crm_services WHERE relationship_id = ? AND deleted_at IS NULL ORDER BY name').all(rels[0].id);
  assert.deepEqual(services, [
    { name: 'Domain', status: 'active', period: 'yearly', start_date: START, renewal_date: '2027-10-12' },
    { name: 'Hosting', status: 'active', period: 'yearly', start_date: START, renewal_date: '2027-10-12' },
  ], 'its renewals, a year after the launch');
  const tasks = server.db.prepare('SELECT title, due_date, owner, relationship_id FROM planner_tasks WHERE run_id = ? AND deleted_at IS NULL ORDER BY due_date, title').all(k.run);
  assert.equal(tasks.length, 6, 'never twice');
  assert.deepEqual(tasks.find((x) => x.title.startsWith('Follow up')), { title: 'Follow up: how is the new site working for them?', due_date: '2026-10-26', owner: 'owner', relationship_id: rels[0].id });
  assert.deepEqual(tasks.find((x) => x.title === 'Offer social media').due_date, '2026-11-11', 'no GWND social yet: offered a month out');

  // Its checklist on the device.
  const runSteps = await mac.engine.list('run_step', { where: { run_id: k.run } });
  const checklist = runChecklist(runSteps, await mac.engine.list('task', { where: { run_id: k.run } }));
  assert.deepEqual([checklist.current, checklist.total, checklist.done], ['Launch', 6, 0]);
});

test('done when: editing a playbook changes only future runs; an open step sheet keeps the other person’s change', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  const pb = await saveExample(mac.engine, 'onboarding');
  await mac.engine.syncNow();
  const first = await runOn(mac, pb, { name: 'Onboarding — Alpha', startDate: START, owner: '' }).catch((err) => err);
  assert.ok(first instanceof Error, 'a client playbook needs a client');
  const clientId = await mac.engine.create('client', { name: 'Alpha', status: 'active' });
  const accountId = await mac.engine.create('account', { client_id: clientId, name: 'Alpha' });
  const run1 = await runOn(mac, pb, { name: 'Onboarding — Alpha', startDate: START, clientId, accountId, owner: '' });
  await mac.engine.syncNow();
  await phone.engine.syncNow();

  // The Mac opens the kick-off step's sheet; meanwhile the phone moves it to 5 days; the Mac renames it.
  const kickoff = (await mac.engine.list('playbook_step', { where: { playbook_id: pb } })).find((s) => s.title === 'Kick-off call');
  const sheet = valuesFrom(stepForm, kickoff);
  await phone.engine.update('playbook_step', kickoff.id, { offset_amount: 5 });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const edit = editChanges(stepForm, sheet, { ...sheet, title: 'Kick-off video call' });
  assert.deepEqual(edit.fields, { title: 'Kick-off video call' });
  await mac.engine.update('playbook_step', kickoff.id, edit.fields);
  await mac.engine.syncNow();
  const step = row(server.db, 'playbooks_steps', kickoff.id);
  assert.deepEqual([step.title, step.offset_amount], ['Kick-off video call', 5], 'both changes survive');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);

  // The first run is untouched: its copy and its task keep the old title and day.
  const oldCopy = server.db.prepare("SELECT title, offset_amount FROM playbooks_run_steps WHERE run_id = ? AND step_id = ?").get(run1.ids.run, kickoff.id);
  assert.deepEqual(oldCopy, { title: 'Kick-off call', offset_amount: 3 });
  assert.deepEqual(server.db.prepare("SELECT title, due_date FROM planner_tasks WHERE run_id = ? AND title LIKE 'Kick-off%'").get(run1.ids.run), { title: 'Kick-off call', due_date: '2026-10-15' });

  // A new run (on the phone, once it has the Mac's rename) uses the playbook as it is now.
  await phone.engine.syncNow();
  const bravoClient = await phone.engine.create('client', { name: 'Bravo', status: 'active' });
  const bravoAccount = await phone.engine.create('account', { client_id: bravoClient, name: 'Bravo' });
  const run2 = await runOn(phone, pb, { name: 'Onboarding — Bravo', startDate: START, clientId: bravoClient, accountId: bravoAccount, owner: '' });
  await phone.engine.syncNow();
  assert.deepEqual(server.db.prepare("SELECT title, due_date, owner FROM planner_tasks WHERE run_id = ? AND title LIKE 'Kick-off%'").get(run2.ids.run),
    { title: 'Kick-off video call', due_date: '2026-10-17', owner: 'partner' });
  // Deleting the playbook leaves both runs and their copies.
  await mac.engine.syncNow();
  await mac.engine.remove('playbook', pb);
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  assert.equal((await phone.engine.list('run_step', { where: { run_id: run1.ids.run } })).length, 4, 'the run’s copy stays on devices');
  assert.ok(await phone.engine.get('playbook_run', run2.ids.run));
});

test('review fixes: runs under way for the Run sheet; runs made twice', () => {
  const runs = [
    { id: '01a', playbook_id: 'p', account_id: 'a', start_date: START, status: 'active', name: 'One' },
    { id: '01b', playbook_id: 'p', account_id: 'a', start_date: START, status: 'starting', name: 'Two' },
    { id: '01c', playbook_id: 'p', account_id: 'a', start_date: '2026-11-01', status: 'done', name: 'Old' },
    { id: '01d', playbook_id: 'q', account_id: 'a', start_date: START, name: 'Other playbook' },
  ];
  assert.deepEqual(runsUnderWay(runs, 'p', 'a').map((r) => r.id), ['01a', '01b'], 'not finished counts; done doesn’t');
  assert.deepEqual(runsUnderWay(runs, 'p', null), []);
  const twice = duplicateRuns(runs);
  assert.deepEqual([...twice.keys()].sort(), ['01a', '01b']);
  assert.equal(twice.get('01b').kept.id, '01a', 'the first made is kept');
  assert.deepEqual(twice.get('01a').extras.map((r) => r.id), ['01b']);

  const extra = { id: 'x', name: 'Extra', made: 'relationship:rel2 service:s2 renewal:s9:2026-01-01' };
  const synced = (o) => ({ ...o, _sync: { createdAt: 't', updatedAt: 't' } });
  const d = {
    runs: [extra, { id: 'k', relationship_id: 'rel1' }],
    tasks: [synced({ id: 't1', run_id: 'x', title: 'Go live' }), synced({ id: 't2', run_id: 'x', title: 'Done one', done_at: 'z' }),
      { id: 't3', run_id: 'x', title: 'Edited', _sync: { createdAt: 't', updatedAt: 'u' } }],
    relationships: [synced({ id: 'rel2' })],
    services: [synced({ id: 's2', name: 'Hosting', relationship_id: 'rel2' }), synced({ id: 's9', name: 'Domain', renewal_date: '2027-10-12' })],
  };
  const plan = extraRunPlan(extra, d);
  assert.deepEqual(plan.remove.map((r) => `${r.entity}:${r.id}`), ['task:t1', 'service:s2', 'relationship:rel2', 'playbook_run:x']);
  assert.ok(plan.left.some((l) => /2 of its tasks stay/.test(l)) && plan.left.some((l) => /“Domain” stays/.test(l)));
  const used = extraRunPlan(extra, { ...d, tasks: [...d.tasks, synced({ id: 'p1', title: 'Call them', relationship_id: 'rel2' })] });
  assert.ok(!used.remove.some((r) => r.entity === 'relationship'));
  assert.ok(used.left.some((l) => /relationship it added stays: the task “Call them”/.test(l)));
});

test('review fixes: a playbook run twice on two devices at once — Delete the extra takes back only what is untouched; Kept when changed on the other device', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  const clientId = await mac.engine.create('client', { name: 'Twice Bakery', status: 'active' });
  const accountId = await mac.engine.create('account', { client_id: clientId, name: 'Twice Bakery' });
  const pb = await saveExample(mac.engine, 'website_launch');
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  const choice = { name: 'Website launch — Twice Bakery', startDate: START, clientId, accountId, owner: '' };
  mac.online = false;
  phone.online = false;
  const a = await runOn(mac, pb, choice);
  const b = await runOn(phone, pb, choice);
  mac.online = true;
  phone.online = true;
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const runs = await mac.engine.list('playbook_run');
  const group = duplicateRuns(runs).get(a.ids.run);
  assert.ok(group, 'flagged as run twice');
  const extra = group.extras[0];
  const extraIds = extra.id === a.ids.run ? a.ids : b.ids;
  const keptIds = extra.id === a.ids.run ? b.ids : a.ids;
  // The other device ticks one of the extra's tasks (it stays), and — right after this device's first sync —
  // edits the extra's Hosting service, so its delete is kept.
  const hostingStep = (await phone.engine.list('playbook_step', { where: { playbook_id: pb } })).find((s) => s.title === 'Hosting');
  const extraHosting = extraIds.steps[hostingStep.id].service;
  const finalStep = (await phone.engine.list('playbook_step', { where: { playbook_id: pb } })).find((s) => s.position === 1);
  await phone.engine.update('task', extraIds.steps[finalStep.id].task, { done_at: '2026-10-12T15:00:00.000Z' });
  await phone.engine.syncNow();
  let calls = 0;
  const wrapped = Object.create(mac.engine);
  wrapped.syncNow = async (why) => {
    await mac.engine.syncNow(why);
    calls += 1;
    if (calls === 1) {
      await phone.engine.update('service', extraHosting, { notes: 'Paid three years ahead' });
      await phone.engine.syncNow();
    }
  };
  const out = await removeExtraRuns(wrapped, a.ids.run);
  assert.ok(out.removed.some((r) => r.entity === 'playbook_run' && r.id === extra.id));
  assert.ok(out.kept.some((r) => r.id === extraHosting), JSON.stringify(out));
  assert.ok(out.left.some((l) => /Kept: the service “Hosting” was changed on the other device/.test(l)), JSON.stringify(out.left));
  assert.ok(out.left.some((l) => /1 of its tasks stay/.test(l)));
  assert.ok(out.left.some((l) => /The relationship it added stays: its task “Final checks/.test(l)), 'the ticked task still names it');
  await phone.engine.syncNow();
  const live = (table, where, ...args) => server.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE deleted_at IS NULL AND ${where}`).get(...args).n;
  assert.equal(live('playbooks_runs', 'id = ?', extra.id), 0);
  assert.equal(live('playbooks_runs', 'id = ?', keptIds.run), 1);
  assert.equal(live('planner_tasks', 'run_id = ?', extra.id), 1, 'only the ticked one stays');
  assert.equal(live('planner_tasks', 'run_id = ?', keptIds.run), 6);
  assert.equal(live('crm_services', 'id = ?', extraIds.steps[(await phone.engine.list('playbook_step', { where: { playbook_id: pb } })).find((s) => s.title === 'Domain').id].service), 0, 'its untouched Domain goes');
  assert.equal(live('crm_services', 'id = ?', extraHosting), 1, 'its edited Hosting stays');
  assert.equal(duplicateRuns(await mac.engine.list('playbook_run')).size, 0);
});
