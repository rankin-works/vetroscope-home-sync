// SPDX-License-Identifier: Apache-2.0
//
// /web/* — read-only data endpoints powering the bundled web UI
// (`public/`). Distinct from /sync/* because the desktop sync flow
// scopes pulls to "rows from other devices" — the web UI has no
// local store, so it needs every row.
//
// Shape stays compatible with cloud (a future cloud Worker can mount
// this at the same path with an identical response). Encrypted fields
// (app_name, window_title, project) are returned as ciphertext; the
// browser unwraps the user's sync key with their recovery code and
// decrypts in-memory. The server never sees plaintext.

import type { FastifyPluginAsync } from "fastify";

import type {
  JWTPayload,
  SyncEntry,
  SyncGoal,
  SyncGoalAchievement,
  SyncIcon,
  SyncMarker,
  SyncOverride,
  SyncTag,
} from "../types.js";

interface SnapshotQuery {
  // ISO 8601. When omitted, returns everything from the start of time.
  since?: string;
  // ISO 8601. Cursor for "load older entries" — returns entries with
  // timestamp strictly less than this. Used by the web UI's pagination.
  before?: string;
  // Hard cap for entries returned in one response. Defaults to 500k —
  // a power user logs ~50k samples per month, so this covers around a
  // decade in one round trip. The ceiling exists only so a typo'd
  // ?limit= can't tip the browser into an OOM; SQLite itself doesn't
  // care.
  limit?: string;
}

export const webRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get<{ Querystring: SnapshotQuery }>(
    "/web/snapshot",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const userId = auth.sub;

      const since = request.query.since ?? "1970-01-01T00:00:00.000Z";
      const before = request.query.before ?? null;
      const limit = clampLimit(request.query.limit);

      const entries = before
        ? fastify.db
            .prepare<[string, string, string, number], SyncEntry>(
              `SELECT uuid, device_id, timestamp, app_name, window_title, project,
                      is_adobe, is_passive, tag_uuid, platform, updated_at
               FROM sync_entries
               WHERE user_id = ? AND timestamp >= ? AND timestamp < ?
               ORDER BY timestamp DESC
               LIMIT ?`,
            )
            .all(userId, since, before, limit)
        : fastify.db
            .prepare<[string, string, number], SyncEntry>(
              `SELECT uuid, device_id, timestamp, app_name, window_title, project,
                      is_adobe, is_passive, tag_uuid, platform, updated_at
               FROM sync_entries
               WHERE user_id = ? AND timestamp >= ?
               ORDER BY timestamp DESC
               LIMIT ?`,
            )
            .all(userId, since, limit);

      const tags = fastify.db
        .prepare<[string], SyncTag>(
          `SELECT uuid, name, color, sticky, deleted, updated_at
           FROM sync_tags
           WHERE user_id = ?`,
        )
        .all(userId);

      const goals = fastify.db
        .prepare<[string], SyncGoal>(
          `SELECT uuid, type, app_name, tag_uuid, target_seconds, enabled,
                  deleted, created_at, updated_at
           FROM sync_goals
           WHERE user_id = ?`,
        )
        .all(userId);

      const markers = fastify.db
        .prepare<[string], SyncMarker>(
          `SELECT uuid, timestamp, end_timestamp, label, color, icon, deleted, updated_at
           FROM sync_markers
           WHERE user_id = ?`,
        )
        .all(userId);

      const achievements = fastify.db
        .prepare<[string], SyncGoalAchievement>(
          `SELECT uuid, goal_uuid, goal_snapshot, date, achieved_at,
                  current_seconds, deleted, updated_at
           FROM sync_goal_achievements
           WHERE user_id = ?`,
        )
        .all(userId);

      const icons = fastify.db
        .prepare<[string], SyncIcon>(
          `SELECT name_hash, app_name, platform, data_url, dominant_color, updated_at
           FROM sync_icons
           WHERE user_id = ?`,
        )
        .all(userId);

      const overrides = fastify.db
        .prepare<[string], SyncOverride>(
          `SELECT name_hash, app_name, display_name, color, icon_data_url, updated_at
           FROM sync_overrides
           WHERE user_id = ?`,
        )
        .all(userId);

      // ignored_apps + ignored_projects are stored encrypted by the
      // desktop client. Surface them so the web UI can decrypt and
      // honor them in active-time totals (matches the desktop's
      // ${ignoredFilter} clause).
      const settings = fastify.db
        .prepare<[string], { key: string; value: string; updated_at: string }>(
          `SELECT key, value, updated_at
           FROM sync_settings
           WHERE user_id = ?`,
        )
        .all(userId);

      const devices = fastify.db
        .prepare<
          [string],
          {
            id: string;
            device_name: string;
            platform: string;
            last_sync_at: string | null;
            created_at: string;
          }
        >(
          `SELECT id, device_name, platform, last_sync_at, created_at
           FROM devices
           WHERE user_id = ?`,
        )
        .all(userId);

      // Per-device-id stats from sync_entries. Includes orphans —
      // device_ids that appear in entries but have no matching row in
      // `devices` (e.g. a device was unlinked but its entries linger).
      // The desktop client has a "consolidate orphans" tool for this;
      // surfacing the breakdown here lets the web UI explain time
      // discrepancies without tooling parity with the desktop.
      const deviceStats = fastify.db
        .prepare<
          [string],
          {
            device_id: string;
            entry_count: number;
            passive_count: number;
            first_ts: string | null;
            last_ts: string | null;
            active_buckets: number;
          }
        >(
          `SELECT
              device_id,
              COUNT(*) AS entry_count,
              SUM(CASE WHEN is_passive = 1 THEN 1 ELSE 0 END) AS passive_count,
              MIN(timestamp) AS first_ts,
              MAX(timestamp) AS last_ts,
              COUNT(DISTINCT CASE WHEN is_passive = 0 THEN CAST(strftime('%s', timestamp) AS INTEGER) / 30 END) AS active_buckets
           FROM sync_entries
           WHERE user_id = ?
           GROUP BY device_id
           ORDER BY entry_count DESC`,
        )
        .all(userId);

      const truncated = entries.length >= limit;
      const oldestTimestamp =
        entries.length > 0 ? entries[entries.length - 1]!.timestamp : null;

      return reply.send({
        entries,
        tags,
        goals,
        markers,
        achievements,
        icons,
        overrides,
        devices,
        device_stats: deviceStats,
        settings,
        truncated,
        oldest_timestamp: oldestTimestamp,
        snapshot_at: new Date().toISOString(),
      });
    },
  );

  // Drop every entry tagged with the given device_id. Refuses to delete
  // entries whose device_id is currently registered — only orphans get
  // removed. The web UI surfaces this as "Drop entries" on the Devices
  // page; mirrors the desktop's deleteEntriesByDeviceId behaviour.
  fastify.delete<{ Params: { device_id: string } }>(
    "/web/orphan-entries/:device_id",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const userId = auth.sub;
      const deviceId = request.params.device_id;
      if (!deviceId) {
        return reply.status(400).send({ error: "invalid_request" });
      }
      const stillRegistered = fastify.db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM devices WHERE id = ? AND user_id = ?",
        )
        .get(deviceId, userId);
      if (stillRegistered !== undefined) {
        return reply.status(409).send({
          error: "device_still_registered",
          message:
            "This device_id is still in the devices table — unlink it from /user/devices first if you really want to delete its history.",
        });
      }
      const result = fastify.db
        .prepare<[string, string]>(
          "DELETE FROM sync_entries WHERE user_id = ? AND device_id = ?",
        )
        .run(userId, deviceId);
      return reply.send({ ok: true, deleted: Number(result.changes ?? 0) });
    },
  );
};

function clampLimit(raw: string | undefined): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 500_000;
  return Math.max(1, Math.min(2_000_000, parsed));
}
