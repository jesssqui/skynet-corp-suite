// Projects and playbooks (D9) on the device, without React: the playbook, step and run forms (an edit
// sends only what changed — the CRM's editChanges), running a playbook (planRun → applyRun: the run, its
// own copy of the steps, the tasks, the renewal dates on the client's services and, when needed, the
// relationship — ordered store writes with ids made once, so a retry or a double tap never runs it twice),
// a run's checklist by stage, and the examples. Tested in client/test/playbooks.test.js.
import {
  PLAYBOOK_REPEATS, STEP_ACTIONS, OFFSET_UNITS, STEP_OWNERS, MAX_STEPS, PLAYBOOK_NAME_MAX, STEP_TITLE_MAX, STAGE_MAX, RUN_NAME_MAX,
  STEP_COPY_FIELDS, OFFSET_LIMITS, stepDate, stepOwner, offerSkipReason, stepTaskFields, actionOf, repeatOf, monthLabel, byPosition,
  stagesOf, runStatus, isActiveRun, isOpenRun, unitOf, hasOfferCondition,
} from '@suite/shared/playbooks';
import { ESTIMATE_MAX_MINUTES } from '@suite/shared/planner';
import { formatDate } from '../../ui/format.js';
import { KIND_LABELS, PERIOD_LABELS, parseDollars, centsToInput, textOrNull } from '../crm/logic.js';

export const OFFSET_UNIT_LABELS = Object.freeze({ days: 'days', weeks: 'weeks', months: 'months', years: 'years' });
export const ACTION_LABELS = Object.freeze({ task: 'A task', renewal: 'Set a renewal date on the client’s service' });
export { stagesOf, byPosition, runStatus, isActiveRun, isOpenRun };

const ok = (fields) => ({ fields, problems: {} });
const intOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

// ---- forms -------------------------------------------------------------------------------------------

export const playbookForm = {
  defaults: { name: '', business_id: '', repeat: 'once', for_client: true, kind: '', description: '', archived: false },
  fromRecord: (v, record) => ({
    ...v,
    repeat: repeatOf(record ?? v),
    for_client: record ? Boolean(record.for_client) : v.for_client,
    archived: Boolean(record?.archived),
  }),
  toFields(v) {
    const problems = {};
    if (!textOrNull(v.name)) problems.name = 'Give it a name';
    if (String(v.name ?? '').trim().length > PLAYBOOK_NAME_MAX) problems.name = `At most ${PLAYBOOK_NAME_MAX} characters`;
    if (!v.business_id) problems.business_id = 'Pick one of our businesses';
    return {
      problems,
      fields: {
        name: textOrNull(v.name), business_id: v.business_id || null, repeat: PLAYBOOK_REPEATS.includes(v.repeat) ? v.repeat : 'once',
        for_client: Boolean(v.for_client), kind: v.for_client && v.kind ? v.kind : null, description: textOrNull(v.description),
        archived: Boolean(v.archived),
      },
    };
  },
};

export const stepForm = {
  defaults: {
    title: '', stage: '', action: 'task', offset_amount: '0', offset_unit: 'days', owner: 'runner', estimate_minutes: '', notes: '', links: '',
    service_name: '', service_period: 'yearly', service_amount: '', offer: false, only_if_lacks_business: '', only_if_lacks_kind: '',
    position: '',
  },
  fromRecord: (v, record) => ({
    ...v,
    action: actionOf(record ?? v),
    offset_amount: record ? String(record.offset_amount ?? 0) : v.offset_amount,
    offset_unit: record ? unitOf(record) : v.offset_unit,
    owner: STEP_OWNERS.includes(record?.owner) ? record.owner : v.owner,
    estimate_minutes: record?.estimate_minutes ?? v.estimate_minutes,
    service_period: record?.service_period ?? v.service_period,
    service_amount: centsToInput(record?.service_amount_cents),
    offer: record ? hasOfferCondition(record) : v.offer,
  }),
  toFields(v) {
    const problems = {};
    const title = textOrNull(v.title);
    const renewal = v.action === 'renewal';
    if (!title) problems.title = renewal ? 'Name it (e.g. Hosting renewal)' : 'What is the task?';
    else if (title.length > STEP_TITLE_MAX) problems.title = `At most ${STEP_TITLE_MAX} characters`;
    if (String(v.stage ?? '').trim().length > STAGE_MAX) problems.stage = `At most ${STAGE_MAX} characters`;
    const unit = OFFSET_UNITS.includes(v.offset_unit) ? v.offset_unit : 'days';
    const offset = String(v.offset_amount ?? '').trim() === '' ? 0 : Number(v.offset_amount);
    if (!Number.isInteger(offset) || Math.abs(offset) > OFFSET_LIMITS[unit]) problems.offset_amount = `A whole number, at most ${OFFSET_LIMITS[unit]} ${unit} either way`;
    const est = intOrNull(v.estimate_minutes);
    if (est !== null && !(Number.isInteger(est) && est >= 1 && est <= ESTIMATE_MAX_MINUTES)) problems.estimate_minutes = 'Minutes, 1 to a week';
    if (renewal && !textOrNull(v.service_name)) problems.service_name = 'Which service renews (e.g. Hosting)?';
    const amount = renewal ? parseDollars(v.service_amount) : null;
    if (Number.isNaN(amount)) problems.service_amount = 'Enter dollars, like 300';
    if (!renewal && v.offer && (!v.only_if_lacks_business || !v.only_if_lacks_kind)) problems.offer = 'Pick the business and the kind of service';
    const offer = !renewal && v.offer && v.only_if_lacks_business && v.only_if_lacks_kind;
    return {
      problems,
      fields: {
        position: intOrNull(v.position), title, stage: textOrNull(v.stage), action: renewal ? 'renewal' : 'task', offset_amount: Number.isInteger(offset) ? offset : 0,
        offset_unit: unit, owner: renewal ? null : (STEP_OWNERS.includes(v.owner) ? v.owner : 'runner'),
        estimate_minutes: renewal ? null : est, notes: textOrNull(v.notes), links: textOrNull(v.links),
        service_name: renewal ? textOrNull(v.service_name) : null, service_period: renewal ? (v.service_period || 'yearly') : null,
        service_amount_cents: renewal ? amount : null,
        only_if_lacks_business: offer ? v.only_if_lacks_business : null, only_if_lacks_kind: offer ? v.only_if_lacks_kind : null,
      },
    };
  },
};

export const runForm = {
  defaults: { name: '', end_date: '', notes: '', start_date: '' },
  toFields(v) {
    const problems = {};
    if (!textOrNull(v.name)) problems.name = 'Give it a name';
    if (v.end_date && v.start_date && v.end_date < v.start_date) problems.end_date = 'On or after the start';
    return { problems, fields: { name: textOrNull(v.name), end_date: v.end_date || null, notes: textOrNull(v.notes) } };
  },
};

// ---- examples and copies -----------------------------------------------------------------------------

/** A playbook's fields and its steps' fields from an example (EXAMPLE_PLAYBOOKS), positions 1…n. */
export function exampleRecords(example) {
  return {
    playbook: {
      name: example.name, business_id: example.business_id, repeat: example.repeat, for_client: example.for_client,
      kind: example.kind ?? null, description: example.description ?? null, archived: false,
    },
    steps: example.steps.map((s, i) => ({ position: i + 1, ...s })),
  };
}

/** The step's position to give a new step at the end. */
export const nextPosition = (steps) => steps.reduce((m, s) => Math.max(m, s.position ?? 0), 0) + 1;

/**
 * Moving a step up or down: the position updates to send (only the steps whose position changes; gaps
 * and ties — two devices adding at once — are closed by renumbering 1…n in the current order).
 */
export function reorderChanges(steps, id, dir) {
  const list = [...steps].sort(byPosition);
  const i = list.findIndex((s) => s.id === id);
  const j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return [];
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((s, k) => ({ id: s.id, position: k + 1 })).filter((c, k) => list[k].position !== c.position);
}

// ---- running a playbook --------------------------------------------------------------------------------

/** The run's choices that decide what it makes: another choice after a failed try gets new ids. */
export const runChoiceKey = ({ clientId = '', accountId = '', startDate = '', owner = '', endDate = '' } = {}) => [clientId, accountId, startDate, owner, endDate].join('|');

const runStoreKey = (playbookId) => `suite.playbooks.runIds.${playbookId}`;
/**
 * The ids for one run of this playbook with these choices, kept in `storage` (localStorage) until the run
 * is saved: a retry after a failure part-way, a double tap or a reload re-uses them (a create already made
 * answers already_exists = done) — never a second run. Another choice gets new ids. Steps added since get
 * theirs too.
 */
export function keptRunIds(storage, playbookId, choice, stepIds, newId, memory = new Map()) {
  const key = runChoiceKey(choice);
  let kept = null;
  try { kept = JSON.parse(storage?.getItem(runStoreKey(playbookId)) ?? 'null'); } catch { kept = null; }
  kept ??= memory.get(playbookId) ?? null;
  const fresh = kept?.key === key && kept.ids?.run ? kept : { key, ids: { run: newId(), relationship: newId(), steps: {} } };
  fresh.choice = { ...choice }; // so an unfinished run can be finished from its page
  for (const sid of stepIds) fresh.ids.steps[sid] ??= { runStep: newId(), task: newId(), service: newId() };
  memory.set(playbookId, fresh);
  try { storage?.setItem(runStoreKey(playbookId), JSON.stringify(fresh)); } catch { /* best effort: memory still has them */ }
  return fresh.ids;
}

/** The kept ids and choice of an unfinished run on this device (its page offers "Finish it"), or null. */
export function keptRunFor(storage, playbookId, runId) {
  try {
    const kept = JSON.parse(storage?.getItem(runStoreKey(playbookId)) ?? 'null');
    return kept?.ids?.run === runId && kept.choice ? kept : null;
  } catch { return null; }
}

export function forgetRunIds(storage, playbookId, memory = new Map()) {
  memory.delete(playbookId);
  try { storage?.removeItem(runStoreKey(playbookId)); } catch { /* fine */ }
}

const kindText = (k) => KIND_LABELS[k] ?? k;
/** The latest change among records (their pulled `updatedAt`), or null — a run's "as of" (the playbook and its steps). */
export function latestChange(records) {
  const times = records.map((r) => r?._sync?.updatedAt).filter(Boolean).sort();
  return times.at(-1) ?? null;
}
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const OPEN_SERVICE = (s) => !['done', 'cancelled'].includes(s.status);

/**
 * Running a playbook, as ordered store writes (pure). Writes nothing itself.
 * @param {object} p
 * @param {object} p.playbook  the playbook record
 * @param {object[]} p.steps   its live steps
 * @param {{ name, startDate, clientId, accountId, owner, endDate }} p.choice  owner: '' (as each step says) | owner | partner | shared
 * @param {string} p.me        who runs it (owner | partner)
 * @param {object} p.ids       keptRunIds(…)
 * @param {object} p.data      { businessesById, accountsById, relationships, services } — the device's live CRM records
 * → { problems, writes: [{ op, entity, id, fields, send? }], preview: { relationship, items } }
 *   preview.relationship: null | { action: 'use' | 'create' | 'restart', kind, businessId }
 *   preview.items: [{ stepId, title, stage, kind: 'task' | 'renewal' | 'skipped', date, owner, why, service }]
 */
export function planRun({ playbook, steps, choice, me, ids, data }) {
  const problems = {};
  const ordered = [...steps].sort(byPosition);
  const forClient = Boolean(playbook.for_client);
  const name = textOrNull(choice.name);
  if (!name) problems.name = 'Give the run a name';
  else if (name.length > RUN_NAME_MAX) problems.name = `At most ${RUN_NAME_MAX} characters`;
  if (!choice.startDate) problems.startDate = 'When does it start?';
  if (!ordered.length) problems.steps = 'This playbook has no steps yet';
  if (ordered.length > MAX_STEPS) problems.steps = `A playbook can have at most ${MAX_STEPS} steps`;
  const account = forClient && choice.accountId ? data.accountsById.get(choice.accountId) ?? null : null;
  if (forClient && !choice.clientId) problems.client = 'Pick the client';
  else if (forClient && !account) problems.account = 'Pick their account (add one on the client page if they have none)';
  const monthly = repeatOf(playbook) === 'monthly';
  if (monthly && choice.endDate && choice.startDate && choice.endDate < choice.startDate) problems.endDate = 'On or after the start';
  if (Object.keys(problems).length) return { problems, writes: [], preview: null };

  const business = data.businessesById.get(playbook.business_id) ?? null;
  const businessName = (id) => data.businessesById.get(id)?.name ?? 'that business';
  const start = choice.startDate;
  const writes = [];
  const made = []; // what the run makes or changes in the client's records (the run's `made`: to take back an extra)

  // The relationship the run works on: the account's with our business (and the playbook's kind) —
  // an active one first; a paused or ended one is made active again; none and a kind known → a new one.
  let relationship = null;
  let relPreview = null;
  const accountRels = account ? data.relationships.filter((r) => r.account_id === account.id) : [];
  if (account) {
    const mine = accountRels.filter((r) => r.business_id === playbook.business_id && (!playbook.kind || r.kind === playbook.kind));
    const found = mine.find((r) => r.status === 'active') ?? mine[0] ?? null;
    if (found) {
      relationship = found;
      if (found.id === ids.relationship) {
        // Made by an earlier try of this same run (a retry): still this run's own.
        relPreview = { action: 'create', kind: found.kind, businessId: found.business_id };
        made.push(`relationship:${found.id}`);
      } else {
        relPreview = { action: found.status === 'active' ? 'use' : 'restart', kind: found.kind, businessId: found.business_id };
        if (found.status !== 'active') {
          writes.push({ op: 'update', entity: 'relationship', id: found.id, fields: { status: 'active' } });
          made.push(`restarted:relationship:${found.id}`);
        }
      }
    } else if (playbook.kind) {
      made.push(`relationship:${ids.relationship}`);
      relationship = { id: ids.relationship, account_id: account.id, business_id: playbook.business_id, kind: playbook.kind, status: 'active', start_date: start };
      relPreview = { action: 'create', kind: playbook.kind, businessId: playbook.business_id };
      writes.push({
        op: 'create', entity: 'relationship', id: ids.relationship,
        fields: { account_id: account.id, business_id: playbook.business_id, kind: playbook.kind, status: 'active', start_date: start },
      });
    }
  }
  const relsForOffers = relationship && !accountRels.some((r) => r.id === relationship.id) ? [...accountRels, relationship] : accountRels;

  const runFields = {
    playbook_id: playbook.id, name, business_id: playbook.business_id, repeat: monthly ? 'monthly' : 'once',
    client_id: forClient ? choice.clientId : null, account_id: account?.id ?? null, relationship_id: relationship?.id ?? null,
    // Created `starting`; the LAST write makes it active (review fix): a save that stopped part-way shows as unfinished.
    start_date: start, end_date: monthly ? (choice.endDate || null) : null, owner: choice.owner || null, runner: me, status: 'starting',
    playbook_as_of: latestChange([playbook, ...ordered]), playbook_name: playbook.name, notes: null, made: null,
  };
  const run = { id: ids.run, ...runFields };
  writes.push({ op: 'create', entity: 'playbook_run', id: ids.run, fields: runFields });

  const cycle = monthly ? { start, label: monthLabel(start) } : null;
  const services = relationship ? data.services.filter((s) => s.relationship_id === relationship.id && OPEN_SERVICE(s)) : [];
  const items = [];
  const runStepWrites = [];
  const after = [];
  for (const step of ordered) {
    const sid = ids.steps[step.id];
    const copy = Object.fromEntries(STEP_COPY_FIELDS.map((k) => [k, step[k] ?? null]));
    const date = stepDate(start, step);
    let outcome;
    let note = null;
    if (actionOf(step) === 'renewal') {
      if (!relationship) {
        outcome = 'skipped';
        note = 'No client relationship to put the renewal on';
        items.push({ stepId: step.id, title: step.title, stage: step.stage ?? '', kind: 'skipped', date, why: note });
      } else {
        outcome = 'renewal';
        const existing = services.find((s) => sameName(s.name, step.service_name));
        const ours = existing && existing.id === sid.service; // made by an earlier try of this run
        const from = existing && !ours ? existing.renewal_date ?? null : null;
        // A later date already on their service is left alone unless the person chooses to move it (review fix).
        const keepLater = Boolean(from && from > date && !choice.moveLaterRenewals);
        note = !existing || ours ? `Adds ${step.service_name}, renewing on ${formatDate(date)}`
          : keepLater ? `${step.service_name} already renews on ${formatDate(from)} (later): left as it is`
            : from && from !== date ? `Moves ${step.service_name}’s renewal from ${formatDate(from)} to ${formatDate(date)}`
              : `Sets ${step.service_name}, renewing on ${formatDate(date)}`;
        if (ours) made.push(`service:${existing.id}`);
        else if (existing) {
          if (!keepLater && existing.renewal_date !== date) {
            after.push({ op: 'update', entity: 'service', id: existing.id, fields: { renewal_date: date } });
            made.push(`renewal:${existing.id}:${from ?? 'none'}`);
          }
        } else {
          made.push(`service:${sid.service}`);
          const svc = {
            relationship_id: relationship.id, name: step.service_name, status: 'active',
            billing: step.service_amount_cents !== null && step.service_amount_cents !== undefined ? 'flat' : null,
            amount_cents: step.service_amount_cents ?? null, period: step.service_period ?? 'yearly', start_date: start, renewal_date: date,
          };
          services.push({ id: sid.service, ...svc });
          after.push({ op: 'create', entity: 'service', id: sid.service, fields: svc });
        }
        items.push({
          stepId: step.id, title: step.title, stage: step.stage ?? '', kind: 'renewal', date, service: step.service_name,
          existing: Boolean(existing && !ours), from: from && from !== date ? from : null, keptLater: keepLater,
        });
      }
    } else {
      const why = offerSkipReason(step, { account, relationships: relsForOffers, businessName, kindLabel: kindText });
      if (why) {
        outcome = 'skipped';
        note = why;
        items.push({ stepId: step.id, title: step.title, stage: step.stage ?? '', kind: 'skipped', date, why });
      } else {
        outcome = 'task';
        const owner = stepOwner(step, { runner: me, business, override: choice.owner || null });
        const fields = stepTaskFields({ step: { ...copy, id: sid.runStep }, run, owner, cycle, playbookName: playbook.name, businessName });
        after.push({ op: 'create', entity: 'task', id: sid.task, fields });
        items.push({ stepId: step.id, title: fields.title, stage: step.stage ?? '', kind: 'task', date, owner });
      }
    }
    runStepWrites.push({ op: 'create', entity: 'run_step', id: sid.runStep, fields: { run_id: ids.run, step_id: step.id, ...copy, outcome, outcome_note: note } });
  }
  // Services before tasks: a task names the relationship, which exists by then either way.
  after.sort((a, b) => (a.entity === 'task') - (b.entity === 'task'));
  runFields.made = made.length ? made.join(' ') : null;
  // The last write: the run is under way only once everything before it is saved.
  const finish = { op: 'update', entity: 'playbook_run', id: ids.run, fields: { status: 'active' } };
  return { problems: {}, writes: [...writes, ...runStepWrites, ...after, finish], preview: { relationship: relPreview, items } };
}

/**
 * Save a planned run, in order. A create that already exists (a retry after a failure part-way, or a
 * double tap) answers already_exists and counts as done. Works offline.
 */
export async function applyRun(store, plan) {
  for (const w of plan.writes) {
    if (w.op === 'create') {
      try {
        await store.create(w.entity, w.fields, { id: w.id });
      } catch (err) {
        if (err?.code !== 'already_exists') throw err;
      }
    } else {
      await store.update(w.entity, w.id, w.fields);
    }
  }
  return plan;
}

/** "Website launch — Lefty’s" (or the playbook's name alone with no client). */
export const defaultRunName = (playbook, account) => (account ? `${playbook.name} — ${account.name}` : playbook.name);

/** What the preview's relationship line says. */
export function relationshipLine(rel, businessName) {
  if (!rel) return null;
  const what = `${businessName(rel.businessId)} · ${kindText(rel.kind)}`;
  if (rel.action === 'create') return `Adds the relationship ${what}`;
  if (rel.action === 'restart') return `Makes the relationship ${what} active again`;
  return `Works on the relationship ${what}`;
}

// ---- a run's checklist ---------------------------------------------------------------------------------

/**
 * A run's checklist by stage: its own copy of the steps in order, each with the tasks it made (from any
 * month) — done or open, skipped with why, renewal with what it set. The current stage is the first with
 * an open task; done/total count tasks.
 * → { stages: [{ stage, items: [{ step, tasks }] }], done, total, current, allDone, nextTask }
 */
export function runChecklist(runSteps, tasks) {
  const byStep = new Map();
  for (const t of tasks) if (t.run_step_id) byStep.set(t.run_step_id, [...(byStep.get(t.run_step_id) ?? []), t]);
  const ordered = [...runSteps].sort(byPosition);
  const stages = stagesOf(ordered).map((stage) => ({
    stage,
    items: ordered.filter((s) => (s.stage ?? '') === stage).map((step) => ({
      step,
      tasks: [...(byStep.get(step.id) ?? [])].sort((a, b) => String(a.due_date ?? '').localeCompare(String(b.due_date ?? ''))),
    })),
  }));
  const all = tasks.filter((t) => t.run_step_id);
  const done = all.filter((t) => t.done_at).length;
  const current = stages.find((g) => g.items.some((i) => i.tasks.some((t) => !t.done_at)))?.stage ?? null;
  const open = all.filter((t) => !t.done_at).sort((a, b) => String(a.due_date ?? '9999').localeCompare(String(b.due_date ?? '9999')));
  return { stages, done, total: all.length, current, allDone: all.length > 0 && done === all.length, nextTask: open[0] ?? null };
}

/** "3 of 7 done · now: Launch" (or "All done", "Nothing to do"). */
export function progressText({ done, total, current, allDone }) {
  if (!total) return 'No tasks';
  if (allDone) return `All ${total} done`;
  return `${done} of ${total} done${current ? ` · now: ${current}` : ''}`;
}

/** A step's line on the playbook page: when, who, what it does. */
export function stepSummary(step, { businessName = () => 'that business' } = {}) {
  const parts = [];
  const n = step.offset_amount ?? 0;
  const unit = unitOf(step);
  parts.push(n === 0 ? 'On the start day' : `${Math.abs(n)} ${n === 1 || n === -1 ? unit.replace(/s$/, '') : unit} ${n > 0 ? 'after' : 'before'} the start`);
  if (actionOf(step) === 'renewal') {
    parts.push(`renewal date of ${step.service_name ?? 'a service'} (${(PERIOD_LABELS[step.service_period] ?? 'Yearly').toLowerCase()})`);
  } else {
    parts.push({ runner: 'whoever runs it', business: 'the business’s default owner', owner: 'Owner', partner: 'Partner', shared: 'shared list' }[step.owner ?? 'runner']);
    if (hasOfferCondition(step)) parts.push(`only if they don’t have ${businessName(step.only_if_lacks_business)} · ${kindText(step.only_if_lacks_kind)}`);
  }
  return parts.join(' · ');
}

/** The runs to show for a client (newest start first), with their checklists. */
export function clientRuns(runs, clientId) {
  return runs.filter((r) => r.client_id === clientId).sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)) || (a.id < b.id ? 1 : -1));
}

export { STEP_ACTIONS };

// ---- runs made twice (review fix) --------------------------------------------------------------------

/** Open runs (under way or not finished) of this playbook for this account — "Already under way" on the Run sheet. */
export function runsUnderWay(runs, playbookId, accountId) {
  if (!accountId) return [];
  return runs.filter((r) => r.playbook_id === playbookId && r.account_id === accountId && isOpenRun(r))
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
}

/**
 * Runs made twice: live runs of the same playbook for the same account and start day (two devices running
 * it offline at once — on one device the ids kept per choice prevent it). The first made (UUIDv7 order) is
 * kept; the others are the extras. → Map<run id, { kept, extras }> for every run in such a group.
 */
export function duplicateRuns(runs) {
  const groups = new Map();
  for (const r of runs) {
    if (!r.playbook_id || !r.account_id) continue;
    const k = `${r.playbook_id}|${r.account_id}|${r.start_date}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out = new Map();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
    const g = { kept: sorted[0], extras: sorted.slice(1) };
    for (const r of list) out.set(r.id, g);
  }
  return out;
}

/** "relationship:<id> service:<id> restarted:relationship:<id> renewal:<id>:<old>" → [{ kind, entity, id, old }]. */
export function runMade(run) {
  return String(run?.made ?? '').split(/\s+/).filter(Boolean).map((t) => {
    const p = t.split(':');
    if (p[0] === 'restarted') return { kind: 'restarted', entity: p[1], id: p[2] };
    if (p[0] === 'renewal') return { kind: 'renewal', entity: 'service', id: p[1], old: p[2] === 'none' ? null : p[2] };
    return { kind: 'made', entity: p[0], id: p[1] };
  });
}

// Edited since it was made (D8's rule): on the server (pulled times differ), or a change here not sent yet.
const changedSince = (r) => Boolean(r?._sync?.pending || r?._sync?.local
  || (r?._sync?.updatedAt && r?._sync?.createdAt && r._sync.updatedAt !== r._sync.createdAt));

/**
 * What taking back an extra run does (D8's extraWinPlan in spirit), on the device's copy: its open tasks
 * that nobody changed, the services it added and the relationship it added — each only while untouched and
 * unused by anything else (another run, a task not its own, a service it didn't add, a resold cost) —
 * then the run itself (its copies of the steps go with it). Whatever stays is listed with why. Pure.
 * d: { runs, tasks, relationships, services, costs } (live records).
 * → { remove: [{ entity, id, name }], left: [string] }
 */
export function extraRunPlan(run, d) {
  const remove = [];
  const left = [];
  const made = runMade(run);
  const byId = (list, id) => (list ?? []).find((r) => r.id === id) ?? null;
  const own = (d.tasks ?? []).filter((t) => t.run_id === run.id);
  const keepTasks = own.filter((t) => t.done_at || changedSince(t));
  for (const t of own) if (!keepTasks.includes(t)) remove.push({ entity: 'task', id: t.id, name: `the task “${t.title}”` });
  if (keepTasks.length) left.push(`${keepTasks.length} of its tasks stay: done or changed since (${keepTasks.map((t) => `“${t.title}”`).join(', ')}).`);
  const madeServices = made.filter((m) => m.kind === 'made' && m.entity === 'service').map((m) => byId(d.services, m.id)).filter(Boolean);
  const keptServices = [];
  for (const svc of madeServices) {
    if (changedSince(svc)) {
      keptServices.push(svc);
      left.push(`The service “${svc.name}” stays: it was edited.`);
    } else remove.push({ entity: 'service', id: svc.id, name: `the service “${svc.name}”` });
  }
  for (const m of made.filter((x) => x.kind === 'made' && x.entity === 'relationship')) {
    const rel = byId(d.relationships, m.id);
    if (!rel) continue;
    const why = [];
    if (changedSince(rel)) why.push('it was edited');
    for (const r of (d.runs ?? []).filter((x) => x.id !== run.id && x.relationship_id === rel.id)) why.push(`the run “${r.name}” works on it`);
    for (const svc of (d.services ?? []).filter((x) => x.relationship_id === rel.id && !madeServices.includes(x))) why.push(`the service “${svc.name}”`);
    for (const svc of keptServices) why.push(`the service “${svc.name}”`);
    for (const c of (d.costs ?? []).filter((x) => x.relationship_id === rel.id)) why.push(`the resold cost “${c.name}”`);
    for (const t of (d.tasks ?? []).filter((x) => x.relationship_id === rel.id && x.run_id !== run.id)) why.push(`the task “${t.title}”`);
    for (const t of keepTasks.filter((x) => x.relationship_id === rel.id)) why.push(`its task “${t.title}”`);
    const reasons = [...new Set(why)];
    if (reasons.length) left.push(`The relationship it added stays: ${reasons.join(', ')}.`);
    else remove.push({ entity: 'relationship', id: rel.id, name: 'the relationship it added' });
  }
  if (made.some((m) => m.kind === 'restarted')) left.push('A relationship it made active again stays active.');
  for (const m of made.filter((x) => x.kind === 'renewal')) {
    const svc = byId(d.services, m.id);
    if (svc) left.push(`The renewal date it set on “${svc.name}” stays (${svc.renewal_date ?? 'none'}${m.old ? `; it was ${m.old}` : ''}).`);
  }
  remove.push({ entity: 'playbook_run', id: run.id, name: `the run “${run.name}”` });
  return { remove, left };
}

const FIX_ENTITIES = ['playbook_run', 'task', 'relationship', 'service', 'recurring_cost'];
/** What extraRunPlan reads, from the device's copy (unsent changes included). */
export async function runFixData(engine) {
  const l = await engine.listMany(FIX_ENTITIES);
  return { runs: l.playbook_run, tasks: l.task, relationships: l.relationship, services: l.service, costs: l.recurring_cost };
}

/**
 * Delete the extra of a run made twice (`runId` = any run of the group). First syncs and re-reads (so what
 * the other device and this one did meanwhile counts), plans each extra and removes what it may, syncs
 * again and re-reads each removed record: one the server kept (changed on the other device: a
 * delete-vs-edit clash keeps it) is reported "Kept". Needs a connection to be sure; offline it still
 * removes what it may and the re-read reports nothing kept.
 * @returns {Promise<{ removed: object[], kept: object[], left: string[] }>}
 */
export async function removeExtraRuns(engine, runId) {
  await engine.syncNow('run-twice');
  const d = await runFixData(engine);
  const group = duplicateRuns(d.runs).get(runId);
  const out = { removed: [], kept: [], left: [] };
  if (!group) return out;
  const done = [];
  for (const run of group.extras) {
    const plan = extraRunPlan(run, d);
    const removed = [];
    for (const r of plan.remove) {
      try {
        await engine.remove(r.entity, r.id);
        removed.push(r);
      } catch (err) {
        if (err?.code !== 'not_found') throw err; // already gone (hidden with something removed before it)
      }
    }
    done.push({ plan, removed });
  }
  await engine.syncNow('run-twice');
  for (const { plan, removed } of done) {
    for (const r of removed) ((await engine.get(r.entity, r.id)) ? out.kept : out.removed).push(r);
    out.left.push(...plan.left);
  }
  out.left.push(...out.kept.map((r) => `Kept: ${r.name} was changed on the other device.`));
  return out;
}
