-- C7 review: a batch remembers which request started it (SHA-256 of the file, mapping, business and
-- choices), so a retried commit with the same batch id but a different file is refused (409)
-- instead of being answered with the other import's result.
ALTER TABLE crm_import_batches ADD COLUMN request_hash TEXT;
