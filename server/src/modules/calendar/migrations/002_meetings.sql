-- Meetings from Apple Calendar (C6b): each person's own iCloud connection (CalDAV, read-only, with an
-- app-specific password), what was last read from it, and the meetings themselves as synced records.

-- One row per person (owner | partner). Server settings, not synced; kept across restores
-- (`keepOnRestore`), like Stockroom's connection: a password replaced or forgotten after a backup never
-- comes back. The app-specific password is AES-256-GCM-encrypted with the key file
-- config.calendar.caldav.keyFile (calendar-secret.key in the data folder) — never in the database in
-- usable form, never sent back, never logged.
CREATE TABLE calendar_apple (
  actor         TEXT PRIMARY KEY,           -- owner | partner
  conn_id       TEXT NOT NULL,              -- a new id each time it is connected (what was read belongs to it)
  apple_id      TEXT NOT NULL,              -- the Apple ID (an email), lowercase
  password_enc  TEXT NOT NULL,              -- v1:<iv>:<tag>:<ciphertext>
  home_url      TEXT,                       -- the calendar home iCloud gave (its partition host)
  excluded      TEXT NOT NULL DEFAULT '[]', -- JSON: calendar URLs left out (new calendars are read)
  set_at        TEXT NOT NULL,
  set_device    TEXT,
  refused_at    TEXT                        -- Apple refused the password: no calls until a new one is entered
);

-- Every connect / replace / calendars chosen / forget / refused, for the record (never the password).
CREATE TABLE calendar_apple_changes (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,
  at         TEXT NOT NULL,
  device_id  TEXT,
  action     TEXT NOT NULL,                 -- connected | replaced | calendars | forgotten | refused
  apple_id   TEXT
);

-- Pull state per person (not kept across restores: the next pull refreshes it).
CREATE TABLE calendar_apple_pulls (
  actor            TEXT PRIMARY KEY,
  conn_id          TEXT,
  last_attempt_at  TEXT,
  fetched_at       TEXT,                    -- last complete read
  last_error_at    TEXT,
  last_error       TEXT,
  failures         INTEGER NOT NULL DEFAULT 0,
  next_try_at      TEXT,
  unsupported      INTEGER NOT NULL DEFAULT 0 -- events whose repeat rule the suite can't read (first instance only)
);

-- The calendars of each person's home as last listed (name, colour, CTag; not kept across restores).
CREATE TABLE calendar_apple_calendars (
  actor        TEXT NOT NULL,
  conn_id      TEXT NOT NULL,
  url          TEXT NOT NULL,
  name         TEXT,
  color        TEXT,
  ctag         TEXT,                        -- the CTag its events were last read at (null = read again)
  window_from  TEXT,                        -- the window's first day they were read for
  PRIMARY KEY (actor, url)
) WITHOUT ROWID;

-- Each event object last read: its ETag and the suite's minimal form of it (icsRead.js minimalCalendar:
-- titles, times, repeat rules, exceptions, free/busy, declined — no notes, location or attendees).
CREATE TABLE calendar_apple_objects (
  actor         TEXT NOT NULL,
  conn_id       TEXT NOT NULL,
  calendar_url  TEXT NOT NULL,
  url           TEXT NOT NULL,
  etag          TEXT,
  minimal       TEXT NOT NULL,              -- JSON { events, zones }
  PRIMARY KEY (actor, url)
) WITHOUT ROWID;
CREATE INDEX calendar_apple_objects_calendar ON calendar_apple_objects (actor, calendar_url);

-- The meetings devices see (synced, written by the server only: `readOnly` + a check that refuses every
-- device step). One record per instance in the window (a repeating meeting is one record per day it
-- happens). Rebuilt from what was read at each pull; rolled back with the database on a restore and put
-- right by the next pull.
CREATE TABLE calendar_meetings (
  id             TEXT PRIMARY KEY,
  actor          TEXT,                      -- whose calendar (owner | partner)
  source_key     TEXT,                      -- hash of (person, calendar, UID, instance): adopted by it
  calendar_name  TEXT,
  title          TEXT,
  all_day        INTEGER,
  start_at       TEXT,                      -- timed: UTC instant
  end_at         TEXT,
  start_date     TEXT,                      -- the first day (the suite's zone; all day: the day itself)
  end_date       TEXT,                      -- the last day (inclusive)
  busy           INTEGER,                   -- counts in the day's load (false: "free", all-day)
  recurring      INTEGER,
  created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
  flagged        INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT
);
CREATE INDEX calendar_meetings_key ON calendar_meetings (actor, source_key) WHERE deleted_at IS NULL;
