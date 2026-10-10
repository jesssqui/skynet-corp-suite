// The CRM's synced record types: what each holds, which values are allowed, what points to what.
// Registered with the sync module at start-up; devices learn them from GET /api/sync/info, so
// these definitions are the contract for C3b's screens, C4a's tasks and the D packages.
//
// Rules (CLAUDE.md, "CRM"):
//  - `ref` fields are soft references checked by sync (missing -> not_found, parked and retried
//    on devices). `parent: true` = what the record belongs to (the plan's "Belongs to"): a record
//    is live only while it and every parent up the chain are; deletes don't cascade; a change
//    under a concurrently deleted parent keeps the parent (flagged), and a delete of something
//    whose subtree changed unseen is kept (flagged).
//  - `format` fields are stored normalised (@suite/shared/normalize): devices normalise before
//    the step, the server refuses anything else.
//  - New fields: nullable (or defaulted by the screens); never rename or remove one (old outbox
//    steps would be refused `unknown_field`).
import {
  OWNERS, CLIENT_STATUSES, RELATIONSHIP_KINDS, RELATIONSHIP_STATUSES, SERVICE_STATUSES, SERVICE_BILLING,
  SERVICE_PERIODS, ACTIVITY_TYPES, CONTACT_CHANNELS, CONSENT_KINDS, LINK_MATCHED_BY, LINK_APPS,
} from '@suite/shared/crm';
import {
  LEAD_STAGES, LEAD_SOURCES, LOST_REASONS, LEAD_ACTIVITY_TYPES, LEAD_VALUE_PERIODS,
} from '@suite/shared/leads';

const NOTES = { type: 'text', max: 20_000 };
const TAGS = { type: 'text', max: 1000, format: 'tags' };

export const CRM_ENTITIES = [
  {
    // Never deleted (relationships, consent and tasks belong to it; code names the seeded ones by
    // id): archive one to hide it from pickers and lists instead.
    entity: 'business',
    table: 'crm_businesses',
    ops: ['create', 'update'],
    fields: {
      name: { type: 'text', max: 100, required: true },
      color: { type: 'text', max: 20 },
      logo: { type: 'text', max: 2000 },
      default_owner: { type: 'enum', values: OWNERS, required: true },
      position: { type: 'integer' },
      archived: { type: 'boolean' },
    },
  },
  {
    entity: 'client',
    table: 'crm_clients',
    fields: {
      name: { type: 'text', max: 200, required: true },
      status: { type: 'enum', values: CLIENT_STATUSES, required: true },
      tags: TAGS,
      notes: NOTES,
    },
  },
  {
    entity: 'account',
    table: 'crm_accounts',
    fields: {
      client_id: { type: 'id', ref: 'client', parent: true, required: true },
      name: { type: 'text', max: 200, required: true },
      street: { type: 'text', max: 300 },
      city: { type: 'text', max: 100 },
      region: { type: 'text', max: 100 },
      postal_code: { type: 'text', max: 12, format: 'postal' },
      country: { type: 'text', max: 60 },
      website: { type: 'text', max: 500 },
      tags: TAGS,
      notes: NOTES,
      age_restricted: { type: 'boolean' },
    },
  },
  {
    entity: 'contact',
    table: 'crm_contacts',
    fields: {
      client_id: { type: 'id', ref: 'client', parent: true, required: true },
      account_id: { type: 'id', ref: 'account' }, // optional; not what it belongs to
      name: { type: 'text', max: 200, required: true },
      role: { type: 'text', max: 100 },
      email: { type: 'text', max: 254, format: 'email' },
      phone: { type: 'text', max: 20, format: 'phone' },
      preferred_channel: { type: 'enum', values: CONTACT_CHANNELS },
      notes: NOTES,
    },
  },
  {
    entity: 'consent',
    table: 'crm_consents',
    appendOnly: true,
    fields: {
      contact_id: { type: 'id', ref: 'contact', parent: true, required: true },
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      withdrawn: { type: 'boolean', required: true },
      date: { type: 'date', required: true },
      kind: { type: 'enum', values: CONSENT_KINDS },
      // The day an implied consent lapses: consentExpiresOn({ kind, date }) from @suite/shared/crm,
      // set by the writer (editable); readers fall back to it when empty.
      expires_on: { type: 'date' },
      source: { type: 'text', max: 500 },
    },
  },
  {
    entity: 'relationship',
    table: 'crm_relationships',
    fields: {
      account_id: { type: 'id', ref: 'account', parent: true, required: true },
      business_id: { type: 'id', ref: 'business', parent: true, required: true },
      kind: { type: 'enum', values: RELATIONSHIP_KINDS, required: true },
      status: { type: 'enum', values: RELATIONSHIP_STATUSES, required: true },
      start_date: { type: 'date' },
      notes: NOTES,
    },
  },
  {
    entity: 'service',
    table: 'crm_services',
    fields: {
      relationship_id: { type: 'id', ref: 'relationship', parent: true, required: true },
      name: { type: 'text', max: 200, required: true },
      status: { type: 'enum', values: SERVICE_STATUSES, required: true },
      stage: { type: 'text', max: 60 },
      billing: { type: 'enum', values: SERVICE_BILLING },
      amount_cents: { type: 'integer' },
      rate_cents: { type: 'integer' },
      period: { type: 'enum', values: SERVICE_PERIODS },
      sessions: { type: 'integer' },
      start_date: { type: 'date' },
      renewal_date: { type: 'date' },
      scope: { type: 'text', max: 5000 },
      notes: NOTES,
    },
  },
  {
    entity: 'activity',
    table: 'crm_activities',
    appendOnly: true,
    fields: {
      client_id: { type: 'id', ref: 'client', parent: true, required: true },
      account_id: { type: 'id', ref: 'account' }, // which of their businesses (optional)
      business_id: { type: 'id', ref: 'business' }, // which of ours (optional)
      type: { type: 'enum', values: ACTIVITY_TYPES, required: true },
      body: { type: 'text', max: 20_000, required: true },
      at: { type: 'datetime', required: true },
    },
  },
  {
    entity: 'link',
    table: 'crm_links',
    ops: ['create', 'delete'],
    fields: {
      account_id: { type: 'id', ref: 'account', parent: true }, // exactly one of the two (SQL CHECK)
      contact_id: { type: 'id', ref: 'contact', parent: true },
      app: { type: 'enum', values: LINK_APPS, required: true },
      external_id: { type: 'text', max: 200, required: true },
      matched_by: { type: 'enum', values: LINK_MATCHED_BY, required: true },
      // D2: why it was made, in a few words ("same email", "same phone", "similar name") — shown beside it.
      match_reason: { type: 'text', max: 200 },
    },
  },
  {
    // D8: someone who might become a client (or a current client who might take another service —
    // client_id set). Moves lead → talking → quoted → won | lost; winning makes (or reuses) the client,
    // account and relationship and records them here. Delete is for mistakes; lost is the normal end.
    entity: 'lead',
    table: 'crm_leads',
    ops: ['create', 'update', 'delete'],
    fields: {
      name: { type: 'text', max: 200, required: true }, // their business (or the person, when there is no business)
      contact_name: { type: 'text', max: 200 },
      email: { type: 'text', max: 254, format: 'email' },
      phone: { type: 'text', max: 20, format: 'phone' },
      source: { type: 'enum', values: LEAD_SOURCES },
      business_id: { type: 'id', ref: 'business', parent: true, required: true }, // which of ours it is for
      kind: { type: 'enum', values: RELATIONSHIP_KINDS }, // what we'd do for them (as relationships say)
      stage: { type: 'enum', values: LEAD_STAGES, required: true },
      lost_reason: { type: 'enum', values: LOST_REASONS }, // required with stage lost (checkLead)
      lost_note: { type: 'text', max: 500 },
      value_cents: { type: 'integer' }, // estimated amount per value_period
      value_period: { type: 'enum', values: LEAD_VALUE_PERIODS },
      currency: { type: 'text', max: 3 }, // three capital letters; null = CAD
      owner: { type: 'enum', values: OWNERS }, // whose lead (optional; screens default to the maker)
      notes: NOTES,
      // A current client (cross-sell): winning adds a relationship there instead of a new client.
      // Plain refs: deleting that client never hides the lead.
      client_id: { type: 'id', ref: 'client' },
      account_id: { type: 'id', ref: 'account' },
      // What winning made or reused.
      won_client_id: { type: 'id', ref: 'client' },
      won_relationship_id: { type: 'id', ref: 'relationship' },
      stage_changed_at: { type: 'datetime' },
      closed_at: { type: 'datetime' }, // when it was won or lost (null while open)
    },
  },
  {
    // D8: a lead's own timeline — notes, calls, emails, meetings, and each stage change (append-only,
    // like activities; not the CRM's `activity`, which needs a client the lead may not have yet). Once
    // the lead is won, the client page shows these with its own activities.
    entity: 'lead_activity',
    table: 'crm_lead_activities',
    appendOnly: true,
    fields: {
      lead_id: { type: 'id', ref: 'lead', parent: true, required: true },
      type: { type: 'enum', values: LEAD_ACTIVITY_TYPES, required: true },
      body: { type: 'text', max: 20_000 },
      stage_from: { type: 'enum', values: LEAD_STAGES },
      stage_to: { type: 'enum', values: LEAD_STAGES },
      at: { type: 'datetime', required: true },
      // A win's own record (stage row → won): the client and relationship it went to, and what it made
      // ("client:<id> account:<id> contact:<id> relationship:<id> activity:<id>", "restarted:relationship:<id>")
      // — so a lead won on two devices at once can be found and its extra win taken back (D8 review).
      won_client_id: { type: 'id', ref: 'client' },
      won_relationship_id: { type: 'id', ref: 'relationship' },
      won_made: { type: 'text', max: 2000 },
    },
  },
];

/** entity -> definition */
export const CRM_ENTITY = Object.fromEntries(CRM_ENTITIES.map((e) => [e.entity, e]));
