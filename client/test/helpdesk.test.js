// The helpdesk on the device (D14): the Support pages' words (waiting, closed, the flag), saved answers ({name}, the
// mailto link, which ones a mailbox shows, the sheet's checks and "only what changed"), the mailbox form's checks and
// provider hints, the ticket link in a task's notes, the order card's notes, the overview's support line — and saved
// answers on two devices (made offline, an open sheet keeps the other person's edit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitingText, closedText, ticketLine, fillAnswer, replySubject, mailtoLink, answersFor, answerProblem, answerChanges, mailboxIdOf, providerHint,
  addMailboxProblem, mailboxStatus, ticketPathIn, orderNote, stateFilterOf,
} from '../src/modules/helpdesk/logic.js';
import { itemLine, stateNote, summaryText, attentionTotal, SECTIONS } from '../src/modules/overview/logic.js';
import { startServer, makeDevice, row } from './helpers.js';

test('tickets in words: waiting, closed, the list line, the filter', () => {
  assert.equal(waitingText({ state: 'waiting', hoursWaiting: 0 }), 'Waiting less than an hour');
  assert.equal(waitingText({ state: 'waiting', hoursWaiting: 26 }), 'Waiting 26 hours');
  assert.equal(waitingText({ state: 'waiting', hoursWaiting: 75 }), 'Waiting 3 days');
  assert.equal(waitingText({ state: 'answered', hoursWaiting: 75 }), '');
  assert.equal(closedText({ state: 'closed', closedReason: 'task_done' }), 'Closed when its task was ticked off');
  assert.equal(closedText({ state: 'closed', closedReason: 'no_reply_needed' }), 'Closed: no reply needed');
  assert.deepEqual(ticketLine({ number: 12, subject: 'Late order', customerName: 'Pat', customerEmail: 'pat@example.com' }), { title: '#12 · Late order', who: 'Pat (pat@example.com)' });
  assert.deepEqual(ticketLine({ number: 3, subject: '', customerName: null, customerEmail: 'x@y.co' }), { title: '#3 · (no subject)', who: 'x@y.co' });
  assert.equal(stateFilterOf('closed'), 'closed');
  assert.equal(stateFilterOf('nonsense'), 'waiting');
});

test('saved answers: {name}, the mailto link, which a mailbox shows, the sheet', () => {
  assert.equal(fillAnswer('Hi {name}, it shipped.', 'Renée Tremblay'), 'Hi Renée, it shipped.');
  assert.equal(fillAnswer('Hi {NAME},', null), 'Hi there,');
  assert.equal(replySubject('Where is it?'), 'Re: Where is it?');
  assert.equal(replySubject('RE: Where is it?'), 'RE: Where is it?');
  assert.equal(replySubject(''), 'Re: your email');
  const link = mailtoLink({ to: 'pat+shop@example.com', subject: 'Order #1042 & more', body: 'Hi Pat,\nIt shipped.' });
  assert.equal(link, 'mailto:pat%2Bshop@example.com?subject=Re%3A%20Order%20%231042%20%26%20more&body=Hi%20Pat%2C%0D%0AIt%20shipped.');
  const answers = [
    { id: 'a', title: 'Zeta', mailbox_id: null, position: null },
    { id: 'b', title: 'Alpha', mailbox_id: 'm1', position: null },
    { id: 'c', title: 'Other store', mailbox_id: 'm2', position: null },
    { id: 'd', title: 'First', mailbox_id: null, position: 1 },
  ];
  assert.deepEqual(answersFor(answers, 'm1').map((a) => a.id), ['d', 'b', 'a']);
  assert.equal(answerProblem({ title: '', body: 'x' }), 'Give it a short title');
  assert.equal(answerProblem({ title: 'x', body: ' ' }), 'Write the answer');
  assert.equal(answerProblem({ title: 'x', body: 'y'.repeat(5001) }), 'The answer is too long (5,000 characters at most)');
  assert.equal(answerProblem({ title: 'Ok', body: 'Fine' }), null);
  assert.deepEqual(answerChanges(null, { title: ' New ', body: 'B', mailbox_id: '' }), { title: 'New', body: 'B', mailbox_id: null });
  assert.deepEqual(answerChanges({ title: 'T', body: 'B', mailbox_id: null }, { title: 'T', body: 'B2', mailbox_id: '' }), { body: 'B2' });
});

test('mailboxes: the form’s checks, provider hints, the card’s line, the connection id', () => {
  const f = { host: 'imap.gmail.com', username: 'support@tins.ca', password: 'x', inboxFolder: 'INBOX', sentFolder: '[Gmail]/Sent Mail' };
  assert.equal(addMailboxProblem(f), null);
  assert.match(addMailboxProblem({ ...f, host: '' }), /mail server/);
  assert.match(addMailboxProblem({ ...f, host: 'imap gmail' }), /no spaces/);
  assert.match(addMailboxProblem({ ...f, password: '' }), /app password/);
  assert.match(addMailboxProblem({ ...f, sentFolder: ' ' }), /Sent folder/);
  assert.equal(providerHint('imap.gmail.com').sent, '[Gmail]/Sent Mail');
  assert.equal(providerHint('help@icloud.com').host, 'imap.mail.me.com');
  assert.match(providerHint('outlook.office365.com').note, /no longer accept passwords/);
  assert.equal(providerHint('mail.tinsxpress.com'), null);
  assert.equal(mailboxStatus({ paused: true }), 'Paused: nothing is read');
  assert.match(mailboxStatus({ readable: true, failures: 2, lastError: 'refused' }), /Can’t be read right now: refused/);
  assert.equal(mailboxStatus({ readable: true, lastSuccessAt: 'x', counts: { waiting: 1 }, everyMinutes: 5 }), '1 ticket waiting for a reply · read every 5 minutes');
  assert.equal(mailboxIdOf('mail-019a1b2c3d4e7f001234567890abcdef'), '019a1b2c-3d4e-7f00-1234-567890abcdef');
  assert.equal(mailboxIdOf('woo-019a1b2c3d4e7f001234567890abcdef'), null);
});

test('the ticket link in a task’s notes; the order card’s notes', () => {
  assert.equal(ticketPathIn('Read it on the Support page: /helpdesk/tickets/019a1b2c-3d4e-7f00-8234-567890abcdef\nmore'), '/helpdesk/tickets/019a1b2c-3d4e-7f00-8234-567890abcdef');
  assert.equal(ticketPathIn('nothing here'), null);
  assert.equal(ticketPathIn(null), null);
  assert.match(orderNote(null, { code: 'no_store' }), /isn’t linked to a WooCommerce store/);
  assert.match(orderNote(null, { status: 0 }), /needs a connection/);
  assert.match(orderNote({ by: 'number', numbers: ['1042'], orders: [{}] }), /order number in the email: #1042/);
  assert.match(orderNote({ by: 'email', numbers: [], orders: [{}] }), /by their email/);
  assert.match(orderNote({ by: 'email', numbers: ['77'], orders: [] }), /No order in the store matches #77/);
});

test('the overview’s support line: its items, its notes, the headline', () => {
  const item = { id: 't1', number: 12, mailbox: 'TinsXpress', waitingSince: '2026-10-13T10:00:00Z', hours: 30 };
  assert.deepEqual(itemLine('support', item), { key: 't1', text: 'Support email #12 (TinsXpress)', link: '/helpdesk/tickets/t1', detail: 'Waiting 30 hours for a reply', tone: 'danger' });
  assert.equal(itemLine('support', { ...item, hours: 50 }).detail, 'Waiting 2 days for a reply');
  assert.equal(SECTIONS.support.link, '/helpdesk');
  assert.match(stateNote({ id: 'support', state: 'not_connected' }), /add each store’s support mailbox/);
  assert.match(stateNote({ id: 'support', state: 'paused' }), /support mailbox is paused/);
  assert.equal(summaryText({ id: 'support', count: 1, waiting: 3, failing: ['Pouches'] }), '3 tickets waiting for a reply in all · Pouches can’t be read right now');
  assert.equal(attentionTotal([{ id: 'support', state: 'ok', count: 2 }]), 2, 'urgent: in the headline');
  assert.equal(attentionTotal([{ id: 'support', state: 'not_connected', count: null }]), 0);
});

test('two devices: a saved answer made offline syncs; an open sheet keeps the other person’s change; deleting', async (t) => {
  const server = await startServer(t, undefined, { crm: true });
  const mac = await makeDevice(t, server, 'owner');
  const phone = await makeDevice(t, server, 'partner');
  phone.online = false;
  const id = await phone.engine.create('saved_answer', answerChanges(null, { title: 'Where is my order', body: 'Hi {name}, it shipped today.', mailbox_id: '' }));
  assert.equal((await phone.engine.get('saved_answer', id)).title, 'Where is my order', 'shown at once, offline');
  phone.online = true;
  await phone.engine.syncNow();
  assert.equal(row(server.db, 'helpdesk_saved_answers', id).created_by, 'partner');
  // The Mac opens the sheet; the phone changes the body meanwhile; the Mac renames it.
  await mac.engine.syncNow();
  const before = await mac.engine.get('saved_answer', id);
  await phone.engine.update('saved_answer', id, { body: 'Hi {name}, it shipped this morning.' });
  await phone.engine.syncNow();
  await mac.engine.syncNow();
  const changes = answerChanges(before, { title: 'Where’s my order', body: before.body, mailbox_id: '' });
  assert.deepEqual(changes, { title: 'Where’s my order' });
  await mac.engine.update('saved_answer', id, changes);
  await mac.engine.syncNow();
  const saved = row(server.db, 'helpdesk_saved_answers', id);
  assert.deepEqual([saved.title, saved.body], ['Where’s my order', 'Hi {name}, it shipped this morning.'], 'both changes survive');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM sync_clashes').get().n, 0);
  await mac.engine.remove('saved_answer', id);
  await mac.engine.syncNow();
  assert.ok(row(server.db, 'helpdesk_saved_answers', id).deleted_at);
});
