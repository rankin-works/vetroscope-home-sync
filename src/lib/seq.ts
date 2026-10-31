// SPDX-License-Identifier: Apache-2.0
//
// The save-order counter (seq) of the seq-numbered sync tables.
//
// A desktop pulls each table by seq and keeps the last number it saw, so a
// number must never be handed out twice, or below one already handed out:
// a desktop whose cursor is ahead of the new rows never pulls them. The
// next number is MAX(seq) + 1 over the table, which goes back down when
// rows are deleted, so every delete from one of these tables first records
// the table's MAX(seq) in sync_seq_floor (038), and the next number starts
// above that too.

import type Database from "better-sqlite3";

/** Every table whose rows carry a seq. */
export const SEQ_NUMBERED_TABLES = [
  "sync_entries",
  "sync_tags",
  "sync_goals",
  "sync_markers",
  "sync_notes",
  "sync_note_folders",
  "sync_goal_achievements",
  "sync_icons",
  "sync_overrides",
  "sync_settings",
  "sync_tag_sticky_exclusions",
  "sync_tag_sticky_project_apps",
  "sync_tag_sticky_subproject_scopes",
  "sync_media_links",
  "sync_app_categories",
  "sync_reminders",
  "sync_reminder_events",
  "sync_entry_dismissals",
  "sync_marker_links",
] as const;
export type SeqNumberedTable = (typeof SEQ_NUMBERED_TABLES)[number];

const KNOWN = new Set<string>(SEQ_NUMBERED_TABLES);

/** SQL for the next seq of `table`, for an INSERT's VALUES or an UPDATE's
 *  SET: above every row in the table and above every number handed out
 *  before a delete. */
export function nextSeqSql(table: SeqNumberedTable): string {
  if (!KNOWN.has(table)) throw new Error(`not a seq table: ${table}`);
  return `(SELECT MAX(
     (SELECT COALESCE(MAX(seq), 0) FROM ${table}),
     COALESCE((SELECT seq FROM sync_seq_floor WHERE tbl = '${table}'), 0)
   ) + 1)`;
}

/** Records the current MAX(seq) of each table as its floor (keeping a
 *  higher floor already there). Call it before deleting rows from them, in
 *  the same transaction as the delete. */
export function raiseSeqFloors(
  db: Database.Database,
  tables: readonly SeqNumberedTable[] = SEQ_NUMBERED_TABLES,
): void {
  for (const table of tables) {
    if (!KNOWN.has(table)) throw new Error(`not a seq table: ${table}`);
    db.prepare(
      `INSERT INTO sync_seq_floor (tbl, seq)
       SELECT '${table}', m FROM (SELECT MAX(seq) AS m FROM ${table}) WHERE m IS NOT NULL
       ON CONFLICT(tbl) DO UPDATE SET seq = MAX(sync_seq_floor.seq, excluded.seq)`,
    ).run();
  }
}
