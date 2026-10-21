-- SPDX-License-Identifier: Apache-2.0
-- sync_settings and sync_overrides get the save order the other pulled
-- tables got in 034. Every pull used to return all of them (a full set
-- was the earlier fix for the same race), which with custom app icons in
-- overrides meant re-downloading ~100+ KB every 15 seconds per device.
-- Paged by seq, they're only sent when something changed. Existing rows
-- are numbered by rowid, as in 034.

ALTER TABLE sync_settings ADD COLUMN seq INTEGER;
UPDATE sync_settings SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_settings_seq ON sync_settings(seq);
CREATE INDEX IF NOT EXISTS idx_sync_settings_user_seq ON sync_settings(user_id, seq);

ALTER TABLE sync_overrides ADD COLUMN seq INTEGER;
UPDATE sync_overrides SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_overrides_seq ON sync_overrides(seq);
CREATE INDEX IF NOT EXISTS idx_sync_overrides_user_seq ON sync_overrides(user_id, seq);
