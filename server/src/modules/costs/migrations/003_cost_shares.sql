-- Which of our businesses use a recurring cost (D6b). A synced record type (../entities.js `cost_share`):
-- one row per (cost, business). The company pays; each tagged business shows an even share of the cost.
-- A cost with no rows counts whole to its own business (business_id), so nothing existing changes.
-- No rows of costs_recurring are touched here.
CREATE TABLE costs_shares (
  id          TEXT PRIMARY KEY,
  cost_id     TEXT NOT NULL,             -- the cost it belongs to (parent)
  business_id TEXT NOT NULL,             -- one of our businesses that uses it (plain ref)
  created_at  TEXT,
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX costs_shares_cost ON costs_shares (cost_id);
CREATE INDEX costs_shares_business ON costs_shares (business_id);
