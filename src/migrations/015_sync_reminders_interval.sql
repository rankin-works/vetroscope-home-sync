-- Migration 015: interval cadence for reminders.
--
-- interval_seconds drives kind='interval' (every N seconds) and optional
-- re-fire cadence on tag-threshold reminders while still over threshold.
-- Cleartext — structural schedule field, same as threshold_seconds / period.

ALTER TABLE sync_reminders ADD COLUMN interval_seconds INTEGER;
