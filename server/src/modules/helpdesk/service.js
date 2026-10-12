// The helpdesk (D14): each store's support mailbox, read over IMAP — READ ONLY — into tickets, with the order each one
// is about looked up live in the store, saved answers to copy, a task per open ticket on the shared list, and the
// 24-hour flag for the overview. Nothing is ever sent from the suite: replies are written in the person's own mail
// app, and the suite sees them in the Sent folder.
//
//   mailboxes   added on System → Connections → Support mailboxes: server, username, app password (checked with a real
//               login, both folders opened, before anything is saved; kept AES-256-GCM-encrypted with the key file
//               config.helpdesk.keyFile and never sent back), the inbox and sent folders, the store whose orders it
//               looks up, our business (retail by default). Each is its own pausable Connections row ("mail-<id>").
//   pulls       every few minutes per mailbox: new messages by UID since the last read (the first read goes back
//               FIRST_READ_DAYS), the inbox first, then the Sent folder (only when the inbox is caught up, so a reply
//               is never read before the email it answers). EXAMINE + BODY.PEEK only: nothing is marked read, moved
//               or deleted (imap.js). Failures back off 2, 4 … 60 minutes; paused = no calls at all.
//   tickets     a customer's email opens a ticket or joins one (Message-ID / In-Reply-To / References, else the same
//               customer and subject within SUBJECT_MATCH_DAYS); our reply in the Sent folder marks it answered; a new
//               customer email after that makes it wait again. Waiting 24 hours or more = flagged.
//   privacy     customer emails are personal data (and the stores sell age-restricted products): only what a ticket
//               needs is kept — the sender's name and email, subject, dates and the body as plain text (capped,
//               quoted replies left out); attachments by name only; our replies' bodies never. Bodies are deleted
//               BODY_KEEP_DAYS after a ticket is answered or closed, whole tickets TICKET_KEEP_DAYS after. Never used
//               for marketing, never copied into the CRM, never synced to devices (server data, shown to a signed-in
//               session only). Auto-replies, bounces, list mail, ignored senders and our own mail are not kept.
//   orders      the ticket's order is looked up live through the woocommerce module (D12's lookup): the order numbers
//               the customer's emails mention, else their email. Shown, never stored, never logged.
// It reads and writes only its own tables; tasks through the automations framework (automations.js).
import { newId } from '@suite/shared/ids';
import { nowIso, localDate } from '@suite/shared/time';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { HttpError } from '../../lib/httpError.js';
import { loadKey, encryptSecret, decryptSecret } from '../../lib/sealed.js';
import { openImap, ImapError, cleanHost, isLocalHost, IMAP_PORT } from './imap.js';
import { parseMessage } from './mime.js';
import { ticketStatus, subjectKey, isFlagged, hoursWaiting, orderNumbers, SUBJECT_MATCH_DAYS } from './threads.js';
import { SAVED_ANSWER_ENTITY } from './entities.js';
import { registerHelpdeskAutomations, PULLED_EVENT, CHANGED_EVENT } from './automations.js';

export const HUB_ID = 'helpdesk';
export const connectionId = (mailboxId) => `mail-${mailboxId.replace(/-/g, '')}`;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The first read of a folder goes back this far (older mail isn't made into tickets). */
export const FIRST_READ_DAYS = 14;
/** At most this many messages a folder a round (the rest come with the next rounds, oldest first). */
export const MAX_PER_ROUND = 100;
const FETCH_BATCH = 20;
/** Only the first part of a big message is read (its text comes first; attachments after it are not needed). */
export const MAX_FETCH_BYTES = 256 * 1024;
/** Retention: bodies go this many days after a ticket is answered or closed; whole tickets after TICKET_KEEP_DAYS. */
export const BODY_KEEP_DAYS = 90;
export const TICKET_KEEP_DAYS = 365;
export const LOOK_EVERY_MS = MINUTE;
export const FIRST_LOOK_MS = 25_000;
export const backoffMs = (failures) => Math.min(2 ** Math.max(1, failures), 60) * MINUTE;
const SENT_FIELDS = ['MESSAGE-ID', 'IN-REPLY-TO', 'REFERENCES', 'FROM', 'TO', 'CC', 'SUBJECT', 'DATE'];
const PAGE_MAX = 200;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** "orders@x.com, @wordpress.com" → ['orders@x.com', '@wordpress.com'] (lowercase; anything else dropped). */
export function parseIgnore(text) {
  return [...new Set(String(text ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL_RE.test(s) || /^@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)))].slice(0, 50);
}
const ignored = (list, email) => Boolean(email) && list.some((x) => (x.startsWith('@') ? email.endsWith(x) : email === x));

export function createHelpdeskService(ctx) {
  const { db, config, log, services } = ctx;
  const clock = ctx.now ?? Date.now;
  const { connections, sync, automations, planner, crm } = services;
  if (!connections) throw new Error('helpdesk needs the connections module registered before it');
  const cfg = config.helpdesk;

  // Saved answers sync like any record (devices write them; there are no write routes). The tasks need the planner and
  // the automations; without them (the sync engine's own tests) the module still reads mail.
  if (sync && planner && automations) sync.registerEntity({ module: 'helpdesk', ...SAVED_ANSWER_ENTITY });

  const q = {
    mailboxes: db.prepare('SELECT * FROM helpdesk_mailboxes ORDER BY position, added_at'),
    mailbox: db.prepare('SELECT * FROM helpdesk_mailboxes WHERE id = ?'),
    maxPos: db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM helpdesk_mailboxes'),
    insert: db.prepare(`INSERT INTO helpdesk_mailboxes (id, name, host, port, username, password_enc, inbox_folder, sent_folder, address, store_id,
      business_id, ignore_from, position, added_at, added_by, added_device, password_set_at)
      VALUES (@id, @name, @host, @port, @username, @password_enc, @inbox_folder, @sent_folder, @address, @store_id, @business_id, @ignore_from,
      @position, @at, @actor, @device, @at)`),
    setPassword: db.prepare('UPDATE helpdesk_mailboxes SET username = ?, password_enc = ?, password_set_at = ? WHERE id = ?'),
    setSettings: db.prepare(`UPDATE helpdesk_mailboxes SET name = @name, inbox_folder = @inbox_folder, sent_folder = @sent_folder, address = @address,
      store_id = @store_id, business_id = @business_id, ignore_from = @ignore_from WHERE id = @id`),
    remove: db.prepare('DELETE FROM helpdesk_mailboxes WHERE id = ?'),
    change: db.prepare('INSERT INTO helpdesk_changes (id, at, actor, device_id, mailbox_id, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    changes: db.prepare('SELECT at, actor, device_id AS deviceId, action, detail FROM helpdesk_changes WHERE mailbox_id = ? ORDER BY at DESC, id DESC LIMIT 10'),
    pull: db.prepare('SELECT * FROM helpdesk_pulls WHERE mailbox_id = ?'),
    ensurePull: db.prepare('INSERT INTO helpdesk_pulls (mailbox_id) VALUES (?) ON CONFLICT (mailbox_id) DO NOTHING'),
    pullOk: db.prepare('UPDATE helpdesk_pulls SET last_success_at = @at, last_attempt_at = @at, failures = 0, next_try_at = NULL WHERE mailbox_id = @id'),
    pullFail: db.prepare(`UPDATE helpdesk_pulls SET last_attempt_at = @at, last_error_at = @at, last_error = @error, failures = failures + 1,
      next_try_at = @next WHERE mailbox_id = @id`),
    skipped: db.prepare('UPDATE helpdesk_pulls SET skipped = skipped + ? WHERE mailbox_id = ?'),
    folder: db.prepare('SELECT * FROM helpdesk_folders WHERE mailbox_id = ? AND role = ?'),
    setFolder: db.prepare(`INSERT INTO helpdesk_folders (mailbox_id, role, folder, uid_validity, last_uid) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (mailbox_id, role) DO UPDATE SET folder = excluded.folder, uid_validity = excluded.uid_validity, last_uid = excluded.last_uid`),
    dropMailboxData: [
      db.prepare('DELETE FROM helpdesk_tickets WHERE mailbox_id = ?'),
      db.prepare('DELETE FROM helpdesk_messages WHERE mailbox_id = ?'),
      db.prepare('DELETE FROM helpdesk_folders WHERE mailbox_id = ?'),
      db.prepare('DELETE FROM helpdesk_pulls WHERE mailbox_id = ?'),
    ],
    hasMessage: db.prepare('SELECT ticket_id FROM helpdesk_messages WHERE mailbox_id = ? AND direction = ? AND message_id = ?'),
    ticket: db.prepare('SELECT * FROM helpdesk_tickets WHERE id = ?'),
    nextNumber: db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM helpdesk_tickets'),
    bySubject: db.prepare(`SELECT * FROM helpdesk_tickets WHERE mailbox_id = ? AND customer_email = ? AND subject_key = ?
      AND COALESCE(last_customer_at, opened_at) >= ? ORDER BY opened_at DESC LIMIT 1`),
    insertTicket: db.prepare(`INSERT INTO helpdesk_tickets (id, number, mailbox_id, subject, subject_key, customer_name, customer_email, state,
      waiting_since, last_customer_at, opened_at, updated_at, episode, message_count)
      VALUES (@id, @number, @mailbox_id, @subject, @subject_key, @customer_name, @customer_email, 'waiting', @at, @at, @at, @at, 1, 0)`),
    insertMessage: db.prepare(`INSERT INTO helpdesk_messages (id, ticket_id, mailbox_id, direction, folder_uid, message_id, in_reply_to, refs, from_name,
      from_email, to_email, subject, received_at, sent_at, body_text, body_truncated, attachments)
      VALUES (@id, @ticket_id, @mailbox_id, @direction, @folder_uid, @message_id, @in_reply_to, @refs, @from_name, @from_email, @to_email, @subject,
      @received_at, @sent_at, @body_text, @body_truncated, @attachments) ON CONFLICT DO NOTHING`),
    times: db.prepare('SELECT direction, received_at FROM helpdesk_messages WHERE ticket_id = ?'),
    setStatus: db.prepare(`UPDATE helpdesk_tickets SET state = @state, waiting_since = @waiting_since, last_customer_at = @last_customer_at,
      last_reply_at = @last_reply_at, handled_at = @handled_at, episode = @episode, message_count = @message_count, updated_at = @updated_at WHERE id = @id`),
    setClosed: db.prepare('UPDATE helpdesk_tickets SET closed_at = ?, closed_by = ?, closed_reason = ? WHERE id = ?'),
    messages: db.prepare('SELECT * FROM helpdesk_messages WHERE ticket_id = ? ORDER BY received_at, id'),
    waiting: db.prepare("SELECT * FROM helpdesk_tickets WHERE state = 'waiting' ORDER BY waiting_since, number"),
    counts: db.prepare('SELECT mailbox_id, state, COUNT(*) AS n FROM helpdesk_tickets GROUP BY mailbox_id, state'),
    purgeBodies: db.prepare(`UPDATE helpdesk_messages SET body_text = NULL, attachments = NULL, purged_at = @at WHERE purged_at IS NULL
      AND ticket_id IN (SELECT id FROM helpdesk_tickets WHERE state <> 'waiting' AND handled_at < @before)`),
    purgeTickets: db.prepare("DELETE FROM helpdesk_tickets WHERE state <> 'waiting' AND COALESCE(handled_at, updated_at) < ?"),
    purgeOrphans: db.prepare('DELETE FROM helpdesk_messages WHERE ticket_id NOT IN (SELECT id FROM helpdesk_tickets)'),
  };
  const at = () => nowIso(new Date(clock()));
  const refused = (status, code, message) => new HttpError(status, message, undefined, { code });
  const withDetails = (err, details) => Object.assign(err, { details });

  // ---- the password ---------------------------------------------------------------------------------------------
  const secretCache = new Map();
  function passwordOf(row) {
    if (!row) return null;
    if (!secretCache.has(row.password_enc)) {
      let s = null;
      try {
        s = decryptSecret(loadKey(cfg.keyFile, { create: false }), row.password_enc);
      } catch (err) {
        log?.error?.(`can't read the helpdesk key file: ${err.message}`);
      }
      secretCache.set(row.password_enc, s);
    }
    return secretCache.get(row.password_enc);
  }

  /** How to reach a server: TLS on 993 — except a server on this machine when the tests allow plain TCP. */
  const plainOk = (host) => cfg.plainLocalhost && isLocalHost(host);
  const connect = ({ host, port, username, password }) => openImap({
    host, port: plainOk(host) ? port : IMAP_PORT, secure: !plainOk(host), allowPlain: plainOk(host), username, password, timeoutMs: cfg.timeoutMs,
  });

  // ---- checking a login ------------------------------------------------------------------------------------------
  /**
   * Log in and open both folders (EXAMINE), the way every pull will. A missing folder is refused with the mailbox's
   * folder names (and the one marked \Sent), so the person can pick. → { folders }
   */
  async function verify({ host, port, username, password, inboxFolder, sentFolder }) {
    const s = await connect({ host, port, username, password });
    try {
      const folders = await s.list();
      const names = folders.map((f) => f.name);
      for (const [role, name] of [['inbox', inboxFolder], ['sent', sentFolder]]) {
        try {
          await s.examine(name);
        } catch (err) {
          if (err.code !== 'no_folder') throw err;
          const sentGuess = folders.find((f) => f.attributes.some((a) => /^\\sent$/i.test(a)))?.name ?? null;
          throw withDetails(refused(400, 'no_folder', `There is no folder “${name}” in this mailbox (the ${role === 'inbox' ? 'inbox' : 'Sent'} folder): pick one of its folders${role === 'sent' && sentGuess ? ` — its Sent folder is “${sentGuess}”` : ''}. Nothing was saved.`), { folders: names.slice(0, 200), sentFolder: sentGuess });
        }
      }
      return { folders: names };
    } finally {
      await s.logout();
    }
  }
  const asHttp = (err) => {
    if (!(err instanceof ImapError)) return err;
    if (err.code === 'bad_host') return refused(400, 'bad_host', err.message);
    if (err.code === 'auth') return refused(400, 'refused', `${err.message}: nothing was saved. Use an app password (not your normal password).`);
    if (err.code === 'login_disabled') return refused(400, 'login_disabled', `${err.message}: nothing was saved`);
    if (err.code === 'tls') return refused(502, 'tls', `${err.message}: nothing was saved`);
    if (err.code === 'network' || err.code === 'timeout') return refused(502, 'unreachable', `${err.message}: nothing was saved`);
    return refused(502, err.code, `${err.message}: nothing was saved`);
  };

  // ---- the mailboxes ---------------------------------------------------------------------------------------------
  const businessOk = (id) => Boolean(id && crm?.getBusiness?.(id));
  const storeOk = (id) => {
    if (!id) return true;
    try {
      return Boolean(services.woocommerce?.store?.(id));
    } catch {
      return false;
    }
  };
  const clean = (v, max) => String(v ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
  function settingsFrom(input, current = null) {
    const out = {
      name: input.name !== undefined ? clean(input.name, 120) : current?.name,
      inbox_folder: input.inboxFolder !== undefined ? clean(input.inboxFolder, 200) : current?.inbox_folder ?? 'INBOX',
      sent_folder: input.sentFolder !== undefined ? clean(input.sentFolder, 200) : current?.sent_folder ?? 'Sent',
      address: input.address !== undefined ? (clean(input.address, 320).toLowerCase() || null) : current?.address ?? null,
      store_id: input.storeId !== undefined ? (input.storeId || null) : current?.store_id ?? null,
      business_id: input.businessId !== undefined ? (input.businessId || null) : current?.business_id ?? BUSINESS_IDS.retail,
      ignore_from: input.ignoreFrom !== undefined ? (parseIgnore(input.ignoreFrom).join(', ') || null) : current?.ignore_from ?? null,
    };
    if (!out.inbox_folder || !out.sent_folder) throw refused(400, 'bad_folder', 'Give the inbox folder and the Sent folder (like INBOX and Sent)');
    if (out.address && !EMAIL_RE.test(out.address)) throw refused(400, 'bad_address', 'The mailbox’s address isn’t an email');
    if (!businessOk(out.business_id)) throw refused(400, 'bad_business', 'Pick one of our businesses');
    if (!storeOk(out.store_id)) throw refused(400, 'bad_store', 'Pick one of the connected WooCommerce stores (or none)');
    return out;
  }

  /** Add a mailbox: a real login first, both folders opened; saved only when that works. → mailboxInfo */
  async function addMailbox(input, { actor, deviceId = null }) {
    let host;
    try {
      host = cleanHost(input.host);
    } catch (err) {
      throw asHttp(err);
    }
    const username = clean(input.username, 320);
    const password = String(input.password ?? '');
    if (!username) throw refused(400, 'bad_username', 'Give the mailbox’s username (usually its email address)');
    if (!password || password.length > 500 || /[\r\n]/.test(password)) throw refused(400, 'bad_password', 'Give the mailbox’s app password');
    const port = plainOk(host) && Number.isInteger(input.port) ? input.port : IMAP_PORT;
    const settings = settingsFrom({ ...input, address: input.address ?? (EMAIL_RE.test(username.toLowerCase()) ? username : undefined) });
    settings.name ||= username;
    if (q.mailboxes.all().some((m) => m.host === host && m.username.toLowerCase() === username.toLowerCase())) {
      throw refused(409, 'exists', 'This mailbox is already connected: replace its password on its card instead');
    }
    try {
      await verify({ host, port, username, password, inboxFolder: settings.inbox_folder, sentFolder: settings.sent_folder });
    } catch (err) {
      throw asHttp(err);
    }
    const id = newId();
    const when = at();
    const enc = encryptSecret(loadKey(cfg.keyFile), password);
    db.transaction(() => {
      q.insert.run({ id, host, port, username, password_enc: enc, ...settings, position: q.maxPos.get().p + 1, at: when, actor, device: deviceId });
      q.ensurePull.run(id);
      q.change.run(newId(), when, actor, deviceId, id, 'added', `${username} on ${host}`);
    })();
    secretCache.set(enc, password);
    registerMailbox(q.mailbox.get(id));
    log?.info?.(`support mailbox added by ${actor}: ${host}`);
    pullMailbox(id, { force: true }).catch((err) => log?.error?.('the first helpdesk pull failed:', err));
    return mailboxInfo(q.mailbox.get(id));
  }

  /** A new app password (and username) for a mailbox: checked first. */
  async function replacePassword(id, { username, password }, { actor, deviceId = null }) {
    const row = mustMailbox(id);
    if (isPaused(row)) throw refused(409, 'paused', 'This mailbox is switched off: switch it on, then replace the password');
    const user = username !== undefined ? clean(username, 320) : row.username;
    const pass = String(password ?? '');
    if (!user) throw refused(400, 'bad_username', 'Give the mailbox’s username');
    if (!pass || pass.length > 500 || /[\r\n]/.test(pass)) throw refused(400, 'bad_password', 'Give the mailbox’s app password');
    try {
      await verify({ host: row.host, port: row.port, username: user, password: pass, inboxFolder: row.inbox_folder, sentFolder: row.sent_folder });
    } catch (err) {
      throw asHttp(err);
    }
    const enc = encryptSecret(loadKey(cfg.keyFile), pass);
    db.transaction(() => {
      q.setPassword.run(user, enc, at(), id);
      q.change.run(newId(), at(), actor, deviceId, id, 'password_replaced', user);
    })();
    secretCache.set(enc, pass);
    pullMailbox(id, { force: true }).catch((err) => log?.error?.('helpdesk pull failed:', err));
    return mailboxInfo(q.mailbox.get(id));
  }

  /** Change a mailbox's settings. New folder names are checked with a login (and read from the start). */
  async function updateMailbox(id, input, { actor, deviceId = null }) {
    const row = mustMailbox(id);
    const next = settingsFrom(input, row);
    if (!next.name) throw refused(400, 'bad_name', 'Give the mailbox a name');
    const foldersChanged = next.inbox_folder !== row.inbox_folder || next.sent_folder !== row.sent_folder;
    if (foldersChanged) {
      if (isPaused(row)) throw refused(409, 'paused', 'This mailbox is switched off: switch it on to change its folders (they are checked with a login)');
      const password = passwordOf(row);
      if (!password) throw refused(409, 'unreadable', 'The app password can’t be read on this machine: replace it first');
      try {
        await verify({ host: row.host, port: row.port, username: row.username, password, inboxFolder: next.inbox_folder, sentFolder: next.sent_folder });
      } catch (err) {
        throw asHttp(err);
      }
    }
    const changed = Object.keys(next).filter((k) => next[k] !== row[k]);
    if (changed.length) {
      db.transaction(() => {
        q.setSettings.run({ id, ...next });
        q.change.run(newId(), at(), actor, deviceId, id, 'changed', changed.join(', '));
      })();
    }
    return mailboxInfo(q.mailbox.get(id));
  }

  /** Forget a mailbox here, with its tickets and messages (its open tasks are finished). Revoke the app password too. */
  function removeMailbox(id, { actor, deviceId = null }) {
    const row = mustMailbox(id);
    db.transaction(() => {
      for (const st of q.dropMailboxData) st.run(id);
      q.remove.run(id);
      q.change.run(newId(), at(), actor, deviceId, id, 'removed', `${row.username} on ${row.host}`);
    })();
    connections.unregister(connectionId(id));
    log?.info?.(`support mailbox removed by ${actor}: ${row.host}`);
    changed();
    return { removed: true, mailboxes: listMailboxes() };
  }

  function mustMailbox(id) {
    const row = typeof id === 'string' ? q.mailbox.get(id) : null;
    if (!row) throw refused(404, 'not_found', 'No such mailbox');
    return row;
  }

  // ---- tickets from messages --------------------------------------------------------------------------------------
  function recompute(ticketId) {
    const t = q.ticket.get(ticketId);
    if (!t) return;
    const rows = q.times.all(ticketId);
    const st = ticketStatus({
      inTimes: rows.filter((r) => r.direction === 'in').map((r) => r.received_at),
      outTimes: rows.filter((r) => r.direction === 'out').map((r) => r.received_at),
      closedAt: t.closed_at,
    });
    const episode = t.state !== 'waiting' && st.state === 'waiting' ? t.episode + 1 : t.episode;
    q.setStatus.run({
      id: ticketId, state: st.state, waiting_since: st.waitingSince, last_customer_at: st.lastCustomerAt, last_reply_at: st.lastReplyAt,
      handled_at: st.handledAt, episode, message_count: rows.length, updated_at: at(),
    });
  }

  function ticketByRefs(mailboxId, refs) {
    const ids = [...new Set(refs)].slice(0, 40);
    if (!ids.length) return null;
    const row = db.prepare(`SELECT ticket_id FROM helpdesk_messages WHERE mailbox_id = ? AND message_id IN (${ids.map(() => '?').join(',')})
      ORDER BY received_at DESC LIMIT 1`).get(mailboxId, ...ids);
    return row ? q.ticket.get(row.ticket_id) : null;
  }

  /** A customer's email (from the inbox). → 'kept' | 'skipped' | 'duplicate' */
  function applyIncoming(mb, folder, m, ownAddress, ignoreList) {
    const p = parseMessage(m.body ?? Buffer.alloc(0), { cut: Number.isFinite(m.size) && m.size > (m.body?.length ?? 0) });
    const reply = p.replyTo && p.replyTo.email !== ownAddress ? p.replyTo : null;
    const customer = reply ?? p.from;
    if (!customer?.email || p.auto || customer.email === ownAddress || p.from.email === ownAddress
      || ignored(ignoreList, customer.email) || ignored(ignoreList, p.from.email)) return 'skipped';
    const messageId = p.messageId ?? `uid-${folder.uidValidity}-${m.uid}@${mb.id}`;
    if (q.hasMessage.get(mb.id, 'in', messageId)) return 'duplicate';
    const receivedAt = m.internalDate ?? p.date ?? at();
    const key = subjectKey(p.subject);
    let ticket = ticketByRefs(mb.id, [...p.inReplyTo, ...p.references]);
    if (!ticket && key) ticket = q.bySubject.get(mb.id, customer.email, key, new Date(Date.parse(receivedAt) - SUBJECT_MATCH_DAYS * DAY).toISOString()) ?? null;
    if (!ticket) {
      const id = newId();
      q.insertTicket.run({
        id, number: q.nextNumber.get().n, mailbox_id: mb.id, subject: p.subject || null, subject_key: key || null,
        customer_name: customer.name ?? p.from.name ?? null, customer_email: customer.email, at: receivedAt,
      });
      ticket = q.ticket.get(id);
    }
    q.insertMessage.run({
      id: newId(), ticket_id: ticket.id, mailbox_id: mb.id, direction: 'in', folder_uid: `${folder.uidValidity}:${m.uid}`, message_id: messageId,
      in_reply_to: p.inReplyTo[0] ?? null, refs: JSON.stringify(p.references), from_name: customer.name ?? p.from.name ?? null, from_email: customer.email,
      to_email: null, subject: p.subject || null, received_at: receivedAt, sent_at: p.date, body_text: p.text, body_truncated: p.truncated ? 1 : 0,
      attachments: JSON.stringify(p.moreAttachments ? [...p.attachments, `…and ${p.moreAttachments} more`] : p.attachments),
    });
    recompute(ticket.id);
    return 'kept';
  }

  /** One of our sent emails (headers only): kept — without its body — when it replies to a ticket. */
  function applyOutgoing(mb, folder, m) {
    const p = parseMessage(m.body ?? Buffer.alloc(0));
    const messageId = p.messageId ?? `uid-${folder.uidValidity}-${m.uid}@${mb.id}`;
    if (q.hasMessage.get(mb.id, 'out', messageId)) return 'duplicate';
    const receivedAt = m.internalDate ?? p.date ?? at();
    let ticket = ticketByRefs(mb.id, [...p.inReplyTo, ...p.references]);
    let to = ticket ? (p.to.includes(ticket.customer_email) ? ticket.customer_email : p.to[0] ?? null) : null;
    const key = subjectKey(p.subject);
    if (!ticket && key) {
      // A reply without thread headers (a mailto: link, a new email): the same customer and subject, recently.
      const since = new Date(Date.parse(receivedAt) - SUBJECT_MATCH_DAYS * DAY).toISOString();
      for (const email of p.to) {
        ticket = q.bySubject.get(mb.id, email, key, since) ?? null;
        if (ticket) {
          to = email;
          break;
        }
      }
    }
    if (!ticket) return 'skipped'; // not a reply to a ticket: nothing about it is kept
    q.insertMessage.run({
      id: newId(), ticket_id: ticket.id, mailbox_id: mb.id, direction: 'out', folder_uid: `${folder.uidValidity}:${m.uid}`, message_id: messageId,
      in_reply_to: p.inReplyTo[0] ?? null, refs: JSON.stringify(p.references), from_name: null, from_email: p.from.email ?? null, to_email: to,
      subject: p.subject || null, received_at: receivedAt, sent_at: p.date, body_text: null, body_truncated: 0, attachments: null,
    });
    recompute(ticket.id);
    return 'kept';
  }

  // ---- pulls -------------------------------------------------------------------------------------------------------
  /** Read one folder's new messages (at most MAX_PER_ROUND). → { kept, skipped, more } */
  async function readFolder(session, mb, role) {
    const name = role === 'inbox' ? mb.inbox_folder : mb.sent_folder;
    const st = q.folder.get(mb.id, role);
    const info = await session.examine(name);
    const fresh = !st || st.folder !== name || (info.uidValidity !== null && st.uid_validity !== info.uidValidity);
    const last = fresh ? 0 : st.last_uid;
    let uids;
    if (fresh) uids = await session.searchSince(new Date(clock() - FIRST_READ_DAYS * DAY));
    else if (info.uidNext !== null && info.uidNext <= last + 1) uids = [];
    else uids = await session.searchFrom(last + 1);
    uids = uids.filter((u) => u > last);
    const take = uids.slice(0, MAX_PER_ROUND);
    const own = (mb.address ?? mb.username).toLowerCase();
    const ignore = parseIgnore(mb.ignore_from);
    let kept = 0;
    let skipped = 0;
    for (let i = 0; i < take.length; i += FETCH_BATCH) {
      const batch = take.slice(i, i + FETCH_BATCH);
      const got = role === 'inbox' ? await session.fetchMessages(batch, MAX_FETCH_BYTES) : await session.fetchHeaders(batch, SENT_FIELDS);
      if (!q.mailbox.get(mb.id)) return { kept, skipped, more: false }; // removed meanwhile
      db.transaction(() => {
        for (const m of got) {
          let r;
          try {
            r = role === 'inbox' ? applyIncoming(mb, info, m, own, ignore) : applyOutgoing(mb, info, m);
          } catch (err) {
            // One unreadable message never stops the rest (it is skipped, and the log says which uid — no content).
            log?.warn?.(`helpdesk: message ${m.uid} in ${role} of mailbox ${mb.id} couldn’t be read: ${err.message}`);
            r = 'skipped';
          }
          if (r === 'kept') kept += 1;
          else if (r === 'skipped' && role === 'inbox') skipped += 1;
        }
        q.setFolder.run(mb.id, role, name, info.uidValidity, batch.at(-1));
      })();
    }
    // Nothing (new) to read: remember where the folder ends so only new mail is read next time.
    if (!take.length) {
      let end = last;
      if (fresh) end = info.uidNext !== null ? info.uidNext - 1 : Math.max(0, ...(await session.searchFrom(1)));
      if (fresh || !st) q.setFolder.run(mb.id, role, name, info.uidValidity, end);
    }
    if (skipped) q.skipped.run(skipped, mb.id);
    return { kept, skipped, more: uids.length > take.length };
  }

  const running = new Map();
  function pullMailbox(id, opts = {}) {
    if (running.has(id)) return running.get(id);
    const p = doPull(id, opts).finally(() => running.delete(id));
    running.set(id, p);
    return p;
  }
  const due = (pull, nowMs) => {
    if (pull?.next_try_at && Date.parse(pull.next_try_at) > nowMs) return false;
    return !pull?.last_success_at || nowMs - Date.parse(pull.last_success_at) >= cfg.everyMinutes * MINUTE;
  };

  async function doPull(id, { force = false } = {}) {
    const mb = q.mailbox.get(id);
    if (!mb) return { skipped: 'gone' };
    if (isPaused(mb)) return { skipped: 'paused' };
    q.ensurePull.run(id);
    if (!force && !due(q.pull.get(id), clock())) return { skipped: 'not_due' };
    const password = passwordOf(mb);
    if (!password) {
      recordFailure(id, new ImapError('unreadable', 'The app password can’t be read on this machine (its key file is missing): replace it'));
      return { failed: true };
    }
    let session = null;
    try {
      session = await connect({ host: mb.host, port: mb.port, username: mb.username, password });
      const inbox = await readFolder(session, mb, 'inbox');
      // The Sent folder only once the inbox is caught up: a reply is never read before the email it answers.
      const sent = inbox.more ? { kept: 0, more: true } : await readFolder(session, mb, 'sent');
      await session.logout();
      session = null;
      if (!q.mailbox.get(id)) return { skipped: 'gone' };
      q.pullOk.run({ id, at: at() });
      return { ok: true, inbox: inbox.kept, sent: sent.kept, skipped: inbox.skipped, more: inbox.more || sent.more };
    } catch (err) {
      session?.close();
      if (!(err instanceof ImapError)) log?.error?.(`helpdesk mailbox ${id}: unexpected error`, err);
      else log?.warn?.(`helpdesk mailbox ${id} (${mb.host}): ${err.message}`);
      recordFailure(id, err);
      return { failed: true, error: err.message };
    }
  }

  function recordFailure(id, err) {
    if (!q.mailbox.get(id)) return;
    q.ensurePull.run(id);
    const failures = (q.pull.get(id)?.failures ?? 0) + 1;
    const nowMs = clock();
    const message = err?.code === 'auth' ? `${err.message}: replace the app password on its card` : String(err?.message ?? err);
    q.pullFail.run({ id, at: nowIso(new Date(nowMs)), error: message.slice(0, 500), next: new Date(nowMs + backoffMs(failures)).toISOString() });
  }

  /** Every mailbox that is due, side by side; then retention, then the automations look (tasks). */
  async function pullRound({ force = false } = {}) {
    const boxes = q.mailboxes.all();
    const results = await Promise.allSettled(boxes.map((m) => pullMailbox(m.id, { force })));
    const out = Object.fromEntries(boxes.map((m, i) => [m.id, results[i].status === 'fulfilled' ? results[i].value : { failed: true }]));
    if (Object.values(out).some((r) => r.ok)) {
      purge();
      emitPulled();
    }
    return out;
  }
  const emitPulled = () => {
    try {
      automations?.emit(PULLED_EVENT, { key: newId() });
    } catch (err) {
      log?.error?.('helpdesk: the ticket tasks failed (tried again after the next read):', err);
    }
  };
  function changed() {
    try {
      automations?.emit(CHANGED_EVENT, { key: newId() });
    } catch (err) {
      log?.error?.('helpdesk: the ticket tasks failed (tried again after the next read):', err);
    }
  }

  function startPuller({ everyMs = LOOK_EVERY_MS, firstMs = FIRST_LOOK_MS } = {}) {
    const look = () => pullRound().catch((err) => log?.error?.('helpdesk pulls failed (tried again later):', err));
    const first = setTimeout(look, firstMs);
    const timer = setInterval(look, everyMs);
    first.unref?.();
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  async function pullNow(id) {
    const row = mustMailbox(id);
    if (isPaused(row)) throw refused(409, 'paused', 'This mailbox is switched off: switch it on to read it');
    const result = await pullMailbox(id, { force: true });
    if (result.ok) {
      purge();
      emitPulled();
    }
    return { result, mailbox: mailboxInfo(q.mailbox.get(id)) };
  }

  // ---- retention ---------------------------------------------------------------------------------------------------
  /** Bodies go BODY_KEEP_DAYS after a ticket was answered or closed; whole tickets TICKET_KEEP_DAYS after. */
  function purge(nowMs = clock()) {
    const bodies = q.purgeBodies.run({ at: nowIso(new Date(nowMs)), before: new Date(nowMs - BODY_KEEP_DAYS * DAY).toISOString() }).changes;
    const tickets = q.purgeTickets.run(new Date(nowMs - TICKET_KEEP_DAYS * DAY).toISOString()).changes;
    if (tickets) q.purgeOrphans.run();
    return { bodies, tickets };
  }

  // ---- a person's actions --------------------------------------------------------------------------------------------
  function mustTicket(id) {
    const t = typeof id === 'string' ? q.ticket.get(id) : null;
    if (!t) throw refused(404, 'not_found', 'No such ticket (a ticket is deleted a year after it was answered)');
    return t;
  }
  /** Close a ticket (no reply needed). Its open task is finished by the suite. */
  function closeTicket(id, { actor, reason = 'no_reply_needed' }, { emit = true } = {}) {
    const t = mustTicket(id);
    if (t.state === 'closed') return ticketView(t);
    db.transaction(() => {
      q.setClosed.run(at(), actor, reason, id);
      recompute(id);
    })();
    if (emit) changed();
    return ticketView(q.ticket.get(id));
  }
  /** Reopen a closed ticket: it waits on us again when the customer's last email has no reply. */
  function reopenTicket(id) {
    const t = mustTicket(id);
    if (t.state !== 'closed') return ticketView(t);
    db.transaction(() => {
      q.setClosed.run(null, null, null, id);
      recompute(id);
    })();
    changed();
    return ticketView(q.ticket.get(id));
  }

  // ---- the order (live, never stored) -----------------------------------------------------------------------------
  /**
   * The orders this ticket is about, from the mailbox's WooCommerce store, now: the order numbers its customer emails
   * mention (at most 3), else the customer's email. Nothing is kept or logged. → { by, numbers, orders, more }
   */
  async function lookupOrder(id) {
    const t = mustTicket(id);
    const mb = mustMailbox(t.mailbox_id);
    const woo = services.woocommerce;
    if (!woo || !mb.store_id) throw refused(409, 'no_store', 'This mailbox isn’t linked to a WooCommerce store: pick its store on the mailbox’s card (System → Connections)');
    const texts = [t.subject ?? '', ...q.messages.all(id).filter((m) => m.direction === 'in').map((m) => `${m.subject ?? ''}\n${m.body_text ?? ''}`)];
    const numbers = orderNumbers(texts.join('\n'));
    const found = new Map();
    let more = false;
    for (const n of numbers) {
      const r = await woo.lookup(mb.store_id, { number: n });
      for (const o of r.orders) found.set(o.id, o);
      more ||= r.more;
    }
    if (found.size) return { by: 'number', numbers, orders: [...found.values()], more };
    if (!t.customer_email) return { by: null, numbers, orders: [], more: false };
    const r = await woo.lookup(mb.store_id, { email: t.customer_email });
    return { by: 'email', numbers, orders: r.orders, more: r.more };
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------
  const isPaused = (row) => connections.isPaused(connectionId(row.id));
  const mailboxName = (id) => q.mailbox.get(id)?.name ?? 'a removed mailbox';
  function ticketView(t, nowMs = clock()) {
    return {
      id: t.id, number: t.number, mailboxId: t.mailbox_id, mailbox: mailboxName(t.mailbox_id), subject: t.subject, customerName: t.customer_name,
      customerEmail: t.customer_email, state: t.state, waitingSince: t.waiting_since, lastCustomerAt: t.last_customer_at, lastReplyAt: t.last_reply_at,
      closedAt: t.closed_at, closedBy: t.closed_by, closedReason: t.closed_reason, episode: t.episode, messageCount: t.message_count,
      openedAt: t.opened_at, updatedAt: t.updated_at, flagged: isFlagged(t, nowMs), hoursWaiting: hoursWaiting(t, nowMs),
    };
  }
  /** Tickets for the list (no bodies): waiting first (longest waiting first), then the newest. */
  function listTickets({ mailboxId = null, state = 'waiting', limit = 50, offset = 0 } = {}) {
    const states = state === 'all' ? ['waiting', 'answered', 'closed'] : ['waiting', 'answered', 'closed'].includes(state) ? [state] : ['waiting'];
    const where = [`state IN (${states.map(() => '?').join(',')})`];
    const args = [...states];
    if (mailboxId) {
      where.push('mailbox_id = ?');
      args.push(mailboxId);
    }
    const lim = Math.min(Math.max(1, Number.parseInt(limit, 10) || 50), PAGE_MAX);
    const off = Math.max(0, Number.parseInt(offset, 10) || 0);
    const rows = db.prepare(`SELECT * FROM helpdesk_tickets WHERE ${where.join(' AND ')}
      ORDER BY (state = 'waiting') DESC, CASE WHEN state = 'waiting' THEN waiting_since END ASC, updated_at DESC, number DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM helpdesk_tickets WHERE ${where.join(' AND ')}`).get(...args).n;
    const counts = { waiting: 0, answered: 0, closed: 0, flagged: 0 };
    for (const c of q.counts.all()) if (!mailboxId || c.mailbox_id === mailboxId) counts[c.state] = (counts[c.state] ?? 0) + c.n;
    const nowMs = clock();
    counts.flagged = q.waiting.all().filter((t) => (!mailboxId || t.mailbox_id === mailboxId) && isFlagged(t, nowMs)).length;
    return { tickets: rows.map((t) => ticketView(t, nowMs)), total, counts };
  }
  /** One ticket with its messages (plain text) and what the page needs about its mailbox. */
  function ticket(id) {
    const t = mustTicket(id);
    const mb = q.mailbox.get(t.mailbox_id);
    const messages = q.messages.all(id).map((m) => ({
      id: m.id, direction: m.direction, fromName: m.from_name, fromEmail: m.from_email, toEmail: m.to_email, subject: m.subject,
      receivedAt: m.received_at, sentAt: m.sent_at, text: m.body_text, truncated: m.body_truncated === 1,
      attachments: m.attachments ? JSON.parse(m.attachments) : [], purged: Boolean(m.purged_at),
    }));
    const numbers = orderNumbers([t.subject ?? '', ...messages.filter((m) => m.direction === 'in').map((m) => `${m.subject ?? ''}\n${m.text ?? ''}`)].join('\n'));
    return {
      ticket: ticketView(t),
      messages,
      mailbox: mb ? { id: mb.id, name: mb.name, address: mb.address ?? mb.username, storeId: mb.store_id, paused: isPaused(mb), businessId: mb.business_id } : null,
      orderNumbers: numbers,
      keepDays: { bodies: BODY_KEEP_DAYS, tickets: TICKET_KEEP_DAYS },
    };
  }
  /** Waiting tickets (for the automations): with their mailbox's name and business. */
  const waitingTickets = () => q.waiting.all().map((t) => {
    const mb = q.mailbox.get(t.mailbox_id);
    return { ...t, mailbox_name: mb?.name ?? 'Support', business_id: mb?.business_id ?? BUSINESS_IDS.retail };
  });

  /**
   * The overview's support line (D11): tickets waiting on us for 24 hours or more. state: not_connected (no mailbox),
   * paused (every mailbox paused: the last read), ok. Items are data; the device words them.
   */
  function supportSection(nowMs = clock()) {
    const boxes = q.mailboxes.all();
    if (!boxes.length) return { count: null, state: 'not_connected', items: [] };
    const waiting = q.waiting.all();
    const flagged = waiting.filter((t) => isFlagged(t, nowMs));
    const failing = boxes.filter((m) => !isPaused(m) && (q.pull.get(m.id)?.failures ?? 0) > 0).map((m) => m.name);
    return {
      count: flagged.length,
      state: boxes.every(isPaused) ? 'paused' : 'ok',
      waiting: waiting.length,
      failing,
      items: flagged.map((t) => ({ id: t.id, number: t.number, mailbox: mailboxName(t.mailbox_id), waitingSince: t.waiting_since, hours: hoursWaiting(t, nowMs) })),
    };
  }

  function mailboxInfo(row) {
    const p = q.pull.get(row.id) ?? {};
    const counts = { waiting: 0, answered: 0, closed: 0 };
    for (const c of q.counts.all()) if (c.mailbox_id === row.id) counts[c.state] = c.n;
    return {
      id: row.id, connectionId: connectionId(row.id), name: row.name, host: row.host, port: row.port, username: row.username,
      inboxFolder: row.inbox_folder, sentFolder: row.sent_folder, address: row.address, storeId: row.store_id, businessId: row.business_id,
      ignoreFrom: row.ignore_from, addedAt: row.added_at, addedBy: row.added_by, passwordSetAt: row.password_set_at,
      readable: passwordOf(row) !== null, paused: isPaused(row),
      lastSuccessAt: p.last_success_at ?? null, lastAttemptAt: p.last_attempt_at ?? null, lastErrorAt: p.last_error_at ?? null,
      lastError: p.last_error ?? null, failures: p.failures ?? 0, nextTryAt: p.next_try_at ?? null, skipped: p.skipped ?? 0,
      counts, everyMinutes: cfg.everyMinutes, changes: q.changes.all(row.id),
    };
  }
  const listMailboxes = () => q.mailboxes.all().map(mailboxInfo);

  function describeMailbox(id) {
    const row = q.mailbox.get(id);
    if (!row) return { queueLabel: 'Removed' };
    const s = mailboxInfo(row);
    const flagged = q.waiting.all().filter((t) => t.mailbox_id === id && isFlagged(t, clock())).length;
    return {
      lastSuccessAt: s.lastSuccessAt, lastErrorAt: s.failures ? s.lastErrorAt : null, lastError: s.failures ? s.lastError : null,
      queueSize: s.counts.waiting,
      queueLabel: s.lastSuccessAt ? `${s.counts.waiting} waiting for a reply${flagged ? ` (${flagged} over 24 hours)` : ''}` : 'Not read yet',
      detail: !s.readable ? 'The app password can’t be read on this server: replace it' : null,
    };
  }

  function registerMailbox(row) {
    connections.register({
      id: connectionId(row.id),
      name: `${row.name} (support mailbox)`,
      module: 'helpdesk',
      description: 'Customer emails read over IMAP into tickets, and replies seen in the Sent folder. Read only: nothing is marked read, moved or deleted, and nothing is ever sent.',
      after: HUB_ID,
      describe: () => describeMailbox(row.id),
      pause() { log?.info?.(`paused: no calls to ${row.host}`); },
      resume() {
        pullMailbox(row.id, { force: true }).then((r) => {
          if (r.ok) emitPulled();
        }).catch((err) => log?.error?.('helpdesk pull failed:', err));
      },
    });
  }

  connections.register({
    id: HUB_ID,
    name: 'Support mailboxes',
    module: 'helpdesk',
    description: 'Each store’s support mailbox, read over IMAP with its own app password, into tickets on the Support page. Read only; replies are written in your own mail app. Add a mailbox here; each then has its own row and switch.',
    pausable: false,
    alwaysOnReason: 'This row only adds mailboxes: each mailbox below has its own switch.',
    describe: () => {
      const n = q.mailboxes.all().length;
      return { queueLabel: n ? `${n} mailbox${n === 1 ? '' : 'es'}` : 'No mailboxes yet', detail: null };
    },
  });
  for (const row of q.mailboxes.all()) registerMailbox(row);

  const service = {
    addMailbox, replacePassword, updateMailbox, removeMailbox, listMailboxes, mailbox: (id) => mailboxInfo(mustMailbox(id)),
    pullMailbox, pullRound, pullNow, startPuller, purge, verify,
    listTickets, ticket, closeTicket, reopenTicket, lookupOrder, waitingTickets, ticketRow: (id) => q.ticket.get(id) ?? null, supportSection,
    recomputeTicket: recompute,
    /** At start: retention, and the tasks brought in line with the tickets (a restore, a run that failed). */
    start() {
      try {
        purge();
      } catch (err) {
        log?.error?.('helpdesk retention failed:', err);
      }
      changed();
    },
  };
  if (automations && planner) registerHelpdeskAutomations({ automations, planner, helpdesk: service, db, clock });
  return service;
}

