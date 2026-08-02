-- SPDX-License-Identifier: Apache-2.0
-- Migration 021: account-scoped Google Calendar credentials + sync leader lease.

CREATE TABLE IF NOT EXISTS google_calendar_accounts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, email)
);
CREATE INDEX IF NOT EXISTS idx_google_calendar_accounts_user
  ON google_calendar_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_google_calendar_accounts_user_updated
  ON google_calendar_accounts(user_id, updated_at);

CREATE TABLE IF NOT EXISTS google_calendar_leader (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
