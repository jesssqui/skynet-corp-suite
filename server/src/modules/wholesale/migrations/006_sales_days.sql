-- D11 (wholesale sales per day): the Order Manager's orders count on the UTC day of their created_at (held as
-- placed_at, UTC ISO) and refunds / credit notes on theirs (held as at) — these indexes find one day's rows when a
-- change re-writes that day in the shared daily sales totals. Indexes only; no rows change. See CLAUDE.md,
-- "Wholesale sales (D11)".
CREATE INDEX wholesale_held_orders_placed ON wholesale_held_orders (placed_at);
CREATE INDEX wholesale_held_money_at ON wholesale_held_money (at);
