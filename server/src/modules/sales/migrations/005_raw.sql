-- D11 review (exact cents): a day row may carry its figures unrounded (JSON, dollars: gross, discounts, refunds, net,
-- tax) — the wholesale days, from the Order Manager's raw totals — so a sum of days rounds once, as its P&L does
-- (sumByCurrency in shared/sales.js). Null for every other source. A new column only; no rows change.
ALTER TABLE sales_daily ADD COLUMN raw TEXT;
