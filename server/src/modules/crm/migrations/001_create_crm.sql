-- CRM core records (C3a). Every table is a synced record type (registered in ../entities.js):
-- written only through sync steps (devices) or sync.applyLocal (server code); a direct write
-- fails on the app's connection. Column types follow the field types (CLAUDE.md, "How a module
-- syncs a record type"): text/date/datetime/id/enum TEXT, integer/boolean INTEGER, number REAL.
-- created_* / updated_* / flagged are filled by sync (when and who did it on the device).
--
-- References between records are soft (no SQL FOREIGN KEY): the field's `ref` makes sync check
-- that the record exists when a step names it (missing -> not_found, which devices park and
-- retry; see CLAUDE.md "CRM"). `parent` refs are what a record belongs to: deletes don't cascade,
-- reads show a record only while it and its parents up the chain are live (deleted_at IS NULL).
-- No CHECK lists on enum columns: sync checks the values, and new values then need no rebuild.

-- Our own businesses, and Personal. Seeded at first start (fixed ids, @suite/shared/crm).
CREATE TABLE crm_businesses (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  color         TEXT,              -- brand colour, "#rrggbb"
  logo          TEXT,              -- URL or path of the logo (a file record once files exist)
  default_owner TEXT NOT NULL,     -- owner | partner | shared: who new and automated tasks go to
  position      INTEGER,           -- display order
  created_at    TEXT,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  flagged       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT
);

-- A client: the owner or group behind one or more businesses (accounts).
CREATE TABLE crm_clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,        -- active | closed
  tags       TEXT,                 -- "tag, tag" (normalised)
  notes      TEXT,
  created_at TEXT,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT,
  flagged    INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX crm_clients_name ON crm_clients (name COLLATE NOCASE);

-- An account: one of the client's businesses.
CREATE TABLE crm_accounts (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  name           TEXT NOT NULL,
  street         TEXT,
  city           TEXT,
  region         TEXT,             -- province / state
  postal_code    TEXT,             -- normalised ("N3Y 4K3")
  country        TEXT,
  website        TEXT,
  tags           TEXT,
  notes          TEXT,
  age_restricted INTEGER,          -- buys nicotine / cannabis products: never used in another brand's marketing
  created_at     TEXT,
  created_by     TEXT,
  updated_at     TEXT,
  updated_by     TEXT,
  flagged        INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT
);
CREATE INDEX crm_accounts_client ON crm_accounts (client_id);
CREATE INDEX crm_accounts_postal ON crm_accounts (postal_code);

-- A person: belongs to a client, optionally to one of its accounts.
CREATE TABLE crm_contacts (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL,
  account_id        TEXT,
  name              TEXT NOT NULL,
  role              TEXT,
  email             TEXT,           -- lowercase, trimmed
  phone             TEXT,           -- digits only
  preferred_channel TEXT,
  notes             TEXT,
  created_at        TEXT,
  created_by        TEXT,
  updated_at        TEXT,
  updated_by        TEXT,
  flagged           INTEGER NOT NULL DEFAULT 0,
  deleted_at        TEXT
);
CREATE INDEX crm_contacts_client ON crm_contacts (client_id);
CREATE INDEX crm_contacts_account ON crm_contacts (account_id);
CREATE INDEX crm_contacts_email ON crm_contacts (email);
CREATE INDEX crm_contacts_phone ON crm_contacts (phone);

-- Email consent of one contact for one of our businesses (CASL), append-only: withdrawing adds a
-- row with withdrawn = 1. The latest (date, then id) counts — latestConsents() in @suite/shared/crm.
CREATE TABLE crm_consents (
  id          TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL,
  business_id TEXT NOT NULL,
  withdrawn   INTEGER NOT NULL,
  date        TEXT NOT NULL,        -- the day it was given (or withdrawn)
  kind        TEXT,                 -- express | implied
  source      TEXT,                 -- how: "signed up at the trade show", "replied yes by email"
  created_at  TEXT,
  created_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX crm_consents_contact ON crm_consents (contact_id, business_id);
CREATE INDEX crm_consents_business ON crm_consents (business_id);

-- One of our businesses working with one of theirs.
CREATE TABLE crm_relationships (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  business_id TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- wholesale | website | social | consulting
  status      TEXT NOT NULL,        -- active | paused | ended
  start_date  TEXT,
  notes       TEXT,
  created_at  TEXT,
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX crm_relationships_account ON crm_relationships (account_id);
CREATE INDEX crm_relationships_business ON crm_relationships (business_id);

-- What a relationship delivers: a website build, a social retainer, a consulting engagement.
-- Money in whole cents.
CREATE TABLE crm_services (
  id              TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL,     -- active | paused | done | cancelled
  stage           TEXT,              -- agency project stage (free text until Projects, phase 3)
  billing         TEXT,              -- flat | hourly
  amount_cents    INTEGER,           -- flat fee, or the retainer per period
  rate_cents      INTEGER,           -- hourly rate
  period          TEXT,              -- once | monthly | quarterly | yearly
  sessions        INTEGER,           -- consulting sessions agreed
  start_date      TEXT,
  renewal_date    TEXT,
  scope           TEXT,
  notes           TEXT,
  created_at      TEXT,
  created_by      TEXT,
  updated_at      TEXT,
  updated_by      TEXT,
  flagged         INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT
);
CREATE INDEX crm_services_relationship ON crm_services (relationship_id);
CREATE INDEX crm_services_renewal ON crm_services (renewal_date);

-- The timeline: append-only (notes, calls, orders… simply add up). created_by = who logged it.
CREATE TABLE crm_activities (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  account_id  TEXT,
  business_id TEXT,                 -- which of our businesses it was for
  type        TEXT NOT NULL,        -- note | call | email | meeting | order | milestone
  body        TEXT NOT NULL,
  at          TEXT NOT NULL,        -- when it happened (UTC, nowIso format)
  created_at  TEXT,
  created_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX crm_activities_client ON crm_activities (client_id, at);
CREATE INDEX crm_activities_account ON crm_activities (account_id, at);

-- Another app's record that is this account or contact (D2 matching makes them). Create or
-- delete only (undoing a link deletes it). Exactly one of account_id / contact_id.
CREATE TABLE crm_links (
  id          TEXT PRIMARY KEY,
  account_id  TEXT,
  contact_id  TEXT,
  app         TEXT NOT NULL,        -- wom (Wholesale Order Manager)
  external_id TEXT NOT NULL,        -- that app's record id
  matched_by  TEXT NOT NULL,        -- auto | approved
  created_at  TEXT,
  created_by  TEXT,
  updated_at  TEXT,
  updated_by  TEXT,
  flagged     INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  CHECK ((account_id IS NULL) <> (contact_id IS NULL))
);
CREATE INDEX crm_links_account ON crm_links (account_id);
CREATE INDEX crm_links_contact ON crm_links (contact_id);
-- One live link per outside record and kind of target (an Order Manager customer can be both an
-- account and its contact person).
CREATE UNIQUE INDEX crm_links_external_account ON crm_links (app, external_id)
  WHERE account_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX crm_links_external_contact ON crm_links (app, external_id)
  WHERE contact_id IS NOT NULL AND deleted_at IS NULL;
