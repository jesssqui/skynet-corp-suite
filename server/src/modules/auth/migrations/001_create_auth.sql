-- Sign-in (C1). How it works: CLAUDE.md, "Sign-in (auth module)".

-- The two accounts. Made only by the CLI (server/scripts/users.js), never over HTTP.
--   actor     which of the two people this is; recorded on every synced change
--   username  lowercase, what is typed at sign-in
CREATE TABLE auth_users (
  id                  TEXT PRIMARY KEY,
  actor               TEXT NOT NULL UNIQUE CHECK (actor IN ('owner', 'partner')),
  username            TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  password_hash       TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  created_at          TEXT NOT NULL
) WITHOUT ROWID;

-- Authenticator-app second factor (TOTP, RFC 6238), set up by the CLI with the account (users.js add /
-- reset-2fa) after one code confirms it. No row = the account can't sign in. last_step = the newest time step used (a code works once).
-- A passkey would be another table (auth_passkeys), not a column here.
CREATE TABLE auth_totp (
  user_id     TEXT PRIMARY KEY REFERENCES auth_users (id) ON DELETE CASCADE,
  secret      TEXT NOT NULL,
  last_step   INTEGER NOT NULL DEFAULT 0,
  enrolled_at TEXT NOT NULL
) WITHOUT ROWID;

-- One-time recovery codes (SHA-256 of the normalised code). Used ones stay with used_at set.
CREATE TABLE auth_recovery_codes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at    TEXT
) WITHOUT ROWID;
CREATE INDEX auth_recovery_codes_user ON auth_recovery_codes (user_id);

-- Each browser / home-screen install. Its id is also its sync device id.
-- signed_out_at set = signed out (by its owner or the other person): it never gets a session
-- again, and its next request is told to clear its local copy. Signing in again makes a new device.
CREATE TABLE auth_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  last_ip       TEXT,
  signed_out_at TEXT,
  signed_out_by TEXT
) WITHOUT ROWID;
CREATE INDEX auth_devices_user ON auth_devices (user_id);

-- Sessions: the cookie holds a random token; only its SHA-256 is stored.
-- Valid while ended_at IS NULL, last_seen_at is within the idle limit and expires_at (absolute) is ahead.
--   second_factor  how it was signed in: totp | recovery (later: passkey)
--   end_reason     signed_out | expired | replaced | password_changed | two_factor_reset | reset_by_admin | restored
-- (No CHECK lists on these: adding a passkey must not need a table rebuild.)
CREATE TABLE auth_sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL REFERENCES auth_devices (id) ON DELETE CASCADE,
  second_factor TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT
) WITHOUT ROWID;
CREATE INDEX auth_sessions_device ON auth_sessions (device_id);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

-- Half-finished sign-ins and two-factor changes: a short-lived random token (hashed) that
-- carries the password step over to the code step.
--   sign_in     password was right, waiting for a code
--   totp_reset  signed in, re-checked: waiting for the first code from the new totp_secret
CREATE TABLE auth_challenges (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  session_id  TEXT,
  totp_secret TEXT,
  device_hint TEXT,
  installed   INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
) WITHOUT ROWID;

-- Facts about this database for auth: sync_generation = the sync generation at the last start (a change
-- means the database was restored from a backup, so every session is ended).
CREATE TABLE auth_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Failed-attempt counters for rate limiting (rules in throttle.js). Keys:
--   'acct-ip:<username>@<ip>'  one account from one address (the strict one)
--   'acct:<username>'          one account from everywhere (loose: distributed guessing)
--   'ip:<address>'             one address, any username (spraying)
-- failures count from first_failure_at; the count starts again once the rule's window has passed.
CREATE TABLE auth_throttle (
  key              TEXT PRIMARY KEY,
  failures         INTEGER NOT NULL,
  first_failure_at TEXT NOT NULL,
  last_failure_at  TEXT NOT NULL,
  locked_until     TEXT
) WITHOUT ROWID;
