-- Migration 019: goal reminder link + milestone toggles.
-- Mirrors cloud 040.

ALTER TABLE sync_reminders ADD COLUMN goal_uuid TEXT;
ALTER TABLE sync_reminders ADD COLUMN goal_notify_half INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sync_reminders ADD COLUMN goal_notify_complete INTEGER NOT NULL DEFAULT 1;
