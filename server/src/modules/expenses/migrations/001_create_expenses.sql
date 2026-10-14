-- Expenses (C9): what was spent, and the businesses each expense is for. Synced record types
-- (../entities.js): written only through sync steps or sync.applyLocal. Schema only, no rows.

-- One expense: an amount paid once, on a day. amount_cents is whole cents (checked by the module).
CREATE TABLE expenses_items (
  id            TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  spent_on      TEXT NOT NULL,      -- "YYYY-MM-DD", local day it was spent
  category      TEXT,
  notes         TEXT,
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX expenses_items_spent ON expenses_items (spent_on) WHERE deleted_at IS NULL;

-- "This expense is for this business": one row per business an expense is tagged to. No tags =
-- not for any business. The split is even (@suite/shared/expenses), so a row carries no amount.
CREATE TABLE expenses_shares (
  id            TEXT PRIMARY KEY,
  expense_id    TEXT NOT NULL,      -- parent: the expense (deleting it hides its shares)
  business_id   TEXT NOT NULL,      -- one of our businesses (crm's business)
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);
CREATE INDEX expenses_shares_expense ON expenses_shares (expense_id);
CREATE INDEX expenses_shares_business ON expenses_shares (business_id);
