// Connections and automations (C8) in the browser, on a Mac and on an iPhone: the Connections page
// (the backup always on, placeholders, the test connection switched off and on again), the
// Automations page ("Never run" first), "No next step" run now — its task on Today and the flag
// gone — run again (nothing new), "last run" updated, and the alert in the shell (the bell on the
// Mac, the strip on the phone) and on the alerts list. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSINESS_IDS } from '@suite/shared/crm';
import conndemo from '../../server/test/fixtures/conndemo/index.js';
import { WAIT, startServer, launch, watch, signIn, iphone, shot } from './helpers.js';

const W = BUSINESS_IDS.wholesale;
const TASK = 'Set the next step for Cloud Vape Co (Wholesale)';

function seed(ctx) {
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const client = make('client', { name: 'Northwind Holdings', status: 'active' });
  const account = make('account', { client_id: client, name: 'Cloud Vape Co' });
  return { rel: make('relationship', { account_id: account, business_id: W, kind: 'wholesale', status: 'active' }) };
}

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();

async function connections(page, server, label) {
  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Connections' }).click();
  await page.waitForURL(/\/system\/connections$/, WAIT);
  const card = (id) => page.locator(`[data-connection="${id}"]`);
  await card('backup').getByText('Always on', { exact: true }).waitFor(WAIT);
  await page.getByTestId('always-on-backup').filter({ hasText: 'can’t pause' }).waitFor(WAIT);
  assert.equal(await card('backup').getByRole('switch').count(), 0, 'no switch for backups');
  // D1 made the Order Manager's row real (test/e2e/wholesale.e2e.test.js); the others still wait.
  await page.locator('[data-connection="wom"][data-state="on"]').waitFor(WAIT);
  for (const [id, pkg] of [['calendar', 'C6'], ['stockroom', 'D16']]) {
    await page.getByTestId(`placeholder-${id}`).filter({ hasText: `Not connected yet · comes with ${pkg}` }).waitFor(WAIT);
    assert.equal(await card(id).getByRole('switch').count(), 0);
  }
  // The test connection: off (paused), the queue builds, on again (it catches up).
  const demo = card('conndemo');
  await demo.getByTestId('queue-conndemo').filter({ hasText: 'Nothing waiting' }).waitFor(WAIT);
  await demo.getByRole('switch').click();
  await page.locator('[data-connection="conndemo"][data-state="paused"]').waitFor(WAIT);
  await demo.getByText('Paused by you').waitFor(WAIT);
  assert.equal(server.ctx.services.connections.isPaused('conndemo'), true);
  server.ctx.services.conndemo.enqueue(`${label} job`);
  await page.getByRole('button', { name: 'Check again' }).click();
  await demo.getByTestId('queue-conndemo').filter({ hasText: '1 waiting' }).waitFor(WAIT);
  await shot(page, `connections-${label}`);
  assert.equal(await noSideways(page), 0, 'no sideways scrolling');
  await demo.getByRole('switch').click();
  await page.locator('[data-connection="conndemo"][data-state="on"]').waitFor(WAIT);
  await demo.getByTestId('queue-conndemo').filter({ hasText: 'Nothing waiting' }).waitFor(WAIT);
  assert.deepEqual(server.ctx.services.conndemo.remote.received, [`${label} job`], 'caught up once on');
  const changes = server.db.prepare("SELECT actor FROM connections_changes WHERE connection_id = 'conndemo'").all();
  assert.deepEqual(changes.map((c) => c.actor), ['owner', 'owner']);
}

async function automations(page, server, { phone, label }) {
  const taskCount = () => server.db.prepare('SELECT count(*) AS n FROM planner_tasks WHERE title = ? AND deleted_at IS NULL').get(TASK).n;
  // Today first: the relationship is flagged.
  await nav(page, 'Today');
  await page.getByTestId('no-next-step-summary').filter({ hasText: '1 active relationship has no dated next step' }).waitFor(WAIT);

  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Automations' }).click();
  await page.waitForURL(/\/system\/automations$/, WAIT);
  const card = (id) => page.locator(`[data-automation="${id}"]`);
  for (const id of ['friday-review', 'no-next-step']) await page.getByTestId(`last-run-${id}`).filter({ hasText: 'Never run' }).waitFor(WAIT);
  await page.getByTestId('when-friday-review').filter({ hasText: 'Every Friday at 8:00 a.m.' }).waitFor(WAIT);
  await page.getByTestId('when-no-next-step').filter({ hasText: 'Every day at 7:30 a.m.' }).waitFor(WAIT);
  // Off and silent by default: switch it on, and to Alert so the shell shows what it did.
  const nns = card('no-next-step');
  await page.getByTestId('next-run-no-next-step').filter({ hasText: 'Switched off' }).waitFor(WAIT);
  await page.getByTestId('enabled-no-next-step').click();
  await page.locator('[data-testid="enabled-no-next-step"][aria-checked="true"]').waitFor(WAIT);
  assert.equal(server.ctx.services.automations.get('no-next-step').enabled, true);
  assert.equal(await nns.getByRole('radio', { name: 'Silent' }).getAttribute('aria-checked'), 'true');
  await nns.getByRole('radio', { name: 'Alert' }).click();
  await page.waitForFunction(() => document.querySelector('[data-automation="no-next-step"] [role="radio"][aria-checked="true"]')?.textContent.includes('Alert'), null, WAIT);
  assert.equal(server.ctx.services.automations.get('no-next-step').alert, true);

  // Run now: one task, for the wholesale owner, due today.
  await page.getByTestId('run-no-next-step').click();
  await page.getByTestId('result-no-next-step').filter({ hasText: 'Made 1 task' }).waitFor(WAIT);
  await page.getByTestId('last-run-no-next-step').filter({ hasText: 'Made 1 task' }).filter({ hasText: 'Run now by you' }).waitFor(WAIT);
  assert.equal(taskCount(), 1);
  const firstRun = await page.getByTestId('last-run-no-next-step').innerText();

  // The alert in the shell: the bell on the Mac, the strip on the phone.
  if (phone) {
    await page.getByTestId('alerts-strip').filter({ hasText: '1 new alert · 1 relationship needs a next step' }).waitFor(WAIT);
  } else {
    await page.getByTestId('alerts-count').filter({ hasText: '1' }).waitFor(WAIT);
  }
  await page.getByTestId('alerts-link').filter({ hasText: '1 new alert' }).waitFor(WAIT);

  // Its task is on Today, and the flag is gone.
  await nav(page, 'Today');
  await page.getByTestId('today-tasks').getByText(TASK).waitFor(WAIT);
  await page.getByTestId('no-next-step-summary').waitFor({ state: 'detached', ...WAIT });

  // Run again: nothing new; "last run" moves on.
  await nav(page, 'System');
  await page.getByRole('radio', { name: 'Automations' }).click();
  await page.getByTestId('run-no-next-step').click();
  await page.getByTestId('result-no-next-step').filter({ hasText: 'Every active relationship has a next step' }).waitFor(WAIT);
  await page.getByTestId('last-run-no-next-step').filter({ hasText: 'Every active relationship has a next step' }).waitFor(WAIT);
  assert.notEqual(await page.getByTestId('last-run-no-next-step').innerText(), firstRun);
  assert.equal(taskCount(), 1, 'nothing new');
  await page.getByTestId('next-run-no-next-step').waitFor(WAIT);

  // The Friday review (alert by default) for the alerts list.
  await page.getByTestId('run-friday-review').click();
  await page.getByTestId('result-friday-review').filter({ hasText: 'Made the Friday review' }).waitFor(WAIT);
  await page.getByTestId('alerts-link').filter({ hasText: '2 new alerts' }).waitFor(WAIT);
  await shot(page, `automations-${label}`);
  assert.equal(await noSideways(page), 0);

  // The alerts list: both, newest first; mark one read, then all.
  if (phone) await page.getByTestId('alerts-strip').click();
  else await page.getByTestId('alerts-bell').click();
  await page.waitForURL(/\/alerts$/, WAIT);
  const items = page.locator('[data-alert-id]');
  await items.nth(1).waitFor(WAIT);
  assert.deepEqual(await items.locator('p').first().allInnerTexts(), ['The Friday review is ready']);
  await shot(page, `alerts-${label}`);
  assert.equal(await noSideways(page), 0);
  await page.getByRole('button', { name: 'Mark all read' }).click();
  await page.locator('[data-alert-id][data-unread="true"]').first().waitFor({ state: 'detached', ...WAIT });
  if (!phone) await page.getByTestId('alerts-count').waitFor({ state: 'detached', ...WAIT });
  await page.getByText('Nothing new').waitFor(WAIT);
  await nav(page, 'Today');
  assert.equal(await page.getByTestId('alerts-strip').count(), 0, 'no strip once read');
  // Read on the server for this person only.
  const rows = await (async () => {
    const end = Date.now() + WAIT.timeout;
    for (;;) {
      const r = server.db.prepare('SELECT read_by_owner, read_by_partner FROM automations_alerts').all();
      if (r.every((x) => x.read_by_owner === 1) || Date.now() > end) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
  })();
  assert.deepEqual(rows, [{ read_by_owner: 1, read_by_partner: null }, { read_by_owner: 1, read_by_partner: null }]);
}

for (const [label, phone] of [['mac', false], ['iphone', true]]) {
  test(`Connections and Automations on the ${label === 'mac' ? 'Mac' : 'iPhone'}: switch, run now, task on Today, nothing twice, the alert`, async (t) => {
    const server = await startServer(t, { extraModules: [conndemo] });
    seed(server.ctx);
    const browser = await launch(t);
    const context = await browser.newContext(phone ? iphone() : { viewport: { width: 1280, height: 900 } });
    const errors = await watch(context);
    const page = await context.newPage();
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await connections(page, server, label);
    await automations(page, server, { phone, label });
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  });
}
