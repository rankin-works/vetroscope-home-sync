-- SPDX-License-Identifier: Apache-2.0
-- Migration 010: replicate last_fired_at across devices for reminders.
--
-- Without this column, a reminder firing on Device A doesn't tell
-- Device B that today's occurrence is already covered. Device B's
-- local scheduler reads last_fired_at as NULL (it wasn't synced),
-- sees the time-of-day has passed, and re-fires the same reminder —
-- multiplied across every reminder that fired while Device B was
-- offline, the user gets a stacked overlay queue the moment B comes
-- back online.
--
-- Mirrors Vetroscope Cloud migration 022 from the private repo.
-- ISO timestamp set client-side by the scheduler at fire time;
-- nullable so reminders that have never fired stay represented as
-- NULL. No new index — push/pull join on uuid like every other
-- field on the row.

ALTER TABLE sync_reminders ADD COLUMN last_fired_at TEXT;
