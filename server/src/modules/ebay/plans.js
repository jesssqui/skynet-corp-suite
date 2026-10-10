// What the eBay automations would do (D13), worked out from what the last pull stored and what each automation made
// before — pure over its inputs, so `accept` and `run` decide the same way. Tasks on Save Point Shop, for its default
// owner. "Who finished it decides" (../automations/taskBook.js): a task a person finished or deleted is final for its
// subject; one the suite finished is reopened when its subject comes back; the suite rewrites a title, notes or due
// date only while it is still the one it wrote. Nothing here reads or keeps a buyer's details.
import { BUSINESS_IDS } from '@suite/shared/crm';
import { localDateIn, salesMoney } from '@suite/shared/sales';
import { addDays } from '@suite/shared/planner';
import { markWrote, suiteWrote, suiteFinished, finishTask, dayText } from '../automations/taskBook.js';
import { shipEndedWhy } from './figures.js';

export const SAVE_POINT = BUSINESS_IDS.save_point;
/** New ship tasks a run (they run after every hourly pull): the rest come with the next pulls, earliest ship-by first. */
export const SHIP_CAP = 25;
/** The sign-in reminder comes this many days before the refresh token lapses. */
export const SIGN_IN_LEAD_DAYS = 30;
const TITLE_MAX = 300;
const NOTES_MAX = 20_000;
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/** The order's page in Seller Hub (eBay.ca). */
export const orderLink = (orderId) => `https://www.ebay.ca/sh/ord/details?orderid=${encodeURIComponent(orderId)}`;

/** One waiting order as a task's subject: title, notes (items, total, ship-by, link — no buyer), due its ship-by day. */
export function shipItem(o, { timeZone, today }) {
  const qty = o.items.reduce((a, i) => a + i.quantity, 0);
  const due = o.ship_by ? localDateIn(timeZone, new Date(o.ship_by)) : today;
  const lines = o.items.slice(0, 60).map((i) => `• ${i.quantity} × ${i.title}${i.sku ? ` (${i.sku})` : ''}`);
  if (o.items.length > 60) lines.push(`…and ${o.items.length - 60} more lines (see eBay)`);
  const notes = clip([
    `eBay order ${o.order_id}${o.created_at ? `, placed ${dayText(localDateIn(timeZone, new Date(o.created_at)))}` : ''}${o.status === 'IN_PROGRESS' ? ' (part shipped)' : ''}.`,
    ...lines,
    o.total ? `Order total: ${salesMoney(o.total, o.currency ?? 'CAD')}${o.currency && o.currency !== 'CAD' ? ` ${o.currency}` : ''}.` : null,
    o.ship_by ? `Ship by ${dayText(due)}.` : 'No ship-by date from eBay.',
    `Open it in Seller Hub: ${orderLink(o.order_id)}`,
    '',
    'Mark it shipped on eBay (with tracking). The suite finishes this task when eBay shows it shipped or cancelled. '
      + 'The buyer’s name and address aren’t kept here: see them on eBay.',
  ].filter((l) => l !== null).join('\n'), NOTES_MAX);
  return {
    key: `order:${o.order_id}`, title: clip(`Ship eBay order ${o.order_id}: ${plural(qty, 'item')}`, TITLE_MAX), notes, due, order: o.ship_by ?? '9999',
  };
}

/** The open tasks an automation made under keys starting with `prefix`: Map key → [{ id, state }]. */
function openByKey(madeLike, planner, prefix) {
  const out = new Map();
  const seen = new Set();
  for (const m of madeLike(prefix)) {
    if (seen.has(`${m.key}|${m.id}`)) continue;
    seen.add(`${m.key}|${m.id}`);
    const state = planner.taskState(m.id);
    if (!state?.open) continue;
    out.set(m.key, [...(out.get(m.key) ?? []), { id: m.id, state }]);
  }
  return out;
}

/**
 * Tasks for the items listed now (create / bring up to date / reopen one the suite finished / leave one a person
 * handled), and finish the open ones whose subject isn't listed any more (`goneWhy(key)`). Same shape as D16's.
 */
export function keyedPlan({ prefix, items, goneWhy, today, made, madeLike, planner, owner }) {
  const io = { planner, made };
  const open = openByKey(madeLike, planner, prefix);
  const listed = new Set(items.map((i) => i.key));
  const plan = [];
  for (const item of items) {
    const tasks = open.get(item.key) ?? [];
    if (tasks.length) {
      const { id, state: st } = tasks[tasks.length - 1];
      const fields = {};
      if (item.title !== st.title && suiteWrote(io, id, 'title', st.title)) fields.title = item.title;
      if (item.notes !== st.notes && suiteWrote(io, id, 'notes', st.notes)) fields.notes = item.notes;
      if (item.due && st.dueDate !== item.due && suiteWrote(io, id, 'due_date', st.dueDate)) fields.due_date = item.due;
      if (Object.keys(fields).length) plan.push({ action: 'update', key: item.key, taskId: id, fields, title: fields.title ?? st.title });
      continue;
    }
    const rows = made(item.key).map((m) => ({ id: m.id, state: planner.taskState(m.id) }));
    if (!rows.length) {
      plan.push({
        action: 'create', key: item.key, order: item.order ?? '', title: item.title,
        fields: { owner, business_id: SAVE_POINT, title: item.title, notes: item.notes, due_date: item.due ?? today },
      });
      continue;
    }
    const mine = rows.filter((r) => suiteFinished(io, r.id, r.state));
    if (!mine.length) {
      plan.push({ action: 'handled', key: item.key });
      continue;
    }
    const { id, state: st } = mine[mine.length - 1];
    const fields = { done_at: null };
    if (item.due && st.dueDate !== item.due && suiteWrote(io, id, 'due_date', st.dueDate)) fields.due_date = item.due;
    if (item.title !== st.title && suiteWrote(io, id, 'title', st.title)) fields.title = item.title;
    const ownNotes = suiteWrote(io, id, 'notes', st.notes);
    plan.push({ action: 'reopen', key: item.key, taskId: id, fields, notes: ownNotes ? item.notes : st.notes, ownNotes, title: fields.title ?? st.title });
  }
  for (const [key, tasks] of open) {
    if (listed.has(key)) continue;
    plan.push({ action: 'finish', key, taskIds: tasks.map((t) => t.id), why: goneWhy(key), title: tasks[tasks.length - 1].state.title });
  }
  return plan;
}

/** The ship tasks: one per order waiting to ship (`waiting` = the stored rows), finished when eBay shows it ended. */
export function shipPlan({ waiting, byId, timeZone, today, made, madeLike, planner, owner }) {
  const items = waiting.map((o) => shipItem(o, { timeZone, today }));
  return keyedPlan({
    prefix: 'order:', items, today, made, madeLike, planner, owner,
    goneWhy: (key) => shipEndedWhy(viewOf(byId(key.slice('order:'.length)))),
  });
}
const viewOf = (row) => (row ? { cancelState: row.cancel_state, status: row.status, paymentStatus: row.payment_status } : null);

/**
 * The sign-in reminder: one task when the refresh token lapses within SIGN_IN_LEAD_DAYS (key `lapse:<day>`), or when
 * eBay refused it (key `signed-out:<when>`); finished once a new sign-in moves the expiry (or clears the refusal).
 */
export function signInPlan({ connection, today, timeZone, made, madeLike, planner, owner }) {
  const items = [];
  if (connection?.signed_out_at) {
    items.push({
      key: `signed-out:${connection.signed_out_at}`,
      title: 'Sign in to eBay again: the suite’s eBay connection stopped',
      notes: [
        `eBay stopped accepting the suite’s sign-in on ${dayText(localDateIn(timeZone, new Date(connection.signed_out_at)))}${connection.signed_out_reason ? ` (${connection.signed_out_reason})` : ''}.`,
        'Until you sign in again, Save Point Shop’s sales totals and orders to ship aren’t read (enter a month by hand on Money → Sales meanwhile).',
        'System → Connections → eBay → Sign in to eBay.',
      ].join('\n'),
      due: today,
    });
  } else if (connection?.refresh_expires_at) {
    const lapses = localDateIn(timeZone, new Date(connection.refresh_expires_at));
    if (addDays(today, SIGN_IN_LEAD_DAYS) >= lapses) {
      const due = [addDays(lapses, -7), today].sort().at(-1);
      items.push({
        key: `lapse:${lapses}`,
        title: clip(`Sign in to eBay again before ${dayText(lapses)}`, TITLE_MAX),
        notes: [
          `eBay’s sign-in for the suite lapses on ${dayText(lapses)} (eBay makes them last about 18 months).`,
          'Sign in again before then so Save Point Shop’s sales totals and orders to ship keep coming: System → Connections → eBay → Sign in to eBay.',
        ].join('\n'),
        due,
      });
    }
  }
  return keyedPlan({
    prefix: '', items, today, made, madeLike: (p) => madeLike(p).filter((m) => /^(lapse|signed-out):/.test(m.key)), planner, owner,
    goneWhy: () => (connection?.signed_in_at ? `Signed in to eBay again on ${dayText(localDateIn(timeZone, new Date(connection.signed_in_at)))}` : 'The eBay connection was removed'),
  });
}

/** Carry out a plan inside a run (D16's applyPlan, with a per-run cap). → { made, updated, reopened, finished, handled, rest } */
export function applyPlan(plan, { now, today, made, madeLike, remember, create, update, planner }, cap = null) {
  const io = { planner, made, madeLike, remember, update };
  const out = { made: [], updated: [], reopened: [], finished: [], handled: 0, rest: 0 };
  for (const p of plan) {
    if (p.action === 'handled') out.handled += 1;
    else if (p.action === 'finish') {
      let k = 0;
      for (const id of p.taskIds) {
        const before = planner.taskState(id);
        const own = Boolean(before?.open && suiteWrote(io, id, 'notes', before.notes));
        if (finishTask(io, id, p.why, now)) {
          k += 1;
          if (own) markWrote(io, id, 'notes', planner.taskState(id).notes);
        }
      }
      if (k) out.finished.push(`${p.title}: ${p.why}`);
    } else if (p.action === 'update') {
      update('task', p.taskId, p.fields);
      for (const f of ['title', 'notes', 'due_date']) if (p.fields[f] !== undefined) markWrote(io, p.taskId, f, p.fields[f]);
      out.updated.push(p.title);
    } else if (p.action === 'reopen') {
      const line = `Back on eBay — reopened by the suite on ${dayText(today)}.`;
      const notes = p.notes ? `${p.notes}\n\n${line}` : line;
      update('task', p.taskId, { ...p.fields, notes });
      if (p.ownNotes) markWrote(io, p.taskId, 'notes', notes);
      if (p.fields.title) markWrote(io, p.taskId, 'title', p.fields.title);
      if (p.fields.due_date) markWrote(io, p.taskId, 'due_date', p.fields.due_date);
      out.reopened.push(p.title);
    }
  }
  const creates = plan.filter((p) => p.action === 'create').sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const room = cap === null ? creates.length : Math.min(creates.length, cap);
  out.rest = creates.length - room;
  for (const p of creates.slice(0, room)) {
    const id = create('task', p.fields, { key: p.key });
    for (const f of ['title', 'notes', 'due_date']) markWrote(io, id, f, p.fields[f]);
    out.made.push(p.title);
  }
  return out;
}

/** Is there anything to do (for `accept`: no run rows for the hourly no-ops)? */
export const actionable = (plan) => plan.some((p) => p.action !== 'handled');

/** The run's summary and (when tasks were made or reopened) its alert. */
export function result(out, { noun, nothing, title, link = '/tasks' }) {
  const parts = [
    out.made.length ? `made ${plural(out.made.length, noun)}` : null,
    out.rest ? `${out.rest.toLocaleString('en-CA')} more waiting (made with the next pulls)` : null,
    out.reopened.length ? `reopened ${plural(out.reopened.length, noun)}` : null,
    out.updated.length ? `brought ${plural(out.updated.length, noun)} up to date` : null,
    out.finished.length ? `finished ${plural(out.finished.length, noun)}` : null,
    out.handled ? `${plural(out.handled, noun)} already handled by a person` : null,
  ].filter(Boolean);
  const summary = parts.length ? parts.join('; ').replace(/^./, (c) => c.toUpperCase()) : nothing;
  const titles = [...out.made, ...out.reopened];
  if (!titles.length) return { summary };
  const shown = titles.slice(0, 5);
  const more = titles.length - shown.length + out.rest;
  return { summary, alert: { title: `${title}: ${plural(out.made.length + out.reopened.length + out.rest, noun)}`, body: [...shown, ...(more ? [`and ${more} more`] : [])].join('\n'), link } };
}
