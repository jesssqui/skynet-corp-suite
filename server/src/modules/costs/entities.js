// The costs module's synced record type (D6): one recurring cost — what one of our businesses (or
// the home, under Personal) pays for. Registered with the sync module at start-up; devices learn it
// from GET /api/sync/info. New fields are nullable and never renamed (CLAUDE.md, rule 5).
//
// It belongs to one of our businesses (`parent`; businesses are never deleted). A resold cost
// points at the client relationship it is billed on — a plain ref, so deleting a client never
// hides what we pay for.
import { COST_PERIODS, COST_STATUSES, COST_NAME_MAX } from '@suite/shared/costs';

export const COST_ENTITY = {
  entity: 'recurring_cost',
  table: 'costs_recurring',
  // Delete is for mistakes; stopping one is status: cancelled.
  ops: ['create', 'update', 'delete'],
  fields: {
    name: { type: 'text', max: COST_NAME_MAX, required: true },
    business_id: { type: 'id', ref: 'business', parent: true, required: true },
    vendor: { type: 'text', max: 200 },
    amount_cents: { type: 'integer' },
    currency: { type: 'text', max: 3 }, // three capital letters (checked by the module); null = CAD
    period: { type: 'enum', values: COST_PERIODS, required: true },
    next_renewal: { type: 'date', required: true },
    payment_method: { type: 'text', max: 200 },
    auto_renews: { type: 'boolean' },
    status: { type: 'enum', values: COST_STATUSES }, // null = active
    notes: { type: 'text', max: 20_000 },
    relationship_id: { type: 'id', ref: 'relationship' },
    resold_amount_cents: { type: 'integer' },
  },
};
