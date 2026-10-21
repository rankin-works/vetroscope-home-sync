-- SPDX-License-Identifier: Apache-2.0
-- Device ids a desktop's session was moved off (adoptDeviceId), and the id
-- it moved to. The user's other desktops already pulled entries under the
-- old id; /user/profile lists these so they relabel those rows to the
-- right machine instead of guessing by platform, which picks the wrong one
-- when two machines share a platform.

CREATE TABLE IF NOT EXISTS device_aliases (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_id TEXT NOT NULL,
  new_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, old_id)
);
