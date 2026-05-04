// SPDX-License-Identifier: Apache-2.0
//
// Tiny pub/sub for app state. Decryption results, current period,
// active route, user profile, and the raw snapshot all live here.

const listeners = new Set();
const state = {
  ready: false,
  user: null,
  devices: [],
  serverName: null,
  // Cached sync key (hex). Lives in memory only; not persisted.
  syncKey: null,
  // Snapshot from /web/snapshot (raw, ciphertexts intact).
  snapshot: null,
  // Decrypted entries (with .app, .title, .project plaintext fields).
  entries: [],
  // Tags / icons / overrides indexed by uuid / name_hash for fast lookup.
  tagsById: new Map(),
  iconsByHash: new Map(),
  overridesByHash: new Map(),
  // User preferences from sync_settings. Decrypted client-side.
  ignoredApps: new Set(),
  ignoredProjects: new Set(),
  // ignored_breakdown_patterns: per-app keyword/extension patterns.
  // Shape: Array<{ appName: string; pattern: string }>. Patterns starting
  // with "." are extension (suffix) matches; others are substring matches.
  ignoredBreakdownPatterns: [],
  // UI state
  period: "7d",
  route: "dashboard",
  collapsed: false,
  mobileMenuOpen: false,
  loading: false,
  error: null,
};

export function getState() { return state; }
export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
