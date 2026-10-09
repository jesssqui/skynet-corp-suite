// The wholesale automations (D3), registered with the automations framework (C8). They read the
// holding area (this module's own tables, through `reads`), the CRM and the planner through their
// services, and only ever make or change TASKS (plus C8's in-app alerts when switched to alert):
// "they prepare, you approve" — nothing is ever sent outside the suite. A drafted email sits in a
// task's notes for a person to copy.
//
//   wholesale-check-in        every day at 7:40 — a regular (figures.js orderRhythm) past their usual
//                             gap gets "Check in with <account>: no order in N days (usually every M)",
//                             once per quiet spell (key: customer uid + their last order uid)
//   wholesale-balances        every day at 7:45 — money owing on orders over 30 days old (figures.js
//                             owingByOrder: the Order Manager's balance rule) gets one task with a
//                             drafted email, kept up to date; finished by the suite once nothing over
//                             30 days is owed
//   wholesale-ready-to-ship   when the Order Manager says an order was packed: "Ship order #N for
//                             <account>"; finished by the suite when it ships, is cancelled, deleted,
//                             unpacked or changed (check again); decided on the held order as it is now
//
// Tasks are never deleted by the suite: they are finished (done_at) with a line saying why, and a
// task the SUITE finished is reopened when its reason comes back (a payment removed, an order
// cancelled); only a task a PERSON finished or deleted keeps the suite from making another. What the
// suite finished, and which titles/notes it wrote, is remembered in automations_made under its own
// keys (suite-done:…, wrote:…), so a title or notes a person changed are never put back.
//
// Every task goes to the wholesale business's default owner (planner.automatedOwnerFor), on the
// wholesale business, with the client, account and (when there is one) the account's wholesale
// relationship. Only customers linked to an account (attached) are looked at. See CLAUDE.md,
// "Wholesale automations (D3)".
import crypto from 'node:crypto';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { parseLocalDate, localDate } from '@suite/shared/time';
import { orderRhythm, isQuiet, daysBetween, owingByOrder, overdueOrders, OVERDUE_AFTER_DAYS } from './figures.js';

export const CUSTOMER_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

export const CHECK_IN_ID = 'wholesale-check-in';
export const BALANCES_ID = 'wholesale-balances';
export const SHIP_ID = 'wholesale-ready-to-ship';
/** At most this many new tasks a run (check-ins, balance reminders): the rest wait for the next days. */
export const NEW_TASKS_CAP = 10;
/** Titles listed in an alert's body before "and N more". */
const ALERT_LIST_MAX = 5;
/**
 * The line in a balance task's notes above which the suite keeps the draft up to date; anything
 * a person writes below it is kept. Remove the line and the suite leaves the notes alone.
 */
export const NOTES_MARK = '──── Your notes below this line are kept when the suite updates the draft ────';
const TITLE_MAX = 300;
const W = BUSINESS_IDS.wholesale;

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** $1,234.56 */
export function money(cents) {
  const sign = cents < 0 ? '−' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Aug 1, 2026" for a calendar day. */
export const dayText = (ymd) => (ymd ? parseLocalDate(ymd).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : 'an unknown day');

/** The first few lines, then "and N more". */
function listBody(titles, extra = 0) {
  const shown = titles.slice(0, ALERT_LIST_MAX);
  const more = titles.length - shown.length + extra;
  return [...shown, ...(more ? [`and ${more.toLocaleString('en-CA')} more`] : [])].join('\n');
}

/** The account's wholesale relationship (an active one first), or null. */
function wholesaleRelationship(crm, accountId) {
  const rels = crm.accountRelationships(accountId).filter((r) => r.business_id === W);
  return (rels.find((r) => r.status === 'active') ?? rels[0])?.id ?? null;
}

/**
 * How a task names the customer: the account's name, plus the Order Manager customer's own name
 * when the account has more than one of them linked.
 */
export function nameFor({ reads }, account, c) {
  const own = c.business_name || (c.number ? `customer #${c.number}` : null);
  return reads.attachedOn(account.id) > 1 && own ? `${account.name} (${own})` : account.name;
}

/** The fields every wholesale task shares: business, owner, client, account, relationship. */
export function taskBase({ crm, planner }, account) {
  return {
    owner: planner.automatedOwnerFor(W),
    business_id: W,
    client_id: account.client_id,
    account_id: account.id,
    relationship_id: wholesaleRelationship(crm, account.id),
  };
}

// ---- bookkeeping: what the suite did to its own tasks ------------------------------------------
// `io` = the run's { planner, made, madeLike, remember, update }.

const hash = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest('hex').slice(0, 20);
const wroteKey = (id, field, value) => `wrote:${id}:${field}:${hash(value)}`;
export const doneKey = (id, doneAt) => `suite-done:${id}:${doneAt}`;

/** Remember that the suite wrote this value of a task's field (so a later change is known to be a person's). */
export function markWrote(io, id, field, value) {
  io.remember(wroteKey(id, field, value), 'task', id);
}
/** Is the task's current value of `field` one the suite wrote? (false = a person changed it: leave it). */
export function suiteWrote(io, id, field, value) {
  return io.made(wroteKey(id, field, value)).length > 0;
}
/** Was this task finished by the suite (and not reopened and finished again by a person since)? */
export function suiteFinished(io, id, state = io.planner.taskState(id)) {
  return Boolean(state?.live && state.doneAt && io.made(doneKey(id, state.doneAt)).length);
}

/** Finish one of the suite's own tasks (done_at), adding a line to its notes that says why. */
export function finishTask(io, id, why, now) {
  const t = io.planner.taskState(id);
  if (!t?.open) return false;
  const doneAt = now.toISOString();
  const line = `${why} — finished by the suite on ${dayText(localDate(now))}.`;
  io.update('task', id, { done_at: doneAt, notes: t.notes ? `${t.notes}\n\n${line}` : line });
  io.remember(doneKey(id, doneAt), 'task', id);
  return true;
}

/**
 * Reopen a task the suite finished, because its reason is back: due today again, with a line saying
 * why; `title` is set only when the current one is the suite's; `notes` (when given) replaces the notes
 * before the line is added.
 */
function reopenTask(io, id, { title = null, notes = null, why }, now, today) {
  const t = io.planner.taskState(id);
  if (!t?.live || t.open) return false;
  const fields = { done_at: null, due_date: today };
  if (title && title !== t.title && suiteWrote(io, id, 'title', t.title)) fields.title = title;
  const line = `${why} — reopened by the suite on ${dayText(localDate(now))}.`;
  const base = notes ?? t.notes;
  fields.notes = base ? `${base}\n\n${line}` : line;
  io.update('task', id, fields);
  if (fields.title) markWrote(io, id, 'title', fields.title);
  return true;
}

/**
 * Finish the open tasks this automation made for Order Manager customers that aren't linked any more
 * (keys "<customer uid>:…"; `attached` = the uids linked now). → how many.
 */
function finishUnlinked(io, attached, now) {
  const seen = new Set();
  let n = 0;
  for (const m of io.madeLike('')) {
    const uid = CUSTOMER_KEY.exec(m.key)?.[1];
    if (!uid || attached.has(uid) || seen.has(m.id)) continue;
    seen.add(m.id);
    if (finishTask(io, m.id, 'Unlinked from the Order Manager customer', now)) n += 1;
  }
  return n;
}

// ---- 1. check-ins --------------------------------------------------------------------------

/**
 * What the check-in automation would do on `today` (pure over the reads and what it made):
 *  due      quiet regulars with no check-in for this quiet spell yet (most overdue first)
 *  reopen   a check-in for this spell that the SUITE finished (e.g. the newer order that ended the spell
 *           was cancelled or deleted, or the customer was unlinked and linked again)
 *  finish   open check-ins whose spell is over (a newer order) or whose customer was deleted
 *  handled  quiet spells whose check-in a PERSON finished or deleted (never made again)
 */
export function checkInPlan({ reads, crm, planner }, { today, madeLike, made }) {
  const io = { planner, made };
  const due = [];
  const finish = [];
  const reopen = [];
  let handled = 0;
  for (const c of reads.attachedCustomers()) {
    const orders = reads.ordersOf(c.uid);
    const r = orderRhythm(orders);
    const key = `${c.uid}:${r.last_order_uid}`;
    for (const m of madeLike(`${c.uid}:`)) {
      if (!planner.taskState(m.id)?.open) continue;
      if (c.gone) {
        finish.push({ id: m.id, why: 'Deleted in the Order Manager' });
        continue;
      }
      if (m.key === key) continue;
      // An earlier quiet spell: they have ordered since (or that spell's last order is gone).
      const was = orders.find((o) => o.uid === m.key.slice(c.uid.length + 1));
      const last = orders.find((o) => o.uid === r.last_order_uid);
      const why = last && (!was || (last.order_date ?? '') > (was.order_date ?? ''))
        ? `Ordered again (order #${last.number ?? '?'} on ${dayText(last.order_date)})`
        : 'Their last order changed in the Order Manager';
      finish.push({ id: m.id, why });
    }
    if (c.gone || !isQuiet(r, today)) continue;
    const account = crm.liveAccount(c.account_id);
    if (!account || account.client_status !== 'active') continue; // a closed client: no next steps
    const item = { key, customer: c, account, rhythm: r, days: daysBetween(r.last_order_date, today) };
    const atKey = made(key).map((m) => ({ ...m, state: planner.taskState(m.id) }));
    if (!atKey.length) due.push(item);
    else if (atKey.some((m) => m.state?.open)) continue;
    else {
      const mine = atKey.filter((m) => suiteFinished(io, m.id, m.state));
      if (mine.length) reopen.push({ ...item, id: mine[mine.length - 1].id });
      else handled += 1; // finished or deleted by a person: their call, not made again for this spell
    }
  }
  due.sort((a, b) => (b.days - b.rhythm.quiet_after_days) - (a.days - a.rhythm.quiet_after_days) || (a.key < b.key ? -1 : 1));
  return { due, finish, reopen, handled };
}

function checkInTask(deps, { customer: c, account, rhythm: r, days }, now) {
  const name = nameFor(deps, account, c);
  const lastOrder = deps.reads.ordersOf(c.uid).find((o) => o.uid === r.last_order_uid);
  const title = clip(`Check in with ${name}: no order in ${days} days (usually every ${r.usual_gap_days})`, TITLE_MAX);
  const notes = [
    `${name} usually orders every ${plural(r.usual_gap_days, 'day')} (the middle of their last ${plural(r.gaps.length, 'gap')} between orders). `
      + `Their last order was #${lastOrder?.number ?? '?'} on ${dayText(r.last_order_date)}${lastOrder ? ` (${money(lastOrder.total_cents)})` : ''}: `
      + `${plural(days, 'day')} ago.`,
    'A call or a message from you — the suite never contacts anyone.',
    `Client: /crm/clients/${account.client_id}`,
    `Prepared by the suite on ${dayText(localDate(now))}.`,
  ].join('\n');
  return { title, notes };
}

// ---- 2. balances -----------------------------------------------------------------------------

/**
 * Who the drafted email goes to: the account's first contact with an email (its own contacts first,
 * then the client's with no account), else the Order Manager customer's email. → { name, email }.
 */
function recipient({ crm }, account, c) {
  const contacts = crm.accountContacts(account.id);
  const withEmail = contacts.find((p) => p.email);
  if (withEmail) return { name: withEmail.name, email: withEmail.email };
  return { name: contacts[0]?.name ?? c.contact_name ?? null, email: c.email ?? null };
}

/**
 * The balance task's title and the suite's part of its notes (the drafted email). Plain text, no
 * dates of the run in it: the notes change only when the money does (so an alert means something).
 */
export function balanceDraft({ name, to, overdue, creditCents = 0, businessName }) {
  const total = overdue.reduce((s, o) => s + o.owing_cents, 0);
  const numbers = overdue.map((o) => `#${o.number ?? '?'}`).join(', ');
  const greeting = (to.name ?? '').trim().split(/\s+/)[0] || name;
  const lines = overdue.map((o) => `• Order #${o.number ?? '?'} from ${dayText(o.order_date)}: ${money(o.owing_cents)} owing`
    + (o.owing_cents !== o.total_cents ? ` (order total ${money(o.total_cents)})` : ''));
  const draft = [
    'Drafted by the suite — nothing has been sent. Copy it into your email when you’re ready.',
    '',
    `To: ${to.email ? (to.name ? `${to.name} <${to.email}>` : to.email) : `(no email on file for ${name}: add one to a contact)`}`,
    `Subject: Balance owing: ${money(total)} on order${overdue.length === 1 ? '' : 's'} ${numbers}`,
    '',
    `Hi ${greeting},`,
    '',
    `Our records show ${overdue.length === 1 ? 'this order is' : 'these orders are'} still unpaid after ${OVERDUE_AFTER_DAYS} days:`,
    '',
    ...lines,
    '',
    `Total owing: ${money(total)}`,
    ...(creditCents > 0 ? ['', `You also have ${money(creditCents)} in store credit with us; we can put it towards ${overdue.length === 1 ? 'this order' : 'these orders'} if you like.`] : []),
    '',
    'If you’ve already sent payment, thank you, and please ignore this note. Otherwise, could you let us know when we can expect it?',
    '',
    'Thanks,',
    businessName,
  ].join('\n');
  return {
    title: clip(`Balance owing over ${OVERDUE_AFTER_DAYS} days: ${name}, ${money(total)} (${plural(overdue.length, 'order')})`, TITLE_MAX),
    draft,
    totalCents: total,
  };
}

/** New notes for a balance task: the new draft above NOTES_MARK, the person's own notes below it kept. → null to leave them. */
export function mergeNotes(current, draft) {
  if (current === null || current === undefined || current === '') return `${draft}\n\n${NOTES_MARK}\n`;
  const at = current.indexOf(NOTES_MARK);
  if (at < 0) return null; // the person took the notes over: leave them
  const next = `${draft}\n\n${current.slice(at)}`;
  return next === current ? null : next;
}

/**
 * What the balance automation would do on `today` (pure over the reads and what it made). Per linked
 * customer: `finish` (nothing over 30 days owed any more, or the customer was deleted: its open
 * reminders), `update` (owed, and a reminder is open), `create` (owed, none made for this oldest overdue
 * order), `reopen` (owed again and the reminder for this order was finished by the SUITE — a payment was
 * removed, a bounced cheque), or `handled` (a PERSON finished or deleted it: not made again for this order).
 */
export function balancePlan({ reads, crm, planner }, { today, madeLike, made }) {
  const io = { planner, made };
  const out = [];
  for (const c of reads.attachedCustomers()) {
    const mine = madeLike(`${c.uid}:`).map((m) => ({ ...m, state: planner.taskState(m.id) }));
    const open = mine.filter((m) => m.state?.open);
    const owing = owingByOrder(reads.ordersOf(c.uid), reads.moneyOf(c.uid));
    const overdue = c.gone ? [] : overdueOrders(owing, today);
    if (!overdue.length) {
      if (open.length) out.push({ action: 'finish', customer: c, open, why: c.gone ? 'Deleted in the Order Manager' : `Nothing owing over ${OVERDUE_AFTER_DAYS} days any more` });
      continue;
    }
    const account = crm.liveAccount(c.account_id);
    if (!account) continue;
    const key = `${c.uid}:${overdue[0].uid}`;
    const base = { key, customer: c, account, open, overdue, owing };
    if (open.length) {
      out.push({ ...base, action: 'update' });
      continue;
    }
    const atKey = mine.filter((m) => m.key === key);
    if (!atKey.length) {
      out.push({ ...base, action: 'create' });
      continue;
    }
    const suite = atKey.filter((m) => suiteFinished(io, m.id, m.state));
    out.push(suite.length ? { ...base, action: 'reopen', id: suite[suite.length - 1].id } : { ...base, action: 'handled' });
  }
  return out;
}

// ---- 3. ready to ship --------------------------------------------------------------------------

/** Is the order in an event waiting to go out: active, not deleted, packed and not shipped? */
export function readyToShip(event) {
  if (event.name === 'order.deleted') return false;
  const o = event.data?.order;
  return Boolean(o) && o.status === 'active' && o.packing?.state === 'packed';
}

/**
 * The order as it is NOW in the holding area — the events of one request are all applied before any
 * is emitted, so a catch-up batch with "packed" then "shipped" must not make (and at once finish) a
 * ship task from the first one's snapshot. Falls back to the event when the order isn't held.
 * → { ready, order (snapshot), customerUid, event (event-shaped, for whyNotWaiting) }
 */
export function currentOrder(reads, data) {
  const h = data.orderUid ? reads.order(data.orderUid) : null;
  if (!h) return { ready: readyToShip(data), order: data.data?.order ?? null, customerUid: data.customerUid ?? null, event: data };
  const order = h.snap ?? data.data?.order ?? null;
  const ready = !h.deleted && h.status === 'active' && order?.packing?.state === 'packed';
  return {
    ready, order, customerUid: h.customer_uid,
    event: { ...data, name: h.deleted ? 'order.deleted' : data.name, data: { ...(data.data ?? {}), order } },
  };
}

const SHIPPED_VIA = { eshipper: 'eShipper', delivered: 'delivered', picked_up: 'picked up', bulk: 'marked shipped in bulk', other: 'other' };

/** Why an open ship task is finished, in plain English, from the event that ended it. */
export function whyNotWaiting(event) {
  const d = event.data ?? {};
  const state = d.order?.packing?.state;
  if (event.name === 'order.deleted') return 'Deleted in the Order Manager';
  if (event.name === 'order.cancelled' || d.order?.status === 'cancelled') return 'Cancelled in the Order Manager';
  if (event.name === 'order.shipped' || state === 'shipped') {
    const via = d.via ?? d.order?.packing?.shipped_via;
    return `Shipped in the Order Manager${via ? ` (${SHIPPED_VIA[via] ?? via})` : ''}`;
  }
  if (state === 'check_again') return 'Changed in the Order Manager — check again';
  if (d.change === 'unpacked') return 'Unpacked in the Order Manager (no longer ready to ship)';
  if (d.change === 'put_back') return 'Put back in the Order Manager';
  return `No longer packed in the Order Manager (${state ?? 'unknown'})`;
}

/** The ship task's title and notes from the order as it is (no run date in them: they change only with the order). */
function shipTask(deps, o, customer, account) {
  const name = customer ? nameFor(deps, account, customer) : account.name;
  const items = (Array.isArray(o.lines) ? o.lines : []).map((l) => `${l.quantity} × ${l.name ?? l.sku ?? 'Item'}`).join(', ');
  const packedBy = o.packing?.packed_by ? ` by ${o.packing.packed_by}` : '';
  const notes = [
    `Packed in the Order Manager${packedBy}${o.packing?.packed_at ? ` (${dayText(localDate(new Date(o.packing.packed_at)))})` : ''}.`,
    `Order #${o.number ?? '?'}${o.reference_number ? ` · ${o.reference_number}` : ''} from ${dayText(o.order_date)}: ${money(o.totals?.total_cents ?? 0)}.`,
    ...(items ? [clip(items, 1500)] : []),
    ...(o.notes ? [`Order notes: ${clip(String(o.notes), 1000)}`] : []),
    'The suite finishes this task when the Order Manager says the order shipped, or was cancelled, deleted or changed.',
  ].join('\n');
  return { title: clip(`Ship order #${o.number ?? '?'} for ${name}`, TITLE_MAX), notes };
}

// ---- registration --------------------------------------------------------------------------------

/**
 * Register the three automations. `reads` is the wholesale service's holding-area reads; `crm`
 * and `planner` their services.
 */
export function registerWholesaleAutomations({ automations, planner, crm, reads }) {
  const deps = { reads, crm, planner };
  const attachedUids = () => new Set(reads.attachedCustomers().map((c) => c.uid));

  automations.register({
    id: CHECK_IN_ID,
    name: 'Wholesale check-ins',
    module: 'wholesale',
    description: 'For each linked Order Manager regular (4+ ordering days, usually ordering at least every 90 days) who has gone clearly '
      + 'longer than usual without ordering — more than 1.5 × their usual gap and more than the usual gap + 7 days — makes '
      + '“Check in with … ” due today for the wholesale business’s default owner. Once per quiet spell (a new order starts a new one, and '
      + 'finishes a check-in still open; if that order is cancelled the check-in comes back); at most 10 a day, most overdue first; '
      + 'nothing for closed clients.',
    trigger: { type: 'schedule', every: 'day', at: '07:40' },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, { now, today, made, madeLike, remember, create, update }) {
      const io = { planner, made, madeLike, remember, update };
      const business = crm.getBusiness(W);
      const { due, finish, reopen, handled } = checkInPlan(deps, { today, made, madeLike });
      let finished = 0;
      for (const f of finish) if (finishTask(io, f.id, f.why, now)) finished += 1;
      const unlinked = finishUnlinked(io, attachedUids(), now);
      const tail = [
        finished ? `finished ${plural(finished, 'earlier check-in')}` : null,
        unlinked ? `finished ${plural(unlinked, 'check-in')} of unlinked customers` : null,
        handled ? `${plural(handled, 'quiet regular')} already handled by a person` : null,
      ].filter(Boolean).map((x) => `; ${x}`).join('');
      if (business?.archived) return { summary: `The wholesale business is archived: no new check-ins${tail}` };
      const titles = [];
      for (const d of reopen) {
        const t = checkInTask(deps, d, now);
        if (reopenTask(io, d.id, { title: t.title, why: `Quiet again: no order in ${d.days} days (usually every ${d.rhythm.usual_gap_days})` }, now, today)) titles.push(t.title);
      }
      const reopened = titles.length;
      const batch = due.slice(0, NEW_TASKS_CAP);
      const rest = due.length - batch.length;
      for (const d of batch) {
        const t = checkInTask(deps, d, now);
        const id = create('task', { ...taskBase(deps, d.account), title: t.title, notes: t.notes, due_date: today }, { key: d.key });
        markWrote(io, id, 'title', t.title);
        titles.push(t.title);
      }
      const more = rest ? `; ${rest.toLocaleString('en-CA')} more waiting (made on the next days)` : '';
      const back = reopened ? `; reopened ${plural(reopened, 'check-in')}` : '';
      if (!titles.length) return { summary: `No regular is quiet${tail}` };
      return {
        summary: `Made ${plural(batch.length, 'check-in')}${back}${more}${tail}`,
        alert: { title: `${plural(titles.length + rest, 'regular')} ${titles.length + rest === 1 ? 'has' : 'have'} gone quiet`, body: listBody(titles, rest), link: '/' },
      };
    },
  });

  automations.register({
    id: BALANCES_ID,
    name: 'Wholesale balances over 30 days',
    module: 'wholesale',
    description: 'For each linked Order Manager customer with money owing more than 30 days — worked out as the Order Manager’s '
      + 'Balances page does (all payments and store credit used pay the oldest orders first) — makes one task with a drafted email '
      + 'listing those orders and the total; the suite never sends it. The draft is kept up to date while the task is open; the suite '
      + 'finishes the task once nothing over 30 days is owed, and reopens it if money is owed again. At most 10 new a day, most owed first.',
    trigger: { type: 'schedule', every: 'day', at: '07:45' },
    defaults: { enabled: true, alert: true },
    alertLink: '/',
    run(_ctx, { now, today, made, madeLike, remember, create, update }) {
      const io = { planner, made, madeLike, remember, update };
      const businessName = crm.getBusiness(W)?.name ?? 'Wholesale';
      const plan = balancePlan(deps, { today, madeLike, made });
      const n = { finished: 0, updated: 0, unchanged: 0, reopened: 0, handled: 0 };
      const titles = [];
      const creates = [];
      const draftFor = (p) => balanceDraft({
        name: nameFor(deps, p.account, p.customer), to: recipient(deps, p.account, p.customer), overdue: p.overdue,
        creditCents: reads.figuresOf(p.customer.uid).credit_cents, businessName,
      });
      for (const p of plan) {
        if (p.action === 'finish') {
          for (const m of p.open) if (finishTask(io, m.id, p.why, now)) n.finished += 1;
          continue;
        }
        if (p.action === 'handled') {
          n.handled += 1;
          continue;
        }
        const d = draftFor(p);
        if (p.action === 'update') {
          // One open task per customer: the draft above the line kept up to date, the title too unless a
          // person changed it, and filed under the current oldest overdue order (finishing it never makes
          // another for that order).
          const t = p.open[p.open.length - 1];
          const fields = {};
          if (t.state.title !== d.title && suiteWrote(io, t.id, 'title', t.state.title)) fields.title = d.title;
          const notes = mergeNotes(t.state.notes, d.draft);
          if (notes !== null) fields.notes = notes;
          if (!made(p.key).some((m) => m.id === t.id)) remember(p.key, 'task', t.id);
          if (Object.keys(fields).length) {
            update('task', t.id, fields);
            if (fields.title) markWrote(io, t.id, 'title', fields.title);
            n.updated += 1;
            titles.push(fields.title ?? t.state.title);
          } else n.unchanged += 1;
          continue;
        }
        if (p.action === 'reopen') {
          const t = planner.taskState(p.id);
          const notes = mergeNotes(t.notes, d.draft) ?? t.notes;
          if (reopenTask(io, p.id, { title: d.title, notes, why: `Owing again: ${money(d.totalCents)} over ${OVERDUE_AFTER_DAYS} days` }, now, today)) {
            n.reopened += 1;
            titles.push(d.title);
          }
          continue;
        }
        creates.push({ p, d });
      }
      creates.sort((a, b) => b.d.totalCents - a.d.totalCents || (a.p.key < b.p.key ? -1 : 1));
      const batch = creates.slice(0, NEW_TASKS_CAP);
      const rest = creates.length - batch.length;
      for (const { p, d } of batch) {
        const id = create('task', { ...taskBase(deps, p.account), title: d.title, notes: mergeNotes(null, d.draft), due_date: today }, { key: p.key });
        markWrote(io, id, 'title', d.title);
        titles.push(d.title);
      }
      const unlinked = finishUnlinked(io, attachedUids(), now);
      const parts = [];
      if (batch.length) parts.push(`made ${plural(batch.length, 'reminder')}`);
      if (rest) parts.push(`${rest.toLocaleString('en-CA')} more waiting (made on the next days)`);
      if (n.reopened) parts.push(`reopened ${plural(n.reopened, 'reminder')} (owing again)`);
      if (n.updated) parts.push(`brought ${plural(n.updated, 'reminder')} up to date`);
      if (n.finished) parts.push(`finished ${plural(n.finished, 'reminder')}`);
      if (unlinked) parts.push(`finished ${plural(unlinked, 'reminder')} of unlinked customers`);
      if (n.unchanged) parts.push(`${plural(n.unchanged, 'reminder')} open, nothing changed`);
      if (n.handled) parts.push(`${plural(n.handled, 'balance')} owing but already handled by a person`);
      const summary = parts.length ? parts.join('; ').replace(/^./, (ch) => ch.toUpperCase()) : 'Nothing owing over 30 days';
      return titles.length
        ? { summary, alert: { title: `${plural(titles.length + rest, 'balance')} owing over ${OVERDUE_AFTER_DAYS} days`, body: listBody(titles, rest), link: '/' } }
        : { summary };
    },
  });

  /** D2: the open ship tasks this automation made for a customer's orders: [{ id, orderUid }]. */
  function openShipTasksOf(customerUid) {
    if (!customerUid) return [];
    const out = [];
    for (const o of reads.ordersOf(customerUid)) {
      for (const m of automations.made(SHIP_ID, o.uid)) if (planner.taskState(m.id)?.open) out.push({ id: m.id, orderUid: o.uid });
    }
    return out;
  }

  /** D2: a customer linked elsewhere or unlinked: its open ship tasks follow the account, or are finished. */
  function shipTasksFollowLink(io, customerUid, now) {
    const open = openShipTasksOf(customerUid);
    const customer = reads.customer(customerUid);
    const account = customer?.account_id ? crm.liveAccount(customer.account_id) : null;
    let n = 0;
    for (const t of open) {
      if (!account) {
        if (finishTask(io, t.id, 'Its customer in the Order Manager isn’t linked here any more', now)) n += 1;
        continue;
      }
      const base = taskBase(deps, account);
      const st = planner.taskState(t.id);
      const fields = {};
      if (st.clientId !== base.client_id) fields.client_id = base.client_id;
      if (st.accountId !== base.account_id) fields.account_id = base.account_id;
      if (st.relationshipId !== base.relationship_id) fields.relationship_id = base.relationship_id;
      if (!Object.keys(fields).length) continue;
      io.update('task', t.id, fields);
      n += 1;
    }
    if (!n) return { summary: 'Nothing to change' };
    return { summary: account ? `Moved ${n} ship task${n === 1 ? '' : 's'} to ${account.name}` : `Finished ${n} ship task${n === 1 ? '' : 's'}: the customer was unlinked` };
  }

  automations.register({
    id: SHIP_ID,
    name: 'Ready to ship',
    module: 'wholesale',
    description: 'When the Order Manager says an order of a linked customer was packed, makes “Ship order #N for … ” due today for the '
      + 'wholesale business’s default owner. When the order ships, is cancelled, deleted, unpacked or changed (check again), the suite '
      + 'finishes that task — it never deletes it; packed again, it is made or brought up to date. Nothing for unlinked customers '
      + '(linking one later replays nothing) or for the Order Manager’s “Send existing” catch-up.',
    trigger: {
      type: 'event',
      // D2: and 'wholesale.attachment' (a customer linked, unlinked — an undo — or moved): its open ship
      // tasks are finished (unlinked) or follow the new account at once, not at the order's next change.
      events: ['order.packed', 'order.shipped', 'order.cancelled', 'order.deleted', 'order.restored', 'order.changed', 'wholesale.attachment'],
      label: 'When the Order Manager packs an order (finished when it ships, is cancelled, deleted or changed)',
      key: (data) => data.key, // each event once: a re-delivered one is a no-op
      // Runs only when there is something to do: an order of a linked customer that is ready to ship now,
      // or an order whose ship task the suite made (to finish or refresh it). Never for backfill events.
      accept: (data) => {
        if (data.name === 'wholesale.attachment') return openShipTasksOf(data.customerUid).length > 0;
        if (data.backfill || !data.orderUid) return false;
        const cur = currentOrder(reads, data);
        if (cur.ready && reads.customer(cur.customerUid)?.account_id) return true;
        return automations.made(SHIP_ID, data.orderUid).length > 0;
      },
    },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, { now, today, data, made, madeLike, remember, create, update }) {
      if (!data) return { summary: 'Runs when the Order Manager packs an order: nothing to do now' };
      const io = { planner, made, madeLike, remember, update };
      if (data.name === 'wholesale.attachment') return shipTasksFollowLink(io, data.customerUid, now);
      const cur = currentOrder(reads, data);
      const label = `order #${cur.order?.number ?? data.data?.number ?? '?'}`;
      const open = made(data.orderUid).filter((m) => planner.taskState(m.id)?.open);
      if (!cur.ready) {
        const why = whyNotWaiting(cur.event);
        let k = 0;
        for (const m of open) if (finishTask(io, m.id, why, now)) k += 1;
        return { summary: k ? `Finished the ship task for ${label}: ${why}` : `Nothing open for ${label}` };
      }
      const customer = reads.customer(cur.customerUid);
      const account = customer?.account_id ? crm.liveAccount(customer.account_id) : null;
      if (open.length) {
        if (!account) {
          for (const m of open) finishTask(io, m.id, 'Its customer in the Order Manager isn’t linked here any more', now);
          return { summary: `Finished the ship task for ${label}: its customer isn’t linked` };
        }
        // Packed again (after a change, or for another customer): bring it up to date — the person's own
        // title or notes are left alone.
        const t = shipTask(deps, cur.order, customer, account);
        const base = taskBase(deps, account);
        let refreshed = 0;
        for (const m of open) {
          const st = planner.taskState(m.id);
          const fields = {};
          if (st.title !== t.title && suiteWrote(io, m.id, 'title', st.title)) fields.title = t.title;
          if (st.notes !== t.notes && suiteWrote(io, m.id, 'notes', st.notes)) fields.notes = t.notes;
          if (st.clientId !== base.client_id) fields.client_id = base.client_id;
          if (st.accountId !== base.account_id) fields.account_id = base.account_id;
          if (st.relationshipId !== base.relationship_id) fields.relationship_id = base.relationship_id;
          if (!Object.keys(fields).length) continue;
          update('task', m.id, fields);
          if (fields.title) markWrote(io, m.id, 'title', fields.title);
          if (fields.notes) markWrote(io, m.id, 'notes', fields.notes);
          refreshed += 1;
        }
        return { summary: refreshed ? `Brought the ship task for ${label} up to date` : `The ship task for ${label} is already open` };
      }
      if (!account) return { summary: `${label} isn’t a linked customer’s: nothing made` };
      const t = shipTask(deps, cur.order, customer, account);
      const id = create('task', { ...taskBase(deps, account), title: t.title, notes: t.notes, due_date: today }, { key: data.orderUid });
      markWrote(io, id, 'title', t.title);
      markWrote(io, id, 'notes', t.notes);
      return { summary: `Made “${t.title}”`, alert: { title: t.title, body: t.notes.split('\n')[1] ?? null, link: '/' } };
    },
  });
}
