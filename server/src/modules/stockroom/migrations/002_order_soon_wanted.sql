-- D16 review: "the deliveries changed → read the order-soon list again" is kept on the order-soon row until that read
-- succeeds, so it survives a backoff (and a restart) instead of being lost with the round. Additive.
ALTER TABLE stockroom_pulls ADD COLUMN wanted INTEGER NOT NULL DEFAULT 0;
