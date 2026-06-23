-- SPDX-License-Identifier: Apache-2.0
-- Catch Home Sync up with Vetroscope Cloud migrations 027–029.
--
--   027 — sync_tags.sticky_subprojects
--         Opt-in per-tag flag: when sticky is on, new sub-breakdowns under
--         a tagged breakdown can inherit the tag (songs, videos, etc.).
--
--   028 — sync_tags.sticky_projects
--         Opt-in per-tag flag: when sticky is on and the tag is on the
--         whole app, new breakdowns under that app can inherit the tag.
--
--   029 — sync_tag_sticky_project_apps
--         sync_tag_sticky_subproject_scopes
--         Per-app / per-breakdown allowlists gating the two global flags
--         above so auto-tag only applies where the user opted in.
--
-- Existing rows backfill to 0 on the new columns. Clients re-push the
-- allowlist rows on the next sync cycle after upgrading.

ALTER TABLE sync_tags ADD COLUMN sticky_subprojects INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_tags ADD COLUMN sticky_projects INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sync_tag_sticky_project_apps (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_uuid TEXT,
  app_name TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_sticky_proj_apps_user
  ON sync_tag_sticky_project_apps(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_sticky_proj_apps_user_updated
  ON sync_tag_sticky_project_apps(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_tag_sticky_subproject_scopes (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_uuid TEXT,
  app_name TEXT NOT NULL,
  project TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_sticky_subproj_scopes_user
  ON sync_tag_sticky_subproject_scopes(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_sticky_subproj_scopes_user_updated
  ON sync_tag_sticky_subproject_scopes(user_id, updated_at);
