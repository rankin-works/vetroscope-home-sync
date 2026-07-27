-- SPDX-License-Identifier: Apache-2.0
-- Per-account welcome guide status. NULL = not yet finished or skipped
-- (client auto-prompts). 'completed' | 'skipped' suppress the auto-prompt.
-- No backfill: every existing account should see the guide once.
-- Mirrors Cloud migration 044_users_onboarding_status.

ALTER TABLE users ADD COLUMN onboarding_status TEXT;
ALTER TABLE users ADD COLUMN onboarding_status_at TEXT;
