-- Leads and the pipeline (D8): two new synced tables (written only through sync steps or
-- sync.applyLocal; ../entities.js). New tables only — no existing rows are touched.

-- Someone who might become a client, or a current client who might take another service
-- (client_id / account_id set). stage: lead | talking | quoted | won | lost.
CREATE TABLE crm_leads (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  contact_name        TEXT,
  email               TEXT,
  phone               TEXT,
  source              TEXT,           -- referral | website | social | inbox | event | outreach | cross_sell | other
  business_id         TEXT NOT NULL,  -- which of our businesses it is for (its parent)
  kind                TEXT,           -- wholesale | website | social | consulting (as relationships)
  stage               TEXT NOT NULL,
  lost_reason         TEXT,           -- price | timing | went_elsewhere | no_reply | not_a_fit | other
  lost_note           TEXT,
  value_cents         INTEGER,        -- estimated amount per value_period
  value_period        TEXT,           -- once | monthly | quarterly | yearly
  currency            TEXT,           -- null = CAD
  owner               TEXT,           -- owner | partner | shared
  notes               TEXT,
  client_id           TEXT,           -- an existing client (cross-sell)
  account_id          TEXT,
  won_client_id       TEXT,           -- what winning made or reused
  won_relationship_id TEXT,
  stage_changed_at    TEXT,
  closed_at           TEXT,           -- when it was won or lost
  created_at          TEXT,
  created_by          TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  flagged             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT
);
CREATE INDEX crm_leads_stage ON crm_leads (stage);
CREATE INDEX crm_leads_client ON crm_leads (client_id);
CREATE INDEX crm_leads_won_client ON crm_leads (won_client_id);

-- A lead's own timeline (append-only): notes, calls, emails, meetings and each stage change.
CREATE TABLE crm_lead_activities (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  type        TEXT NOT NULL,        -- note | call | email | meeting | stage
  body        TEXT,
  stage_from  TEXT,
  stage_to    TEXT,
  at          TEXT NOT NULL,
  won_client_id       TEXT,         -- a win's stage row: the client and relationship it went to,
  won_relationship_id TEXT,         -- and what it made (won_made), to undo a duplicate win
  won_made            TEXT,
  created_at  TEXT,
  created_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX crm_lead_activities_lead ON crm_lead_activities (lead_id, at);
