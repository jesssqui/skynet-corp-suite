// D14's IMAP client, mail reading and ticket rules, without the app: the client against the fake IMAP server (plain TCP
// on this machine, and TLS with the test certificate) — it logs in, lists folders, opens them with EXAMINE and reads
// with BODY.PEEK only, so nothing is marked read; it refuses any other command before sending it, refuses plain TCP to
// anything but this machine, and never puts the password in an error. Then reading emails (encoded headers, HTML to
// text, attachments as names, quoted replies left out, auto-replies) and the ticket rules (state, 24-hour flag, subjects,
// order numbers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openImap, checkCommand, COMMANDS, ImapError, encodeFolder, decodeFolder, parseInternalDate, ResponseReader, MAX_LINE, MAX_UNTAGGED, tokenize, nest, cleanHost } from '../src/modules/helpdesk/imap.js';
import { parseMessage, htmlToText, cleanText, decodeWords, parseAddresses, parseParams, trimQuoted, isAutomatic, isAutomaticFor, parseHeaders, MAX_HEADER_LINES } from '../src/modules/helpdesk/mime.js';
import { ticketStatus, isFlagged, subjectKey, orderNumbers, firstName, FLAG_AFTER_MS } from '../src/modules/helpdesk/threads.js';
import { startFakeImap, email, TEST_CERT } from './fixtures/imapFake.js';

const USER = 'support@tins.ca';
const PASS = 'abcd efgh ijkl mnop';

async function fake(t, opts = {}) {
  const imap = await startFakeImap({ users: { [USER]: PASS }, ...opts });
  t.after(() => imap.close());
  return imap;
}
const open = (imap, extra = {}) => openImap({ host: imap.host, port: imap.port, secure: false, allowPlain: true, username: USER, password: PASS, timeoutMs: 2000, ...extra });

test('logs in, lists folders, examines, searches and reads with BODY.PEEK only — nothing is marked read', async (t) => {
  const imap = await fake(t, { folders: ['INBOX', 'Sent Messages', 'Envoyés'] });
  imap.specialUse['Sent Messages'] = '\\Sent';
  const u1 = imap.add('INBOX', email({ id: 'a@x', text: 'First' }), { at: '2026-10-01T12:00:00Z' });
  const u2 = imap.add('INBOX', email({ id: 'b@x', text: 'Second', attachments: ['label.pdf'] }), { at: '2026-10-11T12:00:00Z' });
  const s = await open(imap);
  const folders = await s.list();
  assert.deepEqual(folders.map((f) => f.name), ['INBOX', 'Sent Messages', 'Envoyés']);
  assert.ok(folders[1].attributes.includes('\\Sent'));
  const box = await s.examine('INBOX');
  assert.equal(box.exists, 2);
  assert.equal(box.uidValidity, 1000);
  assert.equal(box.uidNext, 3);
  assert.deepEqual(await s.searchSince(new Date('2026-10-05T00:00:00Z')), [u2]);
  assert.deepEqual(await s.searchFrom(1), [u1, u2]);
  assert.deepEqual(await s.searchFrom(3), [], 'n:* answered with the last message is dropped');
  const got = await s.fetchMessages([u1, u2], 1000);
  assert.equal(got.length, 2);
  assert.equal(got[0].uid, u1);
  assert.equal(got[0].internalDate, '2026-10-01T12:00:00.000Z');
  assert.match(got[1].body.toString(), /Second/);
  assert.ok(got[1].size > 0);
  const cut = await s.fetchMessages([u2], 100);
  assert.equal(cut[0].body.length, 100, 'partial fetch');
  const heads = await s.fetchHeaders([u1], ['MESSAGE-ID', 'SUBJECT']);
  assert.match(heads[0].body.toString(), /^Subject: Where is my order\?\r\nMessage-ID: <a@x>\r\n\r\n$/);
  await s.examine('Envoyés');
  await assert.rejects(s.examine('Nope'), (e) => e.code === 'no_folder');
  await s.logout();
  // Nothing changed in the mailbox.
  assert.deepEqual(imap.flagsOf('INBOX', u1), []);
  assert.deepEqual(imap.flagsOf('INBOX', u2), []);
  const names = new Set(imap.names());
  for (const n of names) assert.ok(COMMANDS.includes(n), `${n} is a read command`);
  assert.ok(!names.has('SELECT'));
  assert.ok(imap.commands.filter((c) => c.name === 'UID FETCH').every((c) => /BODY\.PEEK\[/.test(c.args[2])), 'every fetch peeks');
  assert.ok(imap.commands.some((c) => c.name === 'EXAMINE' && c.args[0] === encodeFolder('Envoyés')));
  assert.equal(imap.commands.find((c) => c.name === 'LOGIN').args[1], '[password]');
});

test('only read commands can be sent: anything else is refused before a byte is written', () => {
  for (const bad of ['SELECT', 'STORE', 'UID STORE', 'COPY', 'UID COPY', 'MOVE', 'UID MOVE', 'EXPUNGE', 'UID EXPUNGE', 'APPEND', 'DELETE', 'CREATE', 'RENAME', 'IDLE', 'AUTHENTICATE', 'SUBSCRIBE']) {
    assert.throws(() => checkCommand(bad, []), (e) => e instanceof ImapError && e.code === 'not_allowed', bad);
  }
  // FETCH may only peek.
  assert.throws(() => checkCommand('UID FETCH', ['1 (BODY[])']), /BODY\.PEEK/);
  assert.throws(() => checkCommand('UID FETCH', ['1 (RFC822)']), /BODY\.PEEK/);
  assert.throws(() => checkCommand('UID FETCH', ['1 (BODY[TEXT])']), /BODY\.PEEK/);
  assert.throws(() => checkCommand('UID FETCH', ['1 (FLAGS) ']), /Malformed/);
  assert.throws(() => checkCommand('UID FETCH', ['1 (UID BODY.PEEK[]<0.10> +FLAGS (\\Seen))']), /BODY\.PEEK/);
  assert.doesNotThrow(() => checkCommand('UID FETCH', ['1,2:4 (UID INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.262144>)']));
  assert.doesNotThrow(() => checkCommand('UID FETCH', ['7 (UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO)])']));
  assert.throws(() => checkCommand('UID SEARCH', ['ALL']), /Malformed/);
  assert.throws(() => checkCommand('LIST', ['"" "%"']), /Malformed/);
  // The only file that opens sockets for the module is imap.js, and it sends nothing outside COMMANDS.
  const dir = new URL('../src/modules/helpdesk/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    if (f !== 'imap.js') assert.ok(!/node:(net|tls|http|https)|fetch\(/.test(src), `${f} makes no connections`);
    assert.ok(!/\b(SMTP|nodemailer|sendmail)\b/i.test(src.replace(/no SMTP|never run SMTP|SMTP:/gi, '')) || f === 'imap.js', `${f} sends no mail`);
  }
});

test('TLS: the real path (certificate checked), and plain TCP only to this machine in tests', async (t) => {
  const imap = await fake(t, { tls: true });
  imap.add('INBOX', email({ id: 'tls@x' }));
  // Not trusted → refused.
  await assert.rejects(openImap({ host: '127.0.0.1', port: imap.port, username: USER, password: PASS, timeoutMs: 2000 }), (e) => e.code === 'tls' && !e.message.includes(PASS));
  // Trusted (the test certificate) → works.
  const s = await openImap({ host: 'localhost', port: imap.port, username: USER, password: PASS, timeoutMs: 2000, ca: fs.readFileSync(TEST_CERT) });
  assert.equal((await s.examine('INBOX')).exists, 1);
  await s.logout();
  await assert.rejects(openImap({ host: 'imap.example.com', port: 143, secure: false, allowPlain: true, username: USER, password: PASS }), (e) => e.code === 'tls');
  await assert.rejects(openImap({ host: '127.0.0.1', port: 143, secure: false, username: USER, password: PASS }), (e) => e.code === 'tls');
});

test('a wrong password, a refused connection, a silent server and a password with other characters', async (t) => {
  const imap = await fake(t);
  await assert.rejects(open(imap, { password: 'wrong one' }), (e) => e.code === 'auth' && /refused the username or app password/.test(e.message) && !e.message.includes('wrong one'));
  imap.byeOnLogin = true;
  await assert.rejects(open(imap), (e) => e instanceof ImapError && !e.message.includes(PASS));
  imap.byeOnLogin = false;
  imap.hang = true;
  const t0 = Date.now();
  await assert.rejects(open(imap, { timeoutMs: 300 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  imap.hang = false;
  // A port with nothing behind it.
  const dead = await startFakeImap();
  const port = dead.port;
  await dead.close();
  await assert.rejects(openImap({ host: '127.0.0.1', port, secure: false, allowPlain: true, username: USER, password: PASS, timeoutMs: 1000 }), (e) => e.code === 'network');
  // Non-ASCII password: sent as a literal (the server's "+" first).
  const other = await fake(t, { users: { [USER]: 'pässwörd' } });
  const s = await openImap({ host: other.host, port: other.port, secure: false, allowPlain: true, username: USER, password: 'pässwörd', timeoutMs: 2000 });
  await s.logout();
  assert.throws(() => cleanHost('imap gmail com'), /server’s name/);
  assert.equal(cleanHost(' IMAP.Gmail.com '), 'imap.gmail.com');
  assert.equal(cleanHost('imaps://mail.tins.ca/'), 'mail.tins.ca');
});

test('protocol pieces: literals, tokens, dates, folder names', () => {
  const reader = new ResponseReader({ maxLiteral: 100 });
  const whole = Buffer.from('* 1 FETCH (UID 5 BODY[HEADER.FIELDS (A B)] {4}\r\nab\r\n)\r\n* 2 EXISTS\r\n');
  // Fed a byte at a time, it still finds both responses (and waits for the whole literal).
  const got = [];
  for (const b of whole) got.push(...reader.push(Buffer.from([b])));
  assert.equal(got.length, 2);
  const t = nest(tokenize(got[0]));
  assert.equal(t[2].atom, 'FETCH');
  assert.equal(t[3][2].atom, 'BODY[HEADER.FIELDS (A B)]');
  assert.equal(t[3][3].str.toString(), 'ab\r\n');
  assert.equal(got[1][0].text, '* 2 EXISTS');
  assert.deepEqual(new ResponseReader().push(Buffer.from('* 1 FETCH (BODY[] {10}\r\nabc')), [], 'waits for the whole literal');
  assert.throws(() => new ResponseReader({ maxLiteral: 100 }).push(Buffer.from('* 1 FETCH (BODY[] {101}\r\n')), /at most 100 were asked for/);
  assert.throws(() => new ResponseReader().push(Buffer.alloc(MAX_LINE + 10, 'a')), /never ends/);
  assert.equal(parseInternalDate('17-Jul-1996 02:44:25 -0700'), '1996-07-17T09:44:25.000Z');
  assert.equal(parseInternalDate(' 7-Oct-2026 23:00:00 +0000'), '2026-10-07T23:00:00.000Z');
  assert.equal(encodeFolder('Envoyés'), 'Envoy&AOk-s');
  assert.equal(decodeFolder('Envoy&AOk-s'), 'Envoyés');
  assert.equal(encodeFolder('A&B'), 'A&-B');
  assert.equal(decodeFolder(encodeFolder('[Gmail]/Отправленные')), '[Gmail]/Отправленные');
});

test('reading an email: headers, plain text from HTML (no images, no links), attachments by name only', () => {
  const html = '<html><head><style>p{}</style><script>steal()</script></head><body><p>Hi&nbsp;there,</p><p>My <b>order</b> #1042 '
    + 'never came.<img src="https://tracker.example/pixel.gif"></p><a href="https://evil.example/x">Click here</a><br>Thanks</body></html>';
  const m = parseMessage(Buffer.from(email({ id: 'm1@x', from: '=?utf-8?Q?Ren=C3=A9e_Tremblay?= <Renee@Example.CA>', subject: '=?utf-8?B?T8O5IGVzdCBtYSBjb21tYW5kZSA/?=',
    html, text: '', attachments: ['photo of box.jpg', 'receipt.pdf'] })));
  assert.equal(m.from.email, 'renee@example.ca');
  assert.equal(m.from.name, 'Renée Tremblay');
  assert.equal(m.subject, 'Où est ma commande ?');
  assert.equal(m.messageId, 'm1@x');
  assert.deepEqual(m.attachments, ['photo of box.jpg', 'receipt.pdf']);
  assert.equal(m.text, '', 'the plain part (empty) wins in multipart/alternative');
  const h = parseMessage(Buffer.from(['From: a@b.co', 'Subject: x', 'Content-Type: text/html; charset=utf-8', '', html].join('\r\n')));
  assert.equal(h.text, 'Hi there,\n\nMy order #1042 never came.\nClick here\nThanks');
  assert.ok(!/<|tracker|evil|steal|style/.test(h.text));
  assert.equal(htmlToText('&lt;script&gt;'), '<script>', 'entities become text — React shows them as text');
  // Cut long bodies; quoted replies left out.
  const long = parseMessage(Buffer.from(email({ id: 'l@x', text: 'x'.repeat(30_000) })), { maxChars: 100 });
  assert.equal(long.text.length, 101);
  assert.ok(long.truncated);
  assert.equal(trimQuoted('Thanks!\n\nOn Mon, Oct 12, 2026 at 9:00 AM Tins <s@t.ca> wrote:\n> We shipped it\n> yesterday'), 'Thanks!');
  assert.equal(trimQuoted('Thanks!\n\n-----Original Message-----\nFrom: x\nSent: y\nold'), 'Thanks!');
  assert.equal(trimQuoted('a\n> b\nc'), 'a\n> b\nc', 'a quote in the middle stays');
  // Threads.
  const r = parseMessage(Buffer.from(email({ id: 'r@x', inReplyTo: 'q@x', references: ['p@x', 'q@x'] })));
  assert.deepEqual(r.inReplyTo, ['q@x']);
  assert.deepEqual(r.references, ['p@x', 'q@x']);
  // Addresses, params, words.
  assert.deepEqual(parseAddresses('"Smith, Pat" <pat@x.com>, bob@y.org (Bob), Undisclosed:;'), [{ name: 'Smith, Pat', email: 'pat@x.com' }, { name: 'Bob', email: 'bob@y.org' }]);
  assert.equal(parseParams("attachment; filename*0*=utf-8''r%C3%A9; filename*1*=sum%C3%A9.pdf").params.filename, 'résumé.pdf');
  assert.equal(decodeWords('=?iso-8859-1?Q?caf=E9?= ok'), 'café ok');
  // Windows-1252 body, 8-bit header.
  const w = parseMessage(Buffer.concat([Buffer.from('From: Zoë <z@x.co>\r\nSubject: hé\r\nContent-Type: text/plain; charset=windows-1252\r\n\r\n', 'utf8'), Buffer.from([0x93, 0x68, 0x69, 0x94])]));
  assert.equal(w.from.name, 'Zoë');
  assert.equal(w.subject, 'hé');
  assert.equal(w.text, '“hi”');
});

test('auto-replies, bounces and list mail are never tickets', () => {
  const head = (lines) => parseHeaders(lines.join('\r\n'));
  assert.ok(isAutomatic(head(['Auto-Submitted: auto-replied']), 'a@b.co'));
  assert.ok(!isAutomatic(head(['Auto-Submitted: no']), 'a@b.co'));
  assert.ok(isAutomatic(head(['Precedence: bulk']), 'a@b.co'));
  assert.ok(isAutomatic(head(['List-Unsubscribe: <mailto:x>']), 'a@b.co'));
  assert.ok(isAutomatic(head([]), 'MAILER-DAEMON@mx.example.com'.toLowerCase()));
  assert.ok(isAutomatic(head([]), 'no-reply@shop.example'));
  assert.ok(!isAutomatic(head([]), 'pat@example.com'));
});

test('ticket rules: state, waiting since, the 24-hour flag, subjects, order numbers', () => {
  assert.deepEqual(ticketStatus({ inTimes: ['2026-10-01T10:00:00Z'] }), { state: 'waiting', waitingSince: '2026-10-01T10:00:00Z', lastCustomerAt: '2026-10-01T10:00:00Z', lastReplyAt: null, handledAt: null });
  assert.equal(ticketStatus({ inTimes: ['2026-10-01T10:00:00Z'], outTimes: ['2026-10-01T11:00:00Z'] }).state, 'answered');
  const again = ticketStatus({ inTimes: ['2026-10-01T10:00:00Z', '2026-10-02T09:00:00Z', '2026-10-02T12:00:00Z'], outTimes: ['2026-10-01T11:00:00Z'] });
  assert.equal(again.state, 'waiting');
  assert.equal(again.waitingSince, '2026-10-02T09:00:00Z', 'since the first message after our reply');
  assert.equal(ticketStatus({ inTimes: ['2026-10-01T10:00:00Z'], closedAt: '2026-10-01T12:00:00Z' }).state, 'closed');
  assert.equal(ticketStatus({ inTimes: ['2026-10-01T10:00:00Z'], closedAt: '2026-10-01T12:00:00Z', outTimes: ['2026-10-01T13:00:00Z'] }).state, 'answered', 'a reply after a close');
  assert.equal(ticketStatus({ inTimes: ['2026-10-01T10:00:00Z', '2026-10-03T10:00:00Z'], closedAt: '2026-10-01T12:00:00Z' }).state, 'waiting', 'the customer wrote again');
  const since = '2026-10-01T10:00:00.000Z';
  assert.ok(!isFlagged({ state: 'waiting', waiting_since: since }, Date.parse(since) + FLAG_AFTER_MS - 1));
  assert.ok(isFlagged({ state: 'waiting', waiting_since: since }, Date.parse(since) + FLAG_AFTER_MS));
  assert.ok(!isFlagged({ state: 'answered', waiting_since: since }, Date.parse(since) + 2 * FLAG_AFTER_MS));
  assert.equal(subjectKey('RE: Fwd:  Where is my order?'), 'where is my order?');
  assert.equal(subjectKey('AW: [Support] Hi'), 'hi');
  assert.equal(subjectKey('Re[2]: Hi'), 'hi');
  assert.deepEqual(orderNumbers('Hi! Order #1042 (and also #1043). Commande no 2051. Paid 2026-10-01.'), ['1042', '1043', '2051']);
  assert.deepEqual(orderNumbers('order number: TX-500'), ['TX-500']);
  assert.deepEqual(orderNumbers('my order is late, call 519'), [], 'no digits in "is"; 519 needs a # or the word order');
  assert.equal(firstName('Renée Tremblay'), 'Renée');
  assert.equal(firstName(null), null);
});

// ---- review fixes -----------------------------------------------------------------------------------------------------
const timed = (fn) => {
  const t0 = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t0 };
};

test('review fix: hostile emails are read in linear time (time budgets)', () => {
  const budget = 1500; // generous for a loaded machine; the quadratic versions took 80+ seconds
  const big = 256 * 1024;
  const cases = {
    'html of "<a" with no ">"': () => htmlToText('<a'.repeat(big / 2)),
    'html of "<a>" tags': () => htmlToText('<a>'.repeat(big / 3)),
    'html with an unclosed <script': () => htmlToText(`x<script>${'<a'.repeat(big / 2)}`),
    'html with an unclosed comment': () => htmlToText(`x<!--${'a'.repeat(big)}`),
    'a long run of spaces': () => cleanText(`${' '.repeat(big)}x`),
    'spaces before many newlines': () => cleanText(' \n'.repeat(big / 2)),
    'many "On … wrote:" lines': () => trimQuoted('On Mon, Oct 5, 2026 Pat <p@x.co> wrote:\n'.repeat(5000)),
    'many quoted lines': () => trimQuoted('> quoted\n'.repeat(big / 9)),
    'thousands of header lines': () => parseHeaders('X-A: b\r\n'.repeat(50_000)),
    'a header folded thousands of times': () => parseHeaders(`Subject: a\r\n${' b\r\n'.repeat(50_000)}`),
    'a whole email of "<a" as HTML': () => parseMessage(Buffer.from(`From: a@b.co\r\nContent-Type: text/html\r\n\r\n${'<a'.repeat(big / 2)}`)),
    'a whole email of spaces': () => parseMessage(Buffer.from(`From: a@b.co\r\n\r\n${' '.repeat(big)}x`)),
    'a Date header of spaces': () => parseMessage(Buffer.from(`From: a@b.co\r\nDate: ${' '.repeat(big)}\r\n\r\nx`)),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const { ms } = timed(fn);
    assert.ok(ms < budget, `${name}: ${Math.round(ms)} ms`);
  }
  assert.ok(htmlToText('<a'.repeat(10)).startsWith('<a<a'), 'a "<" with no ">" is text');
  assert.equal(parseHeaders('X-A: b\r\n'.repeat(5000)).get('x-a').length, MAX_HEADER_LINES);
  assert.ok(parseHeaders(`Subject: a\r\n${' b\r\n'.repeat(50_000)}`).get('subject')[0].length <= 8 * 1024);
});

test('review fix: the reader takes a big literal in small chunks in linear time', () => {
  const size = 4 * 1024 * 1024;
  const reader = new ResponseReader({ maxLiteral: size });
  const head = Buffer.from(`* 1 FETCH (UID 1 BODY[]<0> {${size}}\r\n`);
  const body = Buffer.alloc(size, 'x');
  const { out, ms } = timed(() => {
    const got = [...reader.push(head)];
    for (let i = 0; i < body.length; i += 1024) got.push(...reader.push(body.subarray(i, i + 1024)));
    got.push(...reader.push(Buffer.from(')\r\n')));
    return got;
  });
  assert.equal(out.length, 1);
  assert.equal(out[0][1].literal.length, size);
  assert.ok(ms < 1500, `${Math.round(ms)} ms`);
});

test('review fix: a server that sends too much, too big or too slowly is cut off', async (t) => {
  const imap = await fake(t);
  imap.add('INBOX', email({ id: 'x@x' }));
  // A literal far over what was asked for.
  imap.oversize = 300 * 1024;
  let s = await open(imap, { maxLiteral: 100 * 1024 });
  await s.examine('INBOX');
  await assert.rejects(s.fetchMessages([1], 1000), (e) => e.code === 'protocol' && /at most 102400 were asked for/.test(e.message));
  imap.oversize = 0;
  // Endless untagged answers.
  imap.flood = MAX_UNTAGGED + 10;
  s = await open(imap);
  await s.examine('INBOX');
  await assert.rejects(s.fetchMessages([1], 1000), (e) => e.code === 'protocol' && /far more than was asked for/.test(e.message));
  imap.flood = 0;
  // A trickle that never stops being "almost done": the command's own deadline ends it.
  imap.trickleMs = 5;
  s = await open(imap, { timeoutMs: 1000, commandMs: 400 });
  await s.examine('INBOX');
  const t0 = Date.now();
  await assert.rejects(s.fetchHeaders([1], ['SUBJECT']), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 3000);
  imap.trickleMs = 0;
});

test('review fix: contact forms — judged by a Reply-To that isn’t us', () => {
  const form = parseMessage(Buffer.from(email({
    id: 'f@x', from: 'Tins <noreply@tinsxpress.com>', headers: { 'Reply-To': 'Kim <kim@example.com>', 'List-Unsubscribe': '<https://sendgrid.example/u>', Precedence: 'bulk' },
  })));
  assert.equal(form.auto, true, 'by its From alone it looks like a machine’s');
  assert.equal(isAutomaticFor(form, 'support@tins.ca'), false, 'judged by the Reply-To: a customer');
  const autoReply = parseMessage(Buffer.from(email({ id: 'g@x', from: 'noreply@x.com', headers: { 'Reply-To': 'kim@example.com', 'Auto-Submitted': 'auto-replied' } })));
  assert.equal(isAutomaticFor(autoReply, 'support@tins.ca'), true, 'an auto-reply stays one');
  const toNoreply = parseMessage(Buffer.from(email({ id: 'h@x', from: 'a@x.com', headers: { 'Reply-To': 'no-reply@x.com' } })));
  assert.equal(isAutomaticFor(toNoreply, 'support@tins.ca'), true);
  const newsletter = parseMessage(Buffer.from(email({ id: 'i@x', from: 'News <news@brand.example>', headers: { 'List-Unsubscribe': '<mailto:u@x>' } })));
  assert.equal(isAutomaticFor(newsletter, 'support@tins.ca'), true, 'no Reply-To: list mail is still never a ticket');
  const ownReplyTo = parseMessage(Buffer.from(email({ id: 'j@x', from: 'noreply@x.com', headers: { 'Reply-To': 'support@tins.ca' } })));
  assert.equal(isAutomaticFor(ownReplyTo, 'support@tins.ca'), true, 'a Reply-To that is us doesn’t count');
});
