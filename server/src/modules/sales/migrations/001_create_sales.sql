-- Sales by channel: one record per channel per day (a day's total for a channel is the sum of its
-- records). A synced record type (../entities.js): written only through sync steps or
-- sync.applyLocal. Column types follow the field types; created_* / updated_* / flagged are filled
-- by sync. The business is a soft reference (checked by sync); no CHECK lists on enum columns.

CREATE TABLE sales_days (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL,      -- one of our businesses (Save Point Shop for now)
  channel       TEXT NOT NULL,      -- whatnot | poshmark | facebook_marketplace (see @suite/shared/sales)
  sale_date     TEXT NOT NULL,      -- "YYYY-MM-DD", the Toronto calendar day the sales happened on
  amount        REAL NOT NULL,      -- dollars, 0 or more, at most two decimals (checked by the module)
  notes         TEXT,
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX sales_days_date ON sales_days (business_id, sale_date) WHERE deleted_at IS NULL;
