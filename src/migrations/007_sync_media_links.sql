-- SPDX-License-Identifier: Apache-2.0
-- Migration 007: replicated capture of canonical media URIs.
--
-- Stores per-(app, project, sub_project) media URLs that the desktop
-- client captures when the user opts into media-link capture. Two
-- kinds today:
--
--   * `spotify_track`  — `spotify:track:<id>` URI for songs played in
--                        the Spotify app (macOS only; the URI surfaces
--                        via the AppleScript dictionary).
--   * `youtube_watch`  — `https://www.youtube.com/watch?v=<id>` URLs
--                        captured from the browser bridge. The desktop
--                        client filters strictly to /watch pages and
--                        reconstructs the URL from a validated 11-char
--                        video ID, so no tracking params reach storage.
--
-- All four PII columns (app_name, project, sub_project, url) are
-- encrypted client-side with the user's recovery code before push.
-- `kind` is cleartext because it carries no user-identifying info and
-- is useful for server-side aggregate logs / debugging.
--
-- Pre-007 servers received no media_links field — desktop clients
-- omit it from the push payload when the per-target sync setting is
-- off, and the server silently drops the array when its handler
-- doesn't recognize the key. This migration adds the storage; the
-- matching desktop release adds the push/pull.
--
-- `deleted` is reserved for future tombstone propagation — desktop
-- v1 never sets it to 1 (capture is additive-only; the only removal
-- path is wipeAllLocalData, which doesn't push tombstones).

CREATE TABLE IF NOT EXISTS sync_media_links (
  uuid        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_name    TEXT NOT NULL,        -- encrypted client-side
  project     TEXT NOT NULL,        -- encrypted client-side
  sub_project TEXT NOT NULL,        -- encrypted client-side (empty-string sentinel for "no sub_project")
  url         TEXT NOT NULL,        -- encrypted client-side
  kind        TEXT NOT NULL,        -- cleartext: 'spotify_track' | 'youtube_watch'
  first_seen  TEXT NOT NULL,        -- cleartext ISO timestamp
  last_seen   TEXT NOT NULL,        -- cleartext ISO timestamp
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_media_links_user
  ON sync_media_links(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_media_links_user_updated
  ON sync_media_links(user_id, updated_at);
