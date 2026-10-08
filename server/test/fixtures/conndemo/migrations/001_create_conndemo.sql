-- The test-only connection's outbox: jobs waiting to go to a pretend outside service.
CREATE TABLE conndemo_outbox (
  n        INTEGER PRIMARY KEY AUTOINCREMENT, -- order of sending (test fixture only; real modules use UUIDv7)
  payload  TEXT NOT NULL,
  sent_at  TEXT
);
