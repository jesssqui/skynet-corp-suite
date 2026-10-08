-- D1 review: records found by their Order Manager uid (re-adopted after a restore, extras removed), and a
-- refund's or credit note's return (its own pre-tax subtotal nets spend exactly). The held tables aren't
-- synced, so their rows may be filled here (sync rule 6 is about synced tables only).
CREATE INDEX wholesale_orders_uid ON wholesale_orders (order_uid);
CREATE INDEX wholesale_entries_uid ON wholesale_entries (uid);
CREATE INDEX wholesale_customers_uid ON wholesale_customers (customer_uid);
ALTER TABLE wholesale_held_money ADD COLUMN return_uid TEXT;
UPDATE wholesale_held_money SET return_uid = json_extract(snapshot, '$.return_uid')
  WHERE kind IN ('refund', 'credit_note') AND json_valid(snapshot);
UPDATE wholesale_held_money SET subtotal_cents = json_extract(snapshot, '$.subtotal_cents')
  WHERE kind = 'return' AND json_valid(snapshot) AND typeof(json_extract(snapshot, '$.subtotal_cents')) = 'integer';
CREATE INDEX wholesale_synced_orders_client_at ON wholesale_orders (client_id, at);
