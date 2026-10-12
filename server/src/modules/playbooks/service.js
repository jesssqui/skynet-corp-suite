// Projects and playbooks (D9): registers the four record types with sync (with the module's own checks),
// reads runs for other modules, and registers the automation that makes a repeating run's later months
// (automations.js). Running a playbook happens on the device, offline (the client's planRun/applyRun):
// the run, its copy of the steps, the tasks and the renewal dates are ordinary sync steps. This module
// never writes its tables itself except through sync (the guard makes any other write fail), and reads
// only its own tables; CRM records and tasks through their services. See CLAUDE.md, "Projects and
// playbooks (D9)".
import { isOffset, OFFSET_UNITS } from '@suite/shared/playbooks';
import { ESTIMATE_MAX_MINUTES } from '@suite/shared/planner';
import { PLAYBOOK_ENTITIES } from './entities.js';
import { registerPlaybookAutomations } from './automations.js';

const has = (fields, k) => Object.hasOwn(fields, k) && fields[k] !== null && fields[k] !== undefined;

/**
 * A step's rules (the playbook's and the run's copy), right in any arrival order: an offset within ten
 * years in its unit (the step's unit, else the stored one, else days), an estimate of 1 minute to a week,
 * a service amount of 0 or more.
 */
export function checkStepFields({ op, fields, current }) {
  if (op === 'delete' || !fields) return null;
  if (has(fields, 'offset_amount') || has(fields, 'offset_unit')) {
    // Either half may change alone (review fix): check the pair as the step leaves it.
    const unit = OFFSET_UNITS.includes(fields.offset_unit) ? fields.offset_unit : (OFFSET_UNITS.includes(current?.offset_unit) ? current.offset_unit : 'days');
    const amount = Object.hasOwn(fields, 'offset_amount') ? fields.offset_amount : current?.offset_amount;
    if (amount !== null && amount !== undefined && !isOffset(amount, unit)) {
      return { code: 'invalid_value', reason: 'offset_amount: at most ten years before or after the start' };
    }
  }
  if (has(fields, 'estimate_minutes') && !(fields.estimate_minutes >= 1 && fields.estimate_minutes <= ESTIMATE_MAX_MINUTES)) {
    return { code: 'invalid_value', reason: 'estimate_minutes: 1 minute to a week' };
  }
  if (has(fields, 'service_amount_cents') && !(fields.service_amount_cents >= 0)) return { code: 'invalid_value', reason: 'service_amount_cents: 0 or more' };
  return null;
}

/** A run ends on or after its start (both as the step leaves them). */
export function checkRun({ op, fields, current }) {
  if (op === 'delete' || !fields) return null;
  const start = has(fields, 'start_date') ? fields.start_date : current?.start_date ?? null;
  const end = Object.hasOwn(fields, 'end_date') ? fields.end_date : current?.end_date ?? null;
  if (start && end && end < start) return { code: 'invalid_value', reason: 'end_date: on or after the start date' };
  return null;
}

const CHECKS = { playbook_step: checkStepFields, run_step: checkStepFields, playbook_run: checkRun };

const asBool = (v) => (v === null || v === undefined ? null : v === 1);

export function createPlaybooksService({ db, services, log }) {
  const { sync, crm, planner } = services;
  if (!sync) throw new Error('playbooks needs the sync module registered before it (modules/index.js)');
  if (!crm || !planner) {
    // Test set-ups without the CRM (the sync engine's own tests): nothing to register — a playbook's
    // records point at our businesses and its runs make tasks.
    log?.info?.('playbooks: no crm/planner module, so no playbooks');
    return { enabled: false };
  }
  for (const e of PLAYBOOK_ENTITIES) sync.registerEntity({ module: 'playbooks', ...e, ...(CHECKS[e.entity] ? { check: CHECKS[e.entity] } : {}) });

  const q = {
    playbook: db.prepare('SELECT * FROM playbooks_playbooks WHERE id = ? AND deleted_at IS NULL'),
    run: db.prepare('SELECT * FROM playbooks_runs WHERE id = ? AND deleted_at IS NULL'),
    repeating: db.prepare(`SELECT * FROM playbooks_runs WHERE deleted_at IS NULL AND repeat = 'monthly'
      AND (status IS NULL OR status = 'active') ORDER BY start_date, id`),
    active: db.prepare(`SELECT * FROM playbooks_runs WHERE deleted_at IS NULL AND (status IS NULL OR status = 'active')
      ORDER BY start_date, id`),
    runSteps: db.prepare('SELECT * FROM playbooks_run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position, id'),
  };

  const reads = {
    /** One live playbook (booleans as true/false), or null. */
    playbook(id) {
      const r = q.playbook.get(id);
      return r ? { ...r, for_client: asBool(r.for_client), archived: asBool(r.archived) } : null;
    },
    /** One live run, or null. */
    run: (id) => q.run.get(id) ?? null,
    /** Live repeating runs that are under way (not done or stopped), oldest start first. */
    repeatingRuns: () => q.repeating.all(),
    /** Live runs under way (projects, jobs, retainers), oldest start first — for the overview (D15). */
    activeRuns: () => q.active.all(),
    /** A run's own copy of its steps, in order. */
    runSteps: (runId) => q.runSteps.all(runId),
  };

  if (services.automations) registerPlaybookAutomations({ automations: services.automations, crm, planner, reads });
  return { enabled: true, ...reads };
}
