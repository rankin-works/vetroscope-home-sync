-- SPDX-License-Identifier: Apache-2.0
-- Add the goal columns the cloud schema already had: tag_uuid (cross-device
-- reference for tag-based goals) and created_at (used by the goal detail
-- modal to scope "days met" to days after the goal existed).
--
-- The 001 schema dropped both, so until 002 lands the home-sync server
-- silently discards them on every push and the pull SELECT can't return
-- them. Existing rows backfill to NULL — clients carry the values from
-- their local DB and re-push on the next sync, so the fields populate
-- on their own without a server-side data migration.

ALTER TABLE sync_goals ADD COLUMN tag_uuid   TEXT;
ALTER TABLE sync_goals ADD COLUMN created_at TEXT;
