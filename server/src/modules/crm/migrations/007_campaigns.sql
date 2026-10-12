-- Campaigns (D8c): two new synced tables (written only through sync steps or sync.applyLocal;
-- ../entities.js). New tables only — no existing rows are touched.

-- A way we reach leads. parent_id = its main campaign (two levels).
CREATE TABLE crm_campaigns (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT,
  notes       TEXT,
  archived    INTEGER,
  position    INTEGER,
  created_at  TEXT,
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX crm_campaigns_parent ON crm_campaigns (parent_id);

-- A lead is in a campaign (a lead can be in several).
CREATE TABLE crm_lead_campaigns (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  created_at  TEXT,
  created_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX crm_lead_campaigns_lead ON crm_lead_campaigns (lead_id);
CREATE INDEX crm_lead_campaigns_campaign ON crm_lead_campaigns (campaign_id);
