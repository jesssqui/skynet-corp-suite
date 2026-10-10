-- D13 re-check fix: a month entered by hand that the connection's own figure has replaced stays replaced — marked the
-- first time the connection writes days that count for that month — even if the connection stops reading later
-- (paused, signed out). Saving the month again clears the mark (the person's newer figure counts again).
ALTER TABLE sales_manual_months ADD COLUMN replaced_at TEXT;
