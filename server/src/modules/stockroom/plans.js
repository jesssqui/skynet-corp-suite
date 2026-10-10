// What the Stockroom automations would do (D16), worked out from the last answers Stockroom gave
// (the module's own snapshots) and what each automation made before — pure over its inputs, so the
// automation's `accept` (is there anything to do?) and its `run` decide the same way, and the tests
// can drive every case without a hub.
//
// Four kinds of task, all on the wholesale business (Stockroom's stock is the wholesale business's):
//   reorders     one per supplier "episode" (reorderPlan): from the day Stockroom first suggests
//                ordering something from it until nothing from it needs ordering or a purchase order to
//                it is confirmed in Stockroom; products with no supplier set share one task
//   spot check   one per week (Monday–Sunday), on the shared list (spotCheckPlan)
//   deliveries   one per confirmed purchase order, due on its expected day (keyedPlan)
//   differences  one per open count difference at or over Stockroom's own limit (keyedPlan)
// "Who finished it decides" (../automations/taskBook.js): a task a person finished or deleted is
// final for its subject; one the suite finished may be reopened when its subject comes back; the
// suite only rewrites a title, notes or due date that is still the one it wrote.
//
// Nothing here — or anywhere in this module — can change Stockroom: it reads answers already stored.
import { localDate } from '@suite/shared/time';
import { weekStart } from '@suite/shared/planner';
import { BUSINESS_IDS } from '@suite/shared/crm';
import { SHARED } from '@suite/shared/actors';
import { isoWeekKey } from '../automations/schedule.js';
import { markWrote, suiteWrote, suiteFinished, finishTask, dayText } from '../automations/taskBook.js';

export const WHOLESALE = BUSINESS_IDS.wholesale;
/** New tasks a day, per automation (like D3's caps): the rest come on the next days, most urgent first. */
export const DAILY_CAPS = Object.freeze({ reorders: 10, deliveries: 20, differences: 10 });
const TITLE_MAX = 300;
const NOTES_MAX = 20_000;
const LIST_MAX = 60;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const tins = (n) => plural(n, 'tin');
/** The Toronto (server-local) calendar day of an ISO moment, or null. */
export const dayOf = (iso) => (iso ? localDate(new Date(iso)) : null);
const ymdText = (ymd) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? dayText(ymd) : null);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
function money(cents) {
  if (!Number.isFinite(cents)) return null;
  const abs = (Math.abs(cents) / 100).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' });
  return cents < 0 ? `−${abs}` : abs;
}
/** "Zyn Cool Mint 6mg (ZYN-CM6)" */
const product = (i) => `${i.name ?? i.sku ?? 'A product'}${i.sku && i.sku !== i.name ? ` (${i.sku})` : ''}`;
function bullets(lines) {
  const shown = lines.slice(0, LIST_MAX).map((l) => `• ${l}`);
  if (lines.length > LIST_MAX) shown.push(`…and ${lines.length - LIST_MAX} more (see Stockroom)`);
  return shown;
}
const notesOf = (parts) => clip(parts.filter((p) => p !== null && p !== undefined).join('\n'), NOTES_MAX);

/** The open tasks an automation made under keys starting with `prefix`: Map key → [{ id, state }]. */
function openByKey(madeLike, planner, prefix, keyRe = null) {
  const out = new Map();
  const seen = new Set();
  for (const m of madeLike(prefix)) {
    if (keyRe && !keyRe.test(m.key)) continue;
    if (seen.has(`${m.key}|${m.id}`)) continue;
    seen.add(`${m.key}|${m.id}`);
    const state = planner.taskState(m.id);
    if (!state?.open) continue;
    const list = out.get(m.key) ?? [];
    list.push({ id: m.id, state });
    out.set(m.key, list);
  }
  return out;
}

/** How many new tasks an automation may still make today (its daily cap less what it made today). */
export function capLeft({ madeLike, today }, cap) {
  return Math.max(0, cap - new Set(madeLike(`new:${today}:`).map((m) => m.id)).size);
}

// ---- reorders -----------------------------------------------------------------------------------

/** The key of a product's supplier group: "sup:<supplier id>", or "sup:none" when it has none in Stockroom. */
export const supplierKey = (item) => (item.supplier_id !== null && item.supplier_id !== undefined ? `sup:${item.supplier_id}` : 'sup:none');

/**
 * Stockroom's order-soon list grouped by supplier: only products with a suggested quantity above 0
 * (null = no sales speed to go on: Stockroom says why; 0 = enough on hand and on order).
 * → Map supplierKey → { key, supplierId, supplier, items } (most urgent first: fewest days left).
 */
export function reorderGroups(orderSoon) {
  const groups = new Map();
  for (const i of orderSoon?.items ?? []) {
    if (!(Number.isFinite(i.suggested_qty) && i.suggested_qty > 0)) continue;
    const key = supplierKey(i);
    const g = groups.get(key) ?? { key, supplierId: i.supplier_id ?? null, supplier: key === 'sup:none' ? null : (i.supplier ?? `supplier ${i.supplier_id}`), items: [] };
    g.items.push(i);
    groups.set(key, g);
  }
  const days = (i) => (Number.isFinite(i.days_left) ? i.days_left : Infinity);
  for (const g of groups.values()) g.items.sort((a, b) => days(a) - days(b) || String(a.name).localeCompare(String(b.name)));
  return groups;
}

/** "Reorder from Swedish Match: 3 products" / "Reorder: 2 products with no supplier in Stockroom" */
export function reorderTitle(g) {
  const n = plural(g.items.length, 'product');
  return clip(g.supplier ? `Reorder from ${g.supplier}: ${n}` : `Reorder: ${n} with no supplier in Stockroom`, TITLE_MAX);
}

export function reorderNotes(g, { asOfDay }) {
  const lines = g.items.map((i) => {
    const parts = [`${product(i)} — order ${tins(i.suggested_qty)}`];
    if (Number.isFinite(i.case_size) && i.case_size > 1) parts[0] += ` (cases of ${i.case_size})`;
    if (Number.isFinite(i.days_left)) parts.push(`${plural(Math.max(0, Math.round(i.days_left)), 'day')} left${ymdText(i.runs_out_on) ? ` (runs out ${ymdText(i.runs_out_on)})` : ''}`);
    else if (i.status === 'out') parts.push('out of stock');
    if (Number.isFinite(i.available)) parts.push(`${i.available} available`);
    if (Number.isFinite(i.on_order) && i.on_order > 0) parts.push(`${i.on_order} on order`);
    if (!g.supplier) parts.push(i.last_supplier ? `last bought from ${i.last_supplier}` : i.brand ? `brand ${i.brand}` : 'no supplier or past delivery known');
    return parts.join(' · ');
  });
  const total = g.items.reduce((a, i) => a + i.suggested_qty, 0);
  return notesOf([
    `Stockroom suggests ordering${g.supplier ? ` from ${g.supplier}` : ''} (as of ${dayText(asOfDay)}):`,
    ...bullets(lines),
    `Total: ${tins(total)}.`,
    '',
    g.supplier
      ? `Make the purchase order in Stockroom (Purchasing). Once it is confirmed there, the suite finishes this task; anything still short after that comes back in a new task the next day.`
      : 'These have no supplier set in Stockroom: set one there (or order them however you usually do). The suite finishes this task when nothing here needs ordering any more.',
    'Read only: the suite never changes anything in Stockroom.',
  ]);
}

/**
 * The reorder plan. `episodes`: every row of stockroom_reorder_episodes. → [action] where action is
 *   { action: 'close', supplierKey, episode, why: 'empty'|'ordered', note, taskIds }
 *   { action: 'update', supplierKey, taskId, fields }
 *   { action: 'create', supplierKey, episode, newEpisode: bool, urgency, title, fields }
 *   { action: 'handled', supplierKey }   (a person finished or deleted this episode's task)
 * Nothing when the order-soon list hasn't been read yet.
 */
export function reorderPlan({ orderSoon, deliveries, episodes, made, planner, ownerFor }) {
  if (!orderSoon?.body) return [];
  const io = { planner, made };
  const groups = reorderGroups(orderSoon.body);
  const asOfDay = orderSoon.body.today ?? dayOf(orderSoon.fetchedAt);
  const latest = new Map();
  for (const e of episodes) if (!latest.has(e.supplier_key) || latest.get(e.supplier_key).episode < e.episode) latest.set(e.supplier_key, e);
  const pos = deliveries?.body?.items ?? [];
  const plan = [];
  for (const key of new Set([...groups.keys(), ...latest.keys()])) {
    const g = groups.get(key) ?? null;
    const ep = latest.get(key) ?? null;
    const tasksOf = (e) => made(`${key}:${e.episode}`).map((m) => ({ id: m.id, state: planner.taskState(m.id) }));
    if (ep && !ep.closed_at) {
      const tasks = tasksOf(ep);
      const open = tasks.filter((t) => t.state?.open);
      // Ordered: a purchase order to this supplier confirmed in Stockroom since the episode began.
      const supplierId = g?.supplierId ?? (key.startsWith('sup:') && key !== 'sup:none' ? key.slice(4) : null);
      const po = supplierId === null ? null : pos
        .filter((p) => String(p.supplier_id) === String(supplierId) && p.confirmed_at && p.confirmed_at > ep.opened_at)
        .sort((a, b) => (a.confirmed_at < b.confirmed_at ? -1 : 1))[0];
      if (po) {
        plan.push({ action: 'close', supplierKey: key, episode: ep.episode, why: 'ordered', taskIds: open.map((t) => t.id),
          note: `Ordered: purchase order ${po.number ?? po.po_id} confirmed in Stockroom on ${dayText(dayOf(po.confirmed_at))}` });
        continue;
      }
      if (!g) {
        plan.push({ action: 'close', supplierKey: key, episode: ep.episode, why: 'empty', taskIds: open.map((t) => t.id),
          note: `Nothing ${key === 'sup:none' ? 'without a supplier' : 'from this supplier'} needs ordering in Stockroom any more` });
        continue;
      }
      const title = reorderTitle(g);
      const notes = reorderNotes(g, { asOfDay });
      if (!tasks.length) {
        // The episode began but its task waited for the daily cap.
        plan.push({ action: 'create', supplierKey: key, episode: ep.episode, newEpisode: false, urgency: urgencyOf(g), title, fields: reorderFields(g, { title, notes, ownerFor }) });
        continue;
      }
      if (!open.length) {
        plan.push({ action: 'handled', supplierKey: key }); // a person finished or deleted it: final for this episode
        continue;
      }
      const t = open[open.length - 1];
      const fields = {};
      if (t.state.title !== title && suiteWrote(io, t.id, 'title', t.state.title)) fields.title = title;
      if (t.state.notes !== notes && suiteWrote(io, t.id, 'notes', t.state.notes)) fields.notes = notes;
      if (Object.keys(fields).length) plan.push({ action: 'update', supplierKey: key, taskId: t.id, fields, title: fields.title ?? t.state.title });
      continue;
    }
    if (!g) continue;
    // A new episode: only from an answer read after the last one ended — and, after an order, from
    // the next day on (Stockroom's suggestions then count what is on order).
    if (ep) {
      if (!(orderSoon.fetchedAt > ep.closed_at)) continue;
      if (ep.closed_why === 'ordered' && !(dayOf(orderSoon.fetchedAt) > dayOf(ep.closed_at))) continue;
    }
    const title = reorderTitle(g);
    plan.push({
      action: 'create', supplierKey: key, episode: (ep?.episode ?? 0) + 1, newEpisode: true, urgency: urgencyOf(g), title,
      fields: reorderFields(g, { title, notes: reorderNotes(g, { asOfDay }), ownerFor }),
    });
  }
  return plan;
}

const urgencyOf = (g) => Math.min(...g.items.map((i) => (Number.isFinite(i.days_left) ? i.days_left : 1e6)));
const reorderFields = (g, { title, notes, ownerFor }) => ({ owner: ownerFor(WHOLESALE), business_id: WHOLESALE, title, notes });

// ---- the weekly spot check ----------------------------------------------------------------------

/** The key of a week's spot-check task: its Monday. */
export const weekTaskKey = (monday) => `week:${monday}`;
const WEEK_KEY_RE = /^week:(\d{4}-\d{2}-\d{2})$/;

export function spotCheckNotes(body, { monday }) {
  const sugg = Array.isArray(body?.spot_check_suggestions) ? body.spot_check_suggestions : [];
  const lines = sugg.map((s) => [
    `${product(s)}${s.brand ? `, ${s.brand}` : ''}`,
    Number.isFinite(s.on_hand) ? `${s.on_hand} on hand` : null,
    Array.isArray(s.reasons) && s.reasons.length ? s.reasons.join('; ') : null,
  ].filter(Boolean).join(' · '));
  return notesOf([
    `This week’s spot check (${isoWeekKey(monday)}, week of ${dayText(monday)}).`,
    sugg.length ? 'Stockroom suggests counting:' : 'Stockroom has no suggestions this week: count a few products that sell fast or cost the most.',
    ...bullets(lines),
    '',
    'Count them in Stockroom (Counts → Spot check) and apply it there: once a spot check is applied this week, the suite finishes this task.',
    'The list is Stockroom’s as of when this task was made; Stockroom’s Counts page has the latest.',
  ]);
}

/**
 * The spot-check plan for `today`'s week. → [action]
 *   { action: 'finish', taskId, why }        a spot check was applied in its week (or later), or a newer week's replaces it
 *   { action: 'create', key, title, fields } this week's, once Stockroom's counts were read this week and none was applied yet
 *   { action: 'handled' }                    this week's was finished or deleted by a person
 */
export function spotCheckPlan({ counts, today, made, madeLike, planner }) {
  if (!counts?.body) return [];
  const monday = weekStart(today);
  const lastAt = counts.body.last_spot_check?.applied_at ?? null;
  const doneDay = dayOf(lastAt);
  const plan = [];
  const open = openByKey(madeLike, planner, 'week:', WEEK_KEY_RE);
  const thisKey = weekTaskKey(monday);
  const doneThisWeek = Boolean(doneDay && doneDay >= monday);
  const canCreate = !made(thisKey).length && !doneThisWeek && dayOf(counts.fetchedAt) >= monday;
  for (const [key, tasks] of open) {
    const week = WEEK_KEY_RE.exec(key)[1];
    let why = null;
    if (doneDay && doneDay >= week) why = `Spot check applied in Stockroom on ${dayText(doneDay)}`;
    else if (week < monday && canCreate) why = 'Replaced by this week’s spot check';
    if (why) for (const t of tasks) plan.push({ action: 'finish', taskId: t.id, why, title: t.state.title });
  }
  if (canCreate) {
    const sugg = Array.isArray(counts.body.spot_check_suggestions) ? counts.body.spot_check_suggestions.length : 0;
    const title = sugg ? `Weekly spot check in Stockroom: ${plural(sugg, 'product')} to count` : 'Weekly spot check in Stockroom';
    plan.push({
      action: 'create', key: thisKey, title,
      // On the shared list (decision): either of you can do it, like the Friday review.
      fields: { owner: SHARED, business_id: WHOLESALE, title, notes: spotCheckNotes(counts.body, { monday }), due_date: today },
    });
  } else if (made(thisKey).length && !open.has(thisKey) && !doneThisWeek) {
    plan.push({ action: 'handled' });
  }
  return plan;
}

// ---- one task per subject: deliveries and differences ------------------------------------------

/**
 * One task per subject key (a purchase order, a difference). items: [{ key, title, notes, due,
 * dueFollows, order }] — the subjects to have a task now; `listedKeys` = every subject Stockroom still lists (a
 * superset of the items' keys: a difference under a raised limit is still open, so its task stays — default: the
 * items' keys); `goneWhy` = the reason (a string, or (key) → string) a task is finished when its subject is no longer
 * listed; `complete` = the list is whole (a
 * truncated list can't say a subject is gone). → [action]
 *   { action: 'create', key, order, title, fields }
 *   { action: 'update', key, taskId, fields, title }
 *   { action: 'reopen', key, taskId, fields, notes, title }   the suite had finished it; it is back
 *   { action: 'finish', key, taskIds, why, title }             no longer listed
 *   { action: 'handled', key }                                 a person finished or deleted it: final
 */
export function keyedPlan({ prefix, items, listedKeys = null, complete, goneWhy, today, made, madeLike, planner, ownerFor }) {
  const io = { planner, made };
  const open = openByKey(madeLike, planner, prefix);
  const listed = new Set([...(listedKeys ?? []), ...items.map((i) => i.key)]);
  const plan = [];
  for (const item of items) {
    const tasks = open.get(item.key) ?? [];
    if (tasks.length) {
      const { id, state: st } = tasks[tasks.length - 1];
      const fields = {};
      if (item.title !== st.title && suiteWrote(io, id, 'title', st.title)) fields.title = item.title;
      if (item.notes !== st.notes && suiteWrote(io, id, 'notes', st.notes)) fields.notes = item.notes;
      if (item.dueFollows && item.due && st.dueDate !== item.due && suiteWrote(io, id, 'due_date', st.dueDate)) fields.due_date = item.due;
      if (Object.keys(fields).length) plan.push({ action: 'update', key: item.key, taskId: id, fields, title: fields.title ?? st.title });
      continue;
    }
    const rows = made(item.key).map((m) => ({ id: m.id, state: planner.taskState(m.id) }));
    if (!rows.length) {
      plan.push({
        action: 'create', key: item.key, order: item.order, title: item.title,
        fields: { owner: ownerFor(WHOLESALE), business_id: WHOLESALE, title: item.title, notes: item.notes, due_date: item.due ?? today },
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
    const due = item.due ?? today;
    if (st.dueDate !== due && suiteWrote(io, id, 'due_date', st.dueDate)) fields.due_date = due;
    if (item.title !== st.title && suiteWrote(io, id, 'title', st.title)) fields.title = item.title;
    // Notes: the subject's current ones when the task's notes are still the suite's (so they keep following it
    // after the reopen); otherwise a person's notes with a line added.
    const ownNotes = suiteWrote(io, id, 'notes', st.notes);
    plan.push({ action: 'reopen', key: item.key, taskId: id, fields, notes: ownNotes ? item.notes : st.notes, ownNotes, title: fields.title ?? st.title });
  }
  if (complete) {
    for (const [key, tasks] of open) {
      if (listed.has(key)) continue;
      const why = typeof goneWhy === 'function' ? goneWhy(key) : goneWhy;
      plan.push({ action: 'finish', key, taskIds: tasks.map((t) => t.id), why, title: tasks[tasks.length - 1].state.title });
    }
  }
  return plan;
}

// ---- deliveries ----------------------------------------------------------------------------------

export const deliveryKey = (po) => `po:${po.po_id}`;

/** One expected delivery (a purchase order confirmed in Stockroom) as a task's subject. */
export function deliveryItem(po, { today }) {
  const number = po.number ?? `#${po.po_id}`;
  const supplier = po.supplier ?? 'its supplier';
  const title = clip(`Receive delivery ${number} from ${supplier}${Number.isFinite(po.remaining_tins) ? `: ${tins(po.remaining_tins)}` : ''}`, TITLE_MAX);
  const lines = (po.lines ?? []).map((l) => `${product(l)}${l.supplier_code ? ` (their code ${l.supplier_code})` : ''}: ${Number.isFinite(l.ordered) && l.ordered !== l.remaining ? `${l.remaining} of ${l.ordered}` : l.remaining} tins`);
  const expected = ymdText(po.expected_on);
  const notes = notesOf([
    `Purchase order ${number} from ${supplier}, confirmed in Stockroom${po.confirmed_at ? ` on ${dayText(dayOf(po.confirmed_at))}` : ''}${po.confirmed_by ? ` by ${po.confirmed_by}` : ''}.`,
    expected ? `Expected ${expected}${po.expected_on < today ? ' (late)' : ''}.` : 'No expected day given in Stockroom.',
    po.status === 'partly_received' ? 'Partly received already. Still to come:' : 'To come:',
    ...bullets(lines),
    '',
    'Receive it in Stockroom (Receive) when it arrives. Once it is received in full — or cancelled or closed short there — the suite finishes this task.',
  ]);
  return { key: deliveryKey(po), title, notes, due: po.expected_on ?? null, dueFollows: Boolean(po.expected_on), order: po.expected_on ?? '9999-12-31' };
}

/** A purchase order that left the list without Stockroom saying how (a Stockroom from before B10, or ended long ago). */
export const DELIVERY_GONE = 'No longer expected in Stockroom (received in full, cancelled or closed short)';

/** How an ended purchase order ended (B10's `ended`), in plain English. */
export function endedWhy(e) {
  const reason = typeof e?.reason === 'string' && e.reason.trim() ? `: ${e.reason.trim()}` : '';
  if (e?.status === 'received') return 'Received in full in Stockroom';
  if (e?.status === 'cancelled') return `Cancelled in Stockroom${reason}`;
  if (e?.status === 'closed_short') return `Closed short in Stockroom${reason}`;
  return DELIVERY_GONE;
}

export function deliveriesPlan({ deliveries, today, made, madeLike, planner, ownerFor }) {
  if (!deliveries?.body) return [];
  const items = (deliveries.body.items ?? []).filter((p) => p && p.po_id !== undefined && p.po_id !== null).map((p) => deliveryItem(p, { today }));
  // B10 (newer Stockroom): `ended` says how each order ended in the last 30 days; `purchase_orders_truncated` says the
  // open list was cut (then a missing order may still be open: nothing is finished). A Stockroom without them: the list
  // is whole, and an order that left it is finished with the general reason.
  const ended = new Map((Array.isArray(deliveries.body.ended) ? deliveries.body.ended : []).map((e) => [`po:${e.po_id}`, e]));
  const goneWhy = (key) => (ended.has(key) ? endedWhy(ended.get(key)) : DELIVERY_GONE);
  return keyedPlan({ prefix: 'po:', items, complete: deliveries.body.purchase_orders_truncated !== true, goneWhy, today, made, madeLike, planner, ownerFor });
}

// ---- differences ---------------------------------------------------------------------------------

export const differenceKey = (d) => `diff:${d.id}`;
const COUNT_TYPES = { weekly: 'weekly count', spot: 'spot check', cycle: 'cycle count', initial: 'first count' };

/** Stockroom's own limit (Settings → variance threshold): a difference at or over it gets a task. */
export const overLimit = (d, threshold) => Number.isFinite(d.variance) && Math.abs(d.variance) >= threshold;

export function differenceItem(d) {
  const title = clip(`Investigate count difference: ${product(d)}, ${signed(d.variance)} ${Math.abs(d.variance) === 1 ? 'tin' : 'tins'}`, TITLE_MAX);
  const value = money(d.value_cents);
  const notes = notesOf([
    `${product(d)}${d.brand ? `, ${d.brand}` : ''}: Stockroom expected ${d.expected ?? 'an unknown number'}, the ${COUNT_TYPES[d.count_type] ?? 'count'}${d.counted_at ? ` on ${dayText(dayOf(d.counted_at))}` : ''} found ${d.counted} — ${signed(d.variance)} tins${value ? ` (${value})` : ''}.`,
    d.reason ? `Reason given: ${d.reason}` : null,
    d.opened_by ? `Opened by ${d.opened_by}.` : null,
    '',
    'Look into it, then mark it investigated in Stockroom (Counts → Differences) with a note: the suite then finishes this task.',
  ]);
  return { key: differenceKey(d), title, notes, due: null, dueFollows: false, order: -Math.abs(d.variance) };
}

export const DIFFERENCE_GONE = 'Marked investigated in Stockroom';

export function differencesPlan({ differences, today, made, madeLike, planner, ownerFor }) {
  if (!differences?.body) return [];
  const b = differences.body;
  const threshold = Number.isFinite(b.threshold_tins) && b.threshold_tins > 0 ? b.threshold_tins : 1;
  const open = (b.items ?? []).filter((d) => d && d.id !== undefined && d.id !== null);
  // New tasks only for differences at or over the limit; but every difference still listed is still open in
  // Stockroom (a limit raised later doesn't close it), so its task stays until it is really marked investigated.
  const items = open.filter((d) => overLimit(d, threshold)).map(differenceItem);
  // A truncated list (over 500 open) can't say one is gone: nothing is finished until it is whole again.
  return keyedPlan({
    prefix: 'diff:', items, listedKeys: open.map(differenceKey), complete: !b.truncated, goneWhy: DIFFERENCE_GONE, today, made, madeLike, planner, ownerFor,
  });
}

// ---- carrying out a keyed or spot-check plan -------------------------------------------------------

/**
 * Carry out a keyedPlan / spotCheckPlan inside a run. New tasks: at most `cap` today (null = no cap),
 * in the plan's `order`. → { made, updated, reopened, finished, handled, rest } (titles / counts).
 */
export function applyPlan(plan, { now, today, made, madeLike, remember, create, update, planner }, cap = null) {
  const io = { planner, made, madeLike, remember, update };
  const out = { made: [], updated: [], reopened: [], finished: [], handled: 0, rest: 0 };
  for (const p of plan) {
    if (p.action === 'handled') out.handled += 1;
    else if (p.action === 'finish') {
      let k = 0;
      for (const id of p.taskIds ?? [p.taskId]) if (finishOwn(io, id, p.why, now)) k += 1;
      if (k) out.finished.push(`${p.title}: ${p.why}`);
    } else if (p.action === 'update') {
      update('task', p.taskId, p.fields);
      for (const f of ['title', 'notes', 'due_date']) if (p.fields[f] !== undefined) markWrote(io, p.taskId, f, p.fields[f]);
      out.updated.push(p.title);
    } else if (p.action === 'reopen') {
      const line = `Back in Stockroom — reopened by the suite on ${dayText(today)}.`;
      const notes = p.notes ? `${p.notes}\n\n${line}` : line;
      update('task', p.taskId, { ...p.fields, notes });
      // Still the suite's notes: marked so they keep following the subject (they froze before — review fix).
      if (p.ownNotes) markWrote(io, p.taskId, 'notes', notes);
      if (p.fields.title) markWrote(io, p.taskId, 'title', p.fields.title);
      if (p.fields.due_date) markWrote(io, p.taskId, 'due_date', p.fields.due_date);
      out.reopened.push(p.title);
    }
  }
  const creates = plan.filter((p) => p.action === 'create').sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  const room = cap === null ? creates.length : Math.min(creates.length, capLeft({ madeLike, today }, cap));
  out.rest = creates.length - room;
  for (const p of creates.slice(0, room)) {
    const id = create('task', p.fields, { key: p.key });
    for (const f of ['title', 'notes', 'due_date']) markWrote(io, id, f, p.fields[f]);
    remember(`new:${today}:${id}`, 'task', id);
    out.made.push(p.title);
  }
  return out;
}

/**
 * finishTask (taskBook), and — when the notes were still the suite's — the finished notes (with the suite's line)
 * marked as the suite's too, so a later reopen can tell they are still its own. Kept in this module on purpose, not
 * in taskBook: changing finishTask would change D3/D5/D6, whose reopens append a line without marking the notes (so
 * a D3 ship task reopened by the suite keeps its notes as they were then — the same freeze, left as it is there).
 */
function finishOwn(io, id, why, now) {
  const before = io.planner.taskState(id);
  const own = Boolean(before?.open && suiteWrote(io, id, 'notes', before.notes));
  if (!finishTask(io, id, why, now)) return false;
  if (own) markWrote(io, id, 'notes', io.planner.taskState(id).notes);
  return true;
}

/** Is there anything in a plan to do today (for `accept`: no run rows for the hourly no-ops)? */
export function actionable(plan, { madeLike, today }, cap = null) {
  return plan.some((p) => (p.action === 'create' ? cap === null || capLeft({ madeLike, today }, cap) > 0 : p.action !== 'handled'));
}

/** The run's summary and (when tasks were made or reopened) its alert. */
export function result(out, { noun, nothing, link = '/tasks' }) {
  const parts = [
    out.made.length ? `made ${plural(out.made.length, noun)}` : null,
    out.rest ? `${out.rest.toLocaleString('en-CA')} more waiting (made on the next days)` : null,
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
  return {
    summary,
    alert: {
      title: `Stockroom: ${plural(out.made.length + out.reopened.length + out.rest, noun)}`,
      body: [...shown, ...(more ? [`and ${more.toLocaleString('en-CA')} more`] : [])].join('\n'),
      link,
    },
  };
}

