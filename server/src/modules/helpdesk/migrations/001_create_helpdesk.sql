-- The helpdesk (D14): each store's support mailbox (read over IMAP, read only), the tickets made from its emails, and
-- what was read. Nothing here is synced: customer emails are personal data and stay on the suite's server, shown only
-- to a signed-in session (see CLAUDE.md, "Helpdesk (D14)"). Never used for marketing or copied into the CRM.

-- ---- the mailboxes (server settings, kept across restores: keepOnRestore) ---------------------------------
CREATE TABLE helpdesk_mailboxes (
  id             TEXT PRIMARY KEY,          -- UUIDv7; its Connections row is "mail-<id without dashes>"
  name           TEXT NOT NULL,             -- "TinsXpress support" (the person's name for it)
  host           TEXT NOT NULL,             -- imap.gmail.com (port 993, TLS)
  port           INTEGER NOT NULL DEFAULT 993,
  username       TEXT NOT NULL,
  password_enc   TEXT NOT NULL,             -- the app password, encrypted: v1:<iv>:<tag>:<ciphertext> (lib/sealed.js)
  inbox_folder   TEXT NOT NULL,             -- where customers' emails arrive ("INBOX")
  sent_folder    TEXT NOT NULL,             -- where the mail app keeps what was sent ("Sent", "[Gmail]/Sent Mail")
  address        TEXT,                      -- the mailbox's own email address (its own mail is never a ticket)
  store_id       TEXT,                      -- the WooCommerce store whose orders its tickets look up (D12), or null
  business_id    TEXT,                      -- one of our businesses (retail by default): its tasks go there
  ignore_from    TEXT,                      -- senders that never make a ticket: "orders@x.com, @wordpress.com"
  position       INTEGER NOT NULL,
  added_at       TEXT NOT NULL,
  added_by       TEXT NOT NULL,
  added_device   TEXT,
  password_set_at TEXT NOT NULL
);
-- Every change: added / password_replaced / changed / removed (never the password).
CREATE TABLE helpdesk_changes (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  device_id  TEXT,
  mailbox_id TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT
);

-- ---- what was read (not kept across restores: a restore rolls the tickets back, and the folders are read again from
-- the restored position; a message already held is never held twice) ----------------------------------------------
CREATE TABLE helpdesk_pulls (
  mailbox_id      TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error_at   TEXT,
  last_error      TEXT,
  failures        INTEGER NOT NULL DEFAULT 0,
  next_try_at     TEXT,
  skipped         INTEGER NOT NULL DEFAULT 0   -- auto-replies, lists, ignored senders, our own mail: never kept
) WITHOUT ROWID;
CREATE TABLE helpdesk_folders (
  mailbox_id   TEXT NOT NULL,
  role         TEXT NOT NULL,              -- inbox | sent
  folder       TEXT NOT NULL,              -- the folder read (a renamed setting starts again)
  uid_validity INTEGER,
  last_uid     INTEGER NOT NULL DEFAULT 0, -- every message up to this one has been read
  PRIMARY KEY (mailbox_id, role)
) WITHOUT ROWID;

-- ---- tickets and their messages --------------------------------------------------------------------------------
CREATE TABLE helpdesk_tickets (
  id               TEXT PRIMARY KEY,
  number           INTEGER NOT NULL UNIQUE,  -- #12 (shown, and in the task's title)
  mailbox_id       TEXT NOT NULL,
  subject          TEXT,
  subject_key      TEXT,                     -- for matching a reply without thread headers
  customer_name    TEXT,
  customer_email   TEXT,
  state            TEXT NOT NULL,            -- waiting | answered | closed
  waiting_since    TEXT,                     -- the first customer message nobody answered yet (null unless waiting)
  last_customer_at TEXT,
  last_reply_at    TEXT,                     -- our last reply seen in the Sent folder
  handled_at       TEXT,                     -- the later of last_reply_at and closed_at
  closed_at        TEXT,
  closed_by        TEXT,                     -- owner | partner | system
  closed_reason    TEXT,                     -- no_reply_needed | task_done | task_deleted
  episode          INTEGER NOT NULL DEFAULT 1, -- +1 each time it waits on us again (its task's key)
  message_count    INTEGER NOT NULL DEFAULT 0,
  opened_at        TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX helpdesk_tickets_mailbox ON helpdesk_tickets (mailbox_id, state);
CREATE INDEX helpdesk_tickets_match ON helpdesk_tickets (mailbox_id, customer_email, subject_key);

CREATE TABLE helpdesk_messages (
  id           TEXT PRIMARY KEY,
  ticket_id    TEXT NOT NULL REFERENCES helpdesk_tickets (id) ON DELETE CASCADE,
  mailbox_id   TEXT NOT NULL,
  direction    TEXT NOT NULL,                -- in (the customer's) | out (our reply, from the Sent folder)
  folder_uid   TEXT,                         -- "<uidvalidity>:<uid>" where it was read
  message_id   TEXT NOT NULL,                -- Message-ID (or one made from where it was read)
  in_reply_to  TEXT,
  refs         TEXT,                         -- JSON: the References ids (at most 30)
  from_name    TEXT,
  from_email   TEXT,
  to_email     TEXT,
  subject      TEXT,
  received_at  TEXT NOT NULL,                -- the server's time (INTERNALDATE)
  sent_at      TEXT,                         -- its Date header
  body_text    TEXT,                         -- plain text, capped; null for our replies (never kept) and once purged
  body_truncated INTEGER NOT NULL DEFAULT 0,
  attachments  TEXT,                         -- JSON: names only (never the files)
  purged_at    TEXT,
  UNIQUE (mailbox_id, direction, message_id)
);
CREATE INDEX helpdesk_messages_ticket ON helpdesk_messages (ticket_id, received_at);
CREATE INDEX helpdesk_messages_id ON helpdesk_messages (mailbox_id, message_id);
