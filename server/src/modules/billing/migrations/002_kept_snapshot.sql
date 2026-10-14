-- D17/D18 review: what each kept PDF was issued from — the fingerprint of the approved draft and a snapshot of the
-- document as issued (its fields, the server's fields and its lines, JSON) — so that after a restore that rolled the
-- record back to a draft, approving it again re-adopts the kept number when it says the same, refuses when it doesn't,
-- and "Restore from archive" can put the record back with its original id and number. New columns only.
ALTER TABLE billing_pdfs ADD COLUMN fingerprint TEXT;
ALTER TABLE billing_pdfs ADD COLUMN snapshot TEXT;
