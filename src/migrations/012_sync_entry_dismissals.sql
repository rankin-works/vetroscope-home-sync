-- Synced tombstones for "Dispute time block" (dismissed wake-up blips).
-- uuid is the entries.uuid that was dismissed. deleted=1 means the user
-- undid the dismissal (restore) so other devices should stop suppressing
-- that entry and can re-pull it when the undoing device re-pushes it.
CREATE TABLE IF NOT EXISTS sync_entry_dismissals (
  uuid TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_entry_dismissals_user
  ON sync_entry_dismissals(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_entry_dismissals_user_updated
  ON sync_entry_dismissals(user_id, updated_at);
