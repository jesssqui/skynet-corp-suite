// The planner's synced record types (C4a): tasks and inbox items. Registered with the sync module
// at start-up; devices learn them from GET /api/sync/info. C4b adds week goals and month
// priorities here (new entities, and a nullable goal field on task — never rename a field).
//
// Refs are global entity names (the CRM's `business`, `client`, `account`, `relationship`): a task
// belongs to one of our businesses (`parent`; businesses are never deleted) and only *points at*
// a client / account / relationship, so deleting a client never hides the person's tasks.
import { OWNERS } from '@suite/shared/actors';
import { INBOX_SOURCES, TASK_TITLE_MAX, INBOX_TEXT_MAX } from '@suite/shared/planner';

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
];

export const PLANNER_ENTITY = Object.fromEntries(PLANNER_ENTITIES.map((e) => [e.entity, e]));
