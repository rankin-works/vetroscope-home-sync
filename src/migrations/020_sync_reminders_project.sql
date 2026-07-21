-- Migration 020: optional breakdown (project) for app / presence reminders.
-- Mirrors cloud 041. Encrypted client-side; null = entire app.

ALTER TABLE sync_reminders ADD COLUMN project TEXT;
