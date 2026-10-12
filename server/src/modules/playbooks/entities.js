// The playbooks module's synced record types (D9). Registered with the sync module at start-up; devices
// learn them from GET /api/sync/info. New fields are nullable and never renamed (CLAUDE.md, rule 5).
//
// A playbook belongs to one of our businesses (`parent`; businesses are never deleted) and its steps to
// it. A run belongs to its business too and only *points at* its playbook, client, account and
// relationship (plain refs: deleting a playbook or a client never hides a project, and the run keeps its
// own copy of the steps — `run_step`, append-only — so editing or deleting the playbook changes only
// future runs).
import { OWNERS, ACTORS } from '@suite/shared/actors';
import { RELATIONSHIP_KINDS, SERVICE_PERIODS } from '@suite/shared/crm';
import {
  PLAYBOOK_REPEATS, STEP_ACTIONS, OFFSET_UNITS, STEP_OWNERS, RUN_STATUSES, RUN_STEP_OUTCOMES,
  PLAYBOOK_NAME_MAX, STEP_TITLE_MAX, STAGE_MAX, STEP_TEXT_MAX, RUN_NAME_MAX,
} from '@suite/shared/playbooks';

/** The fields a step has — the playbook's own, and the run's copy of it (the same names, so copying is a spread). */
const STEP_FIELDS = {
  position: { type: 'integer' },
  title: { type: 'text', max: STEP_TITLE_MAX, required: true },
  stage: { type: 'text', max: STAGE_MAX },
  action: { type: 'enum', values: STEP_ACTIONS }, // null = task
  offset_amount: { type: 'integer' }, // after the start (negative = before), in offset_unit; null = 0
  offset_unit: { type: 'enum', values: OFFSET_UNITS }, // null = days
  owner: { type: 'enum', values: STEP_OWNERS }, // null = whoever runs it
  estimate_minutes: { type: 'integer' },
  notes: { type: 'text', max: STEP_TEXT_MAX },
  links: { type: 'text', max: STEP_TEXT_MAX }, // one per line: a web address, "file:<id>" (D10's files) or words
  // A renewal step: the client's service (by name) whose renewal date it sets — made when the relationship has none.
  service_name: { type: 'text', max: 200 },
  service_period: { type: 'enum', values: SERVICE_PERIODS },
  service_amount_cents: { type: 'integer' },
  // An offer: made only while the client's account lacks this business with this kind (D8's cross-sell rule).
  only_if_lacks_business: { type: 'id', ref: 'business' },
  only_if_lacks_kind: { type: 'enum', values: RELATIONSHIP_KINDS },
};

const stepFields = () => Object.fromEntries(Object.entries(STEP_FIELDS).map(([k, v]) => [k, { ...v }]));

export const PLAYBOOK_ENTITIES = [
  {
    entity: 'playbook',
    table: 'playbooks_playbooks',
    // Delete is for mistakes (runs keep their copy); archived hides one from the list.
    ops: ['create', 'update', 'delete'],
    fields: {
      name: { type: 'text', max: PLAYBOOK_NAME_MAX, required: true },
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      repeat: { type: 'enum', values: PLAYBOOK_REPEATS }, // null = once
      for_client: { type: 'boolean' },
      kind: { type: 'enum', values: RELATIONSHIP_KINDS },
      description: { type: 'text', max: STEP_TEXT_MAX },
      archived: { type: 'boolean' },
    },
  },
  {
    entity: 'playbook_step',
    table: 'playbooks_steps',
    ops: ['create', 'update', 'delete'],
    fields: {
      playbook_id: { type: 'id', ref: 'playbook', parent: true, required: true },
      ...stepFields(),
    },
  },
  {
    entity: 'playbook_run',
    table: 'playbooks_runs',
    // Delete is for a run made by mistake (its tasks stay; the run page offers to delete the open ones too).
    ops: ['create', 'update', 'delete'],
    fields: {
      playbook_id: { type: 'id', ref: 'playbook' },
      name: { type: 'text', max: RUN_NAME_MAX, required: true },
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      repeat: { type: 'enum', values: PLAYBOOK_REPEATS },
      client_id: { type: 'id', ref: 'client' },
      account_id: { type: 'id', ref: 'account' },
      relationship_id: { type: 'id', ref: 'relationship' },
      start_date: { type: 'date', required: true },
      end_date: { type: 'date' },
      owner: { type: 'enum', values: OWNERS },
      runner: { type: 'enum', values: ACTORS, required: true },
      status: { type: 'enum', values: RUN_STATUSES }, // null = active
      playbook_as_of: { type: 'datetime' },
      notes: { type: 'text', max: 20_000 },
    },
  },
  {
    // The run's own copy of a step, taken when it started: append-only, never edited.
    entity: 'run_step',
    table: 'playbooks_run_steps',
    appendOnly: true,
    fields: {
      run_id: { type: 'id', ref: 'playbook_run', parent: true, required: true },
      step_id: { type: 'id' }, // the playbook step it was copied from (no ref: it may be deleted later)
      ...stepFields(),
      outcome: { type: 'enum', values: RUN_STEP_OUTCOMES },
      outcome_note: { type: 'text', max: 500 },
    },
  },
];
