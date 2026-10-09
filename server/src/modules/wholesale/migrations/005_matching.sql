-- D2 (matching and suggestions): what linking an Order Manager customer changed, so Undo can put it
-- back, and the people's decisions about suggested pairs. Server tables (not synced); new tables only.
-- See CLAUDE.md, "Matching (D2)".

-- What each link changed, written in the same transaction as the change itself:
--   attached              the link's customer was attached to the account (one row per attachment: a link
--                         with none was made before D2 kept track — Undo then removes only the link)
--   age_restricted        the account's age-restricted mark was set by the attachment (before = what it was)
--   relationship_created  the wholesale relationship the attachment made (after = its fields)
--   account_created       the account "Link to a new account" or "Create a client" made (after = its fields)
--   client_created        the client "Create a client" made
--   contact_created       the contact "Create a client" made
-- Not kept across restores: these rows describe synced records (links, accounts…), which a restore
-- rolls back with them.
CREATE TABLE wholesale_link_changes (
  id            TEXT PRIMARY KEY,
  customer_uid  TEXT NOT NULL,
  link_id       TEXT,                      -- the crm link record (null only while it is being made)
  account_id    TEXT,
  change        TEXT NOT NULL,
  entity        TEXT NOT NULL,             -- link | account | relationship | client | contact
  record_id     TEXT NOT NULL,
  before        TEXT,                      -- JSON: field values before (age_restricted)
  after         TEXT,                      -- JSON: the values written
  at            TEXT NOT NULL,
  actor         TEXT,                      -- who caused it (owner | partner | system)
  undone_at     TEXT,
  undone_by     TEXT,
  outcome       TEXT                       -- after an undo: what happened to it, in plain English
) WITHOUT ROWID;
CREATE INDEX wholesale_link_changes_customer ON wholesale_link_changes (customer_uid);
CREATE INDEX wholesale_link_changes_link ON wholesale_link_changes (link_id);

-- Decisions about a suggested pair, so it isn't suggested (or linked automatically) again:
--   kind 'customer': a = Order Manager customer uid, b = client id
--   kind 'clients':  a < b, two client ids (possible duplicate clients in the CRM)
-- not_same_*: "Not the same" (never suggested again until someone clears it on the page);
-- undone_*:   a link between them was undone — never linked automatically again (still suggested).
-- Kept across restores (like the holding area): a person's decision about Order Manager customers.
CREATE TABLE wholesale_match_decisions (
  kind             TEXT NOT NULL CHECK (kind IN ('customer', 'clients')),
  a                TEXT NOT NULL,
  b                TEXT NOT NULL,
  not_same_at      TEXT,
  not_same_by      TEXT,
  not_same_device  TEXT,
  undone_at        TEXT,
  undone_by        TEXT,
  PRIMARY KEY (kind, a, b)
) WITHOUT ROWID;
