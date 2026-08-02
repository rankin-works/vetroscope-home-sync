-- Migration 020: optional breakdown (project) for app / presence reminders.
-- Encrypted client-side; null = entire app.

ALTER TABLE sync_reminders ADD COLUMN project TEXT;
