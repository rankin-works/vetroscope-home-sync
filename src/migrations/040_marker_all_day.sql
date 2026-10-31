-- SPDX-License-Identifier: Apache-2.0
-- An all-day event's dates, for events imported from Google Calendar or
-- Outlook. The desktop stores an all-day event at the importing computer's
-- local midnights; these dates let every device show it on its own day
-- whatever time zone that device is in.
--
-- all_day_start: the first day (YYYY-MM-DD), "" for "known not all-day", or
-- NULL when no client has said. all_day_end: the day after the last day
-- (exclusive, like Google's end.date), NULL for a one-day event.
--
-- They are cleartext, like timestamp and end_timestamp, which already show
-- midnight for an all-day event. A push without the key (or with null)
-- keeps both stored values; "" clears both; an invalid date keeps both.

ALTER TABLE sync_markers ADD COLUMN all_day_start TEXT;
ALTER TABLE sync_markers ADD COLUMN all_day_end TEXT;
