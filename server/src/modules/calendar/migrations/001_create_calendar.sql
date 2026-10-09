-- The task calendar feed (C6a): one secret link per person, read by Apple Calendar without a session.
-- Only the SHA-256 of each link's token is stored (the token itself is shown once, when it is made).
-- Not synced (server settings, like the connection switches) and kept across restores
-- (`keepOnRestore`): a link someone subscribed to keeps working, and a link replaced or turned off
-- after the backup was made never comes back to life.

CREATE TABLE calendar_feeds (
  actor            TEXT PRIMARY KEY,  -- owner | partner: whose tasks (their own + the shared list)
  token_hash       TEXT NOT NULL,     -- hex SHA-256 of the link's token (32 random bytes, base64url)
  created_at       TEXT NOT NULL,     -- when this link was made (a replace makes a new one)
  created_device   TEXT,              -- the device it was made on (auth device id)
  last_fetched_at  TEXT              -- last time a calendar read it (written at most once a minute)
);

-- Every make / replace / turn off, for the record.
CREATE TABLE calendar_feed_changes (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL,           -- whose link
  action     TEXT NOT NULL,           -- made | replaced | turned_off
  at         TEXT NOT NULL,
  device_id  TEXT
);
CREATE INDEX calendar_feed_changes_actor ON calendar_feed_changes (actor, at);
