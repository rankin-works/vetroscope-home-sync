-- SPDX-License-Identifier: Apache-2.0
-- Migration 008: replicated storage for custom reminders.
--
-- Reminders are user-defined notifications that fire either once at
-- a specific moment or on a repeating weekday + time-of-day
-- schedule. The desktop client owns the local schema; this table
-- mirrors it on the server side for cross-device sync.
--
-- `title` + `body` are user-authored text, so they ride the wire
-- encrypted client-side with the user's recovery code. The schedule
-- fields (kind / weekdays / time_of_day / start_date / end_date /
-- fire_at) carry no user-identifying content and stay cleartext so
-- the server can validate them and surface aggregate logs without
-- decrypting anything.
--
-- LWW on updated_at — desktop client clears synced_at_* on every
-- local edit, which bumps updated_at and wins the conflict.
--
-- Pre-008 servers received no reminders field — desktop clients
-- running the matching release just won't pick up reminders on
-- those servers, which is the expected graceful-degradation path
-- (the local reminder still fires; it just doesn't sync).

CREATE TABLE IF NOT EXISTS sync_reminders (
  uuid        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,            -- encrypted client-side
  body        TEXT,                     -- encrypted client-side (optional)
  kind        TEXT NOT NULL,            -- cleartext: 'once' | 'repeat'
  fire_at     TEXT,                     -- cleartext ISO (kind = 'once')
  weekdays    TEXT,                     -- cleartext CSV or '*' (kind = 'repeat')
  time_of_day TEXT,                     -- cleartext 'HH:MM' local
  start_date  TEXT,                     -- cleartext 'YYYY-MM-DD' (optional)
  end_date    TEXT,                     -- cleartext 'YYYY-MM-DD' (optional)
  enabled     INTEGER NOT NULL DEFAULT 1,
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_reminders_user
  ON sync_reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_reminders_user_updated
  ON sync_reminders(user_id, updated_at);
