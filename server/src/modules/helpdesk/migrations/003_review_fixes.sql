-- D14 review fixes.
-- Ticket numbers come from a counter of their own, so a number is never used twice (deleting old tickets used to free
-- the highest one).
CREATE TABLE helpdesk_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO helpdesk_meta (key, value) SELECT 'ticket_number', COALESCE(MAX(number), 0) FROM helpdesk_tickets;
-- A person reopening a ticket on the Support page: who and when, and how many times (each reopen gets its own task,
-- without moving to a new episode — the customer didn't write again).
ALTER TABLE helpdesk_tickets ADD COLUMN reopened_at TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN reopened_by TEXT;
ALTER TABLE helpdesk_tickets ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;
-- Why the ticket last started waiting again: customer (a new email) | reopened (a person). The task's title says so.
ALTER TABLE helpdesk_tickets ADD COLUMN wait_reason TEXT;
-- A sent email that matched no ticket yet: its thread headers only (no body), kept for a few reads in case the email it
-- answers arrives late (a reply sent from a phone before the inbox was read), then dropped.
CREATE TABLE helpdesk_sent_waiting (
  mailbox_id  TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  refs        TEXT NOT NULL,          -- JSON: In-Reply-To + References
  to_emails   TEXT NOT NULL,          -- JSON
  subject_key TEXT,
  from_email  TEXT,
  subject     TEXT,
  received_at TEXT NOT NULL,
  sent_at     TEXT,
  folder_uid  TEXT,
  rounds      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mailbox_id, message_id)
) WITHOUT ROWID;
