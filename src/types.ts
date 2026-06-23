// SPDX-License-Identifier: Apache-2.0
//
// Shared row + payload shapes. These are the request/response types the
// client already sends to Vetroscope Cloud — we keep them 1:1 on the
// Home Sync side so a client can flip API_BASE between cloud and home
// without any serialization branching.

export type Plan = "home";
export type Role = "admin" | "user";
export type Platform = "darwin" | "win32" | "linux";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  plan: Plan;
  role: Role;
  encrypted_sync_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  platform: string;
  // Vetroscope app version (e.g. "0.2.22"). Refreshed on every token-
  // issuing request that supplies it; NULL on pre-006 rows. Used by
  // /sync/* to gate too-old clients with 426 Upgrade Required.
  app_version: string | null;
  last_sync_at: string | null;
  created_at: string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  device_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface InviteRow {
  id: string;
  token_hash: string;
  created_by: string;
  role: Role;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface JWTPayload {
  sub: string;
  email: string;
  plan: Plan;
  role: Role;
  device_id: string;
  // "sync" tokens belong to a real device row in `devices` and can push
  // / pull entries. "web" tokens are issued to the browser dashboard,
  // do NOT have a device row, and are rejected by /sync/* routes.
  // Optional for back-compat with tokens issued before 004 — absent
  // means "sync" (the legacy default).
  scope?: "sync" | "web";
  iat: number;
  exp: number;
}

// ── sync payload types ──────────────────────────────────────────────────

export interface SyncEntry {
  uuid: string;
  device_id: string;
  timestamp: string;
  app_name: string;
  window_title: string | null;
  project: string | null;
  // Third-level breakdown from the browser extension (videos under
  // YouTube, songs under Spotify Web, etc.). Encrypted client-side,
  // same shape as project. Optional on the wire so pre-005 servers and
  // older clients still parse rows without it.
  sub_project?: string | null;
  is_adobe: number;
  // 1 = away-listening / background sample (e.g. music playing while
  // another app is focused). Excluded from active-time totals on
  // dashboards and charts. Pre-003 servers don't have this column —
  // pulled rows from older schemas come back as 0 by default.
  is_passive?: number;
  tag_uuid: string | null;
  platform: string | null;
  updated_at: string;
}

export interface SyncTag {
  uuid: string;
  name: string;
  color: string;
  sticky: number;
  /** Opt-in: auto-tag new sub-breakdowns under tagged breakdowns.
   *  Added in 011 (Cloud 027). Pre-011 servers drop on push. */
  sticky_subprojects?: number;
  /** Opt-in: auto-tag new breakdowns under tagged apps.
   *  Added in 011 (Cloud 028). Pre-011 servers drop on push. */
  sticky_projects?: number;
  // Optional user-uploaded tag icon (encrypted data URL). Added in 005.
  // Pre-005 servers don't surface it on pull.
  icon_data_url?: string | null;
  // Cross-device parent reference for nested tags. NULL = root tag.
  // Cleartext — uuids carry no user-identifying data. Added in 005;
  // pre-005 servers drop it on push.
  parent_uuid?: string | null;
  deleted: number;
  // Archived tags stay attached to past entries client-side but are
  // hidden from default tag pickers and refuse new assignments.
  // Optional on the wire — pre-008 servers drop it. Added in
  // migration 008 (Home Sync) / 022 (Cloud).
  archived?: number;
  updated_at: string;
}

export interface SyncTagStickyExclusion {
  uuid: string;
  tag_uuid: string | null;
  app_name: string;     // encrypted client-side
  project: string | null; // encrypted client-side, null when scope has no breakdown
  deleted: number;
  updated_at: string;
}

/** Per-app allowlist for sticky_projects auto-tagging. Added in 011. */
export interface SyncTagStickyProjectApp {
  uuid: string;
  tag_uuid: string | null;
  app_name: string;     // encrypted client-side
  deleted: number;
  updated_at: string;
}

/** Per-breakdown allowlist for sticky_subprojects auto-tagging. Added in 011. */
export interface SyncTagStickySubprojectScope {
  uuid: string;
  tag_uuid: string | null;
  app_name: string;     // encrypted client-side
  project: string;      // encrypted client-side
  deleted: number;
  updated_at: string;
}

// Per-(app, project, sub_project) canonical media URLs. Pushed by
// clients that have opted into media-link sync for this target. All
// four PII columns are encrypted client-side; `kind` is cleartext.
// Added in 007 — pre-007 servers silently drop the array on push and
// return an empty (or undefined) array on pull.
export interface SyncMediaLink {
  uuid: string;
  app_name: string;     // encrypted client-side
  project: string;      // encrypted client-side
  sub_project: string;  // encrypted client-side ('' encrypted as the sentinel)
  url: string;          // encrypted client-side
  kind: string;         // cleartext: 'spotify_track' | 'youtube_watch'
  first_seen: string;
  last_seen: string;
  deleted: number;
  updated_at: string;
}

export interface SyncReminder {
  uuid: string;
  title: string;        // encrypted client-side
  body: string | null;  // encrypted client-side when present
  kind: string;         // cleartext: 'once' | 'repeat'
  fire_at: string | null;
  weekdays: string | null;
  time_of_day: string | null;
  start_date: string | null;
  end_date: string | null;
  enabled: number;
  deleted: number;
  /** ISO timestamp set by the client when the reminder fires.
   *  Replicated across devices (010) so a reminder that already
   *  fired on one device doesn't refire on another that comes
   *  online later. Optional on the wire — pre-010 servers and
   *  pre-fix clients omit it. */
  last_fired_at?: string | null;
  updated_at: string;
}

export interface SyncGoal {
  uuid: string;
  type: string;
  app_name: string | null;
  // tag_uuid carries the cross-device tag reference for tag-based goals.
  // Optional because pre-002 servers don't surface it on pull.
  tag_uuid?: string | null;
  target_seconds: number;
  enabled: number;
  deleted: number;
  // First-write-wins creation timestamp. Used by the goal detail modal to
  // scope "days met" / streaks / heatmap to days after the goal existed.
  created_at?: string | null;
  updated_at: string;
}

export interface SyncMarker {
  uuid: string;
  timestamp: string;
  end_timestamp: string | null;
  label: string;
  color: string;
  icon: string;
  deleted: number;
  updated_at: string;
}

export interface SyncGoalAchievement {
  uuid: string;
  goal_uuid: string;
  goal_snapshot: string;
  date: string;
  achieved_at: string;
  current_seconds: number;
  deleted: number;
  updated_at: string;
}

export interface SyncIcon {
  name_hash: string;
  app_name: string;
  platform: string;
  data_url: string;
  dominant_color: string;
  updated_at: string;
}

export interface SyncOverride {
  name_hash: string;
  app_name: string;
  display_name: string | null;
  color: string | null;
  icon_data_url: string | null;
  updated_at: string;
}

export interface SyncSetting {
  key: string;
  value: string;
  updated_at: string;
}

export interface PushPayload {
  entries?: SyncEntry[];
  tags?: SyncTag[];
  goals?: SyncGoal[];
  markers?: SyncMarker[];
  achievements?: SyncGoalAchievement[];
  icons?: SyncIcon[];
  overrides?: SyncOverride[];
  settings?: SyncSetting[];
  // Per-(tag, app, project) sticky-exclusion tombstones. Added in 005.
  // Pre-005 servers silently drop this collection.
  tag_sticky_exclusions?: SyncTagStickyExclusion[];
  // Per-app / per-breakdown auto-tag allowlists. Added in 011.
  // Pre-011 servers silently drop these collections.
  tag_sticky_project_apps?: SyncTagStickyProjectApp[];
  tag_sticky_subproject_scopes?: SyncTagStickySubprojectScope[];
  // Captured media URLs (Spotify track URIs, YouTube /watch URLs).
  // Added in 007. Pre-007 servers silently drop this collection.
  media_links?: SyncMediaLink[];
  // Custom reminders. Added in 008. Pre-008 servers silently drop
  // this collection — local reminders still fire, they just don't
  // cross devices via that server.
  reminders?: SyncReminder[];
}

// Compound cursor for tables where rows commonly share an `updated_at`
// (icons, settings — see icon-sync-fix-plan in the private repo). The
// secondary key is the row's natural unique key and acts as a tiebreaker
// at a timestamp boundary so strict-greater-than pagination doesn't drop
// rows that share the boundary timestamp. Optional in payloads so older
// clients (without compound-cursor awareness) still work — pre-fix
// servers fall back to legacy `updated_at`-only cursors.
export interface CompoundCursor {
  updated_at: string;
  // Natural key of the last row returned. For icons this is `name_hash`;
  // for settings this is `key`.
  key: string;
}

export interface PullPayload {
  cursor: string | null;
  device_id: string;
  // Per-type compound cursors. Sent by clients that understand the
  // compound-cursor protocol (v0.1.0-beta.4+). Servers ignore unknown
  // fields, so older servers reject nothing.
  icon_cursor?: CompoundCursor | null;
  setting_cursor?: CompoundCursor | null;
  // tag_sticky_exclusions share the same shared-timestamp hazard as
  // icons + settings — a bulk re-push during Reset Cloud Data stamps
  // every row with the same `now`. Compound cursor on (updated_at, uuid).
  tag_sticky_exclusion_cursor?: CompoundCursor | null;
  // Per-app / per-breakdown auto-tag allowlists. Compound cursor on
  // (updated_at, uuid) — bulk re-push can cluster timestamps. Added in 011.
  tag_sticky_project_app_cursor?: CompoundCursor | null;
  tag_sticky_subproject_scope_cursor?: CompoundCursor | null;
  // Captured media URLs paginate by compound cursor on (updated_at,
  // uuid) — a fresh capture-enabled device pushes its whole library
  // in one shot which clusters timestamps. Sent by clients running
  // the 007-aware build; older clients omit and the server falls
  // back to legacy time-only pagination.
  media_link_cursor?: CompoundCursor | null;
  // Custom reminders. Same shared-timestamp hazard — a user may
  // create several reminders in quick succession, clustering rows
  // at the same `now`. Compound cursor on (updated_at, uuid).
  reminder_cursor?: CompoundCursor | null;
}

export interface PullResponse {
  entries: SyncEntry[];
  tags: SyncTag[];
  goals: SyncGoal[];
  markers: SyncMarker[];
  achievements: SyncGoalAchievement[];
  icons: SyncIcon[];
  overrides: SyncOverride[];
  settings: SyncSetting[];
  // Per-(tag, app, project) sticky-exclusion tombstones. Empty when the
  // server predates 005 or when the user has no exclusions. Added in 005.
  tag_sticky_exclusions?: SyncTagStickyExclusion[];
  // Per-app / per-breakdown auto-tag allowlists. Empty when the server
  // predates 011. Added in 011.
  tag_sticky_project_apps?: SyncTagStickyProjectApp[];
  tag_sticky_subproject_scopes?: SyncTagStickySubprojectScope[];
  // Captured media URLs. Empty when the server predates 007, when the
  // pushing device(s) haven't opted into media-link sync, or when no
  // captured rows exist for the user. Added in 007.
  media_links?: SyncMediaLink[];
  // Custom reminders. Empty when the server predates 008 or when the
  // user has no reminders. Added in 008.
  reminders?: SyncReminder[];
  cursor: string;
  has_more?: boolean;
  // Set by v0.1.0-beta.4+ servers when icons / settings were paginated.
  // The client round-trips them on the next pull. Absent when the
  // table's response wasn't truncated (server returned everything in
  // one shot) or when the server predates the fix.
  icon_cursor?: CompoundCursor;
  setting_cursor?: CompoundCursor;
  // Added in 005 alongside the sync_tag_sticky_exclusions table.
  tag_sticky_exclusion_cursor?: CompoundCursor;
  // Added in 011 alongside the allowlist tables.
  tag_sticky_project_app_cursor?: CompoundCursor;
  tag_sticky_subproject_scope_cursor?: CompoundCursor;
  // Added in 007 alongside the sync_media_links table.
  media_link_cursor?: CompoundCursor;
  // Added in 008 alongside the sync_reminders table.
  reminder_cursor?: CompoundCursor;
}
