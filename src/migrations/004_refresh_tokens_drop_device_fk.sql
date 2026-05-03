-- SPDX-License-Identifier: Apache-2.0
-- Drop the foreign-key constraint linking refresh_tokens.device_id to
-- devices(id). Web-only sessions (the bundled dashboard) shouldn't
-- register a row in `devices` — they're read-only viewers, not
-- syncing peers — but the FK forced one device row per browser
-- session, which polluted the device list with a "Vetroscope Web"
-- entry per browser/incognito profile/cleared-cache.
--
-- After this migration, /auth/web-login can issue a refresh token
-- with any free-form device_id (a per-session UUID) without inserting
-- a corresponding device row. Existing desktop sync sessions are
-- unaffected — their device rows still exist; the only change is
-- that the FK constraint is no longer enforced.
--
-- SQLite doesn't support DROP CONSTRAINT, so we recreate the table.
-- Indexes get rebuilt on the new table; the data rides through unchanged.

CREATE TABLE refresh_tokens_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO refresh_tokens_new (id, user_id, device_id, token_hash, expires_at, created_at)
  SELECT id, user_id, device_id, token_hash, expires_at, created_at FROM refresh_tokens;

DROP TABLE refresh_tokens;
ALTER TABLE refresh_tokens_new RENAME TO refresh_tokens;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
