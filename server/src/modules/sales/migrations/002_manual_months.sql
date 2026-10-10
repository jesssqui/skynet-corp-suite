-- Months entered by hand (D13): a month's total for a store whose connection is off or not set up yet (eBay first:
-- store 'ebay', the target a source names in registerSource's `manualStores`). It fills that store's card for months
-- the connection has no days for; once the connection has days in a month, those win and the entry is kept and shown
-- as replaced. Totals only (no orders, customers or items). Server data like sales_daily: not synced (entering one
-- needs a connection to the suite); not kept across restores (it rolls back with the rest of the data).
CREATE TABLE sales_manual_months (
  store          TEXT NOT NULL,           -- the manual target ('ebay')
  month          TEXT NOT NULL,           -- YYYY-MM, the store's own calendar month
  currency       TEXT NOT NULL,
  total          INTEGER NOT NULL,        -- cents: the month's total sales as the store's own report shows it
  orders         INTEGER,                 -- optional
  note           TEXT,
  entered_at     TEXT NOT NULL,
  entered_by     TEXT NOT NULL,
  entered_device TEXT,
  PRIMARY KEY (store, month)
) WITHOUT ROWID;
