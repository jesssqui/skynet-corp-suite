-- Sales totals (D12): one row per store and day — totals only, never an order, item or customer. Written by the
-- sources (D12 WooCommerce stores; D13 eBay) through ctx.services.sales.putDays; read by the Sales page and by later
-- packages through ctx.services.sales.totals (D11, D15). Not synced: server data with a read API (devices need a
-- connection to see sales). Not kept across restores: every source re-reads its recent days on its next pull, and a
-- restore makes the WooCommerce backfill run again. See CLAUDE.md, "Sales totals (D12)".
CREATE TABLE sales_daily (
  source       TEXT NOT NULL,             -- woo | ebay | manual
  store        TEXT NOT NULL,             -- the store's key in its source (woo: its address, e.g. tinsxpress.com)
  day          TEXT NOT NULL,             -- YYYY-MM-DD in the store's own time zone
  business_id  TEXT,                      -- one of our businesses (the CRM's fixed ids; retail by default)
  currency     TEXT NOT NULL,             -- the store's currency (CAD, USD…): never added across currencies
  orders       INTEGER NOT NULL DEFAULT 0,
  items        INTEGER NOT NULL DEFAULT 0,
  gross        INTEGER NOT NULL DEFAULT 0, -- cents (see SALES_FIGURES in shared/sales.js)
  discounts    INTEGER NOT NULL DEFAULT 0,
  refunds      INTEGER NOT NULL DEFAULT 0,
  net          INTEGER NOT NULL DEFAULT 0,
  tax          INTEGER NOT NULL DEFAULT 0,
  shipping     INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  fetched_at   TEXT NOT NULL,             -- when this day was last read from the store
  PRIMARY KEY (source, store, day)
) WITHOUT ROWID;
CREATE INDEX sales_daily_day ON sales_daily (day);

-- What each store was last called, its business, currency and time zone — so totals of a store that is no longer
-- connected still have a name, and "today" is the store's own day.
CREATE TABLE sales_stores (
  source      TEXT NOT NULL,
  store       TEXT NOT NULL,
  name        TEXT NOT NULL,
  business_id TEXT,
  currency    TEXT,
  time_zone   TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (source, store)
) WITHOUT ROWID;
