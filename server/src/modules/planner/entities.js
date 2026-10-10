// The planner's synced record types: tasks and inbox items (C4a); goals (week goals and month
// priorities), each task's goal and each person's workday (C4b). Registered with the sync module
// at start-up; devices learn them from GET /api/sync/info. New fields are nullable and never
// renamed (CLAUDE.md, rule 5): old devices' steps without them still apply.
//
// Refs are global entity names (the CRM's `business`, `client`, `account`, `relationship`): a task
// belongs to one of our businesses (`parent`; businesses are never deleted) and only *points at*
// a client / account / relationship, so deleting a client never hides the person's tasks.
import { ACTORS, OWNERS } from '@suite/shared/actors';
import { INBOX_SOURCES, TASK_TITLE_MAX, INBOX_TEXT_MAX, GOAL_KINDS, GOAL_TITLE_MAX } from '@suite/shared/planner';

export const PLANNER_ENTITIES = [
  {
    entity: 'task',
    table: 'planner_tasks',
    // Delete is for mistakes; finishing sets done_at.
    ops: ['create', 'update', 'delete'],
    fields: {
      title: { type: 'text', max: TASK_TITLE_MAX, required: true },
      notes: { type: 'text', max: 20_000 },
      owner: { type: 'enum', values: OWNERS, required: true },
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      client_id: { type: 'id', ref: 'client' },
      account_id: { type: 'id', ref: 'account' },
      relationship_id: { type: 'id', ref: 'relationship' },
      due_date: { type: 'date' },
      due_time: { type: 'text', max: 5 }, // "HH:MM" (checked by the module), only with a due date
      estimate_minutes: { type: 'integer' },
      done_at: { type: 'datetime' },
      // Today's top 3 is per person (each picks their own, a shared task may be in both): the day
      // it was picked by each actor (TOP_FIELDS in @suite/shared/planner).
      top_on_owner: { type: 'date' },
      top_on_partner: { type: 'date' },
      // C4b: the week goal or month priority it belongs to. A plain ref: deleting a goal never
      // hides its tasks (they become unplanned again).
      goal_id: { type: 'id', ref: 'goal' },
      // D8: the lead it is the next step for. A plain ref (deleting a lead never hides its tasks); an open
      // dated task naming a lead clears its "No next step" (leadsWithoutNextStep in @suite/shared/leads).
      lead_id: { type: 'id', ref: 'lead' },
    },
  },
  {
    entity: 'inbox_item',
    table: 'planner_inbox_items',
    ops: ['create', 'update', 'delete'],
    fields: {
      text: { type: 'text', max: INBOX_TEXT_MAX, required: true },
      source: { type: 'enum', values: INBOX_SOURCES },
      captured_at: { type: 'datetime', required: true },
      cleared_at: { type: 'datetime' },
      became_entity: { type: 'text', max: 40 },
      became_id: { type: 'id' }, // no ref: what it became may be deleted later
    },
  },
  {
    // C4b: a week goal (period = its Monday) or a month priority (period = the 1st of its month).
    entity: 'goal',
    table: 'planner_goals',
    ops: ['create', 'update', 'delete'],
    fields: {
      kind: { type: 'enum', values: GOAL_KINDS, required: true },
      period: { type: 'date', required: true }, // checked against kind by the module (checkGoal)
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      title: { type: 'text', max: GOAL_TITLE_MAX, required: true },
      target: { type: 'number' },
      progress: { type: 'number' },
      owner: { type: 'enum', values: OWNERS }, // the screens default it to whoever makes it
      notes: { type: 'text', max: 20_000 },
      done_at: { type: 'datetime' },
      position: { type: 'integer' },
      carried_from: { type: 'id' }, // no ref: the goal it was copied from may be deleted later
    },
  },
  {
    // C4b: one per person, fixed ids (WORKDAY_IDS), made by the server at start; never deleted.
    entity: 'workday',
    table: 'planner_workdays',
    ops: ['create', 'update'],
    fields: {
      actor: { type: 'enum', values: ACTORS, required: true },
      day_minutes: { type: 'integer' },
    },
  },
];

export const PLANNER_ENTITY = Object.fromEntries(PLANNER_ENTITIES.map((e) => [e.entity, e]));
