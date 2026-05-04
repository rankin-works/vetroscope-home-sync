// SPDX-License-Identifier: Apache-2.0
//
// Dashboard — hero numerics, top apps with progress bars, tag donut,
// platform split, and a 14-day bar chart. No cards. Layout is pure
// composition: hairline-divided bands and breathing whitespace.

import { donutChart, barChart } from "../charts.js";
import {
  filterByPeriod,
  filterActive,
  formatDuration,
  formatHHMM,
  POLL_INTERVAL_SECONDS,
  bucketSeconds,
  bucketSecondsByKey,
  platformLabel,
  platformColor,
  colorFromString,
  dayKey,
  periodToRange,
  escapeHtml,
} from "../util.js";

export function renderDashboard(container, state) {
  console.time("[dash] total");
  container.innerHTML = "";
  const allRaw = state.entries;
  const interval = POLL_INTERVAL_SECONDS;
  console.time("[dash] filter+aggregate");
  // Active = exclude is_passive=1 + ignored apps + ignored projects.
  // The dashboard, charts, daily bars, and per-day totals all run on
  // active entries — passive/away-listening is intentionally invisible
  // here, matching the desktop's "Today" total.
  const all = filterActive(allRaw, { ignoredApps: state.ignoredApps, ignoredProjects: state.ignoredProjects, ignoredBreakdownPatterns: state.ignoredBreakdownPatterns });
  const inPeriod = filterByPeriod(all, state.period);

  // Total time = unique 30s buckets × 30s. Dedupes overlapping device
  // time (matches desktop's mergeTimeWindows). Per-key totals are also
  // bucket-deduped so an app is credited at most 30s per distinct
  // window, regardless of how many devices observed it.
  const totalSec = bucketSeconds(inPeriod, interval);
  const periodLabel = labelForPeriod(state.period);

  // breakdown for previous comparable period
  const { start, end } = periodToRange(state.period);
  const span = end - start;
  const prevStart = new Date(start.getTime() - span);
  const prevEnd = start;
  const prevEntries = all.filter(e => {
    const t = Date.parse(e.timestamp);
    return t >= prevStart.getTime() && t < prevEnd.getTime();
  });
  const prevSec = bucketSeconds(prevEntries, interval);
  const delta = prevSec > 0 ? ((totalSec - prevSec) / prevSec) * 100 : null;

  // active days
  const days = new Set();
  for (const e of inPeriod) {
    const d = new Date(e.timestamp);
    days.add(dayKey(d));
  }
  const activeDays = days.size;

  // hourly distribution → "peak hour" (bucket-deduped per hour so two
  // devices recording the same minute aren't double-counted in the
  // peak)
  const bucketMs = interval * 1000;
  const hourBuckets = Array.from({ length: 24 }, () => new Set());
  for (const e of inPeriod) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    const hour = new Date(t).getHours();
    hourBuckets[hour].add(Math.floor(t / bucketMs));
  }
  const byHour = hourBuckets.map(s => s.size * interval);
  const peakHourIdx = byHour.indexOf(Math.max(...byHour));

  // most-used app — bucket-deduped per app
  const byApp = bucketSecondsByKey(inPeriod, e => e.app || null, interval);
  const sortedApps = [...byApp.entries()].sort((a, b) => b[1] - a[1]);
  const topApp = sortedApps[0];
  console.timeEnd("[dash] filter+aggregate");
  console.log(`[dash] all=${all.length}, inPeriod=${inPeriod.length}, interval=${interval}s, period=${state.period}, totalSec=${totalSec}`);

  const heroRow = document.createElement("section");
  heroRow.className = "hero-row";
  heroRow.innerHTML = `
    <div>
      <div class="hero-eyebrow"><span class="pulse"></span>${escapeHtml(periodLabel)}</div>
      <div class="hero-numeric">
        <span class="num">${formatHHMM(totalSec)}</span>
        <span class="unit">tracked</span>
      </div>
      <div class="hero-sub">
        across <strong class="num">${activeDays}</strong> active day${activeDays === 1 ? "" : "s"}
        ${topApp ? ` · top app <strong>${escapeHtml(topApp[0])}</strong>` : ""}
      </div>
      <div class="hero-mini">
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Samples</span>
          <span class="hero-mini__val num">${inPeriod.length.toLocaleString()}</span>
          <span class="hero-mini__delta is-flat">~${interval}s polling</span>
        </div>
        <div class="hero-mini__cell">
          <span class="hero-mini__label">vs. prior</span>
          <span class="hero-mini__val num">${formatDuration(Math.abs(totalSec - prevSec), { compact: true })}</span>
          ${formatDelta(delta)}
        </div>
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Peak hour</span>
          <span class="hero-mini__val num">${peakHourIdx >= 0 ? `${String(peakHourIdx).padStart(2, "0")}:00` : "—"}</span>
          <span class="hero-mini__delta is-flat">${peakHourIdx >= 0 ? formatDuration(byHour[peakHourIdx], { compact: true }) : ""}</span>
        </div>
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Devices</span>
          <span class="hero-mini__val num">${state.devices.length}</span>
          <span class="hero-mini__delta is-flat">${distinctPlatforms(state.devices)}</span>
        </div>
      </div>
    </div>
    <div class="hero-bars" id="hero-bars"></div>
  `;
  container.appendChild(heroRow);

  // 14 / 30 / 90 day bar chart
  const barsHost = heroRow.querySelector("#hero-bars");
  const barCount = state.period === "today" ? 24
    : state.period === "7d" ? 7
    : state.period === "30d" ? 30
    : state.period === "90d" ? 90
    : 30;
  if (state.period === "today") {
    const data = byHour.map((v, i) => ({
      label: i % 4 === 0 ? String(i).padStart(2, "0") : "",
      full: `${String(i).padStart(2, "0")}:00`,
      y: v,
    }));
    barsHost.appendChild(barChart({ data, height: 200 }));
  } else {
    const data = bucketByDay(all, barCount, interval);
    barsHost.appendChild(barChart({ data, height: 200 }));
  }

  // — Top apps band —
  const apps = document.createElement("section");
  apps.className = "band";
  const topAppsList = sortedApps.slice(0, 8);
  apps.innerHTML = `
    <header class="band__head">
      <h2 class="band__title">Top apps <span class="count num">${sortedApps.length} total</span></h2>
      <span class="band__sub">${periodLabel} · sorted by tracked time</span>
    </header>
  `;
  const list = document.createElement("div");
  list.className = "applist";
  const maxAppSec = topAppsList[0]?.[1] ?? 1;
  for (const [name, secs] of topAppsList) {
    const row = document.createElement("div");
    row.className = "approw";
    const override = state.overridesByHash.get(nameHash(name)) ?? null;
    const display = override?.display_name || name;
    const iconUrl = override?.icon_data_url
      ?? findIconForApp(name, state)?.data_url
      ?? null;
    const fallbackBg = colorFromString(name);
    row.innerHTML = `
      <div class="approw__icon" style="${iconUrl ? "" : `background:linear-gradient(135deg, ${fallbackBg}, ${fallbackBg}aa);`}">
        ${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" />` : escapeHtml(initials(display))}
      </div>
      <div class="approw__name">${escapeHtml(display)}</div>
      <div class="approw__bar"><div class="approw__bar-fill" style="width:${(secs / maxAppSec) * 100}%"></div></div>
      <div class="approw__time num">${formatDuration(secs, { compact: true })}</div>
    `;
    list.appendChild(row);
  }
  if (topAppsList.length === 0) list.innerHTML = `<div class="empty"><div class="empty__title">No apps tracked in this range</div></div>`;
  apps.appendChild(list);
  container.appendChild(apps);

  // — Two columns: tag donut + platform split —
  const cols = document.createElement("section");
  cols.className = "band";
  cols.innerHTML = `<header class="band__head"><h2 class="band__title">Tags &amp; platforms</h2><span class="band__sub">where your time landed</span></header>`;
  const inner = document.createElement("div");
  inner.className = "cols";

  // Tag donut — bucket-deduped per tag (and per "untagged"). Cross-
  // device overlap on the same tag counts once.
  const tagSecs = bucketSecondsByKey(inPeriod, (e) => {
    if (e.tag_uuid && state.tagsById.has(e.tag_uuid) && !state.tagsById.get(e.tag_uuid).deleted) {
      return e.tag_uuid;
    }
    return "__untagged__";
  }, interval);
  const segments = [];
  for (const [key, secs] of tagSecs) {
    if (key === "__untagged__") {
      segments.push({ label: "Untagged", value: secs, color: "rgba(255,255,255,0.18)" });
    } else {
      const t = state.tagsById.get(key);
      segments.push({ label: t.name, value: secs, color: t.color });
    }
  }
  segments.sort((a, b) => b.value - a.value);
  const left = document.createElement("div");
  left.appendChild(donutChart({ segments, label: "tagged", size: 220, thickness: 22 }));
  inner.appendChild(left);

  // Platforms — bucket-deduped per platform. Note: the sum across
  // platforms can exceed totalSec because two platforms recording the
  // same wall-clock minute each get credited (intentional: matches
  // desktop's per-platform breakdown).
  const right = document.createElement("div");
  const byPlatform = bucketSecondsByKey(inPeriod, e => e.platform || "unknown", interval);
  const platformTotal = [...byPlatform.values()].reduce((a, b) => a + b, 0);
  const platHeader = document.createElement("div");
  platHeader.style.cssText = "font-size:10px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:14px;";
  platHeader.textContent = "Platform split";
  right.appendChild(platHeader);
  const plats = document.createElement("div");
  plats.className = "platforms";
  for (const [p, secs] of [...byPlatform.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = platformTotal > 0 ? (secs / platformTotal) * 100 : 0;
    const row = document.createElement("div");
    row.className = "platform-row";
    row.innerHTML = `
      <div class="platform-row__label">
        <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${platformColor(p)};"></span>
        ${escapeHtml(platformLabel(p))}
      </div>
      <div class="platform-row__bar">
        <div class="platform-row__bar-fill" style="width:${pct}%; background:linear-gradient(90deg, ${platformColor(p)}, ${platformColor(p)}66);"></div>
      </div>
      <div class="platform-row__pct num">${pct.toFixed(0)}%</div>
    `;
    plats.appendChild(row);
  }
  if (byPlatform.size === 0) plats.innerHTML = `<div class="empty"><div class="empty__title">No platform data</div></div>`;
  right.appendChild(plats);

  // Devices, exposed (platform IDs requirement)
  if (state.devices.length > 0) {
    const devHead = document.createElement("div");
    devHead.style.cssText = "margin-top:28px;font-size:10px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:10px;";
    devHead.textContent = "Devices on this server";
    right.appendChild(devHead);
    const dlist = document.createElement("div");
    dlist.style.cssText = "display:flex;flex-direction:column;gap:0;";
    for (const dev of state.devices) {
      const r = document.createElement("div");
      r.style.cssText = "display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--hairline);";
      r.innerHTML = `
        <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${platformColor(dev.platform)};"></span>
        <div style="min-width:0;display:flex;flex-direction:column;">
          <span style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(dev.device_name)}</span>
          <span style="font-size:10px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;">${escapeHtml(dev.id.slice(0, 8))}… · ${escapeHtml(platformLabel(dev.platform))}</span>
        </div>
        <span style="font-size:10px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;">${dev.last_sync_at ? relativeTime(dev.last_sync_at) : "—"}</span>
      `;
      dlist.appendChild(r);
    }
    right.appendChild(dlist);
  }
  inner.appendChild(right);

  cols.appendChild(inner);
  container.appendChild(cols);
  console.timeEnd("[dash] total");
}

// — helpers —
function labelForPeriod(p) {
  switch (p) {
    case "today": return "Today";
    case "7d":    return "Last 7 days";
    case "30d":   return "Last 30 days";
    case "90d":   return "Last 90 days";
    case "all":   return "All time";
    default:      return p;
  }
}
function distinctPlatforms(devices) {
  const set = new Set(devices.map(d => d.platform));
  return [...set].map(platformLabel).join(" · ") || "—";
}
function formatDelta(d) {
  if (d == null) return `<span class="hero-mini__delta is-flat">no prior</span>`;
  const arrow = d >= 0 ? "↑" : "↓";
  const cls = Math.abs(d) < 2 ? "is-flat" : (d >= 0 ? "is-up" : "is-down");
  return `<span class="hero-mini__delta ${cls}">${arrow} ${Math.abs(d).toFixed(1)}%</span>`;
}
function bucketByDay(entries, count, interval) {
  const today = new Date(); today.setHours(0,0,0,0);
  const bucketMs = interval * 1000;
  // Two-level dedup: per-day Set of 30s buckets, then convert to
  // seconds at the end. Matches the desktop's daily totals.
  const dayBuckets = Array.from({ length: count }, () => new Set());
  for (const e of entries) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t); d.setHours(0,0,0,0);
    const diff = Math.round((today - d) / 86400000);
    if (diff < 0 || diff >= count) continue;
    dayBuckets[count - 1 - diff].add(Math.floor(t / bucketMs));
  }
  return dayBuckets.map((set, i) => {
    const date = new Date(today); date.setDate(today.getDate() - (count - 1 - i));
    return {
      label: date.toLocaleDateString(undefined, { day: "numeric" }),
      full: date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
      y: set.size * interval,
    };
  });
}

// SHA-1-like trivial hash for matching name_hash. Vetroscope's name_hash
// is a SHA-1 hex of the lowercased app name; we don't have that here so
// fall back to a manual lookup in icons.
function nameHash(name) {
  // Best-effort: scan icons by app_name (icons table has plaintext app_name).
  return name?.toLowerCase?.() ?? "";
}
function findIconForApp(name, state) {
  if (!name) return null;
  const target = name.toLowerCase();
  for (const icon of state.iconsByHash.values()) {
    if ((icon.app_name ?? "").toLowerCase() === target) return icon;
  }
  return null;
}
function initials(name) {
  if (!name) return "·";
  const w = name.split(/\s+/).filter(Boolean);
  if (w.length === 0) return "·";
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  return `${Math.floor(diff/86400)}d`;
}
