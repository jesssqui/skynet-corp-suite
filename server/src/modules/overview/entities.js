// The overview module's synced record type (D15): one monthly target of one of our businesses. Registered with the
// sync module at start-up; devices learn it from GET /api/sync/info and set targets offline on the monthly plan.
// New fields are nullable and never renamed (CLAUDE.md, rule 5).
//
// It belongs to one of our businesses (`parent`; businesses are never deleted). Its business, month and measure never
// change once made (checkTargetStep): a different one is a new target. Two devices setting the same one offline make
// two records — readers use the one changed last and offer to remove the other (pickTargets in @suite/shared/targets).
import { TARGET_MEASURES, TARGET_NOTES_MAX } from '@suite/shared/targets';

export const TARGET_ENTITY = {
  entity: 'target',
  table: 'overview_targets',
  ops: ['create', 'update', 'delete'],
  fields: {
    business_id: { type: 'id', ref: 'business', parent: true, required: true },
    month: { type: 'date', required: true },
    measure: { type: 'enum', values: TARGET_MEASURES, required: true },
    amount: { type: 'integer', required: true },
    currency: { type: 'text', max: 3 }, // money measures: three capital letters (checked); null = CAD
    notes: { type: 'text', max: TARGET_NOTES_MAX },
  },
};
