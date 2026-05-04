// SPDX-License-Identifier: Apache-2.0
//
// Web UI entry. Handles bootstrap, auth, decryption, routing, and
// page rendering. Hash-based router so SPA refresh works on any path
// without server cooperation.

import { api, tokenStore, getOrCreateSessionId, ApiError } from "./api.js";
import { cryptoBackend, decryptField, decryptMany, unwrapKey, clearKeyCache } from "./crypto.js";
import { getState, setState, subscribe } from "./state.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderCharts } from "./pages/charts.js";
import { renderActivity } from "./pages/activity.js";
import { renderDevices } from "./pages/devices.js";

const PERIOD_LABELS = {
  today: "Today",
  "7d":  "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all:   "All time",
};
const ROUTES = {
  dashboard: { crumb: "Dashboard", render: renderDashboard, title: (p) => `${PERIOD_LABELS[p] ?? p}, at a glance` },
  charts:    { crumb: "Charts",    render: renderCharts,    title: (p) => `${PERIOD_LABELS[p] ?? p}, in pictures` },
  activity:  { crumb: "Activity",  render: renderActivity,  title: (p) => `${PERIOD_LABELS[p] ?? p}, in order` },
  devices:   { crumb: "Devices",   render: renderDevices,   title: () => "Devices & accounting" },
};

const SYNC_KEY_STORAGE = "vhs:sync-key"; // sessionStorage only

document.addEventListener("DOMContentLoaded", () => boot());

async function boot() {
  // Show server name on lock screen ASAP — hits unauthenticated endpoint.
  const serverNameEl = document.getElementById("lock-server-name");
  const backendSuffix = cryptoBackend === "noble" ? " · pure-js crypto" : "";
  api.serverInfo().then((info) => {
    if (info?.server_name) {
      serverNameEl.textContent = `${info.server_name} · v${info.version ?? "?"}${backendSuffix}`;
    }
  }).catch(() => {
    serverNameEl.textContent = `server unreachable${backendSuffix}`;
  });

  const tokens = tokenStore.get();
  const cachedKey = sessionStorage.getItem(SYNC_KEY_STORAGE);
  if (tokens?.access_token && cachedKey) {
    setState({ syncKey: cachedKey });
    showLock();
    const form = document.getElementById("lock-form");
    const submitBtn = form?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.dataset.loading = "true";
    const statusEl = form ? ensureLockStatus(form) : null;
    try {
      await loadEverything((msg) => { if (statusEl) statusEl.textContent = msg; });
      await tick();
      enterApp();
      return;
    } catch (err) {
      console.warn("[boot] cached session failed, falling back to lock:", err);
      if (submitBtn) submitBtn.dataset.loading = "false";
      if (statusEl) statusEl.textContent = "";
    }
    return;
  }

  showLock();
}

// Yield to the event loop so the browser can paint between heavy
// synchronous phases. Cheaper and more predictable than rAF for this.
function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function ensureLockStatus(form) {
  let el = form.querySelector(".lock__status");
  if (el) return el;
  el = document.createElement("div");
  el.className = "lock__status";
  form.appendChild(el);
  return el;
}

// — Lock screen —
function showLock() {
  document.getElementById("root").dataset.state = "locked";
  document.querySelector(".boot").style.display = "none";
  document.querySelector(".app").hidden = true;
  document.querySelector(".lock").hidden = false;

  const form = document.getElementById("lock-form");
  form.addEventListener("submit", onLockSubmit);
}

async function onLockSubmit(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const errEl = document.getElementById("lock-error");
  errEl.hidden = true; errEl.textContent = "";
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.dataset.loading = "true";
  submitBtn.disabled = true;

  try {
    const sessionId = getOrCreateSessionId();
    const session = await api.webLogin({
      email: data.email,
      password: data.password,
      session_id: sessionId,
    });
    tokenStore.set({
      access_token: session.accessToken ?? session.access_token,
      refresh_token: session.refreshToken ?? session.refresh_token,
      session_id: session.session_id,
    });

    // Fetch wrapped sync key
    const wrapped = await api.syncKey();
    if (!wrapped.has_key || !wrapped.encrypted_sync_key) {
      throw new Error("This account doesn't have a sync key on the server yet. Push from a desktop client first.");
    }
    const syncKey = await unwrapKey(wrapped.encrypted_sync_key, data.recovery);
    if (!syncKey) {
      throw new Error("Recovery code didn't match. Check Vetroscope → Settings → Sync → Recovery on the desktop app.");
    }
    sessionStorage.setItem(SYNC_KEY_STORAGE, syncKey);
    setState({ syncKey });

    const statusEl = ensureLockStatus(form);
    await loadEverything((msg) => { statusEl.textContent = msg; });
    await tick();
    enterApp();
  } catch (err) {
    let msg = "Couldn't unlock. Check your credentials and recovery code.";
    if (err instanceof ApiError) {
      if (err.status === 401) msg = "Email or password wasn't recognized.";
      else if (err.status === 403) msg = "Server is not accepting new sessions for this account.";
      else if (err.message) msg = err.message;
    } else if (err?.message) {
      msg = err.message;
    }
    errEl.textContent = msg;
    errEl.hidden = false;
  } finally {
    submitBtn.dataset.loading = "false";
    submitBtn.disabled = false;
  }
}

// — Data load —
async function loadEverything(onStatus = null) {
  onStatus?.("fetching profile…");
  const profile = await api.profile();
  onStatus?.("downloading snapshot…");
  const snapshot = await api.snapshot();

  const syncKey = getState().syncKey;

  // Tag names, marker labels, and goal app_names are encrypted with
  // the same sync key. Decrypt before indexing — decryptField is a
  // no-op for plaintext, so values that look like ciphertext get
  // unwrapped and everything else passes through unchanged.
  onStatus?.("decrypting metadata…");
  const rawTags = snapshot.tags ?? [];
  const tagNames = await decryptMany(rawTags.map((t) => t.name), syncKey);
  for (let i = 0; i < rawTags.length; i++) rawTags[i].name = tagNames[i];

  const rawMarkers = snapshot.markers ?? [];
  const markerLabels = await decryptMany(rawMarkers.map((m) => m.label), syncKey);
  for (let i = 0; i < rawMarkers.length; i++) rawMarkers[i].label = markerLabels[i];

  const rawGoals = snapshot.goals ?? [];
  const goalApps = await decryptMany(rawGoals.map((g) => g.app_name), syncKey);
  for (let i = 0; i < rawGoals.length; i++) rawGoals[i].app_name = goalApps[i];

  // ignored_apps / ignored_projects / ignored_breakdown_patterns come back
  // as encrypted JSON blobs. Decrypt + parse, then index as Sets (or keep
  // as an array for the pattern matcher) so per-entry filtering is fast.
  const ignoredApps = new Set();
  const ignoredProjects = new Set();
  let ignoredBreakdownPatterns = [];
  for (const setting of snapshot.settings ?? []) {
    if (!setting.value) continue;
    const plain = await decryptField(setting.value, syncKey);
    let list = null;
    try { list = JSON.parse(plain); } catch { /* not JSON — desktop wrote a raw value, skip */ }
    if (!Array.isArray(list)) continue;
    if (setting.key === "ignored_apps") for (const a of list) ignoredApps.add(a);
    else if (setting.key === "ignored_projects") for (const p of list) ignoredProjects.add(p);
    else if (setting.key === "ignored_breakdown_patterns") {
      ignoredBreakdownPatterns = list.filter(
        (p) => p && typeof p.appName === "string" && typeof p.pattern === "string" && p.pattern.length > 0,
      );
    }
  }

  const tagsById = new Map();
  for (const t of rawTags) tagsById.set(t.uuid, t);
  const iconsByHash = new Map();
  for (const i of snapshot.icons ?? []) iconsByHash.set(i.name_hash, i);
  const overridesByHash = new Map();
  for (const o of snapshot.overrides ?? []) overridesByHash.set(o.name_hash, o);

  const entries = snapshot.entries ?? [];

  // All three field types share a key cache, so kick them off
  // concurrently. WebCrypto can saturate the main thread on its own
  // — Promise.all here just hides the wall-clock cost of running
  // three sequential passes.
  const totals = { apps: 0, titles: 0, projects: 0 };
  const uniques = { apps: 0, titles: 0, projects: 0 };
  const reportProgress = () => {
    const totalU = uniques.apps + uniques.titles + uniques.projects;
    const totalC = totals.apps + totals.titles + totals.projects;
    if (totalU > 0) onStatus?.(`decrypting ${totalC.toLocaleString()} / ${totalU.toLocaleString()}…`);
  };

  const [apps, titles, projects] = await Promise.all([
    decryptMany(entries.map(e => e.app_name), syncKey, {
      onProgress: (c, u) => { totals.apps = c; uniques.apps = u; reportProgress(); },
    }),
    decryptMany(entries.map(e => e.window_title), syncKey, {
      onProgress: (c, u) => { totals.titles = c; uniques.titles = u; reportProgress(); },
    }),
    decryptMany(entries.map(e => e.project), syncKey, {
      onProgress: (c, u) => { totals.projects = c; uniques.projects = u; reportProgress(); },
    }),
  ]);

  onStatus?.(`indexing ${entries.length.toLocaleString()} entries…`);
  await tick();
  // Mutate in place — for prod-sized snapshots (~100k entries) the
  // {...e} spread allocates a fresh object per row and triples GC
  // pressure during render. Direct assignment is ~3× faster.
  for (let i = 0; i < entries.length; i++) {
    entries[i].app = apps[i];
    entries[i].title = titles[i];
    entries[i].project = projects[i];
  }
  const decrypted = entries;
  await tick();
  onStatus?.("rendering…");

  setState({
    user: profile.user,
    devices: snapshot.devices ?? [],
    tagsById,
    iconsByHash,
    overridesByHash,
    ignoredApps,
    ignoredProjects,
    ignoredBreakdownPatterns,
    snapshot,
    entries: decrypted,
    ready: true,
  });
}

// — App shell —
function enterApp() {
  document.getElementById("root").dataset.state = "unlocked";
  document.querySelector(".boot").style.display = "none";
  document.querySelector(".lock").hidden = true;
  document.querySelector(".app").hidden = false;

  attachShell();
  applyRouteFromHash();

  subscribe(() => render());
  render();
}

function attachShell() {
  const root = document.getElementById("root");
  // Sidebar collapse
  const collapseBtn = document.getElementById("sidebar-toggle");
  if (collapseBtn && !collapseBtn.dataset.bound) {
    collapseBtn.addEventListener("click", () => {
      const cur = root.dataset.collapsed === "true";
      root.dataset.collapsed = String(!cur);
      try { localStorage.setItem("vhs:collapsed", String(!cur)); } catch {}
    });
    collapseBtn.dataset.bound = "1";
    if (localStorage.getItem("vhs:collapsed") === "true") root.dataset.collapsed = "true";
  }

  // Mobile menu
  const ham = document.getElementById("hamburger");
  const backdrop = document.getElementById("backdrop");
  if (ham && !ham.dataset.bound) {
    ham.addEventListener("click", () => {
      const cur = root.dataset.mobileMenu === "open";
      root.dataset.mobileMenu = cur ? "closed" : "open";
      ham.setAttribute("aria-expanded", String(!cur));
    });
    backdrop?.addEventListener("click", () => {
      root.dataset.mobileMenu = "closed";
      ham.setAttribute("aria-expanded", "false");
    });
    ham.dataset.bound = "1";
  }

  // Period picker
  const periodEl = document.getElementById("period");
  if (periodEl && !periodEl.dataset.bound) {
    periodEl.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-period]");
      if (!btn) return;
      const period = btn.dataset.period;
      setState({ period });
      for (const b of periodEl.querySelectorAll("button")) {
        b.classList.toggle("is-active", b.dataset.period === period);
      }
    });
    periodEl.dataset.bound = "1";
  }

  // Refresh
  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.style.opacity = "0.4";
      try { await loadEverything(); } finally { refreshBtn.style.opacity = ""; }
    });
    refreshBtn.dataset.bound = "1";
  }

  // Logout
  const logoutBtn = document.getElementById("logout");
  if (logoutBtn && !logoutBtn.dataset.bound) {
    logoutBtn.addEventListener("click", async () => {
      try { await api.logout(); } catch {}
      tokenStore.clear();
      sessionStorage.removeItem(SYNC_KEY_STORAGE);
      clearKeyCache();
      location.hash = "";
      location.reload();
    });
    logoutBtn.dataset.bound = "1";
  }

  // Hash routing
  if (!window.__vhs_hashbound) {
    window.addEventListener("hashchange", applyRouteFromHash);
    window.__vhs_hashbound = true;
  }
  // Activity-page re-render on filter change
  if (!window.__vhs_refreshbound) {
    window.addEventListener("vhs:refresh-page", () => render());
    window.__vhs_refreshbound = true;
  }

  // Close mobile menu when clicking a link
  document.querySelectorAll(".sidebar__nav a").forEach((a) => {
    a.addEventListener("click", () => {
      root.dataset.mobileMenu = "closed";
    });
  });
}

function applyRouteFromHash() {
  const hash = location.hash.replace(/^#\/?/, "").split("/")[0];
  const route = ROUTES[hash] ? hash : "dashboard";
  setState({ route });
}

// — Render —
function render() {
  const state = getState();
  if (!state.ready) return;
  try {
    return renderInner(state);
  } catch (err) {
    console.error("[render] failed:", err);
    const page = document.getElementById("page");
    if (page) {
      page.innerHTML = `<div class="empty"><div class="empty__title">Render error</div><div class="empty__sub">${(err && err.stack) ? String(err.stack).split("\n").slice(0, 4).join("<br>") : String(err)}</div></div>`;
    }
  }
}

function renderInner(state) {

  // sidebar plan badge + identity
  const planEl = document.getElementById("sidebar-plan");
  if (planEl && state.user) planEl.textContent = (state.user.plan === "home" ? "Home" : state.user.plan);
  const meName = document.getElementById("me-name");
  const meEmail = document.getElementById("me-email");
  const meAvatar = document.getElementById("me-avatar");
  if (state.user) {
    meName.textContent = state.user.display_name || "—";
    meEmail.textContent = state.user.email || "";
    meAvatar.textContent = (state.user.display_name || state.user.email || "·").trim().slice(0, 1).toUpperCase();
  }

  // sidebar devices — hide platform=web rows. Web sessions don't push
  // data; they're viewers, not sync sources. Show them on the Devices
  // page where management lives, not in the persistent sidebar.
  const devicesEl = document.getElementById("sidebar-devices");
  const sidebarDevices = state.devices.filter((d) => d.platform !== "web");
  if (devicesEl) {
    devicesEl.innerHTML = "";
    if (sidebarDevices.length === 0) {
      devicesEl.innerHTML = `<li class="devices__empty">no devices yet</li>`;
    } else {
      for (const d of sidebarDevices) {
        const li = document.createElement("li");
        li.className = "devices__row";
        li.innerHTML = `
          <span class="devices__platform" data-p="${escapeAttr(d.platform)}"></span>
          <span class="devices__name">${escapeHtml(d.device_name)}</span>
          <span class="devices__meta">${d.last_sync_at ? relativeTime(d.last_sync_at) : "—"}</span>
        `;
        devicesEl.appendChild(li);
      }
    }
  }

  // active nav
  document.querySelectorAll(".navlink").forEach((a) => {
    a.classList.toggle("is-active", a.dataset.route === state.route);
  });

  // topbar
  const route = ROUTES[state.route];
  const head = document.getElementById("topbar-head");
  const crumb = document.getElementById("topbar-crumb");
  if (head) head.textContent = typeof route.title === "function" ? route.title(state.period) : route.title;
  if (crumb) crumb.textContent = route.crumb;

  // page
  const page = document.getElementById("page");
  route.render(page, state);
  appendLoadMore(page, state);
}

// — Load older entries —
// Only renders when the most recent snapshot was truncated. Hits
// /web/snapshot?before=<oldest> with a fresh ID, then merges the new
// rows into state.entries (deduped by uuid), decrypts them, re-renders.
function appendLoadMore(page, state) {
  if (!state.snapshot?.truncated) return;
  if (page.querySelector("[data-load-more]")) return;
  const oldest = state.snapshot.oldest_timestamp;
  if (!oldest) return;

  const wrap = document.createElement("div");
  wrap.dataset.loadMore = "1";
  wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px;padding:36px 0 8px;border-top:1px solid var(--hairline);margin-top:32px;";
  wrap.innerHTML = `
    <span style="font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-tertiary);">Older entries available</span>
    <button class="btn btn--ghost" data-load-more-btn>
      <span class="btn__label">Load older entries</span>
      <span class="btn__spinner" aria-hidden="true"></span>
    </button>
    <span style="font-size:11px;color:var(--text-tertiary);font-variant-numeric:tabular-nums;" data-load-more-count>showing ${state.entries.length.toLocaleString()} entries (oldest: ${formatDate(oldest)})</span>
  `;
  const btn = wrap.querySelector("[data-load-more-btn]");
  btn.addEventListener("click", () => loadOlder(btn, wrap));
  page.appendChild(wrap);
}

function formatDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function loadOlder(btn, wrap) {
  const state = getState();
  const oldest = state.snapshot?.oldest_timestamp;
  if (!oldest) return;
  btn.dataset.loading = "true";
  btn.disabled = true;
  try {
    const next = await api.snapshot({ before: oldest });
    const newEntries = next.entries ?? [];
    if (newEntries.length === 0) {
      wrap.innerHTML = `<span style="font-size:11px;color:var(--text-tertiary);">no older entries</span>`;
      return;
    }
    const apps = await decryptMany(newEntries.map((e) => e.app_name), state.syncKey);
    const titles = await decryptMany(newEntries.map((e) => e.window_title), state.syncKey);
    const projects = await decryptMany(newEntries.map((e) => e.project), state.syncKey);
    for (let i = 0; i < newEntries.length; i++) {
      newEntries[i].app = apps[i];
      newEntries[i].title = titles[i];
      newEntries[i].project = projects[i];
    }

    // Merge: drop dupes by uuid, sort timestamp DESC.
    const seen = new Set(state.entries.map((e) => e.uuid));
    const additions = newEntries.filter((e) => !seen.has(e.uuid));
    const merged = state.entries.concat(additions);
    merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    setState({
      entries: merged,
      snapshot: {
        ...state.snapshot,
        truncated: next.truncated,
        oldest_timestamp: next.oldest_timestamp ?? state.snapshot.oldest_timestamp,
      },
    });
  } catch (err) {
    console.error("[load-more] failed:", err);
    wrap.querySelector("[data-load-more-count]")?.replaceChildren(
      document.createTextNode(`error: ${err?.message ?? err}`),
    );
  } finally {
    btn.dataset.loading = "false";
    btn.disabled = false;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h`;
  return `${Math.floor(diff/86400)}d`;
}
