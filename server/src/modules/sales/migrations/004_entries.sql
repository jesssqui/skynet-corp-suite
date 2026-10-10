-- D11: sales entered by hand — invoices, and anything no connection brings in — one row per entry: a business, a day,
-- an amount (cents, signed: sales count up, refunds and credit notes are negatives), its currency (CAD by default),
-- orders (optional, sales only) and a note. Each business's entries (per currency) are added up per day into
-- sales_daily (source 'manual', store 'hand:<business id>' or 'hand:<business id>:<currency>'), where they count like
-- any store's days but only their total and orders are known (`totalOnly`). Server data like the totals: not synced
-- (entering one needs a connection to the suite); not kept across restores (it rolls back with the rest of the data).
-- The id is made by the device when the sheet opens (UUIDv7), so a save sent twice is one entry.
-- See CLAUDE.md, "Sales entered by hand (D11)".
CREATE TABLE sales_entries (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL,           -- one of our businesses (the CRM's fixed ids)
  day            TEXT NOT NULL,           -- YYYY-MM-DD, the day of the sale (or of the refund / credit note)
  kind           TEXT NOT NULL CHECK (kind IN ('sale', 'refund', 'credit_note')),
  amount         INTEGER NOT NULL,        -- cents: > 0 for a sale, < 0 for a refund or credit note
  currency       TEXT NOT NULL,           -- CAD, USD…: never added across currencies
  orders         INTEGER,                 -- optional (sales only)
  note           TEXT,
  entered_at     TEXT NOT NULL,
  entered_by     TEXT NOT NULL,           -- owner | partner
  entered_device TEXT,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  CHECK ((kind = 'sale' AND amount > 0) OR (kind <> 'sale' AND amount < 0))
);
CREATE INDEX sales_entries_store_day ON sales_entries (business_id, currency, day);
CREATE INDEX sales_entries_day ON sales_entries (day);
