// SPDX-License-Identifier: Apache-2.0
//
// Devices page. Shows every device_id that appears in sync_entries
// (with entry counts and bucket-deduped time totals), and flags any
// that don't have a matching row in `devices` as orphans.
//
// Discrepancies between the web UI's totals and the desktop's are
// almost always orphans — entries from a device that was unlinked or
// renamed. From here you can drop those entries to bring the totals
// into alignment.

import { POLL_INTERVAL_SECONDS, formatDuration, platformLabel, platformColor, escapeHtml } from "../util.js";

export function renderDevices(container, state) {
  container.innerHTML = "";
  const stats = state.snapshot?.device_stats ?? [];
  const registered = new Map();
  for (const d of state.devices ?? []) registered.set(d.id, d);

  const enriched = stats.map((s) => {
    const reg = registered.get(s.device_id);
    return {
      device_id: s.device_id,
      entry_count: s.entry_count,
      passive_count: s.passive_count ?? 0,
      first_ts: s.first_ts,
      last_ts: s.last_ts,
      seconds: (s.active_buckets ?? 0) * POLL_INTERVAL_SECONDS,
      registered: reg ?? null,
      orphan: !reg,
    };
  });

  const totalSeconds = enriched.reduce((acc, d) => acc + d.seconds, 0);
  const totalPassive = enriched.reduce((acc, d) => acc + d.passive_count, 0);
  const orphans = enriched.filter((d) => d.orphan);
  const orphanSeconds = orphans.reduce((acc, d) => acc + d.seconds, 0);

  // Hero band — accounting summary
  const hero = document.createElement("section");
  hero.className = "hero-row";
  hero.innerHTML = `
    <div>
      <div class="hero-eyebrow"><span class="pulse" style="background:${orphans.length > 0 ? "var(--coral)" : "var(--emerald-bright)"};"></span>${orphans.length > 0 ? "Orphan entries detected" : "All entries accounted for"}</div>
      <div class="hero-numeric">
        <span class="num">${formatDuration(totalSeconds, { compact: true })}</span>
        <span class="unit">across ${enriched.length} device id${enriched.length === 1 ? "" : "s"}</span>
      </div>
      <div class="hero-sub">
        ${orphans.length > 0
          ? `<strong style="color:var(--coral);">${formatDuration(orphanSeconds, { compact: true })}</strong> belongs to ${orphans.length} unregistered device id${orphans.length === 1 ? "" : "s"} — likely unlinked or renamed devices whose history is still here.`
          : `Every device_id in your entries maps to a registered device. Discrepancies vs. the desktop are likely rounding.`}
      </div>
      <div class="hero-mini">
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Registered devices</span>
          <span class="hero-mini__val num">${state.devices.length}</span>
          <span class="hero-mini__delta is-flat">${[...new Set(state.devices.map(d => d.platform))].map(platformLabel).join(" · ") || "—"}</span>
        </div>
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Distinct ids in entries</span>
          <span class="hero-mini__val num">${enriched.length}</span>
          <span class="hero-mini__delta ${orphans.length > 0 ? "is-down" : "is-flat"}">${orphans.length} orphan${orphans.length === 1 ? "" : "s"}</span>
        </div>
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Orphan time</span>
          <span class="hero-mini__val num">${formatDuration(orphanSeconds, { compact: true })}</span>
          <span class="hero-mini__delta is-flat">${totalSeconds > 0 ? `${((orphanSeconds/totalSeconds)*100).toFixed(1)}% of total` : "—"}</span>
        </div>
        <div class="hero-mini__cell">
          <span class="hero-mini__label">Passive entries</span>
          <span class="hero-mini__val num">${totalPassive.toLocaleString()}</span>
          <span class="hero-mini__delta is-flat">excluded from totals</span>
        </div>
      </div>
    </div>
    <div></div>
  `;
  container.appendChild(hero);

  // Table band
  const band = document.createElement("section");
  band.className = "band";
  band.innerHTML = `
    <header class="band__head">
      <h2 class="band__title">Every device_id in this database <span class="count num">${enriched.length} total</span></h2>
      <span class="band__sub">sorted by entries</span>
    </header>
  `;

  if (enriched.length === 0) {
    band.appendChild(emptyState("No entries on this server."));
    container.appendChild(band);
    return;
  }

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;";
  for (const d of enriched) {
    list.appendChild(buildDeviceRow(d));
  }
  band.appendChild(list);
  container.appendChild(band);
}

function buildDeviceRow(d) {
  const row = document.createElement("div");
  row.style.cssText = "display:grid;grid-template-columns:14px 1.6fr 80px 90px 1fr auto;gap:18px;align-items:center;padding:14px 0;border-bottom:1px solid var(--hairline);";

  const dot = document.createElement("span");
  dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${d.orphan ? "var(--coral)" : platformColor(d.registered?.platform)};box-shadow:${d.orphan ? "0 0 8px rgba(255,107,107,0.6)" : ""};`;

  const id = document.createElement("div");
  id.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:2px;";
  id.innerHTML = `
    <span style="font-size:13px;font-weight:500;${d.orphan ? "color:var(--coral);" : ""}">
      ${d.registered ? escapeHtml(d.registered.device_name) : '<span style="font-style:italic;">orphan</span>'}
      ${d.orphan ? '<span class="plan-badge" style="margin-left:8px;font-size:9px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;padding:2px 6px;border-radius:3px;background:rgba(239,68,68,0.13);color:#fca5a5;">orphan</span>' : ''}
    </span>
    <span style="font-size:10px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;font-family:var(--font-mono);">${escapeHtml(d.device_id)}</span>
  `;

  const platform = document.createElement("div");
  platform.style.cssText = "font-size:12px;color:var(--text-secondary);display:inline-flex;align-items:center;gap:6px;";
  platform.innerHTML = d.registered
    ? `<span style="width:6px;height:6px;border-radius:50%;background:${platformColor(d.registered.platform)};"></span>${escapeHtml(platformLabel(d.registered.platform))}`
    : `<span style="color:var(--text-tertiary);">—</span>`;

  const entries = document.createElement("div");
  entries.style.cssText = "font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums;text-align:right;";
  entries.textContent = d.entry_count.toLocaleString();

  const range = document.createElement("div");
  range.style.cssText = "font-size:11px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;display:flex;flex-direction:column;line-height:1.3;";
  range.innerHTML = `
    <span>${escapeHtml(formatTimestamp(d.first_ts))}</span>
    <span style="color:var(--text-quaternary);">→ ${escapeHtml(formatTimestamp(d.last_ts))}</span>
  `;

  const right = document.createElement("div");
  right.style.cssText = "display:inline-flex;align-items:center;gap:14px;";
  const time = document.createElement("span");
  time.style.cssText = "font-size:14px;color:var(--text-primary);font-variant-numeric:tabular-nums;min-width:80px;text-align:right;";
  time.textContent = formatDuration(d.seconds, { compact: true });
  right.appendChild(time);
  if (d.orphan) {
    const drop = document.createElement("button");
    drop.className = "btn btn--ghost";
    drop.style.cssText = "padding:6px 11px;font-size:12px;color:#fca5a5;border-color:rgba(239,68,68,0.28);";
    drop.innerHTML = `<span class="btn__label">Drop ${d.entry_count.toLocaleString()} entries</span><span class="btn__spinner"></span>`;
    drop.addEventListener("click", () => onDrop(d, drop));
    right.appendChild(drop);
  }

  row.append(dot, id, platform, entries, range, right);
  return row;
}

async function onDrop(d, btn) {
  const ok = window.confirm(
    `Drop ${d.entry_count.toLocaleString()} entries from device_id ${d.device_id}?\n\n` +
    `This is permanent — there is no undo. Use this only for orphan ids that no longer correspond to a device you own.`,
  );
  if (!ok) return;
  btn.dataset.loading = "true";
  btn.disabled = true;
  try {
    const res = await fetch(`/web/orphan-entries/${encodeURIComponent(d.device_id)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${JSON.parse(sessionStorage.getItem("vhs:tokens") ?? "{}").access_token ?? ""}`,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
    }
    // Trigger a full refresh so all pages reflect the deletion. Easiest
    // path is just reload — state is snapshot-driven so anything else
    // would require partial reseeding logic that isn't worth its cost
    // for a destructive admin action.
    location.reload();
  } catch (err) {
    alert(`Failed: ${err?.message ?? err}`);
    btn.dataset.loading = "false";
    btn.disabled = false;
  }
}

function emptyState(msg) {
  const e = document.createElement("div");
  e.className = "empty";
  e.innerHTML = `<div class="empty__title">${escapeHtml(msg)}</div>`;
  return e;
}
function formatTimestamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
