-- Migration 018: app / presence reminder target.
-- app_name is encrypted client-side.

ALTER TABLE sync_reminders ADD COLUMN app_name TEXT;
