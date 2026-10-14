-- Saved answers (D14): text the person copies into their mail app. A synced record type (../entities.js
-- `saved_answer`): written only through sync steps (devices). No customer data: what we write, not what they wrote.
CREATE TABLE helpdesk_saved_answers (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  mailbox_id  TEXT,                 -- the mailbox (store) it is for; null = every mailbox (no sync ref: mailboxes are server settings)
  position    INTEGER,
  created_at  TEXT,
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
