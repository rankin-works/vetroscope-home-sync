-- SPDX-License-Identifier: Apache-2.0
-- Migration 028: note folders + optional note time / folder / pin.
--
-- Nested folders for organizing notes. name is ciphertext on the wire
-- (client-side E2EE); parent_uuid / deleted travel cleartext.
--
-- Also rebuilds sync_notes so timestamp may be null (timeless notes)
-- and adds folder_uuid + pinned. Pre-028 servers silently drop the
-- note_folders collection and reject null timestamps on notes.

CREATE TABLE IF NOT EXISTS sync_note_folders (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_uuid TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_note_folders_user
  ON sync_note_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_note_folders_user_updated
  ON sync_note_folders(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_notes_new (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  timestamp TEXT,
  end_timestamp TEXT,
  marker_uuid TEXT,
  folder_uuid TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO sync_notes_new (
  uuid, user_id, title, body, timestamp, end_timestamp, marker_uuid,
  folder_uuid, pinned, deleted, updated_at
)
SELECT
  uuid, user_id, title, body, timestamp, end_timestamp, marker_uuid,
  NULL, 0, deleted, updated_at
FROM sync_notes;

DROP TABLE IF EXISTS sync_notes;
ALTER TABLE sync_notes_new RENAME TO sync_notes;
CREATE INDEX IF NOT EXISTS idx_sync_notes_user
  ON sync_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_notes_user_updated
  ON sync_notes(user_id, updated_at);
