// Renewal reminders (D6), registered with the automations framework (C8) by the costs module:
//
//   service-renewals   every day at 7:50 — a client service (not done or cancelled, under a live
//                      relationship (not ended), account and client (not closed)) whose renewal_date is 30 days away gets
//                      "Renewal in 30 days: <service> for <account> (<business>)", due that day, for
//                      the business's default owner, with the client, account and relationship
//   cost-renewals      every day at 7:55 — first rolls auto-renewing costs whose date has passed
//                      forward by their period; then a recurring cost whose next renewal is 14 days
//                      away gets "Renews in 14 days: <name> ($X/yr)", due that day, for the cost's
//                      business's default owner (monthly costs that renew on their own get none)
//
// One engine for both (reminderPlan): a reminder is ONE task per record and renewal date (key
// "<record id>:<date>" in automations_made), made on the day it is due — renewal − 30 / − 14 days,
// or today when that day has gone by but the renewal hasn't (a record added late, the first run, a
// server that was off). Like D3/D5 ("who finished it decides", ../automations/taskBook.js):
//   - a task a PERSON finished or deleted is final for that date; a new date (renewed for another
//     period) is a new key and a new task when its day comes;
//   - while a task is open, a renewal date moved LATER past the reminder's window (renewed for another
//     period: new date − lead > today) FINISHES it ("Renewed: the next renewal is …"); next year's task
//     is made on its own day. A correction that stays inside the window, or an earlier date, MOVES it
//     (re-filed under the new key): its due date follows only while it is still the one the suite set —
//     a person's own day is kept and a line in the notes says the date changed; title and notes are
//     refreshed only while still the suite's;
//   - the record cancelled / done, deleted, or its date cleared → the open task is FINISHED with the
//     reason; a task the suite finished is reopened if the reason goes away (same date, not passed);
//   - at most NEW_REMINDERS_CAP new tasks a run, soonest renewal first; the rest come the next days.
// Tasks only ("they prepare, you approve"); the one other write is the cost-renewals run rolling an
// auto-renewing cost's next_renewal forward (sync.applyLocal as system, like every automation write).
// See CLAUDE.md, "Renewals and recurring costs (D6)".
import { addDays } from '@suite/shared/planner';
import {
  SERVICE_REMINDER_DAYS, COST_REMINDER_DAYS, daysFromTo, rollForward, wantsCostReminder, costAmountText, moneyText,
  PERIOD_SUFFIX, isActiveCost, effectiveAnchor,
} from '@suite/shared/costs';
import { markWrote, suiteWrote, suiteFinished, finishTask, dayText } from '../automations/taskBook.js';

export const SERVICE_RENEWALS_ID = 'service-renewals';
export const COST_RENEWALS_ID = 'cost-renewals';
/** At most this many new reminder tasks a run (per automation); the rest are made on the next days. */
export const NEW_REMINDERS_CAP = 20;
const TITLE_MAX = 300;
const ALERT_LIST_MAX = 5;

const RECORD_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{4}-\d{2}-\d{2})$/;
/** The key a reminder task is filed under: the record and the renewal date it is for. */
export const reminderKey = (id, date) => `${id}:${date}`;
// Which renewal date an open task is for now (it moves with the record): a row per move, the newest
// wins — so a date moved and moved back is still told apart.
const forKey = (taskId, at, date) => `for:${taskId}:${at}:${date}`;
const toldKey = (taskId, date) => `told:${taskId}:${date}`;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;
const later = (a, b) => (a > b ? a : b);

/** How far the renewal is from the day the task is due: "in 30 days", "tomorrow", "today", or null when it has passed. */
export function whenText(date, due) {
  const n = daysFromTo(due, date);
  if (n > 1) return `in ${n} days`;
  if (n === 1) return 'tomorrow';
  if (n === 0) return 'today';
  return null;
}

/** "Renewal in 30 days: Hosting for Lefty’s (Great White North Design)" */
export function serviceTitle({ name, accountName, businessName, date, due }) {
  const when = whenText(date, due);
  const head = when ? `Renewal ${when}` : `Renewal date passed (${dayText(date)})`;
  return clip(`${head}: ${name} for ${accountName}${businessName ? ` (${businessName})` : ''}`, TITLE_MAX);
}

/** "Renews in 14 days: Domain leftys.ca ($20/yr)" */
export function costTitle({ cost, date, due }) {
  const when = whenText(date, due);
  const head = when ? `Renews ${when}` : `Renewal date passed (${dayText(date)})`;
  const amount = costAmountText(cost);
  return clip(`${head}: ${cost.name}${amount ? ` (${amount})` : ''}`, TITLE_MAX);
}

/**
 * What a reminder automation would do on `today` (pure over the adapter's reads and what it made).
 * adapter = { lead, window(from, to) → [rec], lookup(id) → rec | null } where
 *   rec = { id, date, eligible, why?, build(due) → { title, notes, base } }  (base: the task's owner,
 *   business and refs; only the refs listed in it — client_id, account_id, relationship_id — follow
 *   the record later).
 * → [{ action: create | update | reopen | finish | handled, … }]
 */
export function reminderPlan(adapter, { today, made, madeLike, planner }) {
  const io = { planner, made };
  const { lead } = adapter;
  // Open reminders per record (each task once, oldest first).
  const open = new Map();
  for (const m of madeLike('')) {
    const k = RECORD_KEY.exec(m.key);
    if (!k) continue;
    const list = open.get(k[1]) ?? [];
    if (list.some((x) => x.id === m.id)) continue;
    const state = planner.taskState(m.id);
    if (!state?.open) continue;
    list.push({ id: m.id, key: m.key, state });
    open.set(k[1], list);
  }
  const recs = new Map(adapter.window(today, addDays(today, lead)).map((r) => [r.id, r]));
  for (const id of open.keys()) if (!recs.has(id)) recs.set(id, adapter.lookup(id) ?? { id, eligible: false, why: adapter.goneWhy });

  /** The renewal date an open task is for now. */
  const forDate = (task) => {
    const rows = madeLike(`for:${task.id}:`).map((r) => r.key).sort();
    return rows.length ? rows[rows.length - 1].slice(-10) : RECORD_KEY.exec(task.key)[2];
  };
  const refsOf = (base, st) => {
    const out = {};
    for (const [f, k] of [['client_id', 'clientId'], ['account_id', 'accountId'], ['relationship_id', 'relationshipId']]) {
      if (Object.hasOwn(base, f) && st[k] !== base[f]) out[f] = base[f];
    }
    return out;
  };

  const plan = [];
  for (const [id, rec] of recs) {
    const tasks = open.get(id) ?? [];
    if (!rec.eligible || !rec.date) {
      if (tasks.length) plan.push({ action: 'finish', id, ids: tasks.map((t) => t.id), why: rec.why, title: tasks[tasks.length - 1].state.title });
      continue;
    }
    const key = reminderKey(id, rec.date);
    const start = addDays(rec.date, -lead);
    const due = later(start, today);
    if (tasks.length) {
      // One open task per record: the newest is kept up to date.
      const task = tasks[tasks.length - 1];
      const st = task.state;
      const was = forDate(task);
      const moved = was !== rec.date;
      // Renewed (the date moved later, past the reminder's window): the renewal this task was for is
      // done — FINISH it, never move it a year out (ticked there, it would stand for next year's
      // renewal as "handled by a person"). Next year's reminder is made on its own day, under its key.
      if (moved && rec.date > was && start > today) {
        plan.push({
          action: 'finish', id, ids: tasks.map((t) => t.id), title: st.title,
          why: `Renewed: the next renewal is ${dayText(rec.date)} (its reminder comes on ${dayText(start)})`,
        });
        continue;
      }
      const fields = {};
      let told = false;
      if (moved && st.dueDate !== due) {
        if (suiteWrote(io, task.id, 'due_date', st.dueDate)) fields.due_date = due;
        else if (!made(toldKey(task.id, rec.date)).length) told = true; // a person's own day: kept, and told once
      }
      const t = rec.build(fields.due_date ?? st.dueDate ?? due);
      if (st.title !== t.title && suiteWrote(io, task.id, 'title', st.title)) fields.title = t.title;
      if (st.notes !== t.notes && suiteWrote(io, task.id, 'notes', st.notes)) fields.notes = t.notes;
      Object.assign(fields, refsOf(t.base, st));
      if (told) {
        const line = `The renewal date is now ${dayText(rec.date)} (this task keeps the day you gave it).`;
        const notes = fields.notes ?? st.notes;
        fields.notes = notes ? `${notes}\n\n${line}` : line;
      }
      if (!Object.keys(fields).length && !moved) continue;
      plan.push({ action: 'update', id, key, taskId: task.id, fields, moved, told, date: rec.date, title: fields.title ?? st.title });
      continue;
    }
    const atKey = made(key).map((m) => ({ ...m, state: planner.taskState(m.id) }));
    if (!atKey.length) {
      if (today >= start && today <= rec.date) {
        const t = rec.build(due);
        plan.push({ action: 'create', id, key, date: rec.date, title: t.title, fields: { ...t.base, title: t.title, notes: t.notes, due_date: due } });
      }
      continue;
    }
    const mine = atKey.filter((m) => suiteFinished(io, m.id, m.state));
    if (!mine.length) {
      plan.push({ action: 'handled', id, key }); // a person finished or deleted it: final for this date
      continue;
    }
    if (today > rec.date) continue; // the renewal has gone by: nothing to bring back
    const { id: taskId, state: st } = mine[mine.length - 1];
    const fields = { done_at: null };
    const keepDay = st.dueDate !== due && !suiteWrote(io, taskId, 'due_date', st.dueDate);
    if (st.dueDate !== due && !keepDay) fields.due_date = due;
    const t = rec.build(fields.due_date ?? st.dueDate ?? due);
    if (st.title !== t.title && suiteWrote(io, taskId, 'title', st.title)) fields.title = t.title;
    Object.assign(fields, refsOf(t.base, st));
    plan.push({ action: 'reopen', id, key, taskId, fields, keepDay, date: rec.date, notes: st.notes, title: fields.title ?? st.title });
  }
  return plan;
}

/**
 * Carry out a plan inside a run. → { made, moved, reopened, updated, finished, handled, rest } (titles).
 * `cap` new tasks at most, soonest renewal first.
 */
export function applyReminderPlan(plan, { now, today, made, madeLike, remember, create, update, planner }, cap = NEW_REMINDERS_CAP) {
  const io = { planner, made, madeLike, remember, update };
  const at = now.toISOString();
  const out = { made: [], moved: [], reopened: [], updated: [], finished: [], handled: 0, rest: 0 };
  const creates = plan.filter((p) => p.action === 'create')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1)));
  out.rest = Math.max(0, creates.length - cap);
  for (const p of plan) {
    if (p.action === 'handled') out.handled += 1;
    else if (p.action === 'finish') {
      let k = 0;
      for (const id of p.ids) if (finishTask(io, id, p.why, now)) k += 1;
      if (k) out.finished.push(`${p.title}: ${p.why}`);
    } else if (p.action === 'update') {
      if (Object.keys(p.fields).length) update('task', p.taskId, p.fields);
      for (const f of ['title', 'due_date']) if (p.fields[f] !== undefined) markWrote(io, p.taskId, f, p.fields[f]);
      if (p.fields.notes !== undefined && !p.told) markWrote(io, p.taskId, 'notes', p.fields.notes);
      if (p.told) remember(toldKey(p.taskId, p.date), 'task', p.taskId);
      if (p.moved) {
        remember(p.key, 'task', p.taskId);
        remember(forKey(p.taskId, at, p.date), 'task', p.taskId);
        out.moved.push(`${p.title} → ${dayText(p.date)}`);
      } else out.updated.push(p.title);
    } else if (p.action === 'reopen') {
      const line = `Renewing on ${dayText(p.date)} again${p.keepDay ? ' (this task keeps the day you gave it)' : ''} — reopened by the suite on ${dayText(today)}.`;
      update('task', p.taskId, { ...p.fields, notes: p.notes ? `${p.notes}\n\n${line}` : line });
      if (p.fields.title) markWrote(io, p.taskId, 'title', p.fields.title);
      if (p.fields.due_date) markWrote(io, p.taskId, 'due_date', p.fields.due_date);
      if (p.keepDay) remember(toldKey(p.taskId, p.date), 'task', p.taskId);
      remember(forKey(p.taskId, at, p.date), 'task', p.taskId);
      out.reopened.push(p.title);
    }
  }
  for (const p of creates.slice(0, cap)) {
    const id = create('task', p.fields, { key: p.key });
    markWrote(io, id, 'title', p.fields.title);
    markWrote(io, id, 'notes', p.fields.notes);
    markWrote(io, id, 'due_date', p.fields.due_date);
    remember(forKey(id, at, p.date), 'task', id);
    out.made.push(p.title);
  }
  return out;
}

/** The run's summary and (when something new needs a look) its alert. */
function result(out, { noun, extra = [] }) {
  const parts = [
    ...extra,
    out.made.length ? `made ${plural(out.made.length, noun)}` : null,
    out.rest ? `${out.rest.toLocaleString('en-CA')} more waiting (made on the next days)` : null,
    out.moved.length ? `moved ${plural(out.moved.length, noun)} with ${out.moved.length === 1 ? 'its' : 'their'} new date` : null,
    out.reopened.length ? `reopened ${plural(out.reopened.length, noun)}` : null,
    out.updated.length ? `brought ${plural(out.updated.length, noun)} up to date` : null,
    out.finished.length ? `finished ${plural(out.finished.length, noun)}` : null,
    out.handled ? `${plural(out.handled, 'renewal')} already handled by a person` : null,
  ].filter(Boolean);
  const summary = parts.length ? parts.join('; ').replace(/^./, (c) => c.toUpperCase()) : 'Nothing renews soon';
  const titles = [...out.made, ...out.moved, ...out.reopened];
  if (!titles.length) return { summary };
  const shown = titles.slice(0, ALERT_LIST_MAX);
  const more = titles.length - shown.length + out.rest;
  return {
    summary,
    alert: {
      title: `${plural(out.made.length + out.rest + out.moved.length + out.reopened.length, 'renewal')} coming up`,
      body: [...shown, ...(more ? [`and ${more.toLocaleString('en-CA')} more`] : [])].join('\n'),
      link: '/',
    },
  };
}

// ---- the two adapters ------------------------------------------------------------------------------

/** A service's money in one line: "$1,500/yr", "$95 / hour"; '' when none. */
function serviceAmount(s) {
  if (s.billing === 'hourly' && Number.isFinite(s.rate_cents)) return `${moneyText(s.rate_cents)} / hour`;
  const m = moneyText(s.amount_cents);
  return m ? `${m}${s.period ? PERIOD_SUFFIX[s.period] ?? '' : ''}` : '';
}

const SERVICE_GONE = 'The service (or its relationship, account or client) was deleted';

/** Client services: renewal_date, 30 days ahead, the relationship's business. */
export function serviceAdapter({ crm, planner }) {
  const businessName = (id) => crm.getBusiness(id)?.name ?? null;
  const toRec = (s) => {
    if (!s) return null;
    // Closed clients and ended relationships get no reminders (closed = no next steps, as D3's
    // check-ins); a paused relationship still does — its service can still renew.
    const why = s.status === 'cancelled' ? 'The service was cancelled'
      : s.status === 'done' ? 'The service was marked done'
        : s.client_status === 'closed' ? 'The client was closed'
          : s.relationship_status === 'ended' ? 'The relationship ended'
            : !s.renewal_date ? 'Its renewal date was cleared' : null;
    return {
      id: s.id,
      date: s.renewal_date,
      eligible: !why,
      why,
      build(due) {
        const bname = businessName(s.business_id);
        const amount = serviceAmount(s);
        return {
          title: serviceTitle({ name: s.name, accountName: s.account_name, businessName: bname, date: s.renewal_date, due }),
          notes: [
            `${s.name} for ${s.account_name}${s.client_name && s.client_name !== s.account_name ? ` (client ${s.client_name})` : ''} renews on ${dayText(s.renewal_date)}${amount ? `: ${amount}` : ''}.`,
            `Renewed? Set the service’s new renewal date on the client page: the suite finishes this task, and a new reminder comes ${SERVICE_REMINDER_DAYS} days before the new date.`,
            'Not renewing? Set the service to Done or Cancelled: the suite then finishes this task.',
            `Client: /crm/clients/${s.client_id}`,
          ].join('\n'),
          base: {
            owner: planner.automatedOwnerFor(s.business_id),
            business_id: s.business_id,
            client_id: s.client_id,
            account_id: s.account_id,
            relationship_id: s.relationship_id,
          },
        };
      },
    };
  };
  return {
    lead: SERVICE_REMINDER_DAYS,
    goneWhy: SERVICE_GONE,
    window: (from, to) => crm.renewalsBetween(from, to).map((r) => toRec(crm.liveService(r.id))).filter(Boolean),
    lookup: (id) => toRec(crm.liveService(id)) ?? { id, eligible: false, why: SERVICE_GONE },
  };
}

const COST_GONE = 'The cost was deleted';

/** Recurring costs: next_renewal, 14 days ahead, the cost's business; resold ones name the client. */
export function costAdapter({ crm, planner, reads }) {
  const resoldTo = (c) => {
    if (!c.relationship_id) return null;
    const rel = crm.liveRecord('relationship', c.relationship_id);
    const account = rel ? crm.liveAccount(rel.account_id) : null;
    return account ? { account } : null;
  };
  const toRec = (c) => {
    if (!c) return null;
    const why = !isActiveCost(c) ? 'The cost was cancelled'
      : !wantsCostReminder(c) ? 'It renews monthly on its own (no reminders for those)' : null;
    return {
      id: c.id,
      date: c.next_renewal,
      eligible: !why,
      why,
      build(due) {
        const resold = resoldTo(c);
        const amount = costAmountText(c);
        const paid = [amount, c.payment_method ? `paid with ${c.payment_method}` : null].filter(Boolean).join(', ');
        return {
          title: costTitle({ cost: c, date: c.next_renewal, due }),
          notes: [
            `${c.name}${c.vendor ? ` from ${c.vendor}` : ''} renews on ${dayText(c.next_renewal)}${paid ? `: ${paid}` : ''}.`,
            c.auto_renews
              ? 'It renews on its own: check the card or account it is charged to, or cancel it before then if it’s no longer needed. The suite moves its next renewal forward once the date has passed.'
              : `It doesn’t renew on its own: renew it, then set its next renewal on Costs — the suite finishes this task, and a new reminder comes ${COST_REMINDER_DAYS} days before the new date. Not renewing it? Set it to Cancelled there: the suite finishes this task too.`,
            ...(resold ? [`Resold to ${resold.account.name}${resold.account.client_name && resold.account.client_name !== resold.account.name ? ` (client ${resold.account.client_name})` : ''}${c.resold_amount_cents !== null && c.resold_amount_cents !== undefined ? `: they pay ${costAmountText(c, 'resold_amount_cents')}` : ''}.`] : []),
            'Costs: /costs',
          ].join('\n'),
          // A resold cost's task names its client and account (and follows them); an unresold one's
          // client fields are left to the person.
          base: {
            owner: planner.automatedOwnerFor(c.business_id),
            business_id: c.business_id,
            ...(resold ? { client_id: resold.account.client_id, account_id: resold.account.id } : {}),
          },
        };
      },
    };
  };
  return {
    lead: COST_REMINDER_DAYS,
    goneWhy: COST_GONE,
    window: (from, to) => reads.renewingBetween(from, to).map(toRec),
    lookup: (id) => toRec(reads.cost(id)) ?? { id, eligible: false, why: COST_GONE },
  };
}

/**
 * Roll every active auto-renewing cost whose next renewal has passed forward by its period
 * (rollForward), finishing its open reminder (that renewal happened). → [{ id, name, from, to }]
 */
export function rollCostsForward({ reads, planner }, { now, today, made, madeLike, remember, update }) {
  const io = { planner, made, madeLike, remember, update };
  const rolled = [];
  for (const c of reads.autoRenewingPassed(today)) {
    // The billing day of the month: the cost's own while it agrees with the date (effectiveAnchor),
    // else — null, or stale/split from its date — the date's own day, written with the new date.
    const anchor = effectiveAnchor(c.next_renewal, c.anchor_day);
    const next = rollForward(c.next_renewal, c.period, today, anchor);
    if (!next || next === c.next_renewal) continue;
    // Always the pair (the same anchor too): a device edit made before this roll then clashes on both
    // fields together, so the pair can't be split into the roll's date + the device's day.
    update('recurring_cost', c.id, { next_renewal: next, anchor_day: anchor });
    const seen = new Set();
    for (const m of madeLike(`${c.id}:`)) {
      if (seen.has(m.id) || !RECORD_KEY.test(m.key)) continue;
      seen.add(m.id);
      finishTask(io, m.id, `Renewed on its own on ${dayText(c.next_renewal)}; the next renewal is ${dayText(next)}`, now);
    }
    rolled.push({ id: c.id, name: c.name, from: c.next_renewal, to: next });
  }
  return rolled;
}

/**
 * Register both automations. `reads` = the costs service's reads (cost, renewingBetween,
 * autoRenewingPassed); `crm`, `planner` their services.
 */
export function registerRenewalAutomations({ automations, crm, planner, reads }) {
  const services = serviceAdapter({ crm, planner });
  const costs = costAdapter({ crm, planner, reads });

  automations.register({
    id: SERVICE_RENEWALS_ID,
    name: 'Client service renewals',
    module: 'costs',
    description: `${SERVICE_REMINDER_DAYS} days before a client service renews (its renewal date; not done or cancelled), makes `
      + '“Renewal in 30 days: … ” due that day for the business’s default owner, with the client, account and relationship. Once per '
      + 'service and renewal date: finishing or deleting it is final for that date, and a new date makes a new one. A date moved while the '
      + 'task is open moves the task; a service cancelled or done finishes it. At most 20 new a day.',
    trigger: { type: 'schedule', every: 'day', at: '07:50' },
    defaults: { enabled: true, alert: false },
    alertLink: '/',
    run(_ctx, run) {
      const out = applyReminderPlan(reminderPlan(services, { ...run, planner }), { ...run, planner });
      return result(out, { noun: 'reminder' });
    },
  });

  automations.register({
    id: COST_RENEWALS_ID,
    name: 'Recurring cost renewals',
    module: 'costs',
    description: `${COST_REMINDER_DAYS} days before one of our recurring costs renews, makes “Renews in 14 days: … ($X/yr)” due that day for `
      + 'the cost’s business’s default owner (monthly costs that renew on their own get none). Same rules as the client service renewals. '
      + 'Each morning it also moves an auto-renewing cost whose renewal date has passed forward by its period.',
    trigger: { type: 'schedule', every: 'day', at: '07:55' },
    defaults: { enabled: true, alert: false },
    alertLink: '/costs',
    run(_ctx, run) {
      const rolled = rollCostsForward({ reads, planner }, run);
      const out = applyReminderPlan(reminderPlan(costs, { ...run, planner }), { ...run, planner });
      const extra = rolled.length
        ? [rolled.length <= 3
          ? `moved ${rolled.map((r) => `${r.name} to ${dayText(r.to)}`).join(', ')} (renewed on ${rolled.length === 1 ? 'its' : 'their'} own)`
          : `moved ${plural(rolled.length, 'auto-renewing cost')} to ${rolled.length === 1 ? 'its' : 'their'} next renewal`]
        : [];
      return result(out, { noun: 'reminder', extra });
    },
  });
}
