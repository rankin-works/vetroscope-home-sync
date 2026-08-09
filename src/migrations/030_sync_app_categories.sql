-- SPDX-License-Identifier: Apache-2.0
-- Migration 030: synced activity-category assignments.
--
-- Replicates per-(app, project) category mappings so Timeline / Charts /
-- Calendar paint the same labels on every device bound to this server.
-- Seeded mappings stay local to the desktop client; only user / ai /
-- catalog rows are pushed. app_name + project are ciphertext on the
-- wire; category_id / source / confidence / model are cleartext (fixed
-- taxonomy, no PII).
--
-- Pre-030 servers silently drop the app_categories collection. Natural
-- key is the client-generated uuid; LWW on updated_at; upserts are
-- tenant-scoped (user_id = excluded.user_id) like every other sync_*
-- table.

CREATE TABLE IF NOT EXISTS sync_app_categories (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  project TEXT NOT NULL,
  category_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,
  model TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_app_categories_user
  ON sync_app_categories(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_app_categories_user_updated
  ON sync_app_categories(user_id, updated_at);
