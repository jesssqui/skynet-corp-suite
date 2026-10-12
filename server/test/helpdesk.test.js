// The helpdesk (D14) in the app, against the fake IMAP server (fixtures/imapFake.js) and the fake WooCommerce
// (fixtures/wooStore.js). The plan's "done when": a test email becomes a ticket showing its order, and replying from
// your normal mail (the reply lands in the Sent folder) marks it answered. Then: the login checked before anything is
// saved (the password only encrypted, never returned or logged), read only (nothing marked read, only read commands),
// threads (headers, subjects, the customer writing again), what is never a ticket, the task on the shared list ("who
// finished it decides": ticking it closes the ticket), the 24-hour flag and the overview's support line, closing and
// reopening, incremental reads by UID (a new UIDVALIDITY re-read without duplicates), pause = no calls, failures and
// backoff, retention, removing a mailbox, restores. Toronto time.
process.env.TZ = 'America/Toronto';

/* eslint-disable import/first */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { modules } from '../src/modules/index.js';
import { runBackup } from '../src/backup/backup.js';
import { restoreBackup, KEPT_TABLES } from '../src/backup/restore.js';
import { connectionId, BODY_KEEP_DAYS, TICKET_KEEP_DAYS, MAX_PER_ROUND, FIRST_READ_DAYS } from '../src/modules/helpdesk/service.js';
import { AUTOMATION_ID } from '../src/modules/helpdesk/automations.js';
import { startFakeImap, email } from './fixtures/imapFake.js';
import { startFakeWoo, order, STORE_KEY, STORE_SECRET } from './fixtures/wooStore.js';
import { tmpDir, testConfig, startApp, ensureTestUsers, testClock, sessionFor, capturingLog } from './helpers.js';

const START = Date.parse('2026-10-14T14:00:00Z'); // Wednesday 10:00 in Toronto
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const USER = 'support@tins.ca';
const PASS = 'abcd efgh ijkl mnop';
const at = (ms) => new Date(ms).toISOString();

async function setup(t, { config, clock = testClock(), start = START, log, imapOpts = {} } = {}) {
  const cfg = config ?? testConfig(tmpDir(t), { HELPDESK_TEST_PLAIN_LOCALHOST: '1', HELPDESK_TIMEOUT_MS: '1500', WOO_TIMEOUT_MS: '1000' });
  const setNow = (ms) => { clock.offsetMs = ms - Date.now(); };
  if (start !== null) setNow(start);
  const env = await startApp(t, cfg, { modules, now: clock.now, ...(log ? { log } : {}) });
  const users = await ensureTestUsers(env.ctx);
  const owner = sessionFor(env.ctx, users.owner);
  const call = async (method, url, { body, session = owner } = {}) => {
    const res = await fetch(`${env.base}${url}`, {
      method,
      headers: {
        ...(session ? { cookie: session.cookie } : {}),
        ...(method !== 'GET' ? { origin: env.base } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const imap = await startFakeImap({ users: { [USER]: PASS }, folders: ['INBOX', 'Sent'], ...imapOpts });
  t.after(() => imap.close());
  const svc = env.ctx.services.helpdesk;
  /** Add the mailbox through the API (the fake server on this machine) and wait for its first read. */
  const add = async (extra = {}) => {
    const r = await call('POST', '/api/helpdesk/mailboxes', { body: { name: 'TinsXpress', host: '127.0.0.1', port: imap.port, username: USER, password: PASS, inboxFolder: 'INBOX', sentFolder: 'Sent', ...extra } });
    assert.equal(r.status, 201, r.text);
    await svc.pullMailbox(r.body.mailbox.id);
    return r.body.mailbox;
  };
  /** Read every mailbox now (as the pull loop does when due), then the automation. */
  const pull = () => svc.pullRound({ force: true });
  const tasks = () => env.db.prepare("SELECT * FROM planner_tasks WHERE deleted_at IS NULL AND title LIKE 'Answer support email%' ORDER BY created_at, id").all();
  const tickets = () => env.db.prepare('SELECT * FROM helpdesk_tickets ORDER BY number').all();
  const sync = env.ctx.services.sync;
  return { ...env, config: cfg, clock, setNow, users, owner, call, imap, svc, add, pull, tasks, tickets, sync };
}

// ---- the plan's "done when" ------------------------------------------------------------------------------------------
test('done when: a test email becomes a ticket showing its order, and replying from your normal mail marks it answered', async (t) => {
  const s = await setup(t);
  const woo = await startFakeWoo(t);
  woo.state.orders = [order({ id: 1042, created: '2026-10-10T09:00:00', email: 'pat@example.com', first: 'Pat', last: 'Lefty', items: [{ name: 'Zyn Cool Mint 6mg', sku: 'ZYN-CM6', qty: 3, price: 10 }] })];
  const store = await s.call('POST', '/api/woocommerce/stores', { body: { url: woo.url, key: STORE_KEY, secret: STORE_SECRET, readOnlyConfirmed: true } });
  assert.equal(store.status, 201, store.text);
  const mb = await s.add({ storeId: store.body.store.id });

  // A customer writes.
  const uid = s.imap.add('INBOX', email({ id: 'q1@example.com', from: 'Pat Lefty <Pat@Example.com>', subject: 'Where is my order #1042?', text: 'Hi, my order #1042 hasn’t arrived yet. Thanks, Pat', attachments: ['photo.jpg'] }), { at: at(START + 5 * MINUTE) });
  s.setNow(START + 10 * MINUTE);
  await s.pull();
  const [tk] = s.tickets();
  assert.equal(tk.state, 'waiting');
  assert.equal(tk.customer_email, 'pat@example.com');
  assert.equal(tk.number, 1);

  // The ticket page: the email as plain text, the attachment by name only.
  const page = await s.call('GET', `/api/helpdesk/tickets/${tk.id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.body.ticket.state, 'waiting');
  assert.equal(page.body.messages.length, 1);
  assert.equal(page.body.messages[0].text, 'Hi, my order #1042 hasn’t arrived yet. Thanks, Pat');
  assert.deepEqual(page.body.messages[0].attachments, ['photo.jpg']);
  assert.deepEqual(page.body.orderNumbers, ['1042']);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM helpdesk_messages').all()).includes('secret contents'), 'no attachment is stored');

  // Its order, live from the store (first name only) — nothing about it kept.
  const o = await s.call('POST', `/api/helpdesk/tickets/${tk.id}/order`, { body: {} });
  assert.equal(o.status, 200, o.text);
  assert.equal(o.body.by, 'number');
  assert.equal(o.body.orders.length, 1);
  assert.equal(o.body.orders[0].number, '1042');
  assert.equal(o.body.orders[0].customerFirstName, 'Pat');
  assert.deepEqual(o.body.orders[0].items.map((i) => i.sku), ['ZYN-CM6']);
  const everything = JSON.stringify(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'helpdesk_%'").all()
    .map(({ name }) => s.db.prepare(`SELECT * FROM ${name}`).all()));
  assert.ok(!everything.includes('ZYN-CM6') && !everything.includes('Zyn Cool Mint') && !everything.includes('12 Main St') && !everything.includes('Brantford'), 'the order isn’t stored');

  // A task on the shared retail list: the ticket's number and mailbox only.
  const [task] = s.tasks();
  assert.equal(task.owner, 'shared');
  assert.equal(task.business_id, BUSINESS_IDS.retail);
  assert.equal(task.title, 'Answer support email #1 (TinsXpress)');
  assert.equal(task.due_date, '2026-10-14');
  assert.match(task.notes, new RegExp(`/helpdesk/tickets/${tk.id}`));
  assert.ok(!/pat|1042|arrived/i.test(`${task.title}\n${task.notes}`), 'no customer data in the task (it syncs to devices and the calendar feed)');

  // Reply from your normal mail: it lands in the Sent folder.
  s.imap.add('Sent', email({ id: 'r1@tins.ca', from: USER, to: 'pat@example.com', subject: 'Re: Where is my order #1042?', inReplyTo: 'q1@example.com', references: ['q1@example.com'], text: 'It shipped today.' }), { at: at(START + 2 * HOUR) });
  s.setNow(START + 2 * HOUR + 10 * MINUTE);
  await s.pull();
  const after = s.tickets()[0];
  assert.equal(after.state, 'answered');
  assert.equal(after.last_reply_at, at(START + 2 * HOUR).replace('Z', '.000Z').replace('.000.000Z', '.000Z'));
  const done = s.tasks()[0];
  assert.ok(done.done_at, 'the task is finished');
  assert.match(done.notes, /Answered from your mail on Oct 14, 2026 — finished by the suite/);
  const msgs = (await s.call('GET', `/api/helpdesk/tickets/${tk.id}`)).body.messages;
  assert.deepEqual(msgs.map((m) => m.direction), ['in', 'out']);
  assert.equal(msgs[1].text, null, 'our reply’s body is never kept');

  // Read only: nothing was marked read, and only read commands were sent.
  assert.deepEqual(s.imap.flagsOf('INBOX', uid), []);
  const names = new Set(s.imap.names());
  assert.deepEqual([...names].filter((n) => !['CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'UID SEARCH', 'UID FETCH', 'NOOP', 'LOGOUT'].includes(n)), []);
  assert.ok(!names.has('SELECT'));
  assert.ok(s.imap.commands.filter((c) => c.name === 'UID FETCH').every((c) => /PEEK/.test(c.args[2])));
  assert.equal(mb.name, 'TinsXpress');
});

// ---- adding a mailbox ---------------------------------------------------------------------------------------------------
test('a mailbox is checked with a real login (both folders) before anything is saved; the app password is only kept encrypted, never returned or logged', async (t) => {
  const log = capturingLog();
  const s = await setup(t, { log });
  const body = { name: 'Tins', host: '127.0.0.1', port: s.imap.port, username: USER, password: PASS, inboxFolder: 'INBOX', sentFolder: 'Sent' };
  let r = await s.call('POST', '/api/helpdesk/mailboxes', { body: { ...body, password: 'nope nope' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'refused');
  assert.match(r.body.error, /app password/);
  s.imap.specialUse.Sent = '\\Sent';
  r = await s.call('POST', '/api/helpdesk/mailboxes', { body: { ...body, sentFolder: 'Sent Items' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'no_folder');
  assert.match(r.body.error, /its Sent folder is “Sent”/);
  assert.deepEqual(r.body.details.folders, ['INBOX', 'Sent']);
  r = await s.call('POST', '/api/helpdesk/mailboxes', { body: { ...body, host: 'not a host' } });
  assert.equal(r.body.code, 'bad_host');
  r = await s.call('POST', '/api/helpdesk/mailboxes', { body: { ...body, port: 1 } });
  assert.equal(r.status, 502, 'nothing listening: unreachable');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM helpdesk_mailboxes').get().n, 0, 'nothing saved');

  r = await s.call('POST', '/api/helpdesk/mailboxes', { body });
  assert.equal(r.status, 201, r.text);
  const mb = r.body.mailbox;
  assert.equal(mb.address, USER, 'the username is the address');
  assert.equal(mb.businessId, BUSINESS_IDS.retail);
  assert.ok(!JSON.stringify(r.body).includes(PASS));
  assert.ok(!JSON.stringify((await s.call('GET', '/api/helpdesk/mailboxes')).body).includes(PASS));
  const row = s.db.prepare('SELECT * FROM helpdesk_mailboxes').get();
  assert.ok(row.password_enc.startsWith('v1:') && !row.password_enc.includes(PASS));
  assert.ok(fs.existsSync(s.config.helpdesk.keyFile));
  assert.equal((await s.call('POST', '/api/helpdesk/mailboxes', { body })).body.code, 'exists');
  // Its own Connections row, after the hub row.
  const ids = (await s.call('GET', '/api/connections')).body.connections.map((c) => c.id);
  assert.equal(ids[ids.indexOf('helpdesk') + 1], connectionId(mb.id));
  // A new password: checked first.
  r = await s.call('PUT', `/api/helpdesk/mailboxes/${mb.id}/password`, { body: { password: 'wrong' } });
  assert.equal(r.body.code, 'refused');
  r = await s.call('PUT', `/api/helpdesk/mailboxes/${mb.id}/password`, { body: { password: PASS } });
  assert.equal(r.status, 200);
  // Settings: a folder that isn't there is refused; a store that isn't connected too.
  assert.equal((await s.call('PUT', `/api/helpdesk/mailboxes/${mb.id}`, { body: { sentFolder: 'Nope' } })).body.code, 'no_folder');
  assert.equal((await s.call('PUT', `/api/helpdesk/mailboxes/${mb.id}`, { body: { storeId: '01890000-0000-7000-8000-000000000000' } })).body.code, 'bad_store');
  r = await s.call('PUT', `/api/helpdesk/mailboxes/${mb.id}`, { body: { name: 'TinsXpress support', ignoreFrom: 'Orders@TinsXpress.com, @wordpress.com, junk' } });
  assert.equal(r.body.mailbox.name, 'TinsXpress support');
  assert.equal(r.body.mailbox.ignoreFrom, 'orders@tinsxpress.com, @wordpress.com');
  assert.deepEqual(s.db.prepare('SELECT action FROM helpdesk_changes ORDER BY at, rowid').all().map((x) => x.action), ['added', 'password_replaced', 'changed']);
  // The password never reached the log.
  assert.ok(!log.lines.some((l) => l.text.includes(PASS) || l.text.includes('nope nope')));
});

// ---- threads -----------------------------------------------------------------------------------------------------------
test('threads: replies join their ticket; the customer writing again makes it wait again (a new task); a mailto reply is matched by subject', async (t) => {
  const s = await setup(t);
  await s.add();
  s.imap.add('INBOX', email({ id: 'a1@x', from: 'Pat <pat@example.com>', subject: 'Damaged tin', text: 'One tin was crushed.' }), { at: at(START + MINUTE) });
  s.imap.add('INBOX', email({ id: 'b1@x', from: 'Sam <sam@example.org>', subject: 'Wholesale?', text: 'Do you sell by the case?' }), { at: at(START + 2 * MINUTE) });
  await s.pull();
  assert.equal(s.tickets().length, 2);
  // Our reply to Pat; Pat answers it (References name our reply).
  s.imap.add('Sent', email({ id: 'a2@tins.ca', from: USER, to: 'Pat <pat@example.com>', subject: 'RE: Damaged tin', inReplyTo: 'a1@x', references: ['a1@x'] }), { at: at(START + HOUR) });
  s.setNow(START + HOUR + MINUTE);
  await s.pull();
  let pat = s.tickets()[0];
  assert.equal(pat.state, 'answered');
  s.imap.add('INBOX', email({ id: 'a3@x', from: 'Pat <pat@example.com>', subject: 'Re: RE: Damaged tin', references: ['a1@x', 'a2@tins.ca'], text: 'Thanks! Also the lid is bent.' }), { at: at(START + 3 * HOUR) });
  s.setNow(START + 3 * HOUR + MINUTE);
  await s.pull();
  pat = s.tickets()[0];
  assert.equal(pat.state, 'waiting');
  assert.equal(pat.episode, 2);
  assert.equal(pat.waiting_since, new Date(START + 3 * HOUR).toISOString());
  assert.equal(s.tickets().length, 2, 'the same ticket');
  const patTasks = s.tasks().filter((x) => x.title.includes('#1'));
  assert.equal(patTasks.length, 2);
  assert.ok(patTasks[0].done_at);
  assert.equal(patTasks[1].title, 'Answer support email #1 (TinsXpress): the customer wrote again');
  assert.equal(patTasks[1].done_at, null);
  // Sam: a reply written as a new email (a mailto: link — no thread headers), found by the subject and Sam's address.
  s.imap.add('Sent', email({ id: 'b2@tins.ca', from: USER, to: 'sam@example.org', subject: 'Re: Wholesale?' }), { at: at(START + 4 * HOUR) });
  // A different subject to Sam is not a reply to that ticket; mail to someone else isn't kept at all.
  s.imap.add('Sent', email({ id: 'b3@tins.ca', from: USER, to: 'sam@example.org', subject: 'Our price list' }), { at: at(START + 4 * HOUR) });
  s.imap.add('Sent', email({ id: 'z@tins.ca', from: USER, to: 'friend@example.net', subject: 'Lunch?' }), { at: at(START + 4 * HOUR) });
  s.setNow(START + 4 * HOUR + MINUTE);
  await s.pull();
  assert.equal(s.tickets()[1].state, 'answered');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM helpdesk_messages WHERE direction = 'out'").get().n, 2, 'only replies to tickets are kept');
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM helpdesk_messages').all()).includes('friend@example.net'));
  // A new subject from Pat: a new ticket.
  s.imap.add('INBOX', email({ id: 'c1@x', from: 'Pat <pat@example.com>', subject: 'Another question' }), { at: at(START + 5 * HOUR) });
  s.setNow(START + 5 * HOUR + MINUTE);
  await s.pull();
  assert.equal(s.tickets().length, 3);
});

test('never a ticket: auto-replies, bounces, list mail, ignored senders and our own mail; a contact form’s Reply-To is the customer', async (t) => {
  const s = await setup(t);
  await s.add({ ignoreFrom: 'orders@tinsxpress.com, @notifications.example' });
  const add = (o) => s.imap.add('INBOX', email(o), { at: at(START + MINUTE) });
  add({ id: 'auto@x', headers: { 'Auto-Submitted': 'auto-replied' } });
  add({ id: 'bounce@x', from: 'Mail Delivery System <MAILER-DAEMON@mx.example.com>' });
  add({ id: 'list@x', from: 'News <news@brand.example>', headers: { 'List-Unsubscribe': '<mailto:u@brand.example>' } });
  add({ id: 'ign@x', from: 'orders@tinsxpress.com', subject: '[TinsXpress] New order #1200' });
  add({ id: 'ign2@x', from: 'alerts@notifications.example' });
  add({ id: 'own@x', from: USER });
  add({ id: 'form@x', from: 'WordPress <wordpress@tinsxpress.com>', headers: { 'Reply-To': 'Kim <kim@example.com>' }, subject: 'Contact form: refund?' });
  await s.pull();
  const tks = s.tickets();
  assert.equal(tks.length, 1);
  assert.equal(tks[0].customer_email, 'kim@example.com');
  assert.equal(tks[0].customer_name, 'Kim');
  assert.equal(s.db.prepare('SELECT skipped FROM helpdesk_pulls').get().skipped, 6);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM helpdesk_messages').all()).includes('MAILER-DAEMON'), 'skipped mail isn’t kept');
});

// ---- tasks, the flag, the overview -----------------------------------------------------------------------------------------
test('ticking the task off closes the ticket (a person handled it); closing on the Support page finishes the task; reopening makes a new one', async (t) => {
  const s = await setup(t);
  await s.add();
  s.imap.add('INBOX', email({ id: 'p1@x', subject: 'Question one' }), { at: at(START + MINUTE) });
  s.imap.add('INBOX', email({ id: 'p2@x', from: 'Lee <lee@example.com>', subject: 'Question two' }), { at: at(START + 2 * MINUTE) });
  await s.pull();
  const [t1, t2] = s.tasks();
  // A person ticks task 1 on their phone (a device step: here applyLocal as the partner).
  s.sync.applyLocal({ actor: 'partner', entity: 'task', op: 'update', recordId: t1.id, fields: { done_at: at(START + 10 * MINUTE) } });
  s.setNow(START + 15 * MINUTE);
  await s.pull();
  let [k1, k2] = s.tickets();
  assert.equal(k1.state, 'closed');
  assert.equal(k1.closed_reason, 'task_done');
  assert.equal(s.tasks().length, 2, 'no second task');
  // Ticket 2 closed on the Support page: its task is finished by the suite.
  const r = await s.call('POST', `/api/helpdesk/tickets/${k2.id}/close`, { body: {} });
  assert.equal(r.body.ticket.state, 'closed');
  const t2after = s.tasks().find((x) => x.id === t2.id);
  assert.ok(t2after.done_at);
  assert.match(t2after.notes, /Closed on the Support page \(no reply needed\)/);
  // Reopened: it waits again — a new task for the new wait.
  await s.call('POST', `/api/helpdesk/tickets/${k2.id}/reopen`, { body: {} });
  [k1, k2] = s.tickets();
  assert.equal(k2.state, 'waiting');
  assert.equal(k2.episode, 2);
  assert.equal(s.tasks().filter((x) => !x.done_at).length, 1);
  // The customer of ticket 1 writes again: waiting again, a new task.
  s.imap.add('INBOX', email({ id: 'p3@x', subject: 'Re: Question one', inReplyTo: 'p1@x' }), { at: at(START + HOUR) });
  s.setNow(START + HOUR + MINUTE);
  await s.pull();
  assert.equal(s.tickets()[0].state, 'waiting');
  assert.equal(s.tasks().filter((x) => !x.done_at).length, 2);
  // A deleted task counts as handled too.
  const open1 = s.tasks().find((x) => !x.done_at && x.title.includes('#1'));
  s.sync.applyLocal({ actor: 'owner', entity: 'task', op: 'delete', recordId: open1.id });
  await s.pull();
  assert.equal(s.tickets()[0].closed_reason, 'task_deleted');
  // Re-running changes nothing.
  const runs = s.db.prepare('SELECT COUNT(*) AS n FROM automations_runs WHERE automation_id = ?').get(AUTOMATION_ID).n;
  await s.pull();
  await s.pull();
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM automations_runs WHERE automation_id = ?').get(AUTOMATION_ID).n, runs, 'nothing to do: no run rows');
});

test('the 24-hour flag, and the overview’s support line', async (t) => {
  const s = await setup(t);
  let ov = await s.call('GET', '/api/overview?today=2026-10-14');
  const sup = () => ov.body.attention.find((x) => x.id === 'support');
  assert.equal(sup().state, 'not_connected');
  await s.add();
  s.imap.add('INBOX', email({ id: 'f1@x', subject: 'Old one' }), { at: at(START + MINUTE) });
  s.imap.add('INBOX', email({ id: 'f2@x', from: 'Lee <lee@example.com>', subject: 'New one' }), { at: at(START + 20 * HOUR) });
  s.setNow(START + 20 * HOUR + MINUTE);
  await s.pull();
  ov = await s.call('GET', '/api/overview?today=2026-10-15');
  assert.equal(sup().state, 'ok');
  assert.equal(sup().count, 0, 'nothing waiting 24 hours yet');
  assert.equal(sup().waiting, 2);
  s.setNow(START + 24 * HOUR + MINUTE);
  ov = await s.call('GET', '/api/overview?today=2026-10-15');
  assert.equal(sup().count, 1);
  assert.deepEqual(sup().items.map((i) => [i.number, i.mailbox, i.hours]), [[1, 'TinsXpress', 24]]);
  const list = (await s.call('GET', '/api/helpdesk/tickets')).body;
  assert.equal(list.counts.flagged, 1);
  assert.deepEqual(list.tickets.map((x) => [x.number, x.flagged]), [[1, true], [2, false]], 'longest waiting first');
  // Paused: the last read, said so.
  await s.call('PUT', `/api/connections/${connectionId(s.svc.listMailboxes()[0].id)}`, { body: { paused: true } });
  ov = await s.call('GET', '/api/overview?today=2026-10-15');
  assert.equal(sup().state, 'paused');
  assert.equal(sup().count, 1);
});

// ---- reading -------------------------------------------------------------------------------------------------------------
test('incremental reads by UID: the first read goes back 14 days, later ones only ask for new UIDs; a new UIDVALIDITY re-reads without duplicates', async (t) => {
  const s = await setup(t);
  s.imap.add('INBOX', email({ id: 'old@x', subject: 'Long ago' }), { at: at(START - (FIRST_READ_DAYS + 2) * DAY) });
  s.imap.add('INBOX', email({ id: 'recent@x', subject: 'Last week' }), { at: at(START - 7 * DAY) });
  s.imap.add('Sent', email({ id: 'sent-old@tins.ca', from: USER, to: 'x@y.co', subject: 'Something' }), { at: at(START - DAY) });
  await s.add();
  assert.deepEqual(s.tickets().map((x) => x.subject), ['Last week']);
  const searches = () => s.imap.commands.filter((c) => c.name === 'UID SEARCH').map((c) => c.args.slice(1).join(' '));
  assert.ok(searches()[0].startsWith('SINCE '));
  const before = s.imap.commands.length;
  await s.pull();
  assert.ok(!s.imap.commands.slice(before).some((c) => c.name === 'UID FETCH'), 'nothing new: no fetch (UIDNEXT says so)');
  s.imap.add('INBOX', email({ id: 'n1@x', subject: 'New' }), { at: at(START + MINUTE) });
  await s.pull();
  assert.equal(searches().at(-1), 'UID 3:*');
  assert.equal(s.tickets().length, 2);
  // The server renumbers the folder: read again (14 days), nothing held twice.
  s.imap.setUidValidity('INBOX', 77);
  await s.pull();
  assert.equal(s.tickets().length, 2);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM helpdesk_messages WHERE direction = 'in'").get().n, 2);
  assert.equal(s.db.prepare("SELECT uid_validity FROM helpdesk_folders WHERE role = 'inbox'").get().uid_validity, 77);
});

test('at most 100 messages a folder a round; the Sent folder waits until the inbox is caught up', async (t) => {
  const s = await setup(t);
  const mb = await s.add();
  for (let i = 0; i < MAX_PER_ROUND + 5; i += 1) {
    s.imap.add('INBOX', email({ id: `bulk${i}@x`, from: `C${i} <c${i}@example.com>`, subject: `Q ${i}` }), { at: at(START + MINUTE + i * 1000) });
  }
  s.imap.add('Sent', email({ id: 'rep@tins.ca', from: USER, to: 'c104@example.com', subject: 'Re: Q 104', inReplyTo: 'bulk104@x' }), { at: at(START + HOUR) });
  s.setNow(START + HOUR + MINUTE);
  let r = await s.svc.pullMailbox(mb.id, { force: true });
  assert.equal(r.inbox, MAX_PER_ROUND);
  assert.equal(r.sent, 0, 'not yet');
  assert.ok(r.more);
  r = await s.svc.pullMailbox(mb.id, { force: true });
  assert.equal(r.inbox, 5);
  assert.equal(r.sent, 1);
  assert.equal(s.tickets().find((x) => x.subject === 'Q 104').state, 'answered', 'the reply found its email');
  // 25 new tasks a run (the longest waiting first); the rest with the next runs.
  await s.pull();
  assert.ok(s.tasks().length >= 25);
});

test('paused = no calls at all; failures back off; a mailbox whose password can’t be read says so', async (t) => {
  const s = await setup(t);
  const mb = await s.add();
  const cid = connectionId(mb.id);
  await s.call('PUT', `/api/connections/${cid}`, { body: { paused: true } });
  const sessions = s.imap.sessions;
  s.imap.add('INBOX', email({ id: 'x@x' }), { at: at(START + MINUTE) });
  await s.pull();
  assert.equal((await s.call('POST', `/api/helpdesk/mailboxes/${mb.id}/pull`, { body: {} })).body.code, 'paused');
  assert.equal(s.imap.sessions, sessions, 'no connection while paused');
  assert.equal(s.tickets().length, 0);
  await s.call('PUT', `/api/connections/${cid}`, { body: { paused: false } });
  await new Promise((r) => setTimeout(r, 300)); // switched on: read at once
  assert.equal(s.tickets().length, 1);
  // The server refuses the password now.
  s.imap.failLogin = true;
  s.setNow(START + HOUR);
  await s.pull();
  let p = s.db.prepare('SELECT * FROM helpdesk_pulls').get();
  assert.equal(p.failures, 1);
  assert.match(p.last_error, /refused the username or app password.*: replace the app password on its card/);
  assert.ok(Math.abs(Date.parse(p.next_try_at) - (START + HOUR) - 2 * MINUTE) < 2000, 'tried again in 2 minutes');
  const row = (await s.call('GET', '/api/connections')).body.connections.find((c) => c.id === cid);
  assert.match(row.lastError, /refused/);
  // Not due during the backoff (the loop's own look).
  const before = s.imap.sessions;
  await s.svc.pullRound();
  assert.equal(s.imap.sessions, before);
  s.imap.failLogin = false;
  s.setNow(START + HOUR + 3 * MINUTE);
  await s.svc.pullRound();
  p = s.db.prepare('SELECT * FROM helpdesk_pulls').get();
  assert.equal(p.failures, 0);
  // The key file gone: no calls, the card says so.
  fs.rmSync(s.config.helpdesk.keyFile);
  const s2 = await setup(t, { config: s.config, clock: s.clock, start: null });
  assert.equal(s2.svc.listMailboxes()[0].readable, false);
  const r = await s2.svc.pullMailbox(mb.id, { force: true });
  assert.ok(r.failed);
});

// ---- retention, removal, restores ----------------------------------------------------------------------------------------
test(`retention: bodies go ${BODY_KEEP_DAYS} days after a ticket is answered, whole tickets after ${TICKET_KEEP_DAYS}; waiting tickets stay`, async (t) => {
  const s = await setup(t);
  await s.add();
  s.imap.add('INBOX', email({ id: 'k1@x', subject: 'Keep?', text: 'private words' }), { at: at(START + MINUTE) });
  s.imap.add('INBOX', email({ id: 'k2@x', from: 'Lee <lee@example.com>', subject: 'Still waiting', text: 'more words' }), { at: at(START + MINUTE) });
  await s.pull();
  s.imap.add('Sent', email({ id: 'k1r@tins.ca', from: USER, to: 'pat@example.com', subject: 'Re: Keep?', inReplyTo: 'k1@x' }), { at: at(START + HOUR) });
  s.setNow(START + HOUR + MINUTE);
  await s.pull();
  s.setNow(START + (BODY_KEEP_DAYS + 1) * DAY);
  assert.deepEqual(s.svc.purge(), { bodies: 2, tickets: 0 });
  const t1 = s.tickets()[0];
  const page = s.svc.ticket(t1.id); // (the session itself has ended by now)
  assert.equal(page.messages[0].text, null);
  assert.ok(page.messages[0].purged);
  assert.ok(!JSON.stringify(s.db.prepare('SELECT * FROM helpdesk_messages').all()).includes('private words'));
  assert.ok(JSON.stringify(s.db.prepare('SELECT * FROM helpdesk_messages').all()).includes('more words'), 'a waiting ticket keeps its email');
  s.setNow(START + (TICKET_KEEP_DAYS + 1) * DAY);
  assert.equal(s.svc.purge().tickets, 1);
  assert.deepEqual(s.tickets().map((x) => x.subject), ['Still waiting']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM helpdesk_messages').get().n, 1);
});

test('removing a mailbox forgets its tickets and messages; its open tasks are finished', async (t) => {
  const s = await setup(t);
  const mb = await s.add();
  s.imap.add('INBOX', email({ id: 'rm@x' }), { at: at(START + MINUTE) });
  await s.pull();
  const r = await s.call('DELETE', `/api/helpdesk/mailboxes/${mb.id}`);
  assert.equal(r.status, 200);
  assert.equal(s.tickets().length, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM helpdesk_messages').get().n, 0);
  assert.match(s.tasks()[0].notes, /support mailbox was removed/);
  assert.ok(s.tasks()[0].done_at);
  assert.ok(!(await s.call('GET', '/api/connections')).body.connections.some((c) => c.id === connectionId(mb.id)));
  assert.equal((await s.call('GET', '/api/helpdesk/tickets/no-such-ticket')).status, 404);
});

test('restores: the mailboxes are the current ones; tickets roll back and the mail is read again from there, nothing held twice', async (t) => {
  assert.ok(KEPT_TABLES.includes('helpdesk_mailboxes') && KEPT_TABLES.includes('helpdesk_changes'));
  assert.ok(!KEPT_TABLES.includes('helpdesk_tickets') && !KEPT_TABLES.includes('helpdesk_folders'));
  const dir = tmpDir(t);
  const config = testConfig(dir, { HELPDESK_TEST_PLAIN_LOCALHOST: '1', HELPDESK_TIMEOUT_MS: '1500' });
  fs.mkdirSync(config.backup.offsiteDir, { recursive: true });
  fs.writeFileSync(path.join(config.backup.offsiteDir, '.suite-backup-target'), '');
  const clock = testClock();
  const first = await setup(t, { config, clock });
  await first.add();
  first.imap.add('INBOX', email({ id: 'b1@x', subject: 'Before' }), { at: at(START + MINUTE) });
  await first.pull();
  const backup = await runBackup({ db: first.db, dir: config.backup.dir, offsiteDir: config.backup.offsiteDir, keepDays: 30 });
  first.imap.add('INBOX', email({ id: 'b2@x', from: 'Lee <lee@example.com>', subject: 'After' }), { at: at(START + 2 * MINUTE) });
  await first.pull();
  assert.equal(first.tickets().length, 2);
  await first.close();
  await restoreBackup({ from: backup.file, dbPath: config.dbPath, backupDir: config.backup.dir });
  // The same fake server is still running in `first`; point the restored suite at it.
  const second = await setup(t, { config, clock, start: null });
  assert.equal(second.tickets().length, 1, 'rolled back');
  second.db.prepare('UPDATE helpdesk_mailboxes SET port = ?').run(first.imap.port);
  await second.pull();
  assert.deepEqual(second.tickets().map((x) => x.subject), ['Before', 'After'], 'read again, nothing twice');
  assert.equal(second.db.prepare("SELECT COUNT(*) AS n FROM helpdesk_messages WHERE direction = 'in'").get().n, 2);
});
