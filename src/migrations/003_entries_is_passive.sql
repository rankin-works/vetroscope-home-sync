-- SPDX-License-Identifier: Apache-2.0
-- Add is_passive to sync_entries so away-listening / background-app
-- entries (music playing while another app is focused, idle-but-not-
-- away samples, etc.) can be excluded from active-time totals. Mirrors
-- the cloud schema's migration 004_entries_is_passive.sql.
--
-- Until this migration ran, the desktop client was pushing is_passive
-- on every entry but the server was silently discarding it (the column
-- didn't exist, INSERT just ignored it). After this migration the
-- column exists and future pushes populate it correctly. Historical
-- rows backfill to 0 — the desktop's "Reset Cloud Data → re-sync"
-- action repushes everything with the right flags.

ALTER TABLE sync_entries ADD COLUMN is_passive INTEGER NOT NULL DEFAULT 0;
