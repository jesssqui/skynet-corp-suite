// Notes and follow-ups from the Order Manager (D5) in the browser, on a Mac and on an iPhone: a linked
// customer's notes on its client's timeline (type, who wrote it there, "from the Order Manager"),
// filtered by type; the account card's next follow-up; the follow-up task on the owner's Today; a
// customer still waiting for a client shows its notes waiting; on the phone the notes are there in
// airplane mode too. Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDate } from '@suite/shared/time';
import { WAIT, startServer, launch, watch, signIn, iphone, shot, airplane } from './helpers.js';
import { womKit, postEvents } from '../../server/test/fixtures/wom.js';

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function setup(t) {
  const server = await startServer(t);
  const { ctx } = server;
  const secret = ctx.services.wholesale.makeSecret({ actor: 'owner' });
  const make = (entity, fields) => {
    const r = ctx.services.sync.applyLocal({ actor: 'owner', entity, op: 'create', fields });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    return r.recordId;
  };
  const clientId = make('client', { name: 'Maple Corner Store', status: 'active' });
  const accountId = make('account', { client_id: clientId, name: 'Maple Corner Store' });
  make('activity', { client_id: clientId, type: 'note', body: 'Met them at the spring trade show', at: '2026-04-02T15:00:00.000Z' });
  const today = localDate();
  const om = womKit({ by: 'robin' });
  const c = om.customer({ business_name: 'Maple Corner Store' });
  const waiting = om.customer({ business_name: 'Birch Trading' });
  const events = [
    om.customerCreated(c),
    om.noteAdded(om.note(c, { type: 'call', body: 'Asked for the Velo price list', at: '2026-10-01T14:00:00.000Z', written_by: 'sam' })),
    om.noteAdded(om.note(c, { type: 'follow_up', body: 'Followed up: ordering Friday', at: '2026-10-03T16:00:00.000Z', written_by: 'robin' })),
    om.followUpChanged(c, today),
    om.customerCreated(waiting),
    om.noteAdded(om.note(waiting, { type: 'meeting', body: 'Met at the trade show' })),
    om.noteAdded(om.note(waiting, { type: 'note', body: 'Wants net 30' })),
  ];
  assert.ok((await postEvents(server.direct, secret, events)).body.results.every((r) => r.status === 'applied'));
  ctx.services.wholesale.linkToClient(c.customer_uid, { clientId, accountId }, { actor: 'owner' });
  return { server, ctx, clientId, accountId, today, waiting };
}

async function checkTimeline(page, server, { clientId, label }) {
  await page.goto(`${server.base}/crm/clients/${clientId}`);
  const call = page.locator('[data-wholesale="wholesale_note"][data-type="call"]');
  await call.waitFor(WAIT);
  await call.getByText('Asked for the Velo price list').waitFor(WAIT);
  await call.getByText('by sam').waitFor(WAIT);
  await call.getByText('from the Order Manager').waitFor(WAIT);
  await page.locator('[data-wholesale="wholesale_note"][data-type="follow_up"]').getByText('Follow-up done').waitFor(WAIT);
  await page.getByTestId('account-wholesale-follow-up').filter({ hasText: 'Next follow-up in the Order Manager:' }).waitFor(WAIT);
  await shot(page, `d5-client-timeline-${label}`);
  assert.equal(await noSideways(page), 0);
  // Type: Call → only the Order Manager's call; Notes → the follow-up done there and our own note.
  await page.locator('#tl-type').selectOption('call');
  await page.getByTestId('timeline-count').filter({ hasText: '1 of 3' }).waitFor(WAIT);
  await page.locator('#tl-type').selectOption('note');
  await page.getByTestId('timeline-count').filter({ hasText: '2 of 3' }).waitFor(WAIT);
  await page.locator('#tl-type').selectOption('all');
}

test('Mac: Order Manager notes on the timeline, the next follow-up, its task on Today, notes waiting with an unlinked customer', async (t) => {
  const s = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, s.server.base, 'jessy', s.server.users.owner.totpSecret);
  await checkTimeline(page, s.server, { clientId: s.clientId, label: 'mac' });

  // The follow-up date (today) is a task on the owner's Today (the wholesale business's default owner).
  await page.goto(`${s.server.base}/`);
  await page.getByText('Follow up with Maple Corner Store').waitFor(WAIT);
  await shot(page, 'd5-today-mac');

  // Waiting for a client: its notes wait with it.
  await page.goto(`${s.server.base}/wholesale`);
  const row = page.locator(`[data-customer="${s.waiting.customer_uid}"]`);
  await row.getByText('2 notes waiting', { exact: false }).waitFor(WAIT);
  await page.getByTestId('waiting-counts').filter({ hasText: '2 notes' }).waitFor(WAIT);
  await shot(page, 'd5-waiting-mac');
  assert.equal(await noSideways(page), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
});

test('iPhone: Order Manager notes on the timeline, offline too', async (t) => {
  const s = await setup(t);
  const browser = await launch(t);
  const context = await browser.newContext(iphone());
  const errors = await watch(context);
  const page = await context.newPage();
  await signIn(page, s.server.base, 'sam', s.server.users.partner.totpSecret);
  await checkTimeline(page, s.server, { clientId: s.clientId, label: 'iphone' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, WAIT);
  await airplane(context, s.server, true);
  await page.reload();
  await page.locator('[data-wholesale="wholesale_note"]').first().waitFor(WAIT);
  assert.equal(await page.locator('[data-wholesale="wholesale_note"]').count(), 2);
  await shot(page, 'd5-client-timeline-iphone-offline');
  await airplane(context, s.server, false);
  assert.deepEqual(errors, []);
});
