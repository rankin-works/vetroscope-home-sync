// SPDX-License-Identifier: Apache-2.0
//
// Thin fetch wrapper. Handles bearer auth, automatic refresh on 401,
// and surfacing structured server errors. Same origin in Home Sync —
// in the cloud build this would point at app.vetroscope.com's API.

const TOKEN_KEY = "vhs:tokens";
const API_BASE = ""; // same origin

export const tokenStore = {
  get() {
    try {
      return JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? "null");
    } catch { return null; }
  },
  set(tokens) {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  },
  clear() {
    sessionStorage.removeItem(TOKEN_KEY);
  },
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code ?? `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function refreshIfPossible() {
  const tokens = tokenStore.get();
  if (!tokens?.refresh_token) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    if (!res.ok) return false;
    const next = await res.json();
    tokenStore.set({
      access_token: next.accessToken ?? next.access_token,
      refresh_token: next.refreshToken ?? next.refresh_token,
      device_id: next.device_id ?? tokens.device_id,
    });
    return true;
  } catch {
    return false;
  }
}

async function request(path, init = {}, retry = true) {
  const tokens = tokenStore.get();
  const headers = {
    "Accept": "application/json",
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(tokens?.access_token ? { Authorization: `Bearer ${tokens.access_token}` } : {}),
    ...(init.headers ?? {}),
  };
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    body: init.body !== undefined && typeof init.body !== "string"
      ? JSON.stringify(init.body) : init.body,
  });
  if (res.status === 401 && retry) {
    const refreshed = await refreshIfPossible();
    if (refreshed) return request(path, init, false);
  }
  let parsed = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    parsed = await res.json().catch(() => null);
  }
  if (!res.ok) {
    throw new ApiError(res.status, parsed?.error, parsed?.message);
  }
  return parsed;
}

export const api = {
  serverInfo: () => request("/server-info"),
  webLogin: (body) => request("/auth/web-login", { method: "POST", body }),
  logout: () => request("/auth/logout", { method: "POST" }),
  profile: () => request("/user/profile"),
  syncKey: () => request("/user/sync-key"),
  snapshot: ({ since, before } = {}) => {
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    if (before) q.set("before", before);
    const qs = q.toString();
    return request(`/web/snapshot${qs ? `?${qs}` : ""}`);
  },
  removeDevice: (id) => request(`/user/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export { ApiError };

// Stable per-browser session id. Sent to /auth/web-login so refresh
// rotations between tabs of the same browser don't kick each other.
// Stored in localStorage (not session) so a page reload reuses the
// same id and shares one refresh-token slot. Web sessions do *not*
// register a row in the devices table — this id only identifies a
// session for refresh-token bookkeeping.
const SESSION_KEY = "vhs:web-session-id";
export function getOrCreateSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `web-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}
