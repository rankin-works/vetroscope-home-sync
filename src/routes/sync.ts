// SPDX-License-Identifier: Apache-2.0
//
// /sync/* — push, pull, reset.
//
// Convergence rules, which the client depends on:
//   - Last write wins, compared on the row's `updated_at`. A push whose
//     timestamp isn't strictly newer is dropped, so replaying an old
//     batch can't resurrect stale values.
//   - Rows are addressed by their natural key (a client-generated uuid,
//     or a composite for the hash-keyed tables), never by a server id —
//     that's what lets two devices that have never met agree on a row.
//   - Every push upsert is scoped to the authenticated user, so a uuid
//     that collides across accounts is dropped rather than applied.
//   - Overrides are returned in full on every pull rather than filtered
//     by cursor; the set is small and the client de-dupes on LWW.
//
// There is no plan gate: every account on a Home Sync server is plan=home,
// which the client treats as licensed-equivalent.

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
  SyncNote,
  SyncNoteFolder,
  SyncOverride,
  SyncSetting,
  SyncTag,
  SyncTagStickyExclusion,
  SyncTagStickyProjectApp,
  SyncTagStickySubprojectScope,
  SyncMediaLink,
  SyncAppCategory,
  SyncReminder,
  SyncReminderEvent,
  SyncEntryDismissal,
} from "../types.js";
import { compareSemver } from "../lib/semver.js";
import { SERVER_MIN_CLIENT_VERSION } from "./server-info.js";

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
// server-side schema stable and the payload bounded. A key missing here is
// silently rejected on push even when the client sends it, so this set has
// to grow before a new synced setting will replicate.
const SYNCED_SETTING_KEYS = new Set([
  "ignored_apps",
  "ignored_projects",
  "ignored_breakdown_patterns",
  "ignored_sub_projects",
]);

export const syncRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  // Client-version gate. Reject too-old desktop clients with 426
  // Upgrade Required so they can't silently push/pull payloads that
  // drop the columns this server expects. The client's app_version
  // is recorded on every /auth/login + /auth/register + /auth/refresh
  // + /setup, so the latest version is always one DB lookup away.
  //
  // Falls open when:
  //   - app_version is NULL on the device row (pre-006 device that
  //     hasn't re-authed since the column was added — give them one
  //     more cycle to refresh and stamp a version before gating)
  //   - the version string fails to parse (malformed value, treat as
  //     unknown rather than gate aggressively)
  //
  // The structured 426 body lets the client surface a precise
  // "update to X" message in the UI without scraping the error string.
  fastify.addHook("preHandler", async (request, reply) => {
    const auth = request.authUser as JWTPayload | undefined;
    if (!auth) return undefined;
    const row = fastify.db
      .prepare<
        [string, string],
        { app_version: string | null }
      >("SELECT app_version FROM devices WHERE id = ? AND user_id = ?")
      .get(auth.device_id, auth.sub);
    const appVersion = row?.app_version ?? null;
    if (appVersion === null) return undefined;
    if (compareSemver(appVersion, SERVER_MIN_CLIENT_VERSION) < 0) {
      return reply.status(426).send({
        error: "client_too_old",
        message:
          `Vetroscope ${appVersion} is older than this Home Sync server supports. ` +
          `Update the app to ${SERVER_MIN_CLIENT_VERSION} or newer to continue syncing.`,
        min_client_version: SERVER_MIN_CLIENT_VERSION,
        current_client_version: appVersion,
      });
    }
    return undefined;
  });

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
        string,
        string | null,
        string | null,
        string | null,
        number,
        number,
        string | null,
        string | null,
        string,
      ]
    >(
      // sub_project (005) carries the browser-extension third-level
      // breakdown (videos under YouTube, songs under Spotify Web, etc.).
      // Refreshes on conflict alongside is_passive / tag_uuid / platform:
      // a later push may carry a corrected classification that should
      // overwrite an older one.
      //
      // updated_by_device_id is the pushing device (caller), not the
      // activity-origin device_id. Pull filters on the writer so a tag
      // (or is_passive) edit on another machine's rows still reaches
      // that machine — filtering on device_id alone dropped them.
      //
      // Cross-tenant guard: `uuid` is a global PRIMARY KEY, so a push
      // carrying another user's uuid would otherwise land as an UPDATE of
      // their row. The conflict UPDATE only fires when the existing row
      // already belongs to the authenticated user; a collision with
      // another user's row (accidental or hostile) is dropped silently
      // rather than overwriting it. Every uuid-keyed upsert below carries
      // the same guard.
      `INSERT INTO sync_entries (uuid, user_id, device_id, updated_by_device_id, timestamp, app_name, window_title, project, sub_project, is_adobe, is_passive, tag_uuid, platform, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         sub_project = excluded.sub_project,
         is_passive = excluded.is_passive,
         tag_uuid = excluded.tag_uuid,
         platform = excluded.platform,
         updated_by_device_id = excluded.updated_by_device_id,
         updated_at = excluded.updated_at
       WHERE sync_entries.user_id = excluded.user_id
         AND excluded.updated_at > sync_entries.updated_at`,
    );

    const upsertTag = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        number,
        number,
        number,
        string | null,
        string | null,
        number,
        number,
        string,
      ]
    >(
      // icon_data_url (005) is an optional user-uploaded tag icon,
      // encrypted client-side. parent_uuid (005) is the cross-device
      // parent reference for nested tags — cleartext because tag uuids
      // carry no user-identifying data. sticky_subprojects (011) and
      // sticky_projects (011) gate opt-in auto-tagging of new
      // sub-breakdowns / breakdowns. archived (008) marks the tag
      // hidden-but-preserved client-side.
      `INSERT INTO sync_tags (uuid, user_id, name, color, sticky, sticky_subprojects, sticky_projects, icon_data_url, parent_uuid, deleted, archived, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name,
         color = excluded.color,
         sticky = excluded.sticky,
         sticky_subprojects = excluded.sticky_subprojects,
         sticky_projects = excluded.sticky_projects,
         icon_data_url = excluded.icon_data_url,
         parent_uuid = excluded.parent_uuid,
         deleted = excluded.deleted,
         archived = excluded.archived,
         updated_at = excluded.updated_at
       WHERE sync_tags.user_id = excluded.user_id
         AND excluded.updated_at > sync_tags.updated_at`,
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
       WHERE sync_goals.user_id = excluded.user_id
         AND excluded.updated_at > sync_goals.updated_at`,
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
       WHERE sync_markers.user_id = excluded.user_id
         AND excluded.updated_at > sync_markers.updated_at`,
    );

    const upsertNote = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        number,
        string,
      ]
    >(
      `INSERT INTO sync_notes (
         uuid, user_id, title, body, timestamp, end_timestamp,
         marker_uuid, folder_uuid, pinned, deleted, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         timestamp = excluded.timestamp,
         end_timestamp = excluded.end_timestamp,
         marker_uuid = excluded.marker_uuid,
         folder_uuid = excluded.folder_uuid,
         pinned = excluded.pinned,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_notes.user_id = excluded.user_id
         AND excluded.updated_at > sync_notes.updated_at`,
    );

    const upsertNoteFolder = stmts.prepare<
      [string, string, string, string | null, string | null, number, string]
    >(
      `INSERT INTO sync_note_folders (
         uuid, user_id, name, parent_uuid, color, deleted, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         name = excluded.name,
         parent_uuid = excluded.parent_uuid,
         color = excluded.color,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_note_folders.user_id = excluded.user_id
         AND excluded.updated_at > sync_note_folders.updated_at`,
    );

    const upsertAchievement = stmts.prepare<
      [string, string, string, string, string, string, number, number, string]
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

    // Per-(tag, app, project) sticky exclusion tombstones. Same shape as
    // the other sync_* upserts — uuid is the natural key, updated_at
    // gates conflicts. Added in 005.
    const upsertTagStickyExclusion = stmts.prepare<
      [string, string, string | null, string, string | null, number, string]
    >(
      `INSERT INTO sync_tag_sticky_exclusions (uuid, user_id, tag_uuid, app_name, project, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         tag_uuid = excluded.tag_uuid,
         app_name = excluded.app_name,
         project = excluded.project,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_tag_sticky_exclusions.user_id = excluded.user_id
         AND excluded.updated_at > sync_tag_sticky_exclusions.updated_at`,
    );

    // Per-app allowlist rows for sticky_projects auto-tagging (011).
    const upsertTagStickyProjectApp = stmts.prepare<
      [string, string, string | null, string, number, string]
    >(
      `INSERT INTO sync_tag_sticky_project_apps (uuid, user_id, tag_uuid, app_name, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         tag_uuid = excluded.tag_uuid,
         app_name = excluded.app_name,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_tag_sticky_project_apps.user_id = excluded.user_id
         AND excluded.updated_at > sync_tag_sticky_project_apps.updated_at`,
    );

    // Per-breakdown allowlist rows for sticky_subprojects auto-tagging (011).
    const upsertTagStickySubprojectScope = stmts.prepare<
      [string, string, string | null, string, string, number, string]
    >(
      `INSERT INTO sync_tag_sticky_subproject_scopes (uuid, user_id, tag_uuid, app_name, project, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         tag_uuid = excluded.tag_uuid,
         app_name = excluded.app_name,
         project = excluded.project,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_tag_sticky_subproject_scopes.user_id = excluded.user_id
         AND excluded.updated_at > sync_tag_sticky_subproject_scopes.updated_at`,
    );

    // Captured media URLs (Spotify track URIs, YouTube /watch URLs).
    // app_name / project / sub_project / url are encrypted client-side;
    // kind is cleartext for aggregate logging. LWW on updated_at like
    // every other sync-eligible table. sub_project carries '' as the
    // "no sub_project" sentinel (Spotify case where project itself is
    // the song).
    const upsertMediaLink = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
      ]
    >(
      `INSERT INTO sync_media_links (uuid, user_id, app_name, project, sub_project, url, kind, first_seen, last_seen, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         app_name = excluded.app_name,
         project = excluded.project,
         sub_project = excluded.sub_project,
         url = excluded.url,
         kind = excluded.kind,
         first_seen = excluded.first_seen,
         last_seen = excluded.last_seen,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_media_links.user_id = excluded.user_id
         AND excluded.updated_at > sync_media_links.updated_at`,
    );

    // Activity category assignments (030). app_name + project encrypted;
    // taxonomy fields cleartext. LWW on updated_at. Seed stays local.
    const upsertAppCategory = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        string | null,
        number,
        string,
      ]
    >(
      `INSERT INTO sync_app_categories (uuid, user_id, app_name, project, category_id, confidence, source, model, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         app_name = excluded.app_name,
         project = excluded.project,
         category_id = excluded.category_id,
         confidence = excluded.confidence,
         source = excluded.source,
         model = excluded.model,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_app_categories.user_id = excluded.user_id
         AND excluded.updated_at > sync_app_categories.updated_at`,
    );

    // Custom reminders (008). title + body encrypted client-side;
    // schedule fields cleartext so the server can validate / log them
    // without decrypting. LWW on updated_at like every other table.
    const upsertReminder = stmts.prepare<
      [
        string, // uuid
        string, // user_id
        string, // title (encrypted)
        string | null, // body (encrypted or null)
        string, // kind
        string | null, // fire_at
        string | null, // weekdays
        string | null, // time_of_day
        string | null, // end_time_of_day
        string | null, // start_date
        string | null, // end_date
        string | null, // tag_uuid
        number | null, // threshold_seconds
        string | null, // period
        string | null, // icon_data_url
        number | null, // interval_seconds
        string | null, // app_name
        string | null, // project
        string | null, // goal_uuid
        number | null, // goal_notify_half
        number | null, // goal_notify_complete
        number, // enabled
        number, // deleted
        string | null, // last_fired_at
        string, // updated_at
      ]
    >(
      `INSERT INTO sync_reminders (
         uuid, user_id, title, body, kind, fire_at, weekdays, time_of_day,
         end_time_of_day, start_date, end_date, tag_uuid, threshold_seconds,
         period, icon_data_url, interval_seconds, app_name, project, goal_uuid,
         goal_notify_half, goal_notify_complete, enabled, deleted,
         last_fired_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         title = excluded.title,
         body = excluded.body,
         kind = excluded.kind,
         fire_at = excluded.fire_at,
         weekdays = excluded.weekdays,
         time_of_day = excluded.time_of_day,
         end_time_of_day = excluded.end_time_of_day,
         start_date = excluded.start_date,
         end_date = excluded.end_date,
         tag_uuid = excluded.tag_uuid,
         threshold_seconds = excluded.threshold_seconds,
         period = excluded.period,
         icon_data_url = excluded.icon_data_url,
         interval_seconds = excluded.interval_seconds,
         app_name = excluded.app_name,
         project = excluded.project,
         goal_uuid = excluded.goal_uuid,
         goal_notify_half = excluded.goal_notify_half,
         goal_notify_complete = excluded.goal_notify_complete,
         enabled = excluded.enabled,
         deleted = excluded.deleted,
         last_fired_at = excluded.last_fired_at,
         updated_at = excluded.updated_at
       WHERE sync_reminders.user_id = excluded.user_id
         AND excluded.updated_at > sync_reminders.updated_at`,
    );

    // Reminder notification history (014). Title, body, and icon data are
    // encrypted client-side; state timestamps converge with LWW semantics.
    const upsertReminderEvent = stmts.prepare<
      [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        number,
        string,
      ]
    >(
      `INSERT INTO sync_reminder_events (
         uuid, user_id, reminder_uuid, title, body, icon_data_url, fired_at,
         read_at, dismissed_at, deleted, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         reminder_uuid = excluded.reminder_uuid,
         title = excluded.title,
         body = excluded.body,
         icon_data_url = excluded.icon_data_url,
         fired_at = excluded.fired_at,
         read_at = excluded.read_at,
         dismissed_at = excluded.dismissed_at,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_reminder_events.user_id = excluded.user_id
         AND excluded.updated_at > sync_reminder_events.updated_at`,
    );

    const upsertEntryDismissal = stmts.prepare<
      [string, string, number, string]
    >(
      `INSERT INTO sync_entry_dismissals (uuid, user_id, deleted, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         deleted = excluded.deleted,
         updated_at = excluded.updated_at
       WHERE sync_entry_dismissals.user_id = excluded.user_id
         AND excluded.updated_at > sync_entry_dismissals.updated_at`,
    );

    const updateDeviceSync = stmts.prepare<[string, string, string]>(
      "UPDATE devices SET last_sync_at = ? WHERE id = ? AND user_id = ?",
    );

    // `entries.device_id` is chosen by the client, and the row's owner is
    // already pinned to the JWT's user, so this is integrity defense rather
    // than an authorization boundary — it keeps device_id meaning what
    // /sync/count and the admin tooling expect it to mean. We pre-fetch the
    // caller's device set once and coerce any unknown id to the caller's own
    // authenticated device rather than rejecting the batch: the desktop
    // legitimately re-pushes entries it pulled from another device of the
    // same user, and an unknown id is a wrong-shape value, not an attack
    // worth failing the whole sync over.
    let allowedDeviceIds: Set<string> | null = null;
    if (body.entries?.length) {
      const rows = fastify.db
        .prepare<[string], { id: string }>(
          "SELECT id FROM devices WHERE user_id = ?",
        )
        .all(userId);
      allowedDeviceIds = new Set(rows.map((r) => r.id));
    }
    const callerDeviceId = auth.device_id;

    const tx = fastify.db.transaction(() => {
      for (const e of (body.entries ?? []).slice(0, BATCH_SIZE)) {
        const safeDeviceId =
          e.device_id && allowedDeviceIds!.has(e.device_id)
            ? e.device_id
            : callerDeviceId;
        upsertEntry.run(
          e.uuid,
          userId,
          safeDeviceId,
          callerDeviceId,
          e.timestamp,
          e.app_name,
          e.window_title,
          e.project,
          e.sub_project ?? null,
          e.is_adobe,
          e.is_passive ?? 0,
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
          t.sticky_subprojects ?? 0,
          t.sticky_projects ?? 0,
          t.icon_data_url ?? null,
          t.parent_uuid ?? null,
          t.deleted,
          t.archived ?? 0,
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
      for (const n of (body.notes ?? []).slice(0, BATCH_SIZE)) {
        upsertNote.run(
          n.uuid,
          userId,
          n.title,
          n.body,
          n.timestamp ?? null,
          n.end_timestamp ?? null,
          n.marker_uuid ?? null,
          n.folder_uuid ?? null,
          n.pinned ?? 0,
          n.deleted,
          n.updated_at || now,
        );
      }
      for (const f of (body.note_folders ?? []).slice(0, BATCH_SIZE)) {
        upsertNoteFolder.run(
          f.uuid,
          userId,
          f.name,
          f.parent_uuid ?? null,
          f.color ?? null,
          f.deleted,
          f.updated_at || now,
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
      for (const tse of (body.tag_sticky_exclusions ?? []).slice(
        0,
        BATCH_SIZE,
      )) {
        upsertTagStickyExclusion.run(
          tse.uuid,
          userId,
          tse.tag_uuid ?? null,
          tse.app_name,
          tse.project ?? null,
          tse.deleted,
          tse.updated_at || now,
        );
      }
      for (const spa of (body.tag_sticky_project_apps ?? []).slice(
        0,
        BATCH_SIZE,
      )) {
        upsertTagStickyProjectApp.run(
          spa.uuid,
          userId,
          spa.tag_uuid ?? null,
          spa.app_name,
          spa.deleted,
          spa.updated_at || now,
        );
      }
      for (const sss of (body.tag_sticky_subproject_scopes ?? []).slice(
        0,
        BATCH_SIZE,
      )) {
        upsertTagStickySubprojectScope.run(
          sss.uuid,
          userId,
          sss.tag_uuid ?? null,
          sss.app_name,
          sss.project,
          sss.deleted,
          sss.updated_at || now,
        );
      }
      for (const ml of (body.media_links ?? []).slice(0, BATCH_SIZE)) {
        upsertMediaLink.run(
          ml.uuid,
          userId,
          ml.app_name,
          ml.project,
          ml.sub_project,
          ml.url,
          ml.kind,
          ml.first_seen,
          ml.last_seen,
          ml.deleted,
          ml.updated_at || now,
        );
      }
      for (const c of (body.app_categories ?? []).slice(0, BATCH_SIZE)) {
        upsertAppCategory.run(
          c.uuid,
          userId,
          c.app_name,
          c.project,
          c.category_id,
          c.confidence,
          c.source,
          c.model ?? null,
          c.deleted,
          c.updated_at || now,
        );
      }
      for (const r of (body.reminders ?? []).slice(0, BATCH_SIZE)) {
        upsertReminder.run(
          r.uuid,
          userId,
          r.title,
          r.body ?? null,
          r.kind,
          r.fire_at ?? null,
          r.weekdays ?? null,
          r.time_of_day ?? null,
          r.end_time_of_day ?? null,
          r.start_date ?? null,
          r.end_date ?? null,
          r.tag_uuid ?? null,
          r.threshold_seconds ?? null,
          r.period ?? null,
          r.icon_data_url ?? null,
          r.interval_seconds ?? null,
          r.app_name ?? null,
          r.project ?? null,
          r.goal_uuid ?? null,
          r.goal_notify_half ?? 1,
          r.goal_notify_complete ?? 1,
          r.enabled,
          r.deleted,
          r.last_fired_at ?? null,
          r.updated_at || now,
        );
      }
      for (const event of (body.reminder_events ?? []).slice(0, BATCH_SIZE)) {
        upsertReminderEvent.run(
          event.uuid,
          userId,
          event.reminder_uuid,
          event.title,
          event.body ?? null,
          event.icon_data_url ?? null,
          event.fired_at,
          event.read_at ?? null,
          event.dismissed_at ?? null,
          event.deleted,
          event.updated_at || now,
        );
      }
      for (const d of (body.entry_dismissals ?? []).slice(0, BATCH_SIZE)) {
        upsertEntryDismissal.run(
          d.uuid,
          userId,
          d.deleted,
          d.updated_at || now,
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
        notes: body.notes?.length ?? 0,
        note_folders: body.note_folders?.length ?? 0,
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

    // Pull entries updated after cursor, excluding this device's own writes.
    // Filter on updated_by_device_id (last pusher), not device_id (activity
    // origin) — otherwise tagging another machine's past-day rows never
    // reaches that machine. NULL writer (pre-migration) included defensively.
    const entries = fastify.db
      .prepare<[string, string, string, number], SyncEntry>(
        `SELECT uuid, device_id, timestamp, app_name, window_title, project, sub_project, is_adobe, is_passive, tag_uuid, platform, updated_at
         FROM sync_entries
         WHERE user_id = ? AND updated_at > ?
           AND (updated_by_device_id IS NULL OR updated_by_device_id != ?)
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(userId, cursor, deviceId, BATCH_SIZE);

    const tags = fastify.db
      .prepare<[string, string, number], SyncTag>(
        `SELECT uuid, name, color, sticky, sticky_subprojects, sticky_projects, icon_data_url, parent_uuid, deleted, archived, updated_at
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

    const notes = (() => {
      const noteCursor = body.note_cursor;
      if (noteCursor) {
        return fastify.db
          .prepare<[string, string, string, string, number], SyncNote>(
            `SELECT uuid, title, body, timestamp, end_timestamp, marker_uuid,
                    folder_uuid, pinned, deleted, updated_at
               FROM sync_notes
              WHERE user_id = ?
                AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
              ORDER BY updated_at ASC, uuid ASC
              LIMIT ?`,
          )
          .all(
            userId,
            noteCursor.updated_at,
            noteCursor.updated_at,
            noteCursor.key,
            BATCH_SIZE,
          );
      }
      return fastify.db
        .prepare<[string, string, number], SyncNote>(
          `SELECT uuid, title, body, timestamp, end_timestamp, marker_uuid,
                  folder_uuid, pinned, deleted, updated_at
             FROM sync_notes
            WHERE user_id = ? AND updated_at > ?
            ORDER BY updated_at ASC, uuid ASC
            LIMIT ?`,
        )
        .all(userId, cursor, BATCH_SIZE);
    })();

    const noteFolders = (() => {
      const noteFolderCursor = body.note_folder_cursor;
      if (noteFolderCursor) {
        return fastify.db
          .prepare<[string, string, string, string, number], SyncNoteFolder>(
            `SELECT uuid, name, parent_uuid, color, deleted, updated_at
               FROM sync_note_folders
              WHERE user_id = ?
                AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
              ORDER BY updated_at ASC, uuid ASC
              LIMIT ?`,
          )
          .all(
            userId,
            noteFolderCursor.updated_at,
            noteFolderCursor.updated_at,
            noteFolderCursor.key,
            BATCH_SIZE,
          );
      }
      return fastify.db
        .prepare<[string, string, number], SyncNoteFolder>(
          `SELECT uuid, name, parent_uuid, color, deleted, updated_at
             FROM sync_note_folders
            WHERE user_id = ? AND updated_at > ?
            ORDER BY updated_at ASC, uuid ASC
            LIMIT ?`,
        )
        .all(userId, cursor, BATCH_SIZE);
    })();

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
          .all(
            userId,
            iconCursor.updated_at,
            iconCursor.updated_at,
            iconCursor.key,
          )
      : fastify.db
          .prepare<[string, string], SyncIcon>(
            `SELECT name_hash, app_name, platform, data_url, dominant_color, updated_at
             FROM sync_icons
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, name_hash ASC
             LIMIT ${ICON_LIMIT}`,
          )
          .all(userId, cursor);

    // Overrides are intentionally returned in full rather than cursor-
    // filtered: the set is bounded by OVERRIDE_PULL_LIMIT and the client
    // de-dupes on LWW, so a full list costs little and avoids the
    // shared-timestamp pagination hazard the other tables need cursors for.
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
          .all(
            userId,
            settingCursor.updated_at,
            settingCursor.updated_at,
            settingCursor.key,
          )
      : fastify.db
          .prepare<[string, string], SyncSetting>(
            `SELECT key, value, updated_at
             FROM sync_settings
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, key ASC`,
          )
          .all(userId, cursor);

    // Tag sticky exclusions (005). Same compound-cursor pattern as icons /
    // settings — a Reset Cloud Data → re-push flow can stamp every row
    // with the same `now`, and strict-greater-than pagination would skip
    // rows at the boundary. Tiebreaker is `uuid`. Legacy fallback uses the
    // shared time cursor.
    const tseCursor = body.tag_sticky_exclusion_cursor;
    const tagStickyExclusions = tseCursor
      ? fastify.db
          .prepare<
            [string, string, string, string, number],
            SyncTagStickyExclusion
          >(
            `SELECT uuid, tag_uuid, app_name, project, deleted, updated_at
             FROM sync_tag_sticky_exclusions
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            tseCursor.updated_at,
            tseCursor.updated_at,
            tseCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncTagStickyExclusion>(
            `SELECT uuid, tag_uuid, app_name, project, deleted, updated_at
             FROM sync_tag_sticky_exclusions
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Per-app allowlist for sticky_projects (011). Same compound-cursor
    // pattern as sticky exclusions — bulk re-push can cluster timestamps.
    const spaCursor = body.tag_sticky_project_app_cursor;
    const tagStickyProjectApps = spaCursor
      ? fastify.db
          .prepare<
            [string, string, string, string, number],
            SyncTagStickyProjectApp
          >(
            `SELECT uuid, tag_uuid, app_name, deleted, updated_at
             FROM sync_tag_sticky_project_apps
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            spaCursor.updated_at,
            spaCursor.updated_at,
            spaCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncTagStickyProjectApp>(
            `SELECT uuid, tag_uuid, app_name, deleted, updated_at
             FROM sync_tag_sticky_project_apps
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Per-breakdown allowlist for sticky_subprojects (011).
    const sssCursor = body.tag_sticky_subproject_scope_cursor;
    const tagStickySubprojectScopes = sssCursor
      ? fastify.db
          .prepare<
            [string, string, string, string, number],
            SyncTagStickySubprojectScope
          >(
            `SELECT uuid, tag_uuid, app_name, project, deleted, updated_at
             FROM sync_tag_sticky_subproject_scopes
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            sssCursor.updated_at,
            sssCursor.updated_at,
            sssCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncTagStickySubprojectScope>(
            `SELECT uuid, tag_uuid, app_name, project, deleted, updated_at
             FROM sync_tag_sticky_subproject_scopes
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Captured media URLs (007). Same compound-cursor treatment as
    // sticky exclusions — a fresh capture-enabled device may push its
    // entire library in one shot which clusters every row at the same
    // `now`. Tiebreaker is `uuid`. Legacy fallback uses the shared
    // time cursor for clients that pre-date the compound cursor.
    const mediaLinkCursor = body.media_link_cursor;
    const mediaLinks = mediaLinkCursor
      ? fastify.db
          .prepare<[string, string, string, string, number], SyncMediaLink>(
            `SELECT uuid, app_name, project, sub_project, url, kind, first_seen, last_seen, deleted, updated_at
             FROM sync_media_links
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            mediaLinkCursor.updated_at,
            mediaLinkCursor.updated_at,
            mediaLinkCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncMediaLink>(
            `SELECT uuid, app_name, project, sub_project, url, kind, first_seen, last_seen, deleted, updated_at
             FROM sync_media_links
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Activity category assignments (030). Compound cursor on
    // (updated_at, uuid) — first enable may push the whole non-seed map
    // in one shot. Legacy fallback uses the shared time cursor.
    const appCategoryCursor = body.app_category_cursor;
    const appCategories = appCategoryCursor
      ? fastify.db
          .prepare<[string, string, string, string, number], SyncAppCategory>(
            `SELECT uuid, app_name, project, category_id, confidence, source, model, deleted, updated_at
             FROM sync_app_categories
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            appCategoryCursor.updated_at,
            appCategoryCursor.updated_at,
            appCategoryCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncAppCategory>(
            `SELECT uuid, app_name, project, category_id, confidence, source, model, deleted, updated_at
             FROM sync_app_categories
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Custom reminders (008). Same compound-cursor hazard as media
    // links — a user creating several reminders in quick succession
    // clusters them at the same `now`. Tiebreaker is `uuid`. Legacy
    // fallback uses the shared time cursor for clients that pre-date
    // the compound cursor.
    const reminderCursor = body.reminder_cursor;
    const reminders = reminderCursor
      ? fastify.db
          .prepare<[string, string, string, string, number], SyncReminder>(
            `SELECT uuid, title, body, kind, fire_at, weekdays, time_of_day,
                    end_time_of_day, start_date, end_date, tag_uuid, threshold_seconds,
                    period, icon_data_url, interval_seconds, app_name, project, goal_uuid,
                    goal_notify_half, goal_notify_complete, enabled, deleted,
                    last_fired_at, updated_at
             FROM sync_reminders
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            reminderCursor.updated_at,
            reminderCursor.updated_at,
            reminderCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncReminder>(
            `SELECT uuid, title, body, kind, fire_at, weekdays, time_of_day,
                    end_time_of_day, start_date, end_date, tag_uuid, threshold_seconds,
                    period, icon_data_url, interval_seconds, app_name, project, goal_uuid,
                    goal_notify_half, goal_notify_complete, enabled, deleted,
                    last_fired_at, updated_at
             FROM sync_reminders
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Reminder notification history (014). Compound cursor matches
    // reminders: bulk event inserts commonly share an updated_at timestamp.
    const reminderEventCursor = body.reminder_event_cursor;
    const reminderEvents = reminderEventCursor
      ? fastify.db
          .prepare<[string, string, string, string, number], SyncReminderEvent>(
            `SELECT uuid, reminder_uuid, title, body, icon_data_url, fired_at,
                    read_at, dismissed_at, deleted, updated_at
             FROM sync_reminder_events
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            reminderEventCursor.updated_at,
            reminderEventCursor.updated_at,
            reminderEventCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncReminderEvent>(
            `SELECT uuid, reminder_uuid, title, body, icon_data_url, fired_at,
                    read_at, dismissed_at, deleted, updated_at
             FROM sync_reminder_events
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    // Dispute-time-block tombstones (012). Compound cursor — a single
    // dismiss can tombstone several entry UUIDs at the same updated_at.
    const entryDismissalCursor = body.entry_dismissal_cursor;
    const entryDismissals = entryDismissalCursor
      ? fastify.db
          .prepare<
            [string, string, string, string, number],
            SyncEntryDismissal
          >(
            `SELECT uuid, deleted, updated_at
             FROM sync_entry_dismissals
             WHERE user_id = ?
               AND (updated_at > ? OR (updated_at = ? AND uuid > ?))
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(
            userId,
            entryDismissalCursor.updated_at,
            entryDismissalCursor.updated_at,
            entryDismissalCursor.key,
            BATCH_SIZE,
          )
      : fastify.db
          .prepare<[string, string, number], SyncEntryDismissal>(
            `SELECT uuid, deleted, updated_at
             FROM sync_entry_dismissals
             WHERE user_id = ? AND updated_at > ?
             ORDER BY updated_at ASC, uuid ASC
             LIMIT ?`,
          )
          .all(userId, cursor, BATCH_SIZE);

    fastify.db
      .prepare<
        [string, string, string]
      >("UPDATE devices SET last_sync_at = ? WHERE id = ? AND user_id = ?")
      .run(now, auth.device_id, userId);

    // Time-cursor types: entries, tags, goals, markers, achievements.
    // Notes + note folders use compound cursors (like reminders) so a
    // clustered push doesn't lose rows past the first page. Icons /
    // settings / sticky tables share the same compound pattern.
    const hitLimitTimeTypes =
      entries.length >= BATCH_SIZE ||
      tags.length >= BATCH_SIZE ||
      goals.length >= BATCH_SIZE ||
      markers.length >= BATCH_SIZE ||
      achievements.length >= BATCH_SIZE;
    const hitLimitIcons = icons.length >= ICON_LIMIT;
    const hitLimitSettings = settings.length >= SETTING_LIMIT;
    const hitLimitTse = tagStickyExclusions.length >= BATCH_SIZE;
    const hitLimitSpa = tagStickyProjectApps.length >= BATCH_SIZE;
    const hitLimitSss = tagStickySubprojectScopes.length >= BATCH_SIZE;
    const hitLimitMediaLinks = mediaLinks.length >= BATCH_SIZE;
    const hitLimitAppCategories = appCategories.length >= BATCH_SIZE;
    const hitLimitReminders = reminders.length >= BATCH_SIZE;
    const hitLimitReminderEvents = reminderEvents.length >= BATCH_SIZE;
    const hitLimitEntryDismissals = entryDismissals.length >= BATCH_SIZE;
    const hitLimitNotes = notes.length >= BATCH_SIZE;
    const hitLimitNoteFolders = noteFolders.length >= BATCH_SIZE;

    let newCursor = now;
    if (hitLimitTimeTypes) {
      const latestPerType = [entries, tags, goals, markers, achievements]
        .filter((arr) => arr.length > 0)
        .map(
          (arr) =>
            (arr as Array<{ updated_at: string }>)[arr.length - 1]!.updated_at,
        );
      if (latestPerType.length > 0) {
        newCursor = latestPerType.sort()[0]!;
      }
    }

    // Compound cursors — only emitted when the matching table paginated.
    // The client round-trips them on the next pull. Absence means "this
    // type is fully drained at this snapshot."
    const nextIconCursor =
      hitLimitIcons && icons.length > 0
        ? {
            updated_at: icons[icons.length - 1]!.updated_at,
            key: icons[icons.length - 1]!.name_hash,
          }
        : undefined;
    const nextSettingCursor =
      hitLimitSettings && settings.length > 0
        ? {
            updated_at: settings[settings.length - 1]!.updated_at,
            key: settings[settings.length - 1]!.key,
          }
        : undefined;
    const nextTseCursor =
      hitLimitTse && tagStickyExclusions.length > 0
        ? {
            updated_at:
              tagStickyExclusions[tagStickyExclusions.length - 1]!.updated_at,
            key: tagStickyExclusions[tagStickyExclusions.length - 1]!.uuid,
          }
        : undefined;
    const nextSpaCursor =
      hitLimitSpa && tagStickyProjectApps.length > 0
        ? {
            updated_at:
              tagStickyProjectApps[tagStickyProjectApps.length - 1]!.updated_at,
            key: tagStickyProjectApps[tagStickyProjectApps.length - 1]!.uuid,
          }
        : undefined;
    const nextSssCursor =
      hitLimitSss && tagStickySubprojectScopes.length > 0
        ? {
            updated_at:
              tagStickySubprojectScopes[tagStickySubprojectScopes.length - 1]!
                .updated_at,
            key: tagStickySubprojectScopes[
              tagStickySubprojectScopes.length - 1
            ]!.uuid,
          }
        : undefined;
    const nextMediaLinkCursor =
      hitLimitMediaLinks && mediaLinks.length > 0
        ? {
            updated_at: mediaLinks[mediaLinks.length - 1]!.updated_at,
            key: mediaLinks[mediaLinks.length - 1]!.uuid,
          }
        : undefined;
    const nextAppCategoryCursor =
      hitLimitAppCategories && appCategories.length > 0
        ? {
            updated_at: appCategories[appCategories.length - 1]!.updated_at,
            key: appCategories[appCategories.length - 1]!.uuid,
          }
        : undefined;
    const nextReminderCursor =
      hitLimitReminders && reminders.length > 0
        ? {
            updated_at: reminders[reminders.length - 1]!.updated_at,
            key: reminders[reminders.length - 1]!.uuid,
          }
        : undefined;
    const nextReminderEventCursor =
      hitLimitReminderEvents && reminderEvents.length > 0
        ? {
            updated_at: reminderEvents[reminderEvents.length - 1]!.updated_at,
            key: reminderEvents[reminderEvents.length - 1]!.uuid,
          }
        : undefined;
    const nextEntryDismissalCursor =
      hitLimitEntryDismissals && entryDismissals.length > 0
        ? {
            updated_at: entryDismissals[entryDismissals.length - 1]!.updated_at,
            key: entryDismissals[entryDismissals.length - 1]!.uuid,
          }
        : undefined;
    const nextNoteCursor =
      hitLimitNotes && notes.length > 0
        ? {
            updated_at: notes[notes.length - 1]!.updated_at,
            key: notes[notes.length - 1]!.uuid,
          }
        : undefined;
    const nextNoteFolderCursor =
      hitLimitNoteFolders && noteFolders.length > 0
        ? {
            updated_at: noteFolders[noteFolders.length - 1]!.updated_at,
            key: noteFolders[noteFolders.length - 1]!.uuid,
          }
        : undefined;

    const response: PullResponse = {
      entries,
      tags,
      goals,
      markers,
      notes,
      note_folders: noteFolders,
      achievements,
      icons,
      overrides,
      settings,
      tag_sticky_exclusions: tagStickyExclusions,
      tag_sticky_project_apps: tagStickyProjectApps,
      tag_sticky_subproject_scopes: tagStickySubprojectScopes,
      media_links: mediaLinks,
      app_categories: appCategories,
      reminders,
      reminder_events: reminderEvents,
      entry_dismissals: entryDismissals,
      cursor: newCursor,
      has_more:
        hitLimitTimeTypes ||
        hitLimitIcons ||
        hitLimitSettings ||
        hitLimitTse ||
        hitLimitSpa ||
        hitLimitSss ||
        hitLimitMediaLinks ||
        hitLimitAppCategories ||
        hitLimitReminders ||
        hitLimitReminderEvents ||
        hitLimitEntryDismissals ||
        hitLimitNotes ||
        hitLimitNoteFolders,
      ...(nextIconCursor ? { icon_cursor: nextIconCursor } : {}),
      ...(nextSettingCursor ? { setting_cursor: nextSettingCursor } : {}),
      ...(nextTseCursor ? { tag_sticky_exclusion_cursor: nextTseCursor } : {}),
      ...(nextSpaCursor
        ? { tag_sticky_project_app_cursor: nextSpaCursor }
        : {}),
      ...(nextSssCursor
        ? { tag_sticky_subproject_scope_cursor: nextSssCursor }
        : {}),
      ...(nextMediaLinkCursor
        ? { media_link_cursor: nextMediaLinkCursor }
        : {}),
      ...(nextAppCategoryCursor
        ? { app_category_cursor: nextAppCategoryCursor }
        : {}),
      ...(nextReminderCursor ? { reminder_cursor: nextReminderCursor } : {}),
      ...(nextReminderEventCursor
        ? { reminder_event_cursor: nextReminderEventCursor }
        : {}),
      ...(nextEntryDismissalCursor
        ? { entry_dismissal_cursor: nextEntryDismissalCursor }
        : {}),
      ...(nextNoteCursor ? { note_cursor: nextNoteCursor } : {}),
      ...(nextNoteFolderCursor
        ? { note_folder_cursor: nextNoteFolderCursor }
        : {}),
    };
    return reply.send(response);
  });

  fastify.post("/sync/reset", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const userId = auth.sub;
    wipeUserSyncRows(fastify.db, userId);
    fastify.db
      .prepare<
        [string]
      >("UPDATE devices SET last_sync_at = NULL WHERE user_id = ?")
      .run(userId);
    request.log.info({ userId }, "sync reset");
    return reply.send({ ok: true });
  });

  fastify.post("/sync/count", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const counts = fastify.db
      .prepare<
        [string],
        { device_id: string; count: number }
      >("SELECT device_id, COUNT(*) AS count FROM sync_entries WHERE user_id = ? GROUP BY device_id")
      .all(auth.sub);
    return reply.send({ counts });
  });

  // Atomic mutex for one reminder occurrence — winner shows the OS
  // notification; losers ack locally without toasting.
  fastify.post<{ Body: { occurrence_key?: string } }>(
    "/sync/reminder-claim",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const occurrenceKey =
        typeof request.body?.occurrence_key === "string"
          ? request.body.occurrence_key.trim()
          : "";
      if (!occurrenceKey || occurrenceKey.length > 256) {
        return reply.status(400).send({ error: "occurrence_key required" });
      }
      const now = new Date().toISOString();
      fastify.db
        .prepare(
          `INSERT INTO sync_reminder_claims (user_id, occurrence_key, device_id, claimed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, occurrence_key) DO NOTHING`,
        )
        .run(auth.sub, occurrenceKey, auth.device_id, now);
      const row = fastify.db
        .prepare<
          [string, string],
          { device_id: string }
        >(
          `SELECT device_id FROM sync_reminder_claims
            WHERE user_id = ? AND occurrence_key = ?`,
        )
        .get(auth.sub, occurrenceKey);
      return reply.send({ claimed: row?.device_id === auth.device_id });
    },
  );
};

export function wipeUserSyncRows(db: Database.Database, userId: string): void {
  const tables = [
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
    "sync_reminder_claims",
    "sync_entry_dismissals",
  ];
  const tx = db.transaction(() => {
    for (const t of tables) {
      db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
    }
  });
  tx();
}
