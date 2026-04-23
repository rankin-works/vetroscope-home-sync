-- SPDX-License-Identifier: Apache-2.0
-- Initial Home Sync schema.
--
-- Mirrors the Vetroscope Cloud D1 schema minus billing-related columns and
-- tables. A client can push identical payloads at either endpoint; the
-- server-side shape is the same.

-- Users. `plan` is pinned to 'home' for Home Sync accounts — clients map
-- this to licensed-tier UI treatments. Billing fields from the cloud schema
-- (ls_customer_id, ls_subscription_id, license_key) are intentionally
-- absent: Home Sync has no billing plumbing.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                        -- UUID
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,                -- PBKDF2 hash (hex)
  password_salt TEXT NOT NULL,                -- hex-encoded salt
  plan TEXT NOT NULL DEFAULT 'home',
  role TEXT NOT NULL DEFAULT 'user',          -- 'admin' | 'user'
  encrypted_sync_key TEXT,                    -- wrapped with user's recovery code
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Devices (see VS_MAX_DEVICES_PER_USER — enforced in the route handler).
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,                        -- UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,                     -- 'darwin' | 'win32'
  last_sync_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Refresh tokens. Rotated on every /auth/refresh; old rows deleted on
-- rotation so replay requires the latest token.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,                   -- SHA-256 hash of the token
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Password reset tokens. Home Sync has no SMTP; resets are driven by the
-- admin-CLI in the container. Table is kept so the shape matches cloud.
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_hash ON password_resets(token_hash);

-- One-time invite tokens. Consumed during /auth/register when registration
-- mode is 'invite'. Stored as PBKDF2(value, salt=id) so DB access alone
-- doesn't yield a usable code.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'user',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invites_hash ON invites(token_hash);

-- Synced entries (mirror of the client's local entries table).
CREATE TABLE IF NOT EXISTS sync_entries (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  app_name TEXT NOT NULL,                     -- encrypted client-side
  window_title TEXT,                          -- encrypted client-side
  project TEXT,                               -- encrypted client-side
  is_adobe INTEGER DEFAULT 0,
  tag_uuid TEXT,
  platform TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_entries_user ON sync_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_entries_user_updated ON sync_entries(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_tags (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8b5cf6',
  sticky INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_tags_user ON sync_tags(user_id);

CREATE TABLE IF NOT EXISTS sync_goals (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  app_name TEXT,
  target_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_goals_user ON sync_goals(user_id);

CREATE TABLE IF NOT EXISTS sync_markers (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  end_timestamp TEXT,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f59e0b',
  icon TEXT NOT NULL DEFAULT 'flag',
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_markers_user ON sync_markers(user_id);

-- One row per (goal, local-date). Natural key (user_id, goal_uuid, date)
-- lets cross-device hits on the same day converge; the per-device uuid
-- keys the local row.
CREATE TABLE IF NOT EXISTS sync_goal_achievements (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_uuid TEXT NOT NULL,
  goal_snapshot TEXT NOT NULL,
  date TEXT NOT NULL,
  achieved_at TEXT NOT NULL,
  current_seconds INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, goal_uuid, date)
);
CREATE INDEX IF NOT EXISTS idx_sync_goal_achievements_user ON sync_goal_achievements(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_icons (
  name_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  data_url TEXT NOT NULL,
  dominant_color TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name_hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_icons_user_updated ON sync_icons(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_overrides (
  name_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  display_name TEXT,
  color TEXT,
  icon_data_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name_hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_overrides_user_updated ON sync_overrides(user_id, updated_at);

CREATE TABLE IF NOT EXISTS sync_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,                        -- encrypted JSON blob
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_sync_settings_user_updated ON sync_settings(user_id, updated_at);

-- Server-scoped state: JWT secret, hashed setup token, schema version,
-- installation id. Singleton key/value — don't repurpose this as a
-- per-user kv store.
CREATE TABLE IF NOT EXISTS server_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
