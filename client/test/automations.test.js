// Automations (C8) on devices: the tasks and alerts an automation makes on the server reach both
// people's devices with their next pull (they are ordinary synced records, made by 'system'); the
// "no next step" flag clears on the device; each person marks an alert read on their own field,
// offline too, and two devices of one person marking it read never clash. Plus the page's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDate } from '@suite/shared/time';
import { relationshipsWithoutNextStep } from '@suite/shared/planner';
import { startServer, makeDevice, row, count } from './helpers.js';
import { unreadAlerts, readChange, isUnread, unreadText, safeLink } from '../src/modules/automations/alerts.js';
import { nextRunText, runText } from '../src/modules/automations/logic.js';

const W = BUSINESS_IDS.wholesale;

function seed(server) {
  const make = (entity, fields) => {
    const r = server.ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const client = make('client', { name: 'Northwind Holdings', status: 'active' });
  const account = make('account', { client_id: client, name: 'Cloud Vape Co' });
  const rel = make('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' });
  return { client, account, rel };
}

async function flagged(engine) {
  const [relationships, accounts, clients, tasks] = await Promise.all(['relationship', 'account', 'client', 'task'].map((e) => engine.list(e)));
  return relationshipsWithoutNextStep({ relationships, accounts, clients, tasks }).map((r) => r.id);
}

test('devices pull what an automation made: the task (by the suite), the flag cleared, the alert for both people', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const ids = seed(server);
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  assert.deepEqual(await flagged(mac.engine), [ids.rel], 'flagged before');

  const autos = server.ctx.services.automations;
  autos.setSettings('no-next-step', { alert: true }, { actor: 'owner' });
  const run = autos.runNow('no-next-step', { actor: 'owner' });
  assert.equal(run.createdCount, 1);

  await mac.engine.syncNow();
  await phone.engine.syncNow();
  for (const dev of [mac, phone]) {
    const tasks = await dev.engine.list('task');
    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.deepEqual([task.title, task.owner, task.relationship_id, task.due_date], ['Set the next step for Cloud Vape Co (Wholesale)', 'owner', ids.rel, localDate()]);
    assert.equal(task._sync.createdBy, 'system', 'shown as made by the suite (“Automatic”)');
    assert.deepEqual(await flagged(dev.engine), [], 'the flag is cleared on the device');
    const alerts = await dev.engine.list('alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].title, '1 relationship needs a next step');
    assert.equal(unreadAlerts(alerts, dev.actor).length, 1, `unread for ${dev.actor}`);
  }

  // Run again: nothing new reaches anyone.
  assert.equal(autos.runNow('no-next-step', { actor: 'partner' }).createdCount, 0);
  await mac.engine.syncNow();
  assert.equal((await mac.engine.list('task')).length, 1);
});

test('alerts: each person marks read on their own field, offline too; two devices of one person never clash', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const autos = server.ctx.services.automations;
  const alertId = autos.createAlert({ source: 'friday-review', title: 'The Friday review is ready', link: '/plan/review' });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'owner');
  const partner = await makeDevice(t, server, 'partner');

  // Both of the owner's devices mark it read while offline, then sync.
  mac.online = false;
  phone.online = false;
  await mac.engine.update('alert', alertId, readChange('owner'));
  await phone.engine.update('alert', alertId, readChange('owner'));
  assert.equal(isUnread(await mac.engine.get('alert', alertId), 'owner'), false, 'read at once, offline');
  mac.online = true;
  phone.online = true;
  await mac.engine.syncNow();
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  assert.equal(count(server.db, 'SELECT count(*) AS n FROM sync_clashes'), 0, 'same value from both: no clash');
  const saved = row(server.db, 'automations_alerts', alertId);
  assert.deepEqual([saved.read_by_owner, saved.read_by_partner], [1, null]);

  // Still unread for the partner, who marks it read separately.
  await partner.engine.syncNow();
  const forPartner = await partner.engine.get('alert', alertId);
  assert.equal(isUnread(forPartner, 'partner'), true);
  assert.equal(isUnread(forPartner, 'owner'), false);
  await partner.engine.update('alert', alertId, readChange('partner'));
  await partner.engine.syncNow();
  assert.equal(row(server.db, 'automations_alerts', alertId).read_by_partner, 1);

  // A device can't rewrite an alert: the server refuses it (Needs attention), the title stays.
  await mac.engine.update('alert', alertId, { title: 'Something else' });
  await mac.engine.syncNow();
  const [refused] = await mac.engine.attentionList();
  assert.equal(refused.code ?? refused.result?.code, 'invalid_value', JSON.stringify(refused));
  assert.equal(row(server.db, 'automations_alerts', alertId).title, 'The Friday review is ready');
});

test('the Automations page’s text: last runs, next runs, alerts', () => {
  const now = Date.parse('2026-10-08T14:00:00Z');
  assert.equal(nextRunText({ enabled: false, nextRunAt: null }, { now }), 'Switched off — Run now still works');
  assert.equal(nextRunText({ enabled: true, trigger: { type: 'event' }, nextRunAt: null }, { now }), 'When it happens');
  assert.equal(nextRunText({ enabled: true, trigger: { type: 'schedule' }, nextRunAt: '2026-10-08T14:00:30Z' }, { now }), 'Due now (within a minute)');
  assert.match(nextRunText({ enabled: true, trigger: { type: 'schedule' }, nextRunAt: '2026-10-09T12:00:00Z' }, { now }), /2026/);
  assert.match(nextRunText({ enabled: true, trigger: { type: 'schedule' }, nextRunAt: '2026-10-09T12:00:00Z' }, { now, scheduled: false }), /scheduler off/);
  const base = { startedAt: '2026-10-09T12:00:00Z', status: 'ok', summary: 'Made 1 task' };
  assert.match(runText({ ...base, trigger: 'schedule' }, 'owner'), / · on schedule · Made 1 task$/);
  assert.match(runText({ ...base, trigger: 'manual', actor: 'owner' }, 'owner'), / · Run now by you · Made 1 task$/);
  assert.match(runText({ ...base, trigger: 'manual', actor: 'partner' }, 'owner'), /Run now by your partner/);
  assert.match(runText({ ...base, status: 'error', error: 'boom', trigger: 'schedule' }, 'owner'), /Failed: boom$/);
  assert.deepEqual([unreadText(1), unreadText(3)], ['1 new alert', '3 new alerts']);
  assert.deepEqual(['/plan/review', '//evil.example', 'https://evil.example', null].map(safeLink), ['/plan/review', null, null, null]);
  const alerts = [{ id: 'a', at: '2026-10-01T00:00:00Z' }, { id: 'b', at: '2026-10-02T00:00:00Z', read_by_owner: true }, { id: 'c', at: '2026-10-03T00:00:00Z' }];
  assert.deepEqual(unreadAlerts(alerts, 'owner').map((a) => a.id), ['c', 'a']);
  assert.deepEqual(unreadAlerts(alerts, 'partner').map((a) => a.id), ['c', 'b', 'a']);
});
