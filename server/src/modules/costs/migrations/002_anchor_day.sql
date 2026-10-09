-- D6 review: the billing day of the month (1–31) a monthly/quarterly/yearly cost renews on, so an
-- auto-renewing cost billed on the 31st rolls Jan 31 → Feb 28 → Mar 31 instead of sticking on the 28th.
-- Schema only (a migration never changes rows of a synced table): existing costs start with null,
-- which the roll-forward reads as the current date's day and then writes (through applyLocal).
ALTER TABLE costs_recurring ADD COLUMN anchor_day INTEGER;
