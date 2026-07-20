-- Migration 016: daily end time for interval reminders.
--
-- end_time_of_day (HH:MM local) closes the daily window that starts at
-- time_of_day. Null = run until end of day. Cleartext schedule field.

ALTER TABLE sync_reminders ADD COLUMN end_time_of_day TEXT;
