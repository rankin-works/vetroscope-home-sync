-- SPDX-License-Identifier: Apache-2.0
-- A server-assigned order for sync_entries, so a pull can't skip a row.
--
-- Pulls used to page entries by updated_at, which the pushing desktop
-- stamps with its own clock, and a caught-up pull moved the cursor to the
-- server's clock. A push stamped before another device's pull but saved
-- after it (a desktop clock running behind, say) landed behind that
-- device's cursor and was never pulled.
--
-- seq is assigned on every insert or update from one counter across all
-- users (MAX(seq) + 1, so a user's numbers never restart after a wipe).
-- Rows written before this migration keep seq NULL; clients reach them by
-- updated_at and switch to seq once caught up (see /sync/pull).

ALTER TABLE sync_entries ADD COLUMN seq INTEGER;

CREATE INDEX IF NOT EXISTS idx_sync_entries_seq ON sync_entries(seq);
CREATE INDEX IF NOT EXISTS idx_sync_entries_user_seq ON sync_entries(user_id, seq);
