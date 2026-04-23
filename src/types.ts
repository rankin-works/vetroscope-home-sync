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
  target_seconds: number;
  enabled: number;
  deleted: number;
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

export interface PullPayload {
  cursor: string | null;
  device_id: string;
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
}
