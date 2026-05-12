-- SPDX-License-Identifier: Apache-2.0
-- Catch Home Sync up with sync schema additions that landed in the
-- Vetroscope Cloud Worker between Home Sync v0.1.0-beta.1 and v0.1.0-beta.9.
-- Until this migration ran, the home-sync server was silently dropping
-- four pieces of data the desktop client has been pushing for some time:
--
--   1. sync_tags.icon_data_url
--      Encrypted data URL of an optional user-uploaded tag icon. Cloud
--      migration 007 added this; Home Sync didn't have it, so tag
--      icons never cross-synced via a Home Sync target.
--
--   2. sync_tags.parent_uuid
--      Cross-device parent reference for nested tags. NULL = root tag.
--      Lets a child tag find its parent across devices when local row
--      ids differ. Cleartext — uuids carry no user-identifying data.
--      NEW to both Cloud and Home Sync; Cloud migration 016 ships the
--      same change there. Without this column, the nested-tags hierarchy
--      flattens on push and never re-attaches on pull.
--
--   3. sync_entries.sub_project
--      Third-level breakdown from the Vetroscope browser extension
--      (videos under YouTube, songs under Spotify Web, etc.). Cloud
--      migration 008 added this; Home Sync didn't, so browser-extension
--      sub-projects never replicated via Home Sync.
--
--   4. sync_tag_sticky_exclusions
--      Per-(tag, app, project) sticky-exclusion tombstones. Cloud
--      migration 006 added this table; Home Sync didn't have it at all.
--      Without it, disabling sticky auto-attachment of a tag for a
--      specific scope only takes effect on the device where it was
--      toggled — other devices keep auto-attaching the tag.
--
-- Existing rows backfill to NULL on the new columns. Clients carry the
-- values from their local DB and re-push on the next sync cycle, so the
-- fields populate on their own without a server-side data migration.
--
-- Composite (user_id, updated_at) indexes on sync_tags / sync_goals /
-- sync_markers brought over from Cloud migration 010. The pull route's
-- `WHERE user_id = ? AND updated_at > ? ORDER BY updated_at` is the
-- dominant query; the composite index keeps it index-only as row counts
-- grow.

ALTER TABLE sync_tags ADD COLUMN icon_data_url TEXT;
ALTER TABLE sync_tags ADD COLUMN parent_uuid   TEXT;

ALTER TABLE sync_entries ADD COLUMN sub_project TEXT;

CREATE TABLE IF NOT EXISTS sync_tag_sticky_exclusions (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_uuid TEXT,
  app_name TEXT NOT NULL,            -- encrypted client-side
  project TEXT,                      -- encrypted client-side, null when scope has no breakdown
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_excl_user
  ON sync_tag_sticky_exclusions(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_excl_user_updated
  ON sync_tag_sticky_exclusions(user_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_sync_tags_user_updated
  ON sync_tags(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_goals_user_updated
  ON sync_goals(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_markers_user_updated
  ON sync_markers(user_id, updated_at);
