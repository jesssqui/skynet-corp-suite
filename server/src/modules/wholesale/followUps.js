// Follow-ups from the Order Manager (D5): a linked customer's follow-up date there (A11's
// followup.changed — a state, held on the customer) becomes ONE open task "Follow up with <account>"
// due that day, for the wholesale business's default owner, with the client, account and wholesale
// relationship. Registered with the automations framework (C8) as an event automation; like D3's it
// only makes or changes tasks — nothing is sent anywhere, and finishing the task here changes nothing
// in the Order Manager (one way: its notes say so).
//
// Decided on the customer as it is NOW in the holding area (as D3's ship task is), whatever the event:
//   followup.changed         date set → task made (or moved); cleared → finished ("Done in the Order
//                            Manager" when done: true, else "Cleared in the Order Manager")
//   customer.created/updated deleted there → finished ("Deleted in the Order Manager") and its held date cleared
//                            (the Order Manager forgets it too); back → a NEW task once it sends a date again
//   wholesale.attachment     linked → made (or reopened); unlinked → finished; moved → client/account follow
//   wholesale.check          at start (after a restore too) and Run now: every customer with a follow-up
//                            date or an open follow-up task is checked
// Backfill events DO count (unlike D3's): a follow-up date is the current state, which the owner wants
// to see; replays can't duplicate (one open task per customer, keys below).
//
// Keys (automations_made, "<customer uid>:<episode>:<date>"): the held customer's follow_up_episode
// counts the times a date was set where there was none, so
//   - the same follow-up sent again (a replay, "Send existing", a restore) finds its task: never a second;
//   - a task a PERSON finished or deleted isn't made again for that date (their call), but a new date
//     (moved there) or a new follow-up after a done one is a new task;
//   - a task the SUITE finished because its customer was unlinked is reopened when it is linked again
//     (same key) — with its due date put back only if the suite set the current one. A customer deleted
//     there and back is a NEW follow-up: deleting clears the held date, so the date sent again is a new
//     episode and a new task (the finished one stays finished).
// While a task is open it is the one kept up to date: a new date moves its due date — only while the due
// date is still the one the suite set (D3's "what the suite wrote"); a person's own day is kept and a
// line in the notes says the Order Manager's date changed.
import { localDate } from '@suite/shared/time';
import {
  CUSTOMER_KEY, nameFor, taskBase, markWrote, suiteWrote, suiteFinished, finishTask, dayText, plural,
} from './automations.js';

export const FOLLOW_UP_ID = 'wholesale-follow-ups';
export const FOLLOW_UP_EVENTS = Object.freeze(['followup.changed', 'customer.created', 'customer.updated', 'wholesale.attachment', 'wholesale.check']);
const TITLE_MAX = 300;
const LIST_MAX = 5;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** The key a follow-up's task is filed under: customer, episode, date. */
export const followUpKey = (c) => `${c.uid}:${c.follow_up_episode ?? 0}:${c.follow_up_date}`;
const toldKey = (id, date) => `told:${id}:${date}`;

/** The task's title and notes (no dates in the notes: the task's day is the date, so they change only with the account). */
export function followUpTask(deps, c, account) {
  const name = nameFor(deps, account, c);
  const who = c.business_name && c.business_name !== account.name ? `${c.business_name}, ` : '';
  const notes = [
    `A follow-up set in the Order Manager (${who}customer #${c.number ?? '?'}).`,
    'Mark it done in the Order Manager too: finishing this task here doesn’t change anything there (follow-ups only come from '
      + 'the Order Manager to the suite).',
    'When the date changes there, this task moves with it; when it is marked done or cleared there, the suite finishes this task.',
    `Client: /crm/clients/${account.client_id}`,
  ].join('\n');
  return { title: clip(`Follow up with ${name}`, TITLE_MAX), notes };
}

/**
 * What to do for one customer now (pure over the reads and what the automation made):
 *  none | handled (a person finished or deleted the task for this follow-up) | create | update (the
 *  open task: due date, title, notes, client/account/relationship, filed under the current key) |
 *  finish (no follow-up wanted any more: cleared, done, unlinked, deleted there) | reopen (a task the
 *  suite finished, for this same follow-up: linked again, back in the Order Manager).
 */
export function followUpPlan(deps, uid, { made, madeLike }) {
  const { reads, crm, planner } = deps;
  const io = { planner, made };
  const c = uid ? reads.customer(uid) : null;
  if (!c) return { action: 'none', uid };
  const rows = madeLike(`${uid}:`).map((m) => ({ ...m, state: planner.taskState(m.id) }));
  const open = [];
  for (const r of rows) if (r.state?.open && !open.some((o) => o.id === r.id)) open.push(r);
  const account = c.account_id ? crm.liveAccount(c.account_id) : null;
  if (!account || c.gone || !c.follow_up_date) {
    if (!open.length) return { action: 'none', uid };
    let why = 'Cleared in the Order Manager';
    if (c.gone) why = 'Deleted in the Order Manager';
    else if (!account) why = 'Unlinked from the Order Manager customer';
    else if (c.follow_up_done) why = 'Done in the Order Manager';
    return { action: 'finish', uid, customer: c, ids: open.map((o) => o.id), why, title: open[open.length - 1].state.title };
  }
  const date = c.follow_up_date;
  const key = followUpKey(c);
  const t = followUpTask(deps, c, account);
  const base = taskBase(deps, account);
  const refs = (st) => {
    const out = {};
    if (st.clientId !== base.client_id) out.client_id = base.client_id;
    if (st.accountId !== base.account_id) out.account_id = base.account_id;
    if (st.relationshipId !== base.relationship_id) out.relationship_id = base.relationship_id;
    return out;
  };
  if (open.length) {
    // Never a second open one: the newest open task is the one kept up to date.
    const task = open[open.length - 1];
    const st = task.state;
    const fields = refs(st);
    let told = false;
    if (st.dueDate !== date) {
      if (suiteWrote(io, task.id, 'due_date', st.dueDate)) fields.due_date = date;
      else if (!made(toldKey(task.id, date)).length) told = true; // a person's own day: kept, and told once
    }
    if (st.title !== t.title && suiteWrote(io, task.id, 'title', st.title)) fields.title = t.title;
    if (st.notes !== t.notes && suiteWrote(io, task.id, 'notes', st.notes)) fields.notes = t.notes;
    if (told) {
      const line = `The follow-up date in the Order Manager is now ${dayText(date)} (this task keeps the day you gave it).`;
      const notes = fields.notes ?? st.notes;
      fields.notes = notes ? `${notes}\n\n${line}` : line;
    }
    const file = !rows.some((r) => r.key === key && r.id === task.id);
    if (!Object.keys(fields).length && !file) return { action: 'none', uid };
    return { action: 'update', uid, customer: c, key, id: task.id, fields, told, file, date, title: fields.title ?? st.title };
  }
  const atKey = rows.filter((r) => r.key === key);
  if (!atKey.length) {
    return { action: 'create', uid, customer: c, key, date, title: t.title, fields: { ...base, title: t.title, notes: t.notes, due_date: date } };
  }
  const mine = atKey.filter((r) => suiteFinished(io, r.id, r.state));
  if (!mine.length) return { action: 'handled', uid };
  const id = mine[mine.length - 1].id;
  const st = mine[mine.length - 1].state;
  const fields = { ...refs(st), done_at: null };
  // The due date goes back to the Order Manager's only while it is still the one the suite set: a day the
  // person gave the task is kept (as in the update branch).
  const keepDay = st.dueDate !== date && !suiteWrote(io, id, 'due_date', st.dueDate);
  if (st.dueDate !== date && !keepDay) fields.due_date = date;
  if (st.title !== t.title && suiteWrote(io, id, 'title', st.title)) fields.title = t.title;
  return { action: 'reopen', uid, customer: c, key, id, fields, date, keepDay, title: fields.title ?? st.title, notes: st.notes };
}

/** Plans that change something (accept() runs the automation only for these). */
export const actionable = (p) => ['create', 'update', 'finish', 'reopen'].includes(p.action);

/**
 * Register the automation. `reads` = the wholesale service's holding-area reads (customer,
 * customersWithFollowUp, attachedOn); `crm`, `planner` their services.
 */
export function registerFollowUpAutomation({ automations, planner, crm, reads }) {
  const deps = { reads, crm, planner };
  const outside = {
    made: (key) => automations.made(FOLLOW_UP_ID, key),
    madeLike: (prefix) => automations.madeLike(FOLLOW_UP_ID, prefix),
  };
  /** Customers to look at when no one is named: a follow-up date held, or an open follow-up task. */
  const candidates = ({ madeLike }) => {
    const uids = new Set(reads.customersWithFollowUp());
    for (const m of madeLike('')) {
      const uid = CUSTOMER_KEY.exec(m.key)?.[1];
      if (uid && !uids.has(uid) && planner.taskState(m.id)?.open) uids.add(uid);
    }
    return [...uids];
  };
  const uidsOf = (data, io) => (data?.customerUid ? [data.customerUid] : candidates(io));

  automations.register({
    id: FOLLOW_UP_ID,
    name: 'Order Manager follow-ups',
    module: 'wholesale',
    description: 'When a linked Order Manager customer has a follow-up date there, makes one task “Follow up with … ” due that day for '
      + 'the wholesale business’s default owner. A new date there moves it (unless you gave the task another day); marked done or '
      + 'cleared there, the suite finishes it; unlinking or deleting the customer finishes it too, and linking it later brings it '
      + 'back. One way: finishing the task doesn’t change the Order Manager. Run now checks every customer.',
    trigger: {
      type: 'event',
      events: [...FOLLOW_UP_EVENTS],
      label: 'When a follow-up date changes in the Order Manager, or its customer is linked or unlinked here',
      key: (data) => data.key, // each event once
      // Only when the customer's task would change: no run rows for the thousands of other events.
      accept: (data) => uidsOf(data, outside).some((uid) => actionable(followUpPlan(deps, uid, outside))),
    },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, { now, data, made, madeLike, remember, create, update }) {
      const io = { planner, made, madeLike, remember, update };
      const today = localDate(now);
      const did = { made: [], moved: [], finished: [], reopened: [], updated: [] };
      let handled = 0;
      for (const uid of uidsOf(data, { madeLike })) {
        const p = followUpPlan(deps, uid, { made, madeLike });
        if (p.action === 'handled') handled += 1;
        if (p.action === 'create') {
          const id = create('task', p.fields, { key: p.key });
          markWrote(io, id, 'title', p.fields.title);
          markWrote(io, id, 'notes', p.fields.notes);
          markWrote(io, id, 'due_date', p.date);
          did.made.push(`${p.title} (${dayText(p.date)})`);
        } else if (p.action === 'update') {
          if (Object.keys(p.fields).length) update('task', p.id, p.fields);
          for (const f of ['title', 'notes', 'due_date']) if (p.fields[f] !== undefined && !(f === 'notes' && p.told)) markWrote(io, p.id, f, p.fields[f]);
          if (p.told) remember(`told:${p.id}:${p.date}`, 'task', p.id);
          if (p.file) remember(p.key, 'task', p.id);
          (p.fields.due_date ? did.moved : did.updated).push(`${p.title}${p.fields.due_date ? ` → ${dayText(p.date)}` : ''}`);
        } else if (p.action === 'finish') {
          let k = 0;
          for (const id of p.ids) if (finishTask(io, id, p.why, now)) k += 1;
          if (k) did.finished.push(`${p.title}: ${p.why}`);
        } else if (p.action === 'reopen') {
          const line = `The follow-up on ${dayText(p.date)} is open in the Order Manager${p.keepDay ? ' (this task keeps the day you gave it)' : ''}`
            + ` — reopened by the suite on ${dayText(today)}.`;
          update('task', p.id, { ...p.fields, notes: p.notes ? `${p.notes}\n\n${line}` : line });
          if (p.fields.title) markWrote(io, p.id, 'title', p.fields.title);
          if (p.fields.due_date) markWrote(io, p.id, 'due_date', p.fields.due_date);
          if (p.keepDay) remember(`told:${p.id}:${p.date}`, 'task', p.id);
          did.reopened.push(`${p.title} (${dayText(p.date)})`);
        }
      }
      const lines = [
        ...did.made.map((x) => `Made “${x}”`), ...did.moved.map((x) => `Moved ${x}`), ...did.reopened.map((x) => `Reopened ${x}`),
        ...did.updated.map((x) => `Brought “${x}” up to date`), ...did.finished.map((x) => `Finished ${x}`),
      ];
      const tail = handled ? `${plural(handled, 'follow-up')} already handled by a person` : null;
      if (!lines.length) return { summary: tail ? `Nothing to change; ${tail}` : 'Nothing to change' };
      const summary = lines.length <= 3
        ? [...lines, ...(tail ? [tail] : [])].join('; ')
        : [
          did.made.length && `made ${did.made.length}`, did.moved.length && `moved ${did.moved.length}`, did.reopened.length && `reopened ${did.reopened.length}`,
          did.updated.length && `brought ${did.updated.length} up to date`, did.finished.length && `finished ${did.finished.length}`, tail,
        ].filter(Boolean).join('; ').replace(/^./, (ch) => ch.toUpperCase());
      const shown = lines.slice(0, LIST_MAX);
      return {
        summary,
        alert: {
          title: lines.length === 1 ? lines[0] : `${plural(lines.length, 'follow-up')} changed in the Order Manager`,
          body: [...shown, ...(lines.length > shown.length ? [`and ${lines.length - shown.length} more`] : [])].join('\n'),
          link: '/',
        },
      };
    },
  });
}
