-- D12 review fix: the backfill's own state, apart from the 60-day window's — a backfill chunk that fails (a slow store
-- timing out on a 90-day read) no longer puts the store into backoff or shows as its Connections row's error while the
-- window reads fine. Its chunk is halved after a time-out (down to 7 days) and kept.
ALTER TABLE woocommerce_pulls ADD COLUMN backfill_error TEXT;
ALTER TABLE woocommerce_pulls ADD COLUMN backfill_error_at TEXT;
ALTER TABLE woocommerce_pulls ADD COLUMN backfill_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE woocommerce_pulls ADD COLUMN backfill_next_try_at TEXT;
ALTER TABLE woocommerce_pulls ADD COLUMN backfill_chunk_days INTEGER;
