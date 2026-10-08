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
//                             <account>"; finished by the suite when it ships, is cancelled or deleted
//
// Every task goes to the wholesale business's default owner (planner.automatedOwnerFor), on the
// wholesale business, with the client, account and (when there is one) the account's wholesale
// relationship. Only customers linked to an account (attached) are looked at. See CLAUDE.md,
// "Wholesale automations (D3)".
import { BUSINESS_IDS } from '@suite/shared/crm';
import { parseLocalDate, localDate } from '@suite/shared/time';
import { orderRhythm, isQuiet, daysBetween, owingByOrder, overdueOrders, OVERDUE_AFTER_DAYS } from './figures.js';

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

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
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
function nameFor({ reads }, account, c) {
  const own = c.business_name || (c.number ? `customer #${c.number}` : null);
  return reads.attachedOn(account.id) > 1 && own ? `${account.name} (${own})` : account.name;
}

/** The fields every wholesale task shares: business, owner, client, account, relationship. */
function taskBase({ crm, planner }, account) {
  return {
    owner: planner.automatedOwnerFor(W),
    business_id: W,
    client_id: account.client_id,
    account_id: account.id,
    relationship_id: wholesaleRelationship(crm, account.id),
  };
}

/** Finish one of the suite's own tasks (done_at), adding a line to its notes that says why. */
function finishTask({ planner, update }, id, why, now) {
  const t = planner.taskState(id);
  if (!t?.open) return false;
  const line = `${why} — finished by the suite on ${dayText(localDate(now))}.`;
  update('task', id, { done_at: now.toISOString(), notes: t.notes ? `${t.notes}\n\n${line}` : line });
  return true;
}

// ---- 1. check-ins --------------------------------------------------------------------------

/**
 * What the check-in automation would do on `today`: the quiet regulars to make a task for (most
 * overdue first), and the open check-ins of an earlier quiet spell to finish (they ordered since).
 * Pure over the reads, so the run and the tests share it.
 */
export function checkInPlan({ reads, crm, planner }, { today, madeLike, made }) {
  const due = [];
  const finish = [];
  for (const c of reads.attachedCustomers()) {
    const orders = reads.ordersOf(c.uid);
    const r = orderRhythm(orders);
    const key = `${c.uid}:${r.last_order_uid}`;
    // A check-in made for an earlier quiet spell that is still open: they have ordered since (or
    // that spell's last order was cancelled or deleted, so it is another spell now).
    for (const m of madeLike(`${c.uid}:`)) {
      if (m.key === key || !planner.taskState(m.id)?.open) continue;
      const was = orders.find((o) => o.uid === m.key.slice(c.uid.length + 1));
      const last = orders.find((o) => o.uid === r.last_order_uid);
      const why = last && (!was || (last.order_date ?? '') > (was.order_date ?? ''))
        ? `Ordered again (order #${last.number ?? '?'} on ${dayText(last.order_date)})`
        : 'Their last order changed in the Order Manager';
      finish.push({ id: m.id, customer: c, rhythm: r, why });
    }
    if (c.gone || !isQuiet(r, today)) continue;
    if (made(key).length) continue; // once per quiet spell, even when that task was finished or deleted
    const account = crm.liveAccount(c.account_id);
    if (!account || account.client_status !== 'active') continue; // a closed client: no next steps
    due.push({ key, customer: c, account, rhythm: r, days: daysBetween(r.last_order_date, today) });
  }
  due.sort((a, b) => (b.days - b.rhythm.quiet_after_days) - (a.days - a.rhythm.quiet_after_days) || (a.key < b.key ? -1 : 1));
  return { due, finish };
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

/** What the balance automation would do on `today` (pure over the reads). */
export function balancePlan({ reads, crm, planner }, { today, madeLike }) {
  const out = [];
  for (const c of reads.attachedCustomers()) {
    const mine = madeLike(`${c.uid}:`).map((m) => ({ ...m, state: planner.taskState(m.id) }));
    const open = mine.filter((m) => m.state?.open);
    const owing = owingByOrder(reads.ordersOf(c.uid), reads.moneyOf(c.uid));
    const overdue = c.gone ? [] : overdueOrders(owing, today);
    if (!overdue.length) {
      if (open.length) out.push({ action: 'finish', customer: c, open });
      continue;
    }
    const account = crm.liveAccount(c.account_id);
    if (!account) continue;
    out.push({ action: open.length ? 'update' : 'create', key: `${c.uid}:${overdue[0].uid}`, customer: c, account, open, overdue, owing });
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
  if (d.change === 'unpacked') return 'Unpacked in the Order Manager (no longer ready to ship)';
  if (d.change === 'put_back') return 'Put back in the Order Manager';
  return `No longer packed in the Order Manager (${state ?? 'unknown'})`;
}

function shipTask(deps, data, account, now) {
  const o = data.data.order;
  const c = deps.reads.customer(data.customerUid);
  const name = c ? nameFor(deps, account, c) : account.name;
  const items = (Array.isArray(o.lines) ? o.lines : []).map((l) => `${l.quantity} × ${l.name ?? l.sku ?? 'Item'}`).join(', ');
  const packedBy = o.packing?.packed_by ? ` by ${o.packing.packed_by}` : '';
  const notes = [
    `Packed in the Order Manager${packedBy}${o.packing?.packed_at ? ` (${dayText(localDate(new Date(o.packing.packed_at)))})` : ''}.`,
    `Order #${o.number ?? '?'}${o.reference_number ? ` · ${o.reference_number}` : ''} from ${dayText(o.order_date)}: ${money(o.totals?.total_cents ?? 0)}.`,
    ...(items ? [clip(items, 1500)] : []),
    ...(o.notes ? [`Order notes: ${clip(String(o.notes), 1000)}`] : []),
    'The suite finishes this task when the Order Manager says the order shipped, or was cancelled or deleted.',
    `Prepared by the suite on ${dayText(localDate(now))}.`,
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

  automations.register({
    id: CHECK_IN_ID,
    name: 'Wholesale check-ins',
    module: 'wholesale',
    description: 'For each linked Order Manager regular (4+ ordering days, usually ordering at least every 90 days) who has gone clearly '
      + 'longer than usual without ordering — more than 1.5 × their usual gap and more than the usual gap + 7 days — makes '
      + '“Check in with … ” due today for the wholesale business’s default owner. Once per quiet spell (a new order starts a new one, and '
      + 'finishes a check-in still open); at most 10 a day, most overdue first; nothing for closed clients.',
    trigger: { type: 'schedule', every: 'day', at: '07:40' },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, { now, today, made, madeLike, create, update }) {
      const business = crm.getBusiness(W);
      const { due, finish } = checkInPlan(deps, { today, made, madeLike });
      let finished = 0;
      for (const f of finish) {
        if (finishTask({ planner, update }, f.id, f.why, now)) finished += 1;
      }
      const ordered = finished ? `; finished ${plural(finished, 'earlier check-in')} (a newer order)` : '';
      if (business?.archived) return { summary: `The wholesale business is archived: no new check-ins${ordered}` };
      const batch = due.slice(0, NEW_TASKS_CAP);
      const rest = due.length - batch.length;
      const titles = [];
      for (const d of batch) {
        const t = checkInTask(deps, d, now);
        create('task', { ...taskBase(deps, d.account), title: t.title, notes: t.notes, due_date: today }, { key: d.key });
        titles.push(t.title);
      }
      const more = rest ? `; ${rest.toLocaleString('en-CA')} more waiting (made on the next days)` : '';
      if (!titles.length) return { summary: `No regular is quiet${ordered}` };
      return {
        summary: `Made ${plural(titles.length, 'check-in')}${more}${ordered}`,
        alert: { title: `${plural(titles.length + rest, 'regular')} ${titles.length + rest === 1 ? 'has' : 'have'} gone quiet`, body: listBody(titles, rest), link: '/' },
      };
    },
  });

  automations.register({
    id: BALANCES_ID,
    name: 'Wholesale balances over 30 days',
    module: 'wholesale',
    description: 'For each linked Order Manager customer with money owing on orders more than 30 days old (the Order Manager’s balance: '
      + 'order total less payments and store credit used), makes one task with a drafted email listing those orders and the total — '
      + 'the suite never sends it. The draft is kept up to date while the task is open, and the suite finishes the task once nothing '
      + 'over 30 days is owed. At most 10 new a day, most owed first.',
    trigger: { type: 'schedule', every: 'day', at: '07:45' },
    defaults: { enabled: true, alert: true },
    alertLink: '/',
    run(_ctx, { now, today, made, madeLike, remember, create, update }) {
      const businessName = crm.getBusiness(W)?.name ?? 'Wholesale';
      const plan = balancePlan(deps, { today, madeLike });
      let finished = 0;
      let updated = 0;
      let unchanged = 0;
      const titles = [];
      const creates = [];
      for (const p of plan) {
        if (p.action === 'finish') {
          for (const m of p.open) if (finishTask({ planner, update }, m.id, `Nothing owing over ${OVERDUE_AFTER_DAYS} days any more`, now)) finished += 1;
          continue;
        }
        const name = nameFor(deps, p.account, p.customer);
        const credit = reads.figuresOf(p.customer.uid).credit_cents;
        const d = balanceDraft({ name, to: recipient(deps, p.account, p.customer), overdue: p.overdue, creditCents: credit, businessName });
        if (p.action === 'update') {
          // One open task per customer: brought up to date (title, the draft above the line) and filed
          // under the current oldest unpaid order too, so finishing it never makes another for that order.
          const t = p.open[p.open.length - 1];
          const fields = {};
          if (t.state.title !== d.title) fields.title = d.title;
          const notes = mergeNotes(t.state.notes, d.draft);
          if (notes !== null) fields.notes = notes;
          if (!made(p.key).some((m) => m.id === t.id)) remember(p.key, 'task', t.id);
          if (Object.keys(fields).length) {
            update('task', t.id, fields);
            updated += 1;
            titles.push(d.title);
          } else unchanged += 1;
          continue;
        }
        if (made(p.key).length) continue; // once per oldest unpaid order (a finished or deleted one isn't made again)
        creates.push({ p, d });
      }
      creates.sort((a, b) => b.d.totalCents - a.d.totalCents || (a.p.key < b.p.key ? -1 : 1));
      const batch = creates.slice(0, NEW_TASKS_CAP);
      const rest = creates.length - batch.length;
      for (const { p, d } of batch) {
        create('task', { ...taskBase(deps, p.account), title: d.title, notes: mergeNotes(null, d.draft), due_date: today }, { key: p.key });
        titles.push(d.title);
      }
      const parts = [];
      if (batch.length) parts.push(`made ${plural(batch.length, 'reminder')}`);
      if (rest) parts.push(`${rest.toLocaleString('en-CA')} more waiting (made on the next days)`);
      if (updated) parts.push(`brought ${plural(updated, 'reminder')} up to date`);
      if (finished) parts.push(`finished ${plural(finished, 'reminder')} (paid)`);
      if (unchanged) parts.push(`${plural(unchanged, 'reminder')} open, nothing changed`);
      const summary = parts.length ? parts.join('; ').replace(/^./, (ch) => ch.toUpperCase()) : 'Nothing owing over 30 days';
      return titles.length
        ? { summary, alert: { title: `${plural(titles.length + rest, 'balance')} owing over ${OVERDUE_AFTER_DAYS} days`, body: listBody(titles, rest), link: '/' } }
        : { summary };
    },
  });

  automations.register({
    id: SHIP_ID,
    name: 'Ready to ship',
    module: 'wholesale',
    description: 'When the Order Manager says an order of a linked customer was packed, makes “Ship order #N for … ” due today for the '
      + 'wholesale business’s default owner. When the order ships, is cancelled or deleted (or is unpacked), the suite finishes that '
      + 'task — it never deletes it. Nothing for unlinked customers (linking one later replays nothing) or for the Order Manager’s '
      + '“Send existing” catch-up.',
    trigger: {
      type: 'event',
      events: ['order.packed', 'order.shipped', 'order.cancelled', 'order.deleted', 'order.restored'],
      label: 'When the Order Manager packs an order (finished when it ships, is cancelled or deleted)',
      key: (data) => data.key, // each event once: a re-delivered one is a no-op
      // Runs only when there is something to do: a packed order of a linked customer, or an order
      // whose ship task the suite made (to finish it). Never for backfill events.
      accept: (data) => {
        if (data.backfill || !data.orderUid) return false;
        if (readyToShip(data)) return data.linked;
        return automations.made(SHIP_ID, data.orderUid).length > 0;
      },
    },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, { now, today, data, made, create, update }) {
      if (!data) return { summary: 'Runs when the Order Manager packs an order: nothing to do now' };
      const o = data.data?.order;
      const label = `order #${o?.number ?? data.data?.number ?? '?'}`;
      const open = made(data.orderUid).filter((m) => planner.taskState(m.id)?.open);
      if (!readyToShip(data)) {
        const why = whyNotWaiting(data);
        let n = 0;
        for (const m of open) if (finishTask({ planner, update }, m.id, why, now)) n += 1;
        return { summary: n ? `Finished the ship task for ${label}: ${why}` : `Nothing open for ${label}` };
      }
      if (open.length) return { summary: `The ship task for ${label} is already open` };
      const account = data.linked ? crm.liveAccount(data.accountId) : null;
      if (!account) return { summary: `${label} isn’t a linked customer’s: nothing made` };
      const t = shipTask(deps, data, account, now);
      create('task', { ...taskBase(deps, account), title: t.title, notes: t.notes, due_date: today }, { key: data.orderUid });
      return { summary: `Made “${t.title}”`, alert: { title: t.title, body: t.notes.split('\n')[1] ?? null, link: '/' } };
    },
  });
}
