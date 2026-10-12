// The helpdesk's words and rules on the device (D14), no React (client/test/helpdesk.test.js). Tickets and their emails
// are server data (the Support pages need a connection); saved answers are synced records (offline).

/** What the mailbox's card and the pages say about privacy — in one place. */
export const PRIVACY_NOTE = 'Customer emails are kept only to answer them: never for marketing, never copied into Clients. '
  + 'They stay on the suite’s server (not on this device). Attachments aren’t kept (names only), and an email’s text is deleted '
  + '90 days after its ticket is answered or closed.';
export const READ_ONLY_NOTE = 'Read only: the suite never marks anything read, moves, deletes or sends an email. You reply from your own mail app; '
  + 'the suite sees your reply in the Sent folder.';

export const STATE_WORDS = Object.freeze({ waiting: 'Waiting for a reply', answered: 'Answered', closed: 'Closed' });
export const STATE_TONES = Object.freeze({ waiting: 'warn', answered: 'ok', closed: 'neutral' });
export const STATE_FILTERS = Object.freeze([
  { value: 'waiting', label: 'Waiting' },
  { value: 'answered', label: 'Answered' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
]);
export const stateFilterOf = (v) => (STATE_FILTERS.some((f) => f.value === v) ? v : 'waiting');

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/** "Waiting 26 hours" / "Waiting 3 days" (the flag at 24 hours). */
export function waitingText(ticket) {
  if (ticket?.state !== 'waiting') return '';
  const h = ticket.hoursWaiting ?? 0;
  if (h < 1) return 'Waiting less than an hour';
  if (h < 48) return `Waiting ${plural(h, 'hour')}`;
  return `Waiting ${plural(Math.floor(h / 24), 'day')}`;
}

/** Why a closed ticket is closed, in words. */
export function closedText(ticket) {
  if (ticket?.state !== 'closed') return '';
  return {
    no_reply_needed: 'Closed: no reply needed',
    task_done: 'Closed when its task was ticked off',
    task_deleted: 'Closed when its task was deleted',
  }[ticket.closedReason] ?? 'Closed';
}

/** A ticket's line in the list: "#12 · Where is my order? · Pat (pat@example.com)". */
export function ticketLine(t) {
  const who = t.customerName ? `${t.customerName} (${t.customerEmail ?? 'no address'})` : t.customerEmail ?? 'Unknown sender';
  return { title: `#${t.number} · ${t.subject || '(no subject)'}`, who };
}

/** A saved answer ready to paste: {name} → the customer's first name ("there" when unknown). */
export function fillAnswer(body, customerName) {
  const first = String(customerName ?? '').trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{M}'-]/gu, '') || 'there';
  return String(body ?? '').replace(/\{name\}/gi, first);
}

/** "Re: <subject>" — not doubled. */
export const replySubject = (subject) => {
  const s = String(subject ?? '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s || 'your email'}`;
};

/**
 * A mailto: link that opens the person's mail app with the answer written in — to the customer, "Re: <subject>".
 * (A mail app's own Reply keeps the thread better: the suite then finds the reply by its headers; a mailto reply is
 * found by its subject and address.)
 */
export function mailtoLink({ to, subject, body }) {
  const enc = (s) => encodeURIComponent(s);
  return `mailto:${encodeURIComponent(to ?? '').replace(/%40/g, '@')}?subject=${enc(replySubject(subject))}&body=${enc(String(body ?? '').replace(/\r?\n/g, '\r\n'))}`;
}

/** Saved answers for a mailbox: its own and those for every mailbox, in order (position, then title). */
export function answersFor(answers, mailboxId) {
  return (answers ?? [])
    .filter((a) => !a.mailbox_id || a.mailbox_id === mailboxId)
    .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || String(a.title).localeCompare(String(b.title)));
}

/** The saved answer sheet: problems with what is typed (null when it can be saved). */
export function answerProblem({ title, body }) {
  if (!String(title ?? '').trim()) return 'Give it a short title';
  if (String(title).trim().length > 200) return 'The title is too long (200 characters at most)';
  if (!String(body ?? '').trim()) return 'Write the answer';
  if (String(body).length > 5000) return 'The answer is too long (5,000 characters at most)';
  return null;
}
/** Only the fields that changed (a partner's edit made meanwhile survives). */
export function answerChanges(before, v) {
  const next = { title: v.title.trim(), body: v.body, mailbox_id: v.mailbox_id || null };
  if (!before) return next;
  return Object.fromEntries(Object.entries(next).filter(([k, val]) => (before[k] ?? null) !== val));
}

/** The connection id "mail-<id without dashes>" → the mailbox id. */
export function mailboxIdOf(connectionId) {
  const hex = String(connectionId ?? '').replace(/^mail-/, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Where common providers keep things (a hint under the form; the server checks the real folders anyway, and says
 * which folder is marked Sent when the one typed isn't there).
 */
export const PROVIDERS = Object.freeze([
  { match: /gmail\.com$|googlemail\.com$/, host: 'imap.gmail.com', sent: '[Gmail]/Sent Mail', note: 'Google: an app password (Google Account → Security → 2-Step Verification → App passwords).' },
  { match: /icloud\.com$|me\.com$|mac\.com$/, host: 'imap.mail.me.com', sent: 'Sent Messages', note: 'iCloud: an app-specific password (account.apple.com → Sign-In and Security).' },
  { match: /outlook\.|hotmail\.|live\.com$|office365\.com$/, host: 'outlook.office365.com', sent: 'Sent Items', note: 'Microsoft 365 / Outlook.com no longer accept passwords over IMAP for most accounts: the login may be refused.' },
  { match: /yahoo\.com$/, host: 'imap.mail.yahoo.com', sent: 'Sent', note: 'Yahoo: an app password (Account security → Generate app password).' },
]);
export function providerHint(hostOrEmail) {
  const s = String(hostOrEmail ?? '').trim().toLowerCase();
  return PROVIDERS.find((p) => p.match.test(s.split('@').pop() ?? '')) ?? null;
}

/** Problems with the add-a-mailbox form before it goes to the server (null when it can be sent). */
export function addMailboxProblem(f) {
  if (!String(f.host ?? '').trim()) return 'Give the mail server (like imap.gmail.com)';
  if (/\s/.test(String(f.host).trim())) return 'The mail server’s name has no spaces';
  if (!String(f.username ?? '').trim()) return 'Give the username (usually the mailbox’s email address)';
  if (!String(f.password ?? '')) return 'Give the mailbox’s app password';
  if (!String(f.inboxFolder ?? '').trim() || !String(f.sentFolder ?? '').trim()) return 'Give the inbox and the Sent folder';
  return null;
}

/** "Read 5 minutes ago · 3 waiting for a reply" for a mailbox's card. */
export function mailboxStatus(mb) {
  if (!mb) return '';
  if (mb.paused) return 'Paused: nothing is read';
  if (!mb.readable) return 'Its app password can’t be read on this server: replace it';
  if (mb.failures) return `Can’t be read right now: ${mb.lastError ?? 'unknown error'}`;
  if (!mb.lastSuccessAt) return 'Not read yet';
  return `${plural(mb.counts?.waiting ?? 0, 'ticket')} waiting for a reply · read every ${mb.everyMinutes ?? 5} minutes`;
}

/** The ticket link the helpdesk puts in its tasks' notes ("/helpdesk/tickets/<id>"), or null. */
export function ticketPathIn(notes) {
  const m = /\/helpdesk\/tickets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(String(notes ?? ''));
  return m ? `/helpdesk/tickets/${m[1]}` : null;
}

/** What the order card says when it can't show an order. */
export function orderNote(result, error) {
  if (error) {
    if (error.code === 'no_store') return 'This mailbox isn’t linked to a WooCommerce store: pick its store on the mailbox’s card (System → Connections).';
    if (error.code === 'paused') return 'The store is paused on Connections: orders aren’t looked up.';
    if (error.status === 0) return 'Can’t reach the suite server: looking orders up needs a connection.';
    return error.message ?? 'The lookup failed';
  }
  if (!result) return '';
  if (!result.orders.length) {
    return result.numbers?.length
      ? `No order in the store matches ${result.numbers.map((n) => `#${n}`).join(', ')}, nor the customer’s email.`
      : 'The emails mention no order number, and the customer’s email has no orders in the store.';
  }
  return result.by === 'number'
    ? `Found by the order number${result.numbers.length > 1 ? 's' : ''} in the email: ${result.numbers.map((n) => `#${n}`).join(', ')}.`
    : 'No order number in the email: these are the customer’s orders (by their email).';
}
