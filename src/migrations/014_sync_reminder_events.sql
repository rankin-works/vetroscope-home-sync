-- SPDX-License-Identifier: Apache-2.0
-- Migration 014: replicated reminder notification history.
--
-- Title, body, and icon data are encrypted client-side. Event state fields
-- stay cleartext so devices converge on read / dismissed / deleted status.

CREATE TABLE IF NOT EXISTS sync_reminder_events (
  uuid            TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reminder_uuid   TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  icon_data_url   TEXT,
  fired_at        TEXT NOT NULL,
  read_at         TEXT,
  dismissed_at    TEXT,
  deleted         INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_reminder_events_user
  ON sync_reminder_events(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_reminder_events_user_updated
  ON sync_reminder_events(user_id, updated_at);
