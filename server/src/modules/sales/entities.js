// The sales module's synced record type: sale_day (C-sales). Registered with the sync module at
// start-up; devices learn it from GET /api/sync/info. New fields are nullable and never renamed
// (CLAUDE.md, rule 5).
import { SALES_CHANNEL_IDS, SALE_NOTE_MAX } from '@suite/shared/sales';

export const SALES_ENTITIES = [
  {
    // One channel's sales for one day. Deleting is for mistakes; a correction is an edit.
    entity: 'sale_day',
    table: 'sales_days',
    ops: ['create', 'update', 'delete'],
    fields: {
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      channel: { type: 'enum', values: SALES_CHANNEL_IDS, required: true },
      sale_date: { type: 'date', required: true },
      amount: { type: 'number', required: true },
      notes: { type: 'text', max: SALE_NOTE_MAX },
    },
  },
];

export const SALES_ENTITY = Object.fromEntries(SALES_ENTITIES.map((e) => [e.entity, e]));
