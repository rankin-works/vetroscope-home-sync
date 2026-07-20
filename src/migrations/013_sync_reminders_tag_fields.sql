-- SPDX-License-Identifier: Apache-2.0
-- Migration 013: tag-threshold reminder fields.
--
-- tag_uuid links a tag reminder across devices; threshold_seconds and period
-- describe its trigger; icon_data_url is encrypted client-side like tag icons.
-- sync_reminders intentionally has no kind CHECK, so 'tag' needs no schema
-- constraint change.

ALTER TABLE sync_reminders ADD COLUMN tag_uuid TEXT;
ALTER TABLE sync_reminders ADD COLUMN threshold_seconds INTEGER;
ALTER TABLE sync_reminders ADD COLUMN period TEXT;
ALTER TABLE sync_reminders ADD COLUMN icon_data_url TEXT;
