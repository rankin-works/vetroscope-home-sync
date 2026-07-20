-- SPDX-License-Identifier: Apache-2.0
-- Migration 017: cross-device reminder fire claims.
--
-- Devices claim a deterministic occurrence_key before showing an OS
-- notification so only one live machine toasts for the same fire.
-- Primary key (user_id, occurrence_key) makes INSERT OR IGNORE atomic.

CREATE TABLE IF NOT EXISTS sync_reminder_claims (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (user_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_reminder_claims_user
  ON sync_reminder_claims(user_id);
