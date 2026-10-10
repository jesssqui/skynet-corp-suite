// The Stockroom automations (D16), registered with the automations framework (C8) by the stockroom
// module. All four listen to `stockroom.pulled` — emitted after each pull round that got at least
// one answer from Stockroom (see service.js for the cadence) — and decide on the answers stored
// now (plans.js), so a round that brings nothing new makes no run row (`accept`), and Run now
// plans on what was last read. Tasks only, made and changed through sync (applyLocal as system);
// nothing is ever sent to Stockroom or anywhere else.
//
//   stockroom-reorders     one task per supplier: "Reorder from <supplier>: N products"
//   stockroom-spot-check   the week's spot check, on the shared list
//   stockroom-deliveries   "Receive delivery <PO> from <supplier>", due on its expected day
//   stockroom-differences  "Investigate count difference: <product>, ±N tins"
//
// All on, all silent by default. See CLAUDE.md, "Stock tasks from Stockroom (D16)".
import { finishTask, markWrote } from '../automations/taskBook.js';
import { localDate, nowIso } from '@suite/shared/time';
import {
  reorderPlan, spotCheckPlan, deliveriesPlan, differencesPlan, applyPlan, actionable, result, capLeft, DAILY_CAPS,
} from './plans.js';

export const PULLED_EVENT = 'stockroom.pulled';
export const AUTOMATION_IDS = Object.freeze({
  reorders: 'stockroom-reorders',
  spotCheck: 'stockroom-spot-check',
  deliveries: 'stockroom-deliveries',
  differences: 'stockroom-differences',
});

export function registerStockroomAutomations({ automations, planner, store, clock }) {
  const ownerFor = (businessId) => planner.automatedOwnerFor(businessId);
  const today = () => localDate(new Date(clock()));
  // Outside a run (accept): the framework's reads of what an automation made.
  const io = (id) => ({ made: (key) => automations.made(id, key), madeLike: (prefix) => automations.madeLike(id, prefix), planner, today: today() });
  const trigger = (accept) => ({ type: 'event', event: PULLED_EVENT, key: (d) => d?.key ?? null, label: 'After each pull from Stockroom', accept });

  // ---- reorders ----
  const reorderInputs = (r) => ({
    orderSoon: store.snapshot('order-soon'), deliveries: store.snapshot('deliveries'), episodes: store.episodes(), made: r.made, planner, ownerFor,
  });
  automations.register({
    id: AUTOMATION_IDS.reorders,
    name: 'Reorder from suppliers',
    module: 'stockroom',
    description: 'One task per supplier when Stockroom suggests ordering from it: the products, suggested quantities and days left in its notes, '
      + 'kept up to date while open. Finished once a purchase order to that supplier is confirmed in Stockroom, or when nothing from it needs ordering. '
      + 'Products with no supplier share one task. At most 10 new a day.',
    trigger: trigger(() => {
      const r = io(AUTOMATION_IDS.reorders);
      return actionable(reorderPlan(reorderInputs(r)), r, DAILY_CAPS.reorders);
    }),
    defaults: { enabled: true, alert: false },
    alertLink: '/tasks',
    run(_ctx, run) {
      const plan = reorderPlan(reorderInputs(run));
      return result(applyReorderPlan(plan, { ...run, planner }, store), { noun: 'reorder task', nothing: store.snapshot('order-soon') ? 'Nothing to reorder' : 'Stockroom’s order-soon list hasn’t been read yet' });
    },
  });

  // ---- the weekly spot check ----
  automations.register({
    id: AUTOMATION_IDS.spotCheck,
    name: 'Weekly spot check',
    module: 'stockroom',
    description: 'Once a week (Monday to Sunday), a task on the shared list to spot-check the products Stockroom suggests. '
      + 'Not made when a spot check was already applied that week; finished when Stockroom shows one applied.',
    trigger: trigger(() => {
      const r = io(AUTOMATION_IDS.spotCheck);
      return actionable(spotCheckPlan({ counts: store.snapshot('counts'), today: r.today, made: r.made, madeLike: r.madeLike, planner }), r);
    }),
    defaults: { enabled: true, alert: false },
    alertLink: '/tasks',
    run(_ctx, run) {
      const plan = spotCheckPlan({ counts: store.snapshot('counts'), today: run.today, made: run.made, madeLike: run.madeLike, planner });
      return result(applyPlan(plan, { ...run, planner }), { noun: 'spot-check task', nothing: store.snapshot('counts') ? 'Nothing to do this week' : 'Stockroom’s counts haven’t been read yet' });
    },
  });

  // ---- deliveries ----
  automations.register({
    id: AUTOMATION_IDS.deliveries,
    name: 'Receive deliveries',
    module: 'stockroom',
    description: 'A task for each purchase order confirmed in Stockroom, due on its expected day (or the day it is seen, when there is none): '
      + 'what is still to come in its notes. Finished once Stockroom no longer expects it (received in full, cancelled or closed short).',
    trigger: trigger(() => {
      const r = io(AUTOMATION_IDS.deliveries);
      return actionable(deliveriesPlan({ deliveries: store.snapshot('deliveries'), ...r, ownerFor }), r, DAILY_CAPS.deliveries);
    }),
    defaults: { enabled: true, alert: false },
    alertLink: '/tasks',
    run(_ctx, run) {
      const plan = deliveriesPlan({ deliveries: store.snapshot('deliveries'), today: run.today, made: run.made, madeLike: run.madeLike, planner, ownerFor });
      return result(applyPlan(plan, { ...run, planner }, DAILY_CAPS.deliveries), { noun: 'delivery task', nothing: store.snapshot('deliveries') ? 'No deliveries expected' : 'Stockroom’s deliveries haven’t been read yet' });
    },
  });

  // ---- differences ----
  automations.register({
    id: AUTOMATION_IDS.differences,
    name: 'Investigate count differences',
    module: 'stockroom',
    description: 'A task for each open count difference at or over Stockroom’s own limit (its Settings → variance threshold). '
      + 'Finished once it is marked investigated in Stockroom. At most 10 new a day.',
    trigger: trigger(() => {
      const r = io(AUTOMATION_IDS.differences);
      return actionable(differencesPlan({ differences: store.snapshot('differences'), ...r, ownerFor }), r, DAILY_CAPS.differences);
    }),
    defaults: { enabled: true, alert: false },
    alertLink: '/tasks',
    run(_ctx, run) {
      const plan = differencesPlan({ differences: store.snapshot('differences'), today: run.today, made: run.made, madeLike: run.madeLike, planner, ownerFor });
      return result(applyPlan(plan, { ...run, planner }, DAILY_CAPS.differences), { noun: 'difference task', nothing: store.snapshot('differences') ? 'No differences to investigate' : 'Stockroom’s differences haven’t been read yet' });
    },
  });
}

/**
 * Carry out a reorderPlan inside a run: episodes are opened and closed in the module's own table in
 * the same transaction as the tasks (store.openEpisode / closeEpisode), so a run that fails changes
 * neither. → { made, updated, reopened, finished, handled, rest }
 */
export function applyReorderPlan(plan, run, store) {
  const { now, today, made, madeLike, remember, create, update, planner } = run;
  const io = { planner, made, madeLike, remember, update };
  const at = nowIso(now);
  const out = { made: [], updated: [], reopened: [], finished: [], handled: 0, rest: 0 };
  for (const p of plan) {
    if (p.action === 'handled') out.handled += 1;
    else if (p.action === 'close') {
      store.closeEpisode(p.supplierKey, p.episode, { at, why: p.why, note: p.note });
      let k = 0;
      for (const id of p.taskIds) if (finishTask(io, id, p.note, now)) k += 1;
      if (k) out.finished.push(p.note);
    } else if (p.action === 'update') {
      update('task', p.taskId, p.fields);
      for (const f of ['title', 'notes']) if (p.fields[f] !== undefined) markWrote(io, p.taskId, f, p.fields[f]);
      out.updated.push(p.title);
    }
  }
  const creates = plan.filter((p) => p.action === 'create').sort((a, b) => a.urgency - b.urgency || (a.supplierKey < b.supplierKey ? -1 : 1));
  const room = Math.min(creates.length, capLeft({ madeLike, today }, DAILY_CAPS.reorders));
  out.rest = creates.length - room;
  for (const p of creates.slice(0, room)) {
    if (p.newEpisode) store.openEpisode(p.supplierKey, p.episode, { at });
    const id = create('task', { ...p.fields, due_date: today }, { key: `${p.supplierKey}:${p.episode}` });
    for (const f of ['title', 'notes', 'due_date']) markWrote(io, id, f, f === 'due_date' ? today : p.fields[f]);
    remember(`new:${today}:${id}`, 'task', id);
    out.made.push(p.title);
  }
  return out;
}

