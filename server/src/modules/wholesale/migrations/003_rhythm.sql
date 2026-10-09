-- D3 (wholesale automations): a regular's ordering rhythm on each customer card, for the "Quiet
-- regular" flag — the usual gap between orders and the first day they count as quiet (figures.js
-- orderRhythm). New nullable columns only; the values are written after start through the
-- projection (sync.applyLocal), never here (sync rule 6): the wholesale module marks every held
-- customer dirty once (wholesale_status.card_version) so each card is brought up to date.
ALTER TABLE wholesale_customers ADD COLUMN usual_gap_days INTEGER;
ALTER TABLE wholesale_customers ADD COLUMN quiet_from TEXT;
