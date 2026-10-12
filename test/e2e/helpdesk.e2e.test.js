// The helpdesk (D14) in the browser, on an iPhone and on a Mac, against the fake IMAP server and the fake WooCommerce
// (server/test/fixtures/imapFake.js, wooStore.js): a customer's email (with HTML, a remote image, a script and an
// attachment) becomes a ticket; its task on Today opens the ticket ("Open the ticket"); the ticket shows the email as
// plain text only — nothing remote is loaded, nothing runs — the attachment by name, and its order looked up live (first
// name only); a saved answer made on the Saved answers page is copied and offered as a mailto: link; a reply that lands
// in the Sent folder marks the ticket answered. The Support mailboxes card on Connections lists the mailbox (never the
// password); the overview's support line links to the tickets. Every IMAP command a read, every store call a GET.
// Invented names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeImap, email } from '../../server/test/fixtures/imapFake.js';
import { startFakeWoo, order, STORE_KEY, STORE_SECRET } from '../../server/test/fixtures/wooStore.js';
import { WAIT, startServer, launch, watch, signIn, barSays, iphone, shot } from './helpers.js';

const USER = 'help@northerntins.example';
const PASS = 'abcd efgh ijkl mnop';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const READS = ['CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'NOOP', 'LOGOUT'];

async function setupMail(t, server) {
  const imap = await startFakeImap({ users: { [USER]: PASS } });
  t.after(() => imap.close());
  const store = await startFakeWoo(t, { name: 'Northern Tins' });
  store.state.orders = [order({ id: 1042, created: '2026-10-01T10:00:00', email: 'robin.q@example.com', first: 'Robin', last: 'Quincey', items: [{ name: 'Cool Mint 6mg', sku: 'NT-CM6', qty: 2, price: 12.5 }] })];
  const who = { actor: 'owner' };
  const woo = await server.ctx.services.woocommerce.addStore({ url: store.url, key: STORE_KEY, secret: STORE_SECRET, readOnlyConfirmed: true }, who);
  const helpdesk = server.ctx.services.helpdesk;
  const mb = await helpdesk.addMailbox({ name: 'Northern Tins help', host: '127.0.0.1', port: imap.port, username: USER, password: PASS, inboxFolder: 'INBOX', sentFolder: 'Sent', storeId: woo.id }, who);
  imap.add('INBOX', email({
    id: 'robin-1@example.com', from: 'Robin Quincey <robin.q@example.com>', to: USER, subject: 'Where is order #1042?',
    text: 'Hello, my order #1042 hasn’t arrived. Robin',
    html: '<p>Hello, my order <b>#1042</b> hasn’t arrived.</p><img src="https://tracker.example/pixel.gif"><script>window.__ran = 1</script><p>Robin</p>',
    attachments: ['box-photo.jpg'],
  }), { at: new Date(Date.now() - 2 * 60_000) });
  await helpdesk.pullRound({ force: true });
  return { imap, store, helpdesk, mb };
}

for (const [label, device] of [['iPhone', () => iphone()], ['Mac', () => ({ viewport: { width: 1280, height: 900 } })]]) {
  test(`${label}: a support email becomes a ticket with its order; a saved answer is copied; the reply in Sent marks it answered`, async (t) => {
    const server = await startServer(t, { env: { HELPDESK_TEST_PLAIN_LOCALHOST: '1' } });
    const { imap, store, helpdesk } = await setupMail(t, server);
    const browser = await launch(t);
    const context = await browser.newContext(device());
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
    const errors = await watch(context);
    const page = await context.newPage();
    const outside = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['127.0.0.1', 'localhost'].includes(u.hostname)) outside.push(r.url());
    });
    await signIn(page, server.base, 'jessy', server.users.owner.totpSecret);
    await barSays(page, 'All changes saved');

    // A saved answer first (synced: works offline like tasks).
    await page.goto(`${server.base}/helpdesk/answers`);
    await page.getByTestId('helpdesk-answer-new').click();
    const sheet = page.getByTestId('helpdesk-answer-sheet');
    await sheet.getByLabel('Title').fill('Where is my order');
    await sheet.getByLabel('Answer').fill('Hi {name}, your order shipped today with Canada Post.');
    await sheet.getByRole('button', { name: 'Save' }).click();
    await page.getByTestId('helpdesk-answer-list').getByText('Where is my order').waitFor(WAIT);

    // Today: the task on the shared list, its ticket one tap away.
    await page.goto(`${server.base}/`);
    const task = page.locator('.planner-task').filter({ hasText: 'Answer support email #1 (Northern Tins help)' });
    await task.waitFor(WAIT);
    assert.ok(!(await task.textContent()).includes('Robin'), 'no customer data in the task');
    await task.getByTestId('task-ticket').click();
    await page.waitForURL(/\/helpdesk\/tickets\//, WAIT);

    // The ticket: plain text only, the attachment by name, the order (first name only).
    const msg = page.getByTestId('helpdesk-message').first();
    await msg.getByTestId('helpdesk-text').getByText('Hello, my order #1042 hasn’t arrived. Robin').waitFor(WAIT);
    await msg.getByTestId('helpdesk-attachments').getByText(/box-photo\.jpg/).waitFor(WAIT);
    assert.equal(await page.locator('[data-testid="helpdesk-messages"] img, [data-testid="helpdesk-messages"] script, [data-testid="helpdesk-messages"] b').count(), 0, 'no HTML rendered');
    assert.equal(await page.evaluate(() => window.__ran), undefined, 'nothing in the email ran');
    const found = page.getByTestId('helpdesk-order').getByTestId('sales-order').filter({ hasText: 'Order #1042' });
    await found.getByText('for Robin').waitFor(WAIT);
    await found.getByText('2 × Cool Mint 6mg (NT-CM6)').waitFor(WAIT);
    await page.getByTestId('helpdesk-order').getByText(/order number in the email: #1042/).waitFor(WAIT);
    assert.equal(await page.locator('[data-sender-matches="0"]').count(), 0, 'the order is under the sender’s email');
    const html = await page.content();
    for (const s of ['12 Main St', '5195550100', 'leave at the back door']) assert.ok(!html.includes(s), `${s} isn’t shown`);

    // The saved answer: copied with the customer's first name; the mailto link written in.
    const answers = page.getByTestId('helpdesk-answers');
    await answers.getByTestId('helpdesk-copy').click();
    await answers.getByRole('button', { name: 'Copied' }).waitFor(WAIT);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Hi Robin, your order shipped today with Canada Post.');
    const href = await answers.getByTestId('helpdesk-mailto').getAttribute('href');
    assert.ok(href.startsWith('mailto:robin.q@example.com?subject=Re%3A%20Where%20is%20order%20%231042%3F&body=Hi%20Robin%2C'), href);
    if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on the ticket');
    await shot(page, `d14-ticket-${label.toLowerCase()}`);

    // You reply from your normal mail: the reply lands in the Sent folder; the next read marks the ticket answered.
    imap.add('Sent', email({ id: 'reply-1@northerntins.example', from: USER, to: 'robin.q@example.com', subject: 'Re: Where is order #1042?', inReplyTo: 'robin-1@example.com', text: 'Shipped!' }));
    await helpdesk.pullRound({ force: true });
    await page.reload();
    await page.locator('[data-testid="helpdesk-ticket"][data-state="answered"]').waitFor(WAIT);
    await page.getByTestId('helpdesk-message').filter({ hasText: 'Your reply' }).getByText(/Seen in the Sent folder/).waitFor(WAIT);

    // The list, and the mailbox's card on Connections (never the password).
    await page.goto(`${server.base}/helpdesk?state=answered`);
    await page.locator('[data-testid="helpdesk-tickets"] [data-state="answered"]').getByText('#1 · Where is order #1042?').waitFor(WAIT);
    await page.goto(`${server.base}/system/connections`);
    await page.getByTestId('helpdesk-mailbox').getByText(/help@northerntins\.example/).waitFor(WAIT);
    assert.ok(!(await page.content()).includes(PASS));
    if (label === 'iPhone') assert.ok((await noSideways(page)) <= 0, 'no sideways scrolling on Connections');
    await shot(page, `d14-connections-${label.toLowerCase()}`);

    // The overview's support line: connected, nothing over 24 hours, a link to the tickets.
    await page.goto(`${server.base}/overview`);
    const support = page.locator('[data-section="support"]');
    await support.getByText('No support email has waited 24 hours for a reply.').waitFor(WAIT);

    assert.deepEqual(outside, [], 'nothing from outside the suite was loaded');
    assert.deepEqual(imap.names().filter((n) => !READS.includes(n)), []);
    assert.deepEqual(imap.flagsOf('INBOX', 1), [], 'nothing marked read');
    for (const r of store.requests) assert.deepEqual([r.method, r.bodyLength], ['GET', 0], r.path);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
    assert.ok(helpdesk.listTickets({ state: 'all' }).tickets.length === 1);
  });
}
