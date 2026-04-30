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
  is_adobe: number;
  tag_uuid: string | null;
  platform: string | null;
  updated_at: string;
}

export interface SyncTag {
  uuid: string;
  name: string;
  color: string;
  sticky: number;
  deleted: number;
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
  cursor: string;
  has_more?: boolean;
  // Set by v0.1.0-beta.4+ servers when icons / settings were paginated.
  // The client round-trips them on the next pull. Absent when the
  // table's response wasn't truncated (server returned everything in
  // one shot) or when the server predates the fix.
  icon_cursor?: CompoundCursor;
  setting_cursor?: CompoundCursor;
}
