// SPDX-License-Identifier: Apache-2.0
// Misc helpers for time math, formatting, aggregation.

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "data" && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = String(dv);
    }
    else el.setAttribute(k, String(v));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") {
      el.appendChild(document.createTextNode(String(c)));
    } else {
      el.appendChild(c);
    }
  }
  return el;
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// — Time formatting —
export function formatDuration(seconds, opts = {}) {
  const { compact = false, showSeconds = false } = opts;
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (compact) {
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }
  if (showSeconds) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function formatHHMM(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

// Vetroscope's poll interval is fixed at 30s — both the desktop client
// and the cloud reports use this constant directly rather than inferring
// from the data. Mirror it here so totals match the desktop dashboard
// byte-for-byte.
export const POLL_INTERVAL_SECONDS = 30;

// Kept for legacy callers that want to know "what's the polling cadence"
// — answers the same question as the desktop's hardcoded constant.
export function inferSampleInterval() {
  return POLL_INTERVAL_SECONDS;
}

// Drop entries the dashboard shouldn't count toward active time:
// passive (background / away-listening) entries, and apps/projects
// the user has explicitly ignored. Mirrors the desktop's
// `${ACTIVE_ONLY}${ignoredFilter}` SQL clauses.
//
// `ignoredApps` / `ignoredProjects` are Sets of plaintext names. The
// caller is responsible for having decrypted entry.app / entry.project
// before this is called.
export function filterActive(entries, { ignoredApps, ignoredProjects } = {}) {
  return entries.filter((e) => {
    if (e.is_passive === 1) return false;
    if (ignoredApps && e.app && ignoredApps.has(e.app)) return false;
    if (ignoredProjects && e.project && ignoredProjects.has(e.project)) return false;
    return true;
  });
}

// Count distinct 30-second buckets across the supplied entries and
// return total seconds. This dedupes overlapping device time (e.g. when
// the desktop and laptop are both polling the same minute) — matches
// the desktop's `mergeTimeWindows` semantics in electron/database.ts.
export function bucketSeconds(entries, intervalSec = POLL_INTERVAL_SECONDS) {
  if (!entries || entries.length === 0) return 0;
  const bucketMs = intervalSec * 1000;
  const set = new Set();
  for (const e of entries) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    set.add(Math.floor(t / bucketMs));
  }
  return set.size * intervalSec;
}

// Per-key bucketed total: returns Map<key, seconds>. Each (key, bucket)
// pair counts at most once, so an app is credited 30s for every distinct
// 30s window in which it appeared — across all devices. Matches the
// desktop's per-app SQL: `COUNT(DISTINCT bucket) * POLL_INTERVAL`.
export function bucketSecondsByKey(entries, keyFn, intervalSec = POLL_INTERVAL_SECONDS) {
  const bucketMs = intervalSec * 1000;
  const seen = new Map(); // key → Set<bucket>
  for (const e of entries) {
    const key = keyFn(e);
    if (key == null) continue;
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    const bucket = Math.floor(t / bucketMs);
    let set = seen.get(key);
    if (!set) { set = new Set(); seen.set(key, set); }
    set.add(bucket);
  }
  const out = new Map();
  for (const [key, set] of seen) out.set(key, set.size * intervalSec);
  return out;
}

export function periodToRange(period, now = new Date()) {
  const end = new Date(now);
  let start;
  switch (period) {
    case "today": {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "7d": {
      start = new Date(now); start.setDate(start.getDate() - 7);
      break;
    }
    case "30d": {
      start = new Date(now); start.setDate(start.getDate() - 30);
      break;
    }
    case "90d": {
      start = new Date(now); start.setDate(start.getDate() - 90);
      break;
    }
    case "all":
    default:
      start = new Date(0);
  }
  return { start, end };
}

export function filterByPeriod(entries, period) {
  const { start, end } = periodToRange(period);
  const startMs = start.getTime();
  const endMs = end.getTime();
  return entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
}

export function groupBy(items, keyFn) {
  const out = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

export function sortByValueDesc(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// "Today" / "Yesterday" / "Mon, Mar 4"
export function formatDayLabel(d) {
  const today = new Date(); today.setHours(0,0,0,0);
  const date = new Date(d); date.setHours(0,0,0,0);
  const diff = Math.round((today - date) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" });
}

export function platformLabel(p) {
  switch (p) {
    case "darwin": return "macOS";
    case "win32":  return "Windows";
    case "linux":  return "Linux";
    case "web":    return "Web";
    default: return p ? p.charAt(0).toUpperCase() + p.slice(1) : "Unknown";
  }
}

export function platformColor(p) {
  switch (p) {
    case "darwin": return "var(--text-primary)";
    case "win32":  return "var(--sky)";
    case "linux":  return "var(--amber)";
    case "web":    return "var(--cyan)";
    default: return "var(--text-tertiary)";
  }
}

// Stable color per arbitrary string. Used for app fallback swatches when
// no icon override exists.
export function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const palette = [
    "#06b6d4", "#8b5cf6", "#ec4899", "#f59e0b",
    "#3b82f6", "#10b981", "#f97316", "#ef4444",
  ];
  return palette[Math.abs(h) % palette.length];
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
