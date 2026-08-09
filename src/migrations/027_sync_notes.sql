-- SPDX-License-Identifier: Apache-2.0
-- Migration 027: synced notes.
--
-- User-authored notes with optional time range and optional link to a
-- marker. title and body are ciphertext on the wire (client-side E2EE);
-- timestamp / end_timestamp / marker_uuid are cleartext so the server
-- can paginate and the client can join without decrypting first.
--
-- Pre-027 servers silently drop the notes collection. Natural key is
-- the client-generated uuid; LWW on updated_at; upserts are tenant-
-- scoped (user_id = excluded.user_id) like every other sync_* table.

CREATE TABLE IF NOT EXISTS sync_notes (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  end_timestamp TEXT,
  marker_uuid TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_notes_user
  ON sync_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_notes_user_updated
  ON sync_notes(user_id, updated_at);
