// SPDX-License-Identifier: Apache-2.0
//
// Charts page — multiple visualizations of the same data set.
// Line/area trend, donut by app, hourly heatmap, platform stacked bars.

import { lineChart, donutChart, heatmap, barChart } from "../charts.js";
import {
  filterByPeriod,
  filterActive,
  POLL_INTERVAL_SECONDS,
  bucketSecondsByKey,
  platformLabel,
  platformColor,
  colorFromString,
  formatDuration,
  escapeHtml,
} from "../util.js";

export function renderCharts(container, state) {
  container.innerHTML = "";
  const all = filterActive(state.entries, { ignoredApps: state.ignoredApps, ignoredProjects: state.ignoredProjects });
  const interval = POLL_INTERVAL_SECONDS;
  const inPeriod = filterByPeriod(all, state.period);

  const grid = document.createElement("div");
  grid.className = "charts-grid";

  // — Trend (daily totals over the period) —
  const trend = document.createElement("section");
  trend.className = "band";
  trend.innerHTML = `
    <header class="band__head">
      <h2 class="band__title">Time trend</h2>
      <span class="band__sub">daily totals · ${labelForPeriod(state.period)}</span>
    </header>
  `;
  trend.appendChild(buildTrend(inPeriod, all, interval, state.period));
  grid.appendChild(trend);

  // — Hourly heatmap (last 7 days regardless of period — heatmap reads better that way) —
  const heat = document.createElement("section");
  heat.className = "band";
  heat.innerHTML = `
    <header class="band__head">
      <h2 class="band__title">Hour-of-day</h2>
      <span class="band__sub">last 7 days · darker = more activity</span>
    </header>
  `;
  heat.appendChild(buildHeatmap(all, interval));
  grid.appendChild(heat);

  // — Two-up: app distribution + tag distribution —
  const distRow = document.createElement("section");
  distRow.className = "band";
  distRow.innerHTML = `
    <header class="band__head">
      <h2 class="band__title">Distribution</h2>
      <span class="band__sub">${labelForPeriod(state.period)}</span>
    </header>
  `;
  const distInner = document.createElement("div");
  distInner.className = "cols";

  // App donut — bucket-deduped per app
  const byApp = bucketSecondsByKey(inPeriod, e => e.app || null, interval);
  const appsSorted = [...byApp.entries()].sort((a, b) => b[1] - a[1]);
  const top8 = appsSorted.slice(0, 8);
  const otherSec = appsSorted.slice(8).reduce((acc, [, s]) => acc + s, 0);
  const appSegments = top8.map(([name, secs]) => ({
    label: name, value: secs, color: colorFromString(name),
  }));
  if (otherSec > 0) appSegments.push({ label: "Other", value: otherSec, color: "rgba(255,255,255,0.18)" });

  const appWrap = document.createElement("div");
  const appLabel = document.createElement("div");
  appLabel.style.cssText = "font-size:10px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:14px;";
  appLabel.textContent = "By application";
  appWrap.appendChild(appLabel);
  appWrap.appendChild(donutChart({ segments: appSegments, label: "by app", size: 220, thickness: 22 }));
  distInner.appendChild(appWrap);

  // Tag donut — bucket-deduped per tag
  const tagSecs = bucketSecondsByKey(inPeriod, (e) => {
    if (e.tag_uuid && state.tagsById.has(e.tag_uuid) && !state.tagsById.get(e.tag_uuid).deleted) {
      return e.tag_uuid;
    }
    return "__untagged__";
  }, interval);
  const tagSegments = [];
  for (const [key, secs] of tagSecs) {
    if (key === "__untagged__") {
      tagSegments.push({ label: "Untagged", value: secs, color: "rgba(255,255,255,0.18)" });
    } else {
      const t = state.tagsById.get(key);
      tagSegments.push({ label: t.name, value: secs, color: t.color });
    }
  }
  tagSegments.sort((a, b) => b.value - a.value);

  const tagWrap = document.createElement("div");
  const tagLabel = document.createElement("div");
  tagLabel.style.cssText = "font-size:10px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-tertiary);margin-bottom:14px;";
  tagLabel.textContent = "By tag";
  tagWrap.appendChild(tagLabel);
  tagWrap.appendChild(donutChart({ segments: tagSegments, label: "by tag", size: 220, thickness: 22 }));
  distInner.appendChild(tagWrap);

  distRow.appendChild(distInner);
  grid.appendChild(distRow);

  // — Platform totals as horizontal bars —
  const platformBand = document.createElement("section");
  platformBand.className = "band";
  platformBand.innerHTML = `
    <header class="band__head">
      <h2 class="band__title">Platform totals</h2>
      <span class="band__sub">tracked time per platform · ${labelForPeriod(state.period)}</span>
    </header>
  `;
  const platBox = document.createElement("div");
  platBox.style.cssText = "display:flex;flex-direction:column;gap:18px;";
  const byPlat = bucketSecondsByKey(inPeriod, e => e.platform || "unknown", interval);
  const totalPlat = [...byPlat.values()].reduce((a, b) => a + b, 0);
  const sorted = [...byPlat.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    platBox.innerHTML = `<div class="empty"><div class="empty__title">No platform data</div></div>`;
  } else {
    for (const [p, secs] of sorted) {
      const pct = totalPlat > 0 ? (secs / totalPlat) * 100 : 0;
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:120px 1fr auto;gap:18px;align-items:center;";
      row.innerHTML = `
        <div style="display:inline-flex;align-items:center;gap:8px;font-size:13px;">
          <span style="width:8px;height:8px;border-radius:50%;background:${platformColor(p)};box-shadow:0 0 8px ${platformColor(p)}66;"></span>
          ${escapeHtml(platformLabel(p))}
        </div>
        <div style="height:8px;border-radius:999px;background:rgba(255,255,255,0.05);position:relative;overflow:hidden;">
          <div style="position:absolute;inset:0;width:${pct}%;background:linear-gradient(90deg, ${platformColor(p)}, ${platformColor(p)}55);border-radius:inherit;"></div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;font-variant-numeric:tabular-nums;">
          <span style="font-size:14px;color:var(--text-primary);">${formatDuration(secs, { compact: true })}</span>
          <span style="font-size:10px;color:var(--text-tertiary);">${pct.toFixed(1)}%</span>
        </div>
      `;
      platBox.appendChild(row);
    }
  }
  platformBand.appendChild(platBox);
  grid.appendChild(platformBand);

  container.appendChild(grid);
}

function buildTrend(inPeriod, all, interval, period) {
  const bucketMs = interval * 1000;
  // Number of days to plot
  const days = period === "today" ? 1
    : period === "7d" ? 7
    : period === "30d" ? 30
    : period === "90d" ? 90
    : 180;
  if (period === "today") {
    // Hour-by-hour for today, bucket-deduped per hour.
    const sets = Array.from({ length: 24 }, () => new Set());
    for (const e of inPeriod) {
      const t = Date.parse(e.timestamp);
      if (!Number.isFinite(t)) continue;
      const h = new Date(t).getHours();
      sets[h].add(Math.floor(t / bucketMs));
    }
    const data = sets.map((s, h) => ({
      x: new Date(new Date().setHours(h, 0, 0, 0)),
      y: s.size * interval,
    }));
    return lineChart({ data, height: 220 });
  }
  const today = new Date(); today.setHours(0,0,0,0);
  const sets = Array.from({ length: days }, () => new Set());
  for (const e of inPeriod) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t); d.setHours(0,0,0,0);
    const diff = Math.round((today - d) / 86400000);
    const idx = days - 1 - diff;
    if (idx < 0 || idx >= days) continue;
    sets[idx].add(Math.floor(t / bucketMs));
  }
  const data = sets.map((s, i) => {
    const d = new Date(today); d.setDate(today.getDate() - (days - 1 - i));
    return { x: d, y: s.size * interval };
  });
  return lineChart({ data, height: 240 });
}

function buildHeatmap(all, interval) {
  const bucketMs = interval * 1000;
  const days = 7;
  const today = new Date(); today.setHours(0,0,0,0);
  const grid = Array.from({ length: days }, () => Array.from({ length: 24 }, () => new Set()));
  for (const e of all) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const day = new Date(d); day.setHours(0,0,0,0);
    const diff = Math.round((today - day) / 86400000);
    if (diff < 0 || diff >= days) continue;
    grid[days - 1 - diff][d.getHours()].add(Math.floor(t / bucketMs));
  }
  const numericGrid = grid.map(row => row.map(s => s.size * interval));
  return heatmap({ data: numericGrid, days });
}

function labelForPeriod(p) {
  switch (p) {
    case "today": return "today";
    case "7d":    return "last 7 days";
    case "30d":   return "last 30 days";
    case "90d":   return "last 90 days";
    case "all":   return "all time";
    default:      return p;
  }
}
