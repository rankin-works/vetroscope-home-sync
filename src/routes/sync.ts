// SPDX-License-Identifier: Apache-2.0
//
// /sync/* — push, pull, reset.
//
// Port of the Cloud Worker's /sync endpoints to better-sqlite3. The
// SQL is byte-identical to the cloud side on purpose: LWW semantics,
// natural keys, and the override-full-table-on-pull quirk all carry
// over, so a client pushing to Home Sync and then to Cloud gets the
// same convergence guarantees.
//
// Notable port differences:
//   - env.DB.batch(...)    → one synchronous db.transaction(() => { ... })
//   - async .bind().run()  → db.prepare(sql).run(...args) with no await
//   - The "requirePro" gate doesn't exist here — everyone on a Home
//     Sync server is effectively plan=home, which is licensed-equivalent.

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";

import type {
  JWTPayload,
  PullPayload,
  PullResponse,
  PushPayload,
  SyncEntry,
  SyncGoal,
  SyncGoalAchievement,
  SyncIcon,
  SyncMarker,
  SyncOverride,
  SyncSetting,
  SyncTag,
} from "../types.js";

const BATCH_SIZE = 500;
const ICON_LIMIT = 50;
const OVERRIDE_PULL_LIMIT = 500;
// Settings are a small allowlist (see SYNCED_SETTING_KEYS) so the legacy
// behavior was "no LIMIT" — it always fit in one response. With the
// compound cursor we still cap to a deterministic page size so a future
// allowlist expansion can't turn this into an unbounded scan, but the cap
// is comfortable above the current keyset.
const SETTING_LIMIT = 100;

// Allowlist of sync-eligible setting keys. The client has historically
// attempted to push additional keys; rejecting unknown ones keeps the
// server-side schema stable and the payload bounded.
const SYNCED_SETTING_KEYS = new Set(["ignored_apps", "ignored_projects"]);

export const syncRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.post<{ Body: PushPayload }>("/sync/push", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const body = request.body ?? {};
    const userId = auth.sub;
    const now = new Date().toISOString();

    const stmts = fastify.db;

    const upsertEntry = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        number,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO sync_entries (uuid, user_id, device_id, timestamp, app_name, window_title, project, is_adobe, tag_uuid, platform, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         tag_uuid = excluded.tag_uuid,
         platform = excluded.platform,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_entries.updated_at`,
    );

    const upsertTag = stmts.prepare<
      [string, string, string, string, number, number, string]
    >(
      `INSERT INTO sync_tags (uuid, user_id, name, color, sticky, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name,
         color = excluded.color,
         sticky = excluded.sticky,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_tags.updated_at`,
    );

    const upsertGoal = stmts.prepare<
      [
        string,
        string,
        string,
        string | null,
        string | null,
        number,
        number,
        number,
        string | null,
        string,
      ]
    >(
      // tag_uuid + created_at land in 002_sync_goals_extras.sql. created_at
      // uses COALESCE so a later push that omits it (e.g. an older client)
      // can't clobber the original creation timestamp recorded by the
      // first device to push the goal.
      `INSERT INTO sync_goals (uuid, user_id, type, app_name, tag_uuid, target_seconds, enabled, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         type = excluded.type,
         app_name = excluded.app_name,
         tag_uuid = excluded.tag_uuid,
         target_seconds = excluded.target_seconds,
         enabled = excluded.enabled,
         deleted = excluded.deleted,
         created_at = COALESCE(sync_goals.created_at, excluded.created_at),
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_goals.updated_at`,
    );

    const upsertMarker = stmts.prepare<
      [
        string,
        string,
        string,
        string | null,
        string,
        string,
        string,
        number,
        string,
      ]
    >(
      `INSERT INTO sync_markers (uuid, user_id, timestamp, end_timestamp, label, color, icon, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         timestamp = excluded.timestamp,
         end_timestamp = excluded.end_timestamp,
         label = excluded.label,
         color = excluded.color,
         icon = excluded.icon,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_markers.updated_at`,
    );

    const upsertAchievement = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        number,
        string,
      ]
    >(
      `INSERT INTO sync_goal_achievements (uuid, user_id, goal_uuid, goal_snapshot, date, achieved_at, current_seconds, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, goal_uuid, date) DO UPDATE SET
         goal_snapshot = excluded.goal_snapshot,
         achieved_at = excluded.achieved_at,
         current_seconds = excluded.current_seconds,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_goal_achievements.updated_at`,
    );

    const upsertSetting = stmts.prepare<[string, string, string, string]>(
      `INSERT INTO sync_settings (user_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_settings.updated_at`,
    );

    const upsertIcon = stmts.prepare<
      [string, string, string, string, string, string, string]
    >(
      `INSERT INTO sync_icons (name_hash, user_id, app_name, platform, data_url, dominant_color, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name_hash, user_id) DO UPDATE SET
         app_name = excluded.app_name,
         platform = excluded.platform,
         data_url = excluded.data_url,
         dominant_color = excluded.dominant_color,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_icons.updated_at`,
    );

    const upsertOverride = stmts.prepare<
      [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
      ]
    >(
      `INSERT INTO sync_overrides (name_hash, user_id, app_name, display_name, color, icon_data_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name_hash, user_id) DO UPDATE SET
         app_name = excluded.app_name,
         display_name = excluded.display_name,
         color = excluded.color,
         icon_data_url = excluded.icon_data_url,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > sync_overrides.updated_at`,
    );

    const updateDeviceSync = stmts.prepare<[string, string, string]>(
      "UPDATE devices SET last_sync_at = ? WHERE id = ? AND user_id = ?",
    );

    const tx = fastify.db.transaction(() => {
      for (const e of (body.entries ?? []).slice(0, BATCH_SIZE)) {
        upsertEntry.run(
          e.uuid,
          userId,
          e.device_id,
          e.timestamp,
          e.app_name,
          e.window_title,
          e.project,
          e.is_adobe,
          e.tag_uuid,
          e.platform ?? null,
          e.updated_at || now,
        );
      }
      for (const t of (body.tags ?? []).slice(0, BATCH_SIZE)) {
        upsertTag.run(
          t.uuid,
          userId,
          t.name,
          t.color,
          t.sticky,
          t.deleted,
          t.updated_at || now,
        );
      }
      for (const g of (body.goals ?? []).slice(0, BATCH_SIZE)) {
        upsertGoal.run(
          g.uuid,
          userId,
          g.type,
          g.app_name,
          g.tag_uuid ?? null,
          g.target_seconds,
          g.enabled,
          g.deleted,
          g.created_at ?? null,
          g.updated_at || now,
        );
      }
      for (const m of (body.markers ?? []).slice(0, BATCH_SIZE)) {
        upsertMarker.run(
          m.uuid,
          userId,
          m.timestamp,
          m.end_timestamp,
          m.label,
          m.color,
          m.icon,
          m.deleted,
          m.updated_at || now,
        );
      }
      for (const a of (body.achievements ?? []).slice(0, BATCH_SIZE)) {
        upsertAchievement.run(
          a.uuid,
          userId,
          a.goal_uuid,
          a.goal_snapshot,
          a.date,
          a.achieved_at,
          a.current_seconds,
          a.deleted,
          a.updated_at || now,
        );
      }
      for (const s of body.settings ?? []) {
        if (!SYNCED_SETTING_KEYS.has(s.key)) continue;
        upsertSetting.run(userId, s.key, s.value, s.updated_at || now);
      }
      for (const i of (body.icons ?? []).slice(0, ICON_LIMIT)) {
        upsertIcon.run(
          i.name_hash,
          userId,
          i.app_name,
          i.platform || "unknown",
          i.data_url,
          i.dominant_color,
          i.updated_at || now,
        );
      }
      for (const o of (body.overrides ?? []).slice(0, ICON_LIMIT)) {
        upsertOverride.run(
          o.name_hash,
          userId,
          o.app_name,
          o.display_name,
          o.color,
          o.icon_data_url,
          o.updated_at || now,
        );
      }
      updateDeviceSync.run(now, auth.device_id, userId);
    });
    tx();

    return reply.send({
      ok: true,
      synced: {
        entries: body.entries?.length ?? 0,
        tags: body.tags?.length ?? 0,
        goals: body.goals?.length ?? 0,
        markers: body.markers?.length ?? 0,
        achievements: body.achievements?.length ?? 0,
      },
      cursor: now,
    });
  });

  fastify.post<{ Body: PullPayload }>("/sync/pull", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const body = request.body ?? ({} as PullPayload);
    const userId = auth.sub;
    const cursor = body.cursor ?? "1970-01-01T00:00:00.000Z";
    const deviceId = body.device_id ?? auth.device_id;
    const now = new Date().toISOString();

    const entries = fastify.db
      .prepare<[string, string, string, number], SyncEntry>(
        `SELECT uuid, device_id, timestamp, app_name, window_title, project, is_adobe, tag_uuid, platform, updated_at
         FROM sync_entries
         WHERE user_id = ? AND updated_at > ? AND device_id != ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, cursor, deviceId, BATCH_SIZE);

    const tags = fastify.db
      .prepare<[string, string, number], SyncTag>(
        `SELECT uuid, name, color, sticky, deleted, updated_at
         FROM sync_tags
         WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, cursor, BATCH_SIZE);

    const goals = fastify.db
      .prepare<[string, string, number], SyncGoal>(
        `SELECT uuid, type, app_name, tag_uuid, target_seconds, enabled, deleted, created_at, updated_at
         FROM sync_goals
         WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, cursor, BATCH_SIZE);

    const markers = fastify.db
      .prepare<[string, string, number], SyncMarker>(
        `SELECT uuid, timestamp, end_timestamp, label, color, icon, deleted, updated_at
         FROM sync_markers
         WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, cursor, BATCH_SIZE);

    const achievements = fastify.db
      .prepare<[string, string, number], SyncGoalAchievement>(
        `SELECT uuid, goal_uuid, goal_snapshot, date, achieved_at, current_seconds, deleted, updated_at
         FROM sync_goal_achievements
         WHERE user_id = ? AND updated_at > ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, cursor, BATCH_SIZE);

    // Icons use a compound (updated_at, name_hash) cursor instead of the
    // shared time-only cursor. A single client push of N icons stamps every
    // row in the batch with the same `Date.now()`-resolution timestamp, so
    // strict-greater-than pagination on `updated_at` alone will skip rows
    // that share the boundary timestamp on the next pull. The compound form
    // breaks ties on the row's natural unique key (`name_hash`).
    //
    // When the client doesn't send `icon_cursor` (older builds, or first
    // pull after upgrade) we fall back to the shared time-only cursor for
    // a clean transition — that path matches the legacy behavior exactly.
    const iconCursor = body.icon_cursor;
    const icons = iconCursor
      ? fastify.db
          .prepare<[string, string, string, string], SyncIcon>(
            `SELECT name_hash, app_name, platform, data_url, dominant_color, updated_at
             FROM sync_icons
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND name_hash > ?))
             ORDER BY updated_at ASC, name_hash ASC
             LIMIT ${ICON_LIMIT}`,
          )
          .all(userId, iconCursor.updated_at, iconCursor.updated_at, iconCursor.key)
      : fastify.db
          .prepare<[string, string], SyncIcon>(
            `SELECT name_hash, app_name, platform, data_url, dominant_color, updated_at
             FROM sync_icons
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, name_hash ASC
             LIMIT ${ICON_LIMIT}`,
          )
          .all(userId, cursor);

    // Overrides are intentionally returned in full (not cursor-filtered)
    // — see the cloud Worker comment, the client relies on LWW to dedupe.
    const overrides = fastify.db
      .prepare<[string], SyncOverride>(
        `SELECT name_hash, app_name, display_name, color, icon_data_url, updated_at
         FROM sync_overrides
         WHERE user_id = ?
         ORDER BY updated_at ASC
         LIMIT ${OVERRIDE_PULL_LIMIT}`,
      )
      .all(userId);

    // Settings have the same shared-timestamp hazard as icons — a single
    // bulk update (e.g. a Reset Cloud Data → re-push flow) can stamp every
    // setting with the same `now`. Same compound-cursor treatment, with
    // `key` as the tiebreaker. There's no LIMIT on the legacy fallback so
    // existing behavior is preserved when a client doesn't send
    // `setting_cursor`.
    const settingCursor = body.setting_cursor;
    const settings = settingCursor
      ? fastify.db
          .prepare<[string, string, string, string], SyncSetting>(
            `SELECT key, value, updated_at
             FROM sync_settings
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND key > ?))
             ORDER BY updated_at ASC, key ASC
             LIMIT ${SETTING_LIMIT}`,
          )
          .all(userId, settingCursor.updated_at, settingCursor.updated_at, settingCursor.key)
      : fastify.db
          .prepare<[string, string], SyncSetting>(
            `SELECT key, value, updated_at
             FROM sync_settings
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, key ASC`,
          )
          .all(userId, cursor);

    fastify.db
      .prepare<[string, string, string]>(
        "UPDATE devices SET last_sync_at = ? WHERE id = ? AND user_id = ?",
      )
      .run(now, auth.device_id, userId);

    // Time-cursor types: entries, tags, goals, markers, achievements.
    // Icons + settings are governed by their own compound cursors and
    // tracked separately so the time cursor doesn't have to lie about
    // their state.
    const hitLimitTimeTypes =
      entries.length >= BATCH_SIZE ||
      tags.length >= BATCH_SIZE ||
      goals.length >= BATCH_SIZE ||
      markers.length >= BATCH_SIZE ||
      achievements.length >= BATCH_SIZE;
    const hitLimitIcons = icons.length >= ICON_LIMIT;
    const hitLimitSettings = settings.length >= SETTING_LIMIT;

    let newCursor = now;
    if (hitLimitTimeTypes) {
      const latestPerType = [entries, tags, goals, markers, achievements]
        .filter((arr) => arr.length > 0)
        .map((arr) => (arr as Array<{ updated_at: string }>)[arr.length - 1]!.updated_at);
      if (latestPerType.length > 0) {
        newCursor = latestPerType.sort()[0]!;
      }
    }

    // Compound cursors for icons / settings — only emitted when that
    // table actually paginated (response was truncated). The client
    // round-trips them on the next pull. Absence means "this type is
    // fully drained at this snapshot."
    const nextIconCursor = hitLimitIcons && icons.length > 0
      ? {
          updated_at: icons[icons.length - 1]!.updated_at,
          key: icons[icons.length - 1]!.name_hash,
        }
      : undefined;
    const nextSettingCursor = hitLimitSettings && settings.length > 0
      ? {
          updated_at: settings[settings.length - 1]!.updated_at,
          key: settings[settings.length - 1]!.key,
        }
      : undefined;

    const response: PullResponse = {
      entries,
      tags,
      goals,
      markers,
      achievements,
      icons,
      overrides,
      settings,
      cursor: newCursor,
      has_more: hitLimitTimeTypes || hitLimitIcons || hitLimitSettings,
      ...(nextIconCursor ? { icon_cursor: nextIconCursor } : {}),
      ...(nextSettingCursor ? { setting_cursor: nextSettingCursor } : {}),
    };
    return reply.send(response);
  });

  fastify.post("/sync/reset", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const userId = auth.sub;
    wipeUserSyncRows(fastify.db, userId);
    fastify.db
      .prepare<[string]>(
        "UPDATE devices SET last_sync_at = NULL WHERE user_id = ?",
      )
      .run(userId);
    request.log.info({ userId }, "sync reset");
    return reply.send({ ok: true });
  });

  fastify.post("/sync/count", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const counts = fastify.db
      .prepare<[string], { device_id: string; count: number }>(
        "SELECT device_id, COUNT(*) AS count FROM sync_entries WHERE user_id = ? GROUP BY device_id",
      )
      .all(auth.sub);
    return reply.send({ counts });
  });
};

export function wipeUserSyncRows(db: Database.Database, userId: string): void {
  const tables = [
    "sync_entries",
    "sync_tags",
    "sync_goals",
    "sync_markers",
    "sync_goal_achievements",
    "sync_icons",
    "sync_overrides",
    "sync_settings",
  ];
  const tx = db.transaction(() => {
    for (const t of tables) {
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    }
  });
  tx();
}
