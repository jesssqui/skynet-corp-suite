-- Monthly targets per business (D15): what one of our businesses aims for in a calendar month — total sales, sales
-- before tax and shipping, orders, new clients or leads won — set at the monthly plan and measured on the overview's
-- scorecard. A synced record type (../entities.js `target`): written only through sync steps (devices) or
-- sync.applyLocal. Money targets are integer cents in the target's own currency (null = CAD); the others are counts.
CREATE TABLE overview_targets (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,      -- one of our businesses
  month       TEXT NOT NULL,      -- "YYYY-MM-01"
  measure     TEXT NOT NULL,      -- sales | net_sales | orders | new_clients | won_leads
  amount      INTEGER NOT NULL,   -- cents (money measures) or a count
  currency    TEXT,               -- money measures: ISO 4217; null = CAD
  notes       TEXT,
  created_at  TEXT,
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX overview_targets_month ON overview_targets (month) WHERE deleted_at IS NULL;
CREATE INDEX overview_targets_business ON overview_targets (business_id);
