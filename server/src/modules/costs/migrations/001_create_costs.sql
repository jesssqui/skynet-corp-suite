-- Recurring costs (D6): what our businesses and the home pay for — hosting, domains, software,
-- insurance, subscriptions. A synced record type (../entities.js `recurring_cost`): written only
-- through sync steps (devices) or sync.applyLocal (the suite rolling an auto-renewing cost forward).
-- Money is integer cents in the cost's own currency (null = CAD).
CREATE TABLE costs_recurring (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  business_id         TEXT NOT NULL,      -- one of our businesses, or Personal (home)
  vendor              TEXT,
  amount_cents        INTEGER,            -- what we pay each period
  currency            TEXT,               -- ISO 4217 code; null = CAD
  period              TEXT NOT NULL,      -- monthly | quarterly | yearly | once
  next_renewal        TEXT NOT NULL,      -- "YYYY-MM-DD"
  payment_method      TEXT,
  auto_renews         INTEGER,            -- 0/1 (null = no)
  status              TEXT,               -- active | cancelled (null = active)
  notes               TEXT,
  relationship_id     TEXT,               -- resold: the client relationship it is billed on (plain ref)
  resold_amount_cents INTEGER,            -- what the client pays us for it, per the same period
  created_at          TEXT,
  created_by          TEXT,
  updated_at          TEXT,
  updated_by          TEXT,
  flagged             INTEGER NOT NULL DEFAULT 0,
  deleted_at          TEXT
);
CREATE INDEX costs_recurring_renewal ON costs_recurring (next_renewal) WHERE deleted_at IS NULL;
CREATE INDEX costs_recurring_business ON costs_recurring (business_id);
CREATE INDEX costs_recurring_relationship ON costs_recurring (relationship_id);
