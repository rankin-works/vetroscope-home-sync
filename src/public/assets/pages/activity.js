// SPDX-License-Identifier: Apache-2.0
//
// Activity — chronological per-day timeline. Filterable by tag and
// platform. Each row shows: time · icon · app + window-title · tag pill
// · platform dot. Window titles get the same treatment as in the
// desktop client (light grey, secondary).

import {
  filterByPeriod,
  filterActive,
  POLL_INTERVAL_SECONDS,
  bucketSeconds,
  platformLabel,
  platformColor,
  colorFromString,
  formatDuration,
  formatDayLabel,
  dayKey,
  escapeHtml,
} from "../util.js";

let activeFilters = { tag: null, platform: null, app: null };

export function renderActivity(container, state) {
  container.innerHTML = "";
  const all = filterActive(state.entries, { ignoredApps: state.ignoredApps, ignoredProjects: state.ignoredProjects, ignoredBreakdownPatterns: state.ignoredBreakdownPatterns });
  const interval = POLL_INTERVAL_SECONDS;
  const inPeriod = filterByPeriod(all, state.period);

  // Filter chips
  const filters = document.createElement("div");
  filters.className = "filters";
  filters.appendChild(buildAllChip());
  for (const tag of [...state.tagsById.values()].filter(t => !t.deleted)) {
    filters.appendChild(buildTagChip(tag));
  }
  for (const p of distinctPlatforms(all)) {
    filters.appendChild(buildPlatformChip(p));
  }
  container.appendChild(filters);

  // Apply filters
  const filtered = inPeriod.filter((e) => {
    if (activeFilters.tag && e.tag_uuid !== activeFilters.tag) return false;
    if (activeFilters.platform && (e.platform ?? "unknown") !== activeFilters.platform) return false;
    if (activeFilters.app && e.app !== activeFilters.app) return false;
    return true;
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = `
      <div class="empty__title">No activity in this range</div>
      <div class="empty__sub">Try a longer period or clear the filters above.</div>
    `;
    container.appendChild(empty);
    return;
  }

  // Group by day
  const byDay = new Map();
  for (const e of filtered) {
    const d = new Date(e.timestamp);
    d.setHours(0, 0, 0, 0);
    const k = dayKey(d);
    if (!byDay.has(k)) byDay.set(k, { date: d, entries: [] });
    byDay.get(k).entries.push(e);
  }
  const sortedDays = [...byDay.values()].sort((a, b) => b.date - a.date);

  const wrap = document.createElement("div");
  wrap.className = "activity";

  for (const day of sortedDays) {
    const dayEl = document.createElement("section");
    dayEl.className = "activity-day";
    const total = bucketSeconds(day.entries, interval);
    dayEl.innerHTML = `
      <header class="activity-day__head">
        <span class="activity-day__date">${escapeHtml(formatDayLabel(day.date))} · ${day.date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <span class="activity-day__total num">${formatDuration(total, { compact: true })} · ${day.entries.length} samples</span>
      </header>
    `;

    // Compress contiguous samples on the same app+title into one row
    const compacted = compact(day.entries.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)), interval);
    const list = document.createElement("div");
    list.className = "activity-list";
    const cap = 200; // per day
    const visible = compacted.slice(0, cap);
    for (const item of visible) {
      list.appendChild(buildRow(item, state));
    }
    if (compacted.length > cap) {
      const more = document.createElement("div");
      more.style.cssText = "grid-column:1 / -1; padding:10px 0; font-size:11px; color:var(--text-tertiary); text-align:center; border-top: 1px dashed var(--hairline);";
      more.textContent = `+${(compacted.length - cap).toLocaleString()} more samples`;
      list.appendChild(more);
    }
    dayEl.appendChild(list);
    wrap.appendChild(dayEl);
  }

  container.appendChild(wrap);
}

function buildAllChip() {
  const c = document.createElement("button");
  c.className = "chip";
  if (!activeFilters.tag && !activeFilters.platform && !activeFilters.app) c.classList.add("is-active");
  c.textContent = "All";
  c.addEventListener("click", () => {
    activeFilters = { tag: null, platform: null, app: null };
    refresh();
  });
  return c;
}
function buildTagChip(tag) {
  const c = document.createElement("button");
  c.className = "chip";
  if (activeFilters.tag === tag.uuid) c.classList.add("is-active");
  c.innerHTML = `<span class="swatch" style="background:${escapeHtml(tag.color)}"></span>${escapeHtml(tag.name)}`;
  c.addEventListener("click", () => {
    activeFilters = { ...activeFilters, tag: activeFilters.tag === tag.uuid ? null : tag.uuid, app: null };
    refresh();
  });
  return c;
}
function buildPlatformChip(p) {
  const c = document.createElement("button");
  c.className = "chip";
  if (activeFilters.platform === p) c.classList.add("is-active");
  const color = platformColor(p);
  c.innerHTML = `<span class="swatch" style="background:${color};border-radius:50%;width:8px;height:8px;"></span>${escapeHtml(platformLabel(p))}`;
  c.addEventListener("click", () => {
    activeFilters = { ...activeFilters, platform: activeFilters.platform === p ? null : p };
    refresh();
  });
  return c;
}
function distinctPlatforms(entries) {
  const set = new Set();
  for (const e of entries) set.add(e.platform || "unknown");
  return [...set];
}

function compact(entries, interval) {
  const out = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.app === e.app && last.title === e.title && last.tag_uuid === e.tag_uuid && last.platform === e.platform) {
      last.count += 1;
      last.lastTs = e.timestamp;
    } else {
      out.push({
        app: e.app,
        title: e.title,
        project: e.project,
        tag_uuid: e.tag_uuid,
        platform: e.platform,
        device_id: e.device_id,
        firstTs: e.timestamp,
        lastTs: e.timestamp,
        count: 1,
      });
    }
  }
  // attach durations
  for (const it of out) it.duration = it.count * interval;
  return out;
}

function buildRow(item, state) {
  const row = document.createElement("div");
  row.className = "activity-row";
  const time = formatTime(item.firstTs);
  const tag = item.tag_uuid && state.tagsById.has(item.tag_uuid) ? state.tagsById.get(item.tag_uuid) : null;
  const override = findOverrideForApp(item.app, state);
  const display = override?.display_name || item.app || "—";
  const iconUrl = override?.icon_data_url ?? findIconForApp(item.app, state)?.data_url ?? null;
  const fallbackBg = colorFromString(item.app ?? "?");

  const timeEl = document.createElement("div");
  timeEl.className = "activity-time num";
  timeEl.textContent = time;

  const iconEl = document.createElement("div");
  iconEl.className = "activity-icon";
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    iconEl.appendChild(img);
  } else {
    iconEl.style.background = `linear-gradient(135deg, ${fallbackBg}, ${fallbackBg}aa)`;
    iconEl.textContent = (display ?? "?").slice(0, 1).toUpperCase();
    iconEl.style.color = "rgba(255,255,255,0.92)";
  }

  const appEl = document.createElement("div");
  appEl.className = "activity-app";
  appEl.innerHTML = `${escapeHtml(display)}${item.title ? `<span class="title">${escapeHtml(item.title)}</span>` : ""}`;

  const tagEl = document.createElement("div");
  tagEl.style.minWidth = "0";
  if (tag) {
    tagEl.innerHTML = `<span class="activity-tag"><span class="swatch" style="background:${escapeHtml(tag.color)}"></span>${escapeHtml(tag.name)}</span>`;
  }

  const meta = document.createElement("div");
  meta.style.cssText = "display:inline-flex;align-items:center;gap:10px;font-variant-numeric:tabular-nums;";
  meta.innerHTML = `
    <span class="activity-platform" style="color:${platformColor(item.platform)};">
      <span class="dot"></span>${escapeHtml(platformLabel(item.platform || "unknown"))}
    </span>
    <span style="font-size:11px;color:var(--text-secondary);min-width:46px;text-align:right;">${formatDuration(item.duration, { compact: true })}</span>
  `;

  row.appendChild(timeEl);
  row.appendChild(iconEl);
  row.appendChild(appEl);
  row.appendChild(tagEl);
  row.appendChild(meta);
  return row;
}

function findIconForApp(name, state) {
  if (!name) return null;
  const target = name.toLowerCase();
  for (const icon of state.iconsByHash.values()) {
    if ((icon.app_name ?? "").toLowerCase() === target) return icon;
  }
  return null;
}
function findOverrideForApp(name, state) {
  if (!name) return null;
  const target = name.toLowerCase();
  for (const o of state.overridesByHash.values()) {
    if ((o.app_name ?? "").toLowerCase() === target) return o;
  }
  return null;
}
function formatTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function refresh() {
  const event = new CustomEvent("vhs:refresh-page");
  window.dispatchEvent(event);
}
