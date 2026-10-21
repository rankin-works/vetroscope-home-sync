-- SPDX-License-Identifier: Apache-2.0
-- The rest of the pulled tables get the server-assigned order sync_entries
-- got in 032, for the same reason: they paged by the writing device's
-- updated_at, and a caught-up pull moved the shared cursor to the server's
-- clock, so a row saved during another device's pull could land behind
-- its cursor and never arrive (a dismissed entry, a tag, a note).
--
-- Unlike sync_entries these tables are small, so existing rows are
-- numbered here (by rowid, which every new number is above): a client
-- pulling one of them by seq from 0 gets the whole table, which also
-- restores rows the time cursor skipped. sync_settings and sync_overrides
-- are left out; every pull returns all of them.

ALTER TABLE sync_tags ADD COLUMN seq INTEGER;
UPDATE sync_tags SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_tags_seq ON sync_tags(seq);
CREATE INDEX IF NOT EXISTS idx_sync_tags_user_seq ON sync_tags(user_id, seq);

ALTER TABLE sync_goals ADD COLUMN seq INTEGER;
UPDATE sync_goals SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_goals_seq ON sync_goals(seq);
CREATE INDEX IF NOT EXISTS idx_sync_goals_user_seq ON sync_goals(user_id, seq);

ALTER TABLE sync_markers ADD COLUMN seq INTEGER;
UPDATE sync_markers SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_markers_seq ON sync_markers(seq);
CREATE INDEX IF NOT EXISTS idx_sync_markers_user_seq ON sync_markers(user_id, seq);

ALTER TABLE sync_notes ADD COLUMN seq INTEGER;
UPDATE sync_notes SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_notes_seq ON sync_notes(seq);
CREATE INDEX IF NOT EXISTS idx_sync_notes_user_seq ON sync_notes(user_id, seq);

ALTER TABLE sync_note_folders ADD COLUMN seq INTEGER;
UPDATE sync_note_folders SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_note_folders_seq ON sync_note_folders(seq);
CREATE INDEX IF NOT EXISTS idx_sync_note_folders_user_seq ON sync_note_folders(user_id, seq);

ALTER TABLE sync_goal_achievements ADD COLUMN seq INTEGER;
UPDATE sync_goal_achievements SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_goal_achievements_seq ON sync_goal_achievements(seq);
CREATE INDEX IF NOT EXISTS idx_sync_goal_achievements_user_seq ON sync_goal_achievements(user_id, seq);

ALTER TABLE sync_icons ADD COLUMN seq INTEGER;
UPDATE sync_icons SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_icons_seq ON sync_icons(seq);
CREATE INDEX IF NOT EXISTS idx_sync_icons_user_seq ON sync_icons(user_id, seq);

ALTER TABLE sync_tag_sticky_exclusions ADD COLUMN seq INTEGER;
UPDATE sync_tag_sticky_exclusions SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_exclusions_seq ON sync_tag_sticky_exclusions(seq);
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_exclusions_user_seq ON sync_tag_sticky_exclusions(user_id, seq);

ALTER TABLE sync_tag_sticky_project_apps ADD COLUMN seq INTEGER;
UPDATE sync_tag_sticky_project_apps SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_project_apps_seq ON sync_tag_sticky_project_apps(seq);
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_project_apps_user_seq ON sync_tag_sticky_project_apps(user_id, seq);

ALTER TABLE sync_tag_sticky_subproject_scopes ADD COLUMN seq INTEGER;
UPDATE sync_tag_sticky_subproject_scopes SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_subproject_scopes_seq ON sync_tag_sticky_subproject_scopes(seq);
CREATE INDEX IF NOT EXISTS idx_sync_tag_sticky_subproject_scopes_user_seq ON sync_tag_sticky_subproject_scopes(user_id, seq);

ALTER TABLE sync_media_links ADD COLUMN seq INTEGER;
UPDATE sync_media_links SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_media_links_seq ON sync_media_links(seq);
CREATE INDEX IF NOT EXISTS idx_sync_media_links_user_seq ON sync_media_links(user_id, seq);

ALTER TABLE sync_app_categories ADD COLUMN seq INTEGER;
UPDATE sync_app_categories SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_app_categories_seq ON sync_app_categories(seq);
CREATE INDEX IF NOT EXISTS idx_sync_app_categories_user_seq ON sync_app_categories(user_id, seq);

ALTER TABLE sync_reminders ADD COLUMN seq INTEGER;
UPDATE sync_reminders SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_reminders_seq ON sync_reminders(seq);
CREATE INDEX IF NOT EXISTS idx_sync_reminders_user_seq ON sync_reminders(user_id, seq);

ALTER TABLE sync_reminder_events ADD COLUMN seq INTEGER;
UPDATE sync_reminder_events SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_reminder_events_seq ON sync_reminder_events(seq);
CREATE INDEX IF NOT EXISTS idx_sync_reminder_events_user_seq ON sync_reminder_events(user_id, seq);

ALTER TABLE sync_entry_dismissals ADD COLUMN seq INTEGER;
UPDATE sync_entry_dismissals SET seq = rowid;
CREATE INDEX IF NOT EXISTS idx_sync_entry_dismissals_seq ON sync_entry_dismissals(seq);
CREATE INDEX IF NOT EXISTS idx_sync_entry_dismissals_user_seq ON sync_entry_dismissals(user_id, seq);
