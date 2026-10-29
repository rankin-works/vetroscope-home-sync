-- SPDX-License-Identifier: Apache-2.0
-- Migration 037: calendar copies. A Vetroscope event can be sent to several
-- Google calendars; this server owns the state of every copy, so two
-- desktops never create the same copy twice and a delete made anywhere
-- reaches every calendar the event is on.

-- What decides whether a new event is "a Vetroscope event" and when it was
-- made. A push without the key keeps the stored value; created_at is set on
-- the first insert only.
ALTER TABLE sync_markers ADD COLUMN origin TEXT;
ALTER TABLE sync_markers ADD COLUMN repeat_rule TEXT;
ALTER TABLE sync_markers ADD COLUMN created_at TEXT;

-- One row per copy of an event in one calendar (role 'copy'), or per
-- calendar event an import came from (role 'source'). Only this server
-- changes these rows, through /user/calendar-links/*; desktops pull them by
-- seq. claim_*, ever_claimed, retry_* and give_backs are never pulled.
-- Only 'copy' rows are ever created or deleted in a calendar: a 'source'
-- row is the person's own event and is only ever linked or let go.
CREATE TABLE IF NOT EXISTS sync_marker_links (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marker_uuid  TEXT NOT NULL,
  provider     TEXT NOT NULL CHECK (provider = 'google'),
  calendar_id  TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('copy','source')),
  state        TEXT NOT NULL CHECK (state IN
                 ('pending','linked','deleting','gone','removed_remote','detached','released')),
  reason       TEXT NOT NULL DEFAULT 'target',
  gen          INTEGER NOT NULL DEFAULT 0,
  account_ref  TEXT,
  event_id     TEXT,
  etag         TEXT,
  remote_updated_at TEXT,
  pushed_hash  TEXT,
  created_by   TEXT NOT NULL DEFAULT 'server',
  claim_device TEXT,
  claim_token  TEXT,
  claim_until  TEXT,
  ever_claimed INTEGER NOT NULL DEFAULT 0,
  -- A row a device gave back (unclaim) waits until retry_at before a claim
  -- by that device (retry_device) without keys picks it again, longer each
  -- time (give_backs), and comes after the other rows for every device, so
  -- rows no device can work don't take every claim. Cleared on any state
  -- change.
  retry_at     TEXT,
  retry_device TEXT,
  give_backs   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  linked_at    TEXT,
  updated_at   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  PRIMARY KEY (user_id, marker_uuid, provider, calendar_id)
);
-- One calendar never holds two live rows for one event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sml_event
  ON sync_marker_links(user_id, provider, calendar_id, event_id)
  WHERE event_id IS NOT NULL AND state IN ('linked','deleting','removed_remote');
CREATE INDEX IF NOT EXISTS idx_sml_user_seq ON sync_marker_links(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_sml_seq ON sync_marker_links(seq);
CREATE INDEX IF NOT EXISTS idx_sml_work
  ON sync_marker_links(user_id, state) WHERE state IN ('pending','deleting');

-- "Send new Vetroscope events here", one row per calendar ever switched.
CREATE TABLE IF NOT EXISTS calendar_targets (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider = 'google'),
  calendar_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  -- 1 = a starting target that stays valid while unticked, as an
  -- export-only calendar. Cleared the first time the person changes it.
  legacy_send INTEGER NOT NULL DEFAULT 0,
  on_since    TEXT,
  rev         INTEGER NOT NULL DEFAULT 1,
  changed_at  TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  PRIMARY KEY (user_id, provider, calendar_id)
);

-- Opaque per-account ids, so link rows and targets never carry an email.
CREATE TABLE IF NOT EXISTS calendar_account_refs (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account  TEXT NOT NULL,
  ref      TEXT NOT NULL,
  PRIMARY KEY (user_id, provider, account),
  UNIQUE (user_id, ref)
);

-- One row per user once a desktop that runs calendar links has taken over.
-- Never removed: links mode is permanent.
CREATE TABLE IF NOT EXISTS calendar_links_state (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  links_mode_at TEXT NOT NULL,
  converted_at  TEXT,
  links_epoch   INTEGER NOT NULL DEFAULT 0,
  epoch_at      TEXT,
  -- 1 once the desktop that ran /sync/reset has uploaded its links again
  -- (adopt-local with last: true), so the others can re-pull at once.
  epoch_adopted INTEGER NOT NULL DEFAULT 0
);

-- What each desktop said it can do (the lease's `providers`). A device
-- with no row has declared nothing.
CREATE TABLE IF NOT EXISTS calendar_devices (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  providers TEXT NOT NULL DEFAULT '',
  seen_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id)
);
