// SPDX-License-Identifier: Apache-2.0
//
// Calendar copies: the first-store fill, the link calls and their claims,
// tombstone and restore moves, the lease gate, the vault PUT in links mode,
// targets, reset and tenant isolation.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedGoogleId } from "../lib/calendar-links.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

const LINKS = ["google", "links", "outlook"];
const OLD = ["google", "outlook"];
const CAL_A = "cal-a@group.calendar.google.com";
const CAL_B = "cal-b@group.calendar.google.com";
const CAL_C = "cal-c@group.calendar.google.com";
const CAL_X = "cal-x@group.calendar.google.com";

interface Device {
  token: string;
  deviceId: string;
  userId: string;
}

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

async function call(
  d: Device,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: Record<string, unknown>,
) {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${d.token}` },
    ...(payload ? { payload } : {}),
  });
}

async function admin(): Promise<Device> {
  const a = await bootstrapAdmin(h);
  return { token: a.accessToken, deviceId: a.deviceId, userId: a.userId };
}

async function secondDevice(name = "Second Mac"): Promise<Device> {
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "admin@test.lan",
      password: "hunter2hunter2",
      device_name: name,
      platform: "darwin",
    },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { accessToken: string; device_id: string; user: { id: string } };
  return { token: body.accessToken, deviceId: body.device_id, userId: body.user.id };
}

async function otherUser(adminDev: Device): Promise<Device> {
  const invite = await call(adminDev, "POST", "/admin/invites", {});
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: "other@test.lan",
      password: "hunter2hunter2",
      display_name: "Other",
      device_name: "Other PC",
      platform: "win32",
      invite_token: (invite.json() as { token: string }).token,
    },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { accessToken: string; device_id: string; user: { id: string } };
  return { token: body.accessToken, deviceId: body.device_id, userId: body.user.id };
}

function account(
  email: string,
  calendarIds: string[],
  exportCalendarId: string | null = null,
  direction = "both",
) {
  return { email, refresh_token: `rt-${email}`, calendarIds, exportCalendarId, direction };
}

function putVault(d: Device, accounts: unknown[], extra: Record<string, unknown> = {}) {
  return call(d, "PUT", "/user/google-calendar-accounts", { accounts, ...extra });
}

function lease(d: Device, providers?: string[], extra: Record<string, unknown> = {}) {
  return call(d, "POST", "/user/google-calendar-leader", {
    ...(providers ? { providers } : {}),
    ...extra,
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

function marker(uuid: string, over: Record<string, unknown> = {}) {
  const now = iso(Date.now());
  return {
    uuid,
    timestamp: now,
    end_timestamp: null,
    label: "enc-label",
    color: "#f59e0b",
    icon: "flag",
    deleted: 0,
    origin: "vetroscope",
    repeat_rule: null,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function push(d: Device, markers: unknown[]) {
  return call(d, "POST", "/sync/push", { markers });
}

/** A later updated_at, so the push wins last-write-wins. */
let tick = 1;
function later(): string {
  return iso(Date.now() + 1000 * tick++);
}

interface Row {
  marker_uuid: string;
  calendar_id: string;
  state: string;
  reason: string;
  gen: number;
  event_id: string | null;
  seq: number;
  ever_claimed: number;
  claim_until: string | null;
  account_ref: string | null;
}

function rows(userId: string, uuid?: string): Row[] {
  return h.db
    .prepare(
      `SELECT * FROM sync_marker_links WHERE user_id = ? ${uuid ? "AND marker_uuid = ?" : ""}
        ORDER BY marker_uuid, calendar_id`,
    )
    .all(...(uuid ? [userId, uuid] : [userId])) as Row[];
}

function row(userId: string, uuid: string, calendarId: string): Row | undefined {
  return rows(userId, uuid).find((r) => r.calendar_id === calendarId);
}

const key = (uuid: string, calendar_id: string, provider = "google") => ({
  marker_uuid: uuid,
  provider,
  calendar_id,
});

/** A user in links mode: one account with three ticked calendars, A the
 *  starting target (its exportCalendarId), and `on` switched on too. */
async function linksUser(on: string[] = []): Promise<Device> {
  const d = await admin();
  expect((await putVault(d, [account("me@gmail.com", [CAL_A, CAL_B, CAL_C], CAL_A)])).statusCode).toBe(200);
  const claim = await lease(d, LINKS);
  expect(claim.json()).toMatchObject({ claimed: true, links_mode: true });
  for (const c of on) {
    const res = await call(d, "PUT", "/user/calendar-targets", {
      provider: "google",
      account: "me@gmail.com",
      calendarId: c,
      enabled: true,
      rev: 0,
    });
    expect(res.statusCode).toBe(200);
  }
  // Switched on just now; events made "now" must count as after it.
  h.db.prepare("UPDATE calendar_targets SET on_since = ?").run(iso(Date.now() - 60_000));
  return d;
}

async function claim(d: Device, extra: Record<string, unknown> = {}) {
  const res = await call(d, "POST", "/user/calendar-links/claim", { limit: 50, ...extra });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    rows: Array<Row & { claim_token: string }>;
    serverNow: string;
  };
}

describe("first store", () => {
  it("writes pending per valid enabled target, once", async () => {
    const d = await linksUser([CAL_B]);
    expect((await push(d, [marker("m1")])).statusCode).toBe(200);
    expect(rows(d.userId, "m1").map((r) => [r.calendar_id, r.state, r.reason])).toEqual([
      [CAL_A, "pending", "target"],
      [CAL_B, "pending", "target"],
    ]);
    const seqs = rows(d.userId, "m1").map((r) => r.seq);
    expect(new Set(seqs).size).toBe(2);

    // A re-push of a stored event writes none, even after a new switch.
    await call(d, "PUT", "/user/calendar-targets", {
      provider: "google", account: "me@gmail.com", calendarId: CAL_C, enabled: true, rev: 0,
    });
    await push(d, [marker("m1", { updated_at: later() })]);
    expect(rows(d.userId, "m1")).toHaveLength(2);
  });

  it("skips imported, repeating, deleted, null created_at, old and switched-on-later events", async () => {
    const d = await linksUser();
    const old = iso(Date.now() - 8 * 24 * 3600 * 1000);
    await push(d, [
      marker("imp", { origin: "google" }),
      marker("noorigin", { origin: undefined }),
      marker("rep", { repeat_rule: "weekly" }),
      marker("del", { deleted: 1 }),
      marker("nul", { created_at: null }),
      marker("old", { created_at: old }),
    ]);
    expect(rows(d.userId)).toEqual([]);

    // Made before the calendar was switched on.
    h.db.prepare("UPDATE calendar_targets SET on_since = ?").run(iso(Date.now() + 3600_000));
    await push(d, [marker("before", { created_at: iso(Date.now() - 3600_000) })]);
    expect(rows(d.userId)).toEqual([]);
  });

  it("treats a creation time under ten minutes ago as now", async () => {
    const d = await linksUser();
    h.db.prepare("UPDATE calendar_targets SET on_since = ?").run(iso(Date.now() - 2 * 60_000));
    // Five minutes ago (skewed clock), before on_since: still counts as now.
    await push(d, [marker("skew", { created_at: iso(Date.now() - 5 * 60_000) })]);
    expect(rows(d.userId, "skew")).toHaveLength(1);
    const stored = h.db.prepare("SELECT created_at FROM sync_markers WHERE uuid = 'skew'").get() as { created_at: string };
    expect(Date.now() - Date.parse(stored.created_at)).toBeLessThan(60_000);
  });

  it("an older client without created_at: only recent events", async () => {
    const d = await linksUser();
    const noKey = (uuid: string, over: Record<string, unknown> = {}) => {
      const m = marker(uuid, over) as Record<string, unknown>;
      delete m.created_at;
      return m;
    };
    await push(d, [
      noKey("fresh"),
      noKey("stale", { updated_at: iso(Date.now() - 49 * 3600_000) }),
      noKey("sent", { google_event_id: "abc" }),
    ]);
    expect(rows(d.userId).map((r) => r.marker_uuid)).toEqual(["fresh"]);
  });

  it("writes none outside links mode", async () => {
    const d = await admin();
    await putVault(d, [account("me@gmail.com", [CAL_A], CAL_A)]);
    await lease(d, OLD);
    await push(d, [marker("m1")]);
    expect(rows(d.userId)).toEqual([]);
  });

  it("carries origin / repeat_rule through pull and keeps them when a push has no key", async () => {
    const d = await linksUser();
    await push(d, [marker("m1", { repeat_rule: "" })]);
    const m = marker("m1", { updated_at: later() }) as Record<string, unknown>;
    delete m.origin;
    delete m.repeat_rule;
    delete m.created_at;
    await push(d, [m]);
    const pull = await call(d, "POST", "/sync/pull", { cursor: null, device_id: "x" });
    const pulled = (pull.json().markers as Array<Record<string, unknown>>).find((x) => x.uuid === "m1")!;
    expect(pulled.origin).toBe("vetroscope");
    expect(pulled.repeat_rule).toBe("");
    expect(typeof pulled.created_at).toBe("string");
  });
});

describe("claims", () => {
  it("are exclusive, come back to their holder, expire, and take no seq", async () => {
    const a = await linksUser();
    const b = await secondDevice();
    await lease(b, LINKS, { declare: true });
    await push(a, [marker("m1")]);
    const seqBefore = row(a.userId, "m1", CAL_A)!.seq;

    const first = await claim(a);
    expect(first.rows.map((r) => r.calendar_id)).toEqual([CAL_A]);
    expect((await claim(b)).rows).toEqual([]);
    // The holder asking again (a lost answer) gets its claim back.
    const again = await claim(a);
    expect(again.rows[0]!.claim_token).toBe(first.rows[0]!.claim_token);
    expect(row(a.userId, "m1", CAL_A)!.seq).toBe(seqBefore);

    h.db.prepare("UPDATE sync_marker_links SET claim_until = ?").run(iso(Date.now() - 1000));
    const taken = await claim(b);
    expect(taken.rows).toHaveLength(1);
    expect(taken.rows[0]!.claim_token).not.toBe(first.rows[0]!.claim_token);
  });

  it("a removed device's claim counts as expired", async () => {
    const a = await linksUser();
    const b = await secondDevice();
    await lease(b, LINKS, { declare: true });
    await push(a, [marker("m1")]);
    expect((await claim(b)).rows).toHaveLength(1);
    expect((await call(a, "DELETE", `/user/devices/${b.deviceId}`)).statusCode).toBe(200);
    expect(h.db.prepare("SELECT 1 FROM calendar_devices WHERE device_id = ?").get(b.deviceId)).toBeUndefined();
    expect((await claim(a)).rows).toHaveLength(1);
  });

  it("renew extends, unclaim frees at once", async () => {
    const a = await linksUser();
    const b = await secondDevice();
    await lease(b, LINKS, { declare: true });
    await push(a, [marker("m1")]);
    const c = (await claim(a)).rows[0]!;
    const renew = await call(a, "POST", "/user/calendar-links/renew", { key: key("m1", CAL_A), claim_token: c.claim_token });
    expect(renew.json().ok).toBe(true);
    expect(Date.parse(renew.json().claim_until)).toBeGreaterThan(Date.now() + 4 * 60_000);
    const wrong = await call(a, "POST", "/user/calendar-links/renew", { key: key("m1", CAL_A), claim_token: "nope" });
    expect(wrong.json()).toMatchObject({ ok: false, row: { state: "pending" } });

    expect((await call(a, "POST", "/user/calendar-links/unclaim", { key: key("m1", CAL_A), claim_token: c.claim_token })).json()).toEqual({ ok: true });
    expect((await claim(b)).rows).toHaveLength(1);
  });

  it("only the keys asked for", async () => {
    const a = await linksUser();
    await push(a, [marker("m1"), marker("m2")]);
    const res = await claim(a, { keys: [key("m2", CAL_A)] });
    expect(res.rows.map((r) => r.marker_uuid)).toEqual(["m2"]);
  });

  it("expire stale pending rows: gone if never claimed, deleting if claimed", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1")]);
    await claim(a, { keys: [key("m1", CAL_B)] });
    const old = iso(Date.now() - 8 * 24 * 3600_000);
    h.db.prepare("UPDATE sync_markers SET created_at = ?").run(old);
    h.db.prepare("UPDATE sync_marker_links SET created_at = ?, updated_at = ?, claim_until = ?").run(old, old, iso(Date.now() - 1));
    await claim(a);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "gone", reason: "expired" });
    expect(row(a.userId, "m1", CAL_B)).toMatchObject({ state: "deleting", reason: "expired", event_id: null });
  });

  it("skip pending rows whose calendar can't take events now", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    // Unticked, and not a legacy_send target.
    await putVault(a, [account("me@gmail.com", [CAL_B, CAL_C], CAL_A)]);
    expect((await claim(a)).rows).toEqual([]);
  });
});

describe("complete", () => {
  it("links the copy, stores gen when >=, and works past claim_until while the token matches", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    const c = (await claim(a)).rows[0]!;
    h.db.prepare("UPDATE sync_marker_links SET claim_until = ?").run(iso(Date.now() - 1000));
    const res = await call(a, "POST", "/user/calendar-links/complete", {
      key: key("m1", CAL_A), claim_token: c.claim_token, gen: 1, event_id: "ev1", etag: "e1", pushed_hash: "h1",
    });
    expect(res.json()).toMatchObject({ ok: true, state: "linked", row: { state: "linked", event_id: "ev1", gen: 1 } });
    expect(row(a.userId, "m1", CAL_A)!.claim_until).toBeNull();
  });

  it("misses on a lost claim and answers then: delete on a deleted event", async () => {
    const a = await linksUser([CAL_B]);
    const b = await secondDevice();
    await lease(b, LINKS, { declare: true });
    await push(a, [marker("m1")]);
    const mine = (await claim(a)).rows;
    h.db.prepare("UPDATE sync_marker_links SET claim_until = ?").run(iso(Date.now() - 1000));
    await claim(b);
    const lost = await call(a, "POST", "/user/calendar-links/complete", {
      key: key("m1", CAL_A), claim_token: mine[0]!.claim_token, gen: 0, event_id: "evA",
    });
    expect(lost.json()).toMatchObject({ ok: false, row: { state: "pending" } });

    // b's claimed rows: the event is deleted meanwhile.
    const bRows = (await claim(b)).rows;
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "deleting", reason: "cancelled" });
    const late = await call(b, "POST", "/user/calendar-links/complete", {
      key: key("m1", CAL_A), claim_token: bRows.find((r) => r.calendar_id === CAL_A)!.claim_token, gen: 0, event_id: "evA",
    });
    expect(late.json()).toMatchObject({ ok: true, then: "delete", row: { state: "deleting", event_id: "evA" } });
  });

  it("records released when the account behind the copy is gone, detached with found_cancelled", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1")]);
    const [ca, cb] = (await claim(a)).rows;
    const ref = ca!.account_ref;
    const done = await call(a, "POST", "/user/calendar-links/complete", {
      key: key("m1", CAL_B), claim_token: cb!.claim_token, gen: 0, event_id: "evB", found_cancelled: true,
    });
    expect(done.json()).toMatchObject({ ok: true, state: "detached" });
    h.db.prepare("UPDATE google_calendar_accounts SET deleted = 1").run();
    const gone = await call(a, "POST", "/user/calendar-links/complete", {
      key: key("m1", CAL_A), claim_token: ca!.claim_token, gen: 0, event_id: "evA", account_ref: ref,
    });
    expect(gone.json()).toMatchObject({ ok: true, state: "released" });
  });
});

/** Creates and links copies of `uuid` in the given calendars. */
async function linkAll(d: Device, uuid: string) {
  const claimed = (await claim(d)).rows.filter((r) => r.marker_uuid === uuid);
  for (const c of claimed) {
    const res = await call(d, "POST", "/user/calendar-links/complete", {
      key: key(uuid, c.calendar_id), claim_token: c.claim_token, gen: c.gen,
      event_id: fixedGoogleId(uuid, c.calendar_id, c.gen), etag: "e0",
    });
    expect(res.json().state).toBe("linked");
  }
}

describe("tombstone and restore", () => {
  it("a 3-copy delete gives 3 seqs and a seq > ? pull returns them all", async () => {
    const a = await linksUser([CAL_B, CAL_C]);
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const before = Math.max(...rows(a.userId).map((r) => r.seq));
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    const after = rows(a.userId, "m1");
    expect(after.map((r) => r.state)).toEqual(["deleting", "deleting", "deleting"]);
    expect(new Set(after.map((r) => r.seq)).size).toBe(3);

    const pull = await call(a, "POST", "/sync/pull", { cursor: null, device_id: "x", seq_cursors: { marker_links: before } });
    const pulled = pull.json().marker_links as Array<{ calendar_id: string; state: string; claim_token?: unknown }>;
    expect(pulled.map((p) => p.calendar_id).sort()).toEqual([CAL_A, CAL_B, CAL_C]);
    expect(pulled[0]).not.toHaveProperty("claim_token");
    expect(pull.json().seq_cursors.marker_links).toBe(Math.max(...after.map((r) => r.seq)));
  });

  it("a delete that lost last-write-wins moves nothing", async () => {
    const a = await linksUser();
    await push(a, [marker("m1", { updated_at: later() })]);
    await linkAll(a, "m1");
    await push(a, [marker("m1", { deleted: 1, updated_at: iso(Date.now() - 3600_000) })]);
    expect(row(a.userId, "m1", CAL_A)!.state).toBe("linked");
  });

  it("pending rows: gone if never claimed, deleting if ever claimed; kept copies stay", async () => {
    const a = await linksUser([CAL_B, CAL_C]);
    await push(a, [marker("m1")]);
    const c = (await claim(a)).rows;
    await call(a, "POST", "/user/calendar-links/complete", {
      key: key("m1", CAL_C), claim_token: c.find((r) => r.calendar_id === CAL_C)!.claim_token, gen: 0, event_id: "evC", found_cancelled: true,
    });
    await call(a, "POST", "/user/calendar-links/unclaim", { key: key("m1", CAL_B), claim_token: c.find((r) => r.calendar_id === CAL_B)!.claim_token });
    h.db.prepare("UPDATE sync_marker_links SET ever_claimed = 0 WHERE calendar_id = ?").run(CAL_A);
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "gone", reason: "cancelled" });
    expect(row(a.userId, "m1", CAL_B)).toMatchObject({ state: "deleting", reason: "cancelled", event_id: null });
    expect(row(a.userId, "m1", CAL_C)).toMatchObject({ state: "detached" });
  });

  it("restore: unsent delete back to linked; a claimed one restarts with gen + 1 and a late deleted is a no-op", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    const del = (await claim(a, { keys: [key("m1", CAL_B)] })).rows[0]!;
    await push(a, [marker("m1", { deleted: 0, updated_at: later() })]);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "linked" });
    expect(row(a.userId, "m1", CAL_B)).toMatchObject({ state: "pending", reason: "restore", gen: 1, event_id: null });
    const late = await call(a, "POST", "/user/calendar-links/deleted", { key: key("m1", CAL_B), claim_token: del.claim_token });
    expect(late.json()).toMatchObject({ ok: false, row: { state: "pending" } });
  });

  it("restore brings back gone/deleted rows in the same calendars only", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    const del = (await claim(a)).rows[0]!;
    expect((await call(a, "POST", "/user/calendar-links/deleted", { key: key("m1", CAL_A), claim_token: del.claim_token })).json())
      .toMatchObject({ ok: true, row: { state: "gone", reason: "deleted" } });
    await call(a, "PUT", "/user/calendar-targets", { provider: "google", account: "me@gmail.com", calendarId: CAL_B, enabled: true, rev: 0 });
    await push(a, [marker("m1", { deleted: 0, updated_at: later() })]);
    expect(rows(a.userId, "m1").map((r) => [r.calendar_id, r.state, r.gen])).toEqual([[CAL_A, "pending", 1]]);
  });

  it("the claim backstop moves a linked row of a deleted event", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    h.db.prepare("UPDATE sync_markers SET deleted = 1").run();
    const c = await claim(a);
    expect(c.rows.map((r) => r.state)).toEqual(["deleting"]);
  });
});

describe("attach, ack, remote removal and resolve", () => {
  it("adopts an unknown copy, never a detached / released / gone row, and the event index refuses a second row", async () => {
    const a = await linksUser();
    await push(a, [marker("m1"), marker("m2", { origin: "google" })]);
    const res = await call(a, "POST", "/user/calendar-links/attach", { key: key("m2", CAL_B), role: "source", event_id: "imp1" });
    expect(res.json()).toMatchObject({ ok: true, row: { state: "linked", reason: "adopted", role: "source" } });
    // Another marker can't take the same event in that calendar.
    const twice = await call(a, "POST", "/user/calendar-links/attach", { key: key("m1", CAL_B), event_id: "imp1" });
    expect(twice.json().ok).toBe(false);
    expect(row(a.userId, "m1", CAL_B)).toBeUndefined();

    for (const [state, reason] of [["detached", "kept"], ["released", "kept"], ["gone", "deleted"]]) {
      h.db.prepare("UPDATE sync_marker_links SET state = ?, reason = ? WHERE marker_uuid = 'm2'").run(state, reason);
      const again = await call(a, "POST", "/user/calendar-links/attach", { key: key("m2", CAL_B), role: "source", event_id: "imp2" });
      expect(again.json()).toMatchObject({ ok: false, row: { state } });
    }
  });

  it("takes back its own late copy against a gone/target_off row only by its fixed id, in a calendar that is on", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    h.db.prepare("UPDATE sync_marker_links SET state = 'gone', reason = 'target_off'").run();
    const other = await call(a, "POST", "/user/calendar-links/attach", { key: key("m1", CAL_A), event_id: "random" });
    expect(other.json().ok).toBe(false);
    const own = await call(a, "POST", "/user/calendar-links/attach", { key: key("m1", CAL_A), event_id: fixedGoogleId("m1", CAL_A, 0) });
    expect(own.json()).toMatchObject({ ok: true, row: { state: "linked" } });
  });

  it("a moved event releases the old row, including one already removed_remote", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const id = fixedGoogleId("m1", CAL_A, 0);
    await call(a, "POST", "/user/calendar-links/remote-removed", { key: key("m1", CAL_A), event_id: id });
    expect(row(a.userId, "m1", CAL_A)!.state).toBe("removed_remote");
    const res = await call(a, "POST", "/user/calendar-links/attach", { key: key("m1", CAL_B), event_id: id });
    expect(res.json()).toMatchObject({ ok: true, moved: 1, row: { state: "linked", calendar_id: CAL_B } });
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "released", reason: "moved" });
  });

  it("ack needs the etag the PATCH started from", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const id = fixedGoogleId("m1", CAL_A, 0);
    const ok = await call(a, "POST", "/user/calendar-links/ack", { key: key("m1", CAL_A), event_id: id, from_etag: "e0", etag: "e1", pushed_hash: "h1" });
    expect(ok.json()).toMatchObject({ ok: true, row: { etag: "e1", pushed_hash: "h1" } });
    const stale = await call(a, "POST", "/user/calendar-links/ack", { key: key("m1", CAL_A), event_id: id, from_etag: "e0", etag: "e2" });
    expect(stale.json()).toMatchObject({ ok: false, row: { etag: "e1" } });
  });

  it("resolve: keep detaches, put_back starts gen + 1", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    for (const c of [CAL_A, CAL_B]) {
      await call(a, "POST", "/user/calendar-links/remote-removed", { key: key("m1", c), event_id: fixedGoogleId("m1", c, 0) });
    }
    await call(a, "POST", "/user/calendar-links/resolve", { key: key("m1", CAL_A), choice: "keep" });
    await call(a, "POST", "/user/calendar-links/resolve", { key: key("m1", CAL_B), choice: "put_back" });
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "detached" });
    expect(row(a.userId, "m1", CAL_B)).toMatchObject({ state: "pending", reason: "undo", gen: 1 });
  });
});

describe("drop", () => {
  it("answers ok only under each why's rule", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const drop = (body: Record<string, unknown>) =>
      call(a, "POST", "/user/calendar-links/drop", { provider: "google", marker_uuid: "m1", ...body }).then((r) => r.json().ok);

    // The keeper itself is held: never.
    expect(await drop({ calendar_id: CAL_A, event_id: fixedGoogleId("m1", CAL_A, 0), why: "duplicate" })).toBe(false);
    // A second copy in a calendar whose row names another event.
    expect(await drop({ calendar_id: CAL_A, event_id: "dupe", why: "duplicate" })).toBe(true);
    // A duplicate needs a row; none in B.
    expect(await drop({ calendar_id: CAL_B, event_id: "x", why: "duplicate" })).toBe(false);
    // Own: no row holds it.
    expect(await drop({ calendar_id: CAL_B, event_id: "x", why: "own" })).toBe(true);

    // Stray: no row, calendar not switched on, made after links mode.
    const created = iso(Date.now());
    expect(await drop({ calendar_id: CAL_X, event_id: "s1", why: "stray", created })).toBe(true);
    expect(row(a.userId, "m1", CAL_X)).toMatchObject({ state: "gone", reason: "stray", event_id: "s1" });
    // In a switched-on calendar with no row: refused.
    await push(a, [marker("m2", { created_at: null })]);
    expect(await drop({ marker_uuid: "m2", calendar_id: CAL_A, event_id: "s2", why: "stray", created })).toBe(false);
    // An event made before links mode: refused.
    h.db.prepare("UPDATE sync_markers SET created_at = ? WHERE uuid = 'm1'").run(iso(Date.now() - 3600_000));
    h.db.prepare("UPDATE calendar_links_state SET links_mode_at = ?").run(iso(Date.now() - 1800_000));
    expect(await drop({ calendar_id: CAL_C, event_id: "s3", why: "stray", created })).toBe(false);
  });

  it("never lets a kept copy be deleted", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    h.db.prepare("UPDATE sync_marker_links SET state = 'detached'").run();
    const res = await call(a, "POST", "/user/calendar-links/drop", {
      provider: "google", marker_uuid: "m1", calendar_id: CAL_A, event_id: fixedGoogleId("m1", CAL_A, 0), why: "own",
    });
    expect(res.json().ok).toBe(false);
  });
});

describe("adopt-local, known and disconnect-start", () => {
  it("adopt-local never overwrites and marks the epoch adopted on the last call", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    const res = await call(a, "POST", "/user/calendar-links/adopt-local", {
      rows: [
        { ...key("m1", CAL_A), role: "copy", state: "linked", reason: "migrated", event_id: "e-local" },
        { ...key("m9", CAL_B), role: "copy", state: "detached", reason: "kept", event_id: "e-kept" },
        { ...key("m8", CAL_B), role: "copy", state: "linked", reason: "migrated", event_id: "e-kept" },
        { ...key("m7", CAL_B, "outlook"), role: "copy", state: "linked", reason: "migrated" },
      ],
      last: true,
    });
    expect(res.json()).toEqual({ ok: true, inserted: 1, skipped: 3 });
    expect(row(a.userId, "m1", CAL_A)!.state).toBe("pending");
    expect(row(a.userId, "m9", CAL_B)!.state).toBe("detached");
    const pull = await call(a, "POST", "/sync/pull", { cursor: null, device_id: "x" });
    expect(pull.json().links_adopted).toBe(true);

    const known = (uuid: string) => call(a, "GET", `/user/calendar-links/known?uuid=${uuid}`).then((r) => r.json().known);
    expect(await known("m9")).toBe(true);
    expect(await known("m1")).toBe(true);
    expect(await known("nobody")).toBe(false);
  });

  it("disconnect-start: switches off, claims the copies for the caller, and keeps calendars another account writes to", async () => {
    const a = await linksUser([CAL_B]);
    await putVault(a, [
      account("me@gmail.com", [CAL_A, CAL_B, CAL_C], CAL_A),
      account("work@gmail.com", [CAL_B]),
    ]);
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    await push(a, [marker("m2")]);
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    const res = await call(a, "POST", "/user/calendar-links/disconnect-start", { account_ref: ref, mode: "remove" });
    expect(res.statusCode).toBe(200);
    const held = res.json().rows as Array<{ calendar_id: string; claim_token: string; claim_until: string }>;
    expect(held.map((r) => r.calendar_id)).toEqual([CAL_A]);
    expect(res.json()).toMatchObject({ ok: true, claim_token: held[0]!.claim_token, claim_until: held[0]!.claim_until });
    expect(Date.parse(held[0]!.claim_until)).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "deleting", reason: "disconnected" });
    expect(row(a.userId, "m1", CAL_B)!.state).toBe("linked");
    expect(row(a.userId, "m1", CAL_B)!.account_ref).not.toBe(ref);
    expect(row(a.userId, "m2", CAL_A)!.state).toMatch(/gone|deleting/);
    const targets = (await call(a, "GET", "/user/calendar-targets")).json().targets as Array<{ enabled: boolean }>;
    expect(targets.every((t) => !t.enabled)).toBe(true);
    const done = await call(a, "POST", "/user/calendar-links/deleted", { key: key("m1", CAL_A), claim_token: held[0]!.claim_token });
    expect(done.json()).toMatchObject({ ok: true, row: { state: "gone", reason: "disconnected" } });
  });
});

describe("disconnect-start, ack, attach and adopt-local refs", () => {
  it("disconnect-start holds every copy under one top-level claim_token, and a repeat answers rows: []", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    const start = () =>
      call(a, "POST", "/user/calendar-links/disconnect-start", { account_ref: ref, mode: "remove" }).then((r) => r.json());
    const first = await start();
    expect(typeof first.claim_token).toBe("string");
    expect(Date.parse(first.claim_until)).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const held = first.rows as Array<{ calendar_id: string; claim_token: string }>;
    expect(held.map((r) => r.calendar_id)).toEqual([CAL_A, CAL_B]);
    for (const r of held) {
      const done = await call(a, "POST", "/user/calendar-links/deleted", { key: key("m1", r.calendar_id), claim_token: first.claim_token });
      expect(done.json()).toMatchObject({ ok: true, row: { state: "gone" } });
    }
    // A retry after a lost answer: nothing left to hold, still a token.
    const again = await start();
    expect(again).toMatchObject({ ok: true, rows: [] });
    expect(typeof again.claim_token).toBe("string");
  });

  it("ack changes only the keys it is sent and fills a missing ref with one of the user's", async () => {
    const a = await linksUser();
    await putVault(a, [account("me@gmail.com", [CAL_A, CAL_B, CAL_C], CAL_A), account("work@gmail.com", [CAL_X])]);
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    const accounts = (await call(a, "GET", "/user/calendar-targets")).json().accounts as Array<{ account: string; ref: string }>;
    const workRef = accounts.find((x) => x.account === "work@gmail.com")!.ref;
    // Uploaded without a ref.
    h.db.prepare("UPDATE sync_marker_links SET account_ref = NULL, remote_updated_at = 'r0', pushed_hash = 'h0'").run();
    const id = fixedGoogleId("m1", CAL_A, 0);
    const ack = (body: Record<string, unknown>) =>
      call(a, "POST", "/user/calendar-links/ack", { key: key("m1", CAL_A), event_id: id, from_etag: "e0", ...body }).then((r) => r.json());

    // Another server's ref is never stored, and nothing else changes.
    expect(await ack({ account_ref: "not-a-ref-here" })).toMatchObject({
      ok: true, row: { account_ref: null, etag: "e0", remote_updated_at: "r0", pushed_hash: "h0" },
    });
    expect(await ack({ account_ref: ref })).toMatchObject({
      ok: true, row: { account_ref: ref, etag: "e0", remote_updated_at: "r0", pushed_hash: "h0" },
    });
    // pushed_hash only: the etag stays, so the next PATCH's from_etag matches.
    expect(await ack({ pushed_hash: "h1" })).toMatchObject({ ok: true, row: { etag: "e0", remote_updated_at: "r0", pushed_hash: "h1" } });
    expect(await ack({ pushed_hash: null })).toMatchObject({ ok: true, row: { pushed_hash: "h1" } });
    // A ref that is set is never replaced.
    expect(await ack({ account_ref: workRef })).toMatchObject({ ok: true, row: { account_ref: ref } });
    expect(await ack({ etag: "e1", remote_updated_at: "r1" })).toMatchObject({ ok: true, row: { etag: "e1", remote_updated_at: "r1" } });
  });

  it("attach keeps the stored ref when none of the user's is sent", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1")]);
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    expect(ref).not.toBeNull();
    const attach = (calendarId: string, extra: Record<string, unknown>) =>
      call(a, "POST", "/user/calendar-links/attach", {
        key: key("m1", calendarId), event_id: fixedGoogleId("m1", calendarId, 0), ...extra,
      }).then((r) => r.json());
    expect(await attach(CAL_A, { account_ref: null })).toMatchObject({ ok: true, row: { state: "linked", account_ref: ref } });
    expect(await attach(CAL_B, { account_ref: "not-a-ref-here" })).toMatchObject({ ok: true, row: { state: "linked", account_ref: ref } });
  });

  it("adopt-local stores only this user's refs, and never stores a source row as work", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    const res = await call(a, "POST", "/user/calendar-links/adopt-local", {
      rows: [
        { ...key("m2", CAL_B), role: "copy", state: "pending", reason: "target", account_ref: "other-servers-ref" },
        { ...key("m3", CAL_B), role: "copy", state: "linked", reason: "migrated", event_id: "e3", account_ref: ref },
        // An import deleted in Vetroscope before the upload: the event is the person's.
        { ...key("m4", CAL_C), role: "source", state: "deleting", reason: "deleted", event_id: "own-4", account_ref: ref },
        { ...key("m5", CAL_C), role: "source", state: "pending", reason: "target" },
      ],
    });
    expect(res.json()).toEqual({ ok: true, inserted: 3, skipped: 1 });
    expect(row(a.userId, "m2", CAL_B)!.account_ref).toBeNull();
    expect(row(a.userId, "m3", CAL_B)!.account_ref).toBe(ref);
    expect(row(a.userId, "m4", CAL_C)).toMatchObject({ state: "released", reason: "deleted", event_id: "own-4" });
    expect(row(a.userId, "m5", CAL_C)).toBeUndefined();
  });
});

describe("source rows are never deleted in a calendar", () => {
  /** A links user with a Vetroscope event linked in A and an import of
   *  the person's own event `own-1` in B. */
  async function withImport() {
    const a = await linksUser();
    await push(a, [marker("m1"), marker("imp", { origin: "google" })]);
    await linkAll(a, "m1");
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    const res = await call(a, "POST", "/user/calendar-links/attach", {
      key: key("imp", CAL_B), role: "source", event_id: "own-1", account_ref: ref,
    });
    expect(res.json()).toMatchObject({ ok: true, row: { role: "source", state: "linked" } });
    return { a, ref };
  }

  it("deleting the import lets the row go, Undo follows the event again, and the backstop never deletes", async () => {
    const { a } = await withImport();
    await push(a, [marker("imp", { origin: "google", deleted: 1, updated_at: later() })]);
    expect(row(a.userId, "imp", CAL_B)).toMatchObject({ state: "released", reason: "deleted", event_id: "own-1" });
    expect((await claim(a)).rows.filter((r) => r.marker_uuid === "imp")).toEqual([]);

    await push(a, [marker("imp", { origin: "google", deleted: 0, updated_at: later() })]);
    expect(row(a.userId, "imp", CAL_B)).toMatchObject({ state: "linked", reason: "restore", event_id: "own-1", gen: 0 });

    h.db.prepare("UPDATE sync_markers SET deleted = 1 WHERE uuid = 'imp'").run();
    expect((await claim(a)).rows.filter((r) => r.marker_uuid === "imp")).toEqual([]);
    expect(row(a.userId, "imp", CAL_B)).toMatchObject({ state: "released", reason: "deleted" });

    // An import attached for an event already deleted is let go too.
    await push(a, [marker("imp2", { origin: "google", deleted: 1 })]);
    const late = await call(a, "POST", "/user/calendar-links/attach", { key: key("imp2", CAL_C), role: "source", event_id: "own-2" });
    expect(late.json()).toMatchObject({ ok: true, row: { state: "released", reason: "deleted" } });
    // And a removal of it can't be "put back" as a new copy.
    h.db.prepare("UPDATE sync_marker_links SET state = 'removed_remote' WHERE marker_uuid = 'imp2'").run();
    const back = await call(a, "POST", "/user/calendar-links/resolve", { key: key("imp2", CAL_C), choice: "put_back" });
    expect(back.json()).toMatchObject({ ok: false, row: { state: "removed_remote" } });
  });

  it("disconnect-start never hands out source rows; the disconnect lets them go", async () => {
    const { a, ref } = await withImport();
    const start = await call(a, "POST", "/user/calendar-links/disconnect-start", { account_ref: ref, mode: "remove" });
    const held = start.json().rows as Array<{ marker_uuid: string; role: string }>;
    expect(held.map((r) => [r.marker_uuid, r.role])).toEqual([["m1", "copy"]]);
    expect(row(a.userId, "imp", CAL_B)!.state).toBe("linked");
    await putVault(a, [], { disconnected: [{ email: "me@gmail.com", at: iso(Date.now() + 1000) }] });
    expect(row(a.userId, "imp", CAL_B)).toMatchObject({ state: "released", reason: "kept", event_id: "own-1" });
  });
});

describe("restore, give-backs and deletes nobody can make", () => {
  it("restore revives a copy only where the calendar is still a switched-on, valid target", async () => {
    const a = await linksUser([CAL_B]);
    await push(a, [marker("m1"), marker("m2")]);
    await push(a, [marker("m1", { deleted: 1, updated_at: later() }), marker("m2", { deleted: 1, updated_at: later() })]);
    expect(rows(a.userId).map((r) => r.state)).toEqual(["gone", "gone", "gone", "gone"]);
    const off = await call(a, "PUT", "/user/calendar-targets", { provider: "google", account: "me@gmail.com", calendarId: CAL_B, enabled: false, rev: 1 });
    expect(off.statusCode).toBe(200);
    await push(a, [marker("m1", { deleted: 0, updated_at: later() })]);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "pending", reason: "restore", gen: 1 });
    expect(row(a.userId, "m1", CAL_B)).toMatchObject({ state: "gone", reason: "cancelled", gen: 0 });

    // A unticked: no longer valid, so nothing comes back.
    await putVault(a, [account("me@gmail.com", [CAL_B, CAL_C], CAL_A)]);
    await push(a, [marker("m2", { deleted: 0, updated_at: later() })]);
    expect(rows(a.userId, "m2").map((r) => [r.state, r.gen])).toEqual([["gone", 0], ["gone", 0]]);
  });

  it("a restore after a DELETE whose answer was lost (given back) starts again with gen + 1", async () => {
    const a = await linksUser();
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    const del = (await claim(a)).rows[0]!;
    const back = await call(a, "POST", "/user/calendar-links/unclaim", { key: key("m1", CAL_A), claim_token: del.claim_token });
    expect(back.json()).toEqual({ ok: true });
    await push(a, [marker("m1", { deleted: 0, updated_at: later() })]);
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({ state: "pending", reason: "restore", gen: 1, event_id: null });
  });

  it("rows a device gives back lose their turn on it, so newer rows still get claimed", async () => {
    const a = await linksUser();
    await push(a, [marker("m1"), marker("m2"), marker("m3")]);
    const first = (await claim(a, { limit: 2 })).rows;
    expect(first.map((r) => r.marker_uuid)).toEqual(["m1", "m2"]);
    for (const r of first) {
      await call(a, "POST", "/user/calendar-links/unclaim", { key: key(r.marker_uuid, CAL_A), claim_token: r.claim_token });
    }
    expect((await claim(a, { limit: 2 })).rows.map((r) => r.marker_uuid)).toEqual(["m3"]);
    // Asked for by key, it still comes.
    expect((await claim(a, { keys: [key("m1", CAL_A)] })).rows.map((r) => r.marker_uuid)).toEqual(["m1"]);
    // Another device can take one at once.
    const b = await secondDevice();
    await lease(b, LINKS, { declare: true });
    expect((await claim(b)).rows.map((r) => r.marker_uuid)).toEqual(["m2"]);
    // Each give-back doubles the wait.
    const m2 = (await claim(b)).rows[0]!;
    await call(b, "POST", "/user/calendar-links/unclaim", { key: key("m2", CAL_A), claim_token: m2.claim_token });
    const waits = h.db
      .prepare("SELECT marker_uuid, give_backs FROM sync_marker_links WHERE retry_at IS NOT NULL ORDER BY marker_uuid")
      .all();
    expect(waits).toEqual([{ marker_uuid: "m1", give_backs: 1 }, { marker_uuid: "m2", give_backs: 2 }]);
  });

  it("a delete whose account is gone moves to another account that writes the calendar, or ends gone/disconnected", async () => {
    const a = await linksUser();
    await putVault(a, [account("me@gmail.com", [CAL_A, CAL_B, CAL_C], CAL_A), account("work@gmail.com", [CAL_B])]);
    await call(a, "PUT", "/user/calendar-targets", { provider: "google", account: "me@gmail.com", calendarId: CAL_B, enabled: true, rev: 0 });
    h.db.prepare("UPDATE calendar_targets SET on_since = ?").run(iso(Date.now() - 60_000));
    await push(a, [marker("m1")]);
    await linkAll(a, "m1");
    const ref = row(a.userId, "m1", CAL_A)!.account_ref!;
    await push(a, [marker("m1", { deleted: 1, updated_at: later() })]);
    expect(rows(a.userId, "m1").map((r) => r.state)).toEqual(["deleting", "deleting"]);

    await putVault(a, [], { disconnected: [{ email: "me@gmail.com", at: iso(Date.now() + 1000) }] });
    expect(row(a.userId, "m1", CAL_A)).toMatchObject({
      state: "gone", reason: "disconnected", event_id: fixedGoogleId("m1", CAL_A, 0),
    });
    const b = row(a.userId, "m1", CAL_B)!;
    expect(b).toMatchObject({ state: "deleting", reason: "deleted" });
    expect(b.account_ref).not.toBe(ref);
    expect((await claim(a)).rows.map((r) => r.calendar_id)).toEqual([CAL_B]);
  });
});

describe("lease and declare", () => {
  it("declare records providers without touching the lease or starting links mode", async () => {
    const d = await admin();
    await putVault(d, [account("me@gmail.com", [CAL_A], CAL_A)]);
    const res = await lease(d, LINKS, { declare: true });
    expect(res.json()).toEqual({ ok: true, declared: true, links_mode: false });
    expect(h.db.prepare("SELECT providers FROM calendar_devices").get()).toEqual({ providers: "google,links,outlook" });
    expect(h.db.prepare("SELECT 1 FROM google_calendar_leader").get()).toBeUndefined();
    expect(h.db.prepare("SELECT 1 FROM calendar_links_state").get()).toBeUndefined();
  });

  it("outside links mode an older desktop leads as today", async () => {
    const d = await admin();
    await putVault(d, [account("me@gmail.com", [CAL_A], CAL_A)]);
    const res = await lease(d);
    expect(res.json()).toMatchObject({ claimed: true, links_mode: false });
  });

  it("no links mode from a links claim with no account", async () => {
    const d = await admin();
    expect((await lease(d, LINKS)).json()).toMatchObject({ claimed: true, links_mode: false });
  });

  it("in links mode: update_required (200) without links, and a lease held without links counts as expired", async () => {
    const old = await admin();
    await putVault(old, [account("me@gmail.com", [CAL_A], CAL_A)]);
    expect((await lease(old, OLD)).json()).toMatchObject({ claimed: true });
    const fresh = await secondDevice();
    const res = await lease(fresh, LINKS);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ claimed: true, links_mode: true, device_id: fresh.deviceId });

    const refused = await lease(old, OLD, { steal: true });
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toEqual({ claimed: false, reason: "update_required", links_mode: true });
  });
});

describe("vault PUT", () => {
  it("starting target: the first sending account's exportCalendarId, unticked kept as legacy_send", async () => {
    const d = await admin();
    await putVault(d, [
      account("b@gmail.com", [CAL_B], CAL_B),
      account("a-import@gmail.com", [CAL_C], CAL_C, "import"),
      account("a@gmail.com", [CAL_A], CAL_X),
    ]);
    await lease(d, LINKS);
    const state = (await call(d, "GET", "/user/calendar-targets")).json();
    expect(state.linksMode).toBe(true);
    expect(state.targets).toEqual([
      expect.objectContaining({ calendarId: CAL_X, enabled: true, valid: true, legacySend: true }),
    ]);
    expect(state.accounts.map((a: { account: string }) => a.account)).toEqual(["a-import@gmail.com", "a@gmail.com", "b@gmail.com"]);
    // It keeps getting new events while unticked.
    await push(d, [marker("m1")]);
    expect(rows(d.userId, "m1").map((r) => r.calendar_id)).toEqual([CAL_X]);
  });

  it("an account connected with links: true starts links mode first and gets no target", async () => {
    const d = await admin();
    await putVault(d, [account("old@gmail.com", [CAL_A], CAL_A)]);
    await putVault(d, [account("old@gmail.com", [CAL_A], CAL_A), account("new@gmail.com", [CAL_B], CAL_B)], { links: true });
    const state = (await call(d, "GET", "/user/calendar-targets")).json();
    expect(state.linksMode).toBe(true);
    expect(state.targets.map((t: { calendarId: string }) => t.calendarId)).toEqual([CAL_A]);
  });

  it("the first account ever, connected with links: true, starts with no switch on", async () => {
    const d = await admin();
    await putVault(d, [account("new@gmail.com", [CAL_B], CAL_B)], { links: true });
    const state = (await call(d, "GET", "/user/calendar-targets")).json();
    expect(state).toMatchObject({ linksMode: true, targets: [] });
  });

  it("outside links mode an account left out is removed, as today", async () => {
    const d = await admin();
    await putVault(d, [account("a@gmail.com", [CAL_A]), account("b@gmail.com", [CAL_B])]);
    await putVault(d, [account("a@gmail.com", [CAL_A])]);
    const live = h.db.prepare("SELECT email FROM google_calendar_accounts WHERE deleted = 0").all();
    expect(live).toEqual([{ email: "a@gmail.com" }]);
  });

  it("in links mode a left-out account is kept and its rows don't change", async () => {
    const d = await linksUser();
    await putVault(d, [account("me@gmail.com", [CAL_A, CAL_B, CAL_C], CAL_A), account("two@gmail.com", [CAL_X])]);
    await push(d, [marker("m1")]);
    await linkAll(d, "m1");
    // A stale desktop's vault without two@ and without me@.
    await putVault(d, [account("two@gmail.com", [CAL_X])]);
    await putVault(d, []);
    const live = h.db.prepare("SELECT email FROM google_calendar_accounts WHERE deleted = 0 ORDER BY email").all();
    expect(live).toEqual([{ email: "me@gmail.com" }, { email: "two@gmail.com" }]);
    expect(row(d.userId, "m1", CAL_A)!.state).toBe("linked");
  });

  it("disconnected removes the account, releases its copies and switches its targets off; an older entry is ignored", async () => {
    const d = await linksUser([CAL_B]);
    await push(d, [marker("m1")]);
    await linkAll(d, "m1");
    // Older than the account's last upsert: ignored.
    await putVault(d, [], { disconnected: [{ email: "me@gmail.com", at: iso(Date.now() - 3600_000) }] });
    expect(row(d.userId, "m1", CAL_A)!.state).toBe("linked");

    await push(d, [marker("m2")]);
    await putVault(d, [], { disconnected: [{ email: "me@gmail.com", at: iso(Date.now() + 1000) }] });
    expect(h.db.prepare("SELECT deleted FROM google_calendar_accounts").get()).toEqual({ deleted: 1 });
    expect(rows(d.userId, "m1").map((r) => [r.state, r.reason])).toEqual([["released", "kept"], ["released", "kept"]]);
    expect(rows(d.userId, "m2").every((r) => r.state === "gone" && r.reason === "disconnected")).toBe(true);
    const targets = (await call(d, "GET", "/user/calendar-targets")).json().targets as Array<{ enabled: boolean }>;
    expect(targets.every((t) => !t.enabled)).toBe(true);

    // Connecting it again starts with none on.
    await putVault(d, [account("me@gmail.com", [CAL_A, CAL_B, CAL_C], CAL_A)]);
    await push(d, [marker("m3")]);
    expect(rows(d.userId, "m3")).toEqual([]);
  });

  it("release refuses while the account is in this server's vault or gone for under 24 hours", async () => {
    const d = await linksUser();
    await push(d, [marker("m1")]);
    await linkAll(d, "m1");
    const ref = row(d.userId, "m1", CAL_A)!.account_ref!;
    const release = () => call(d, "POST", "/user/calendar-links/release", { account_ref: ref });
    expect((await release()).statusCode).toBe(409);
    h.db.prepare("UPDATE google_calendar_accounts SET deleted = 1, updated_at = ?").run(iso(Date.now() - 3600_000));
    expect((await release()).statusCode).toBe(409);
    h.db.prepare("UPDATE google_calendar_accounts SET updated_at = ?").run(iso(Date.now() - 25 * 3600_000));
    const ok = await release();
    expect(ok.json()).toEqual({ ok: true, released: 1 });
    expect(row(d.userId, "m1", CAL_A)!.state).toBe("released");
  });
});

describe("targets", () => {
  it("per-target revision, CAL_TARGET_CHANGED, CAL_TARGET_INVALID and switching off", async () => {
    const d = await linksUser();
    const put = (body: Record<string, unknown>) =>
      call(d, "PUT", "/user/calendar-targets", { provider: "google", account: "me@gmail.com", ...body });
    expect((await put({ calendarId: CAL_B, enabled: true, rev: 0 })).statusCode).toBe(200);
    // Different calendars never conflict.
    expect((await put({ calendarId: CAL_C, enabled: true, rev: 0 })).statusCode).toBe(200);
    const stale = await put({ calendarId: CAL_B, enabled: false, rev: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "CAL_TARGET_CHANGED", linksMode: true });
    expect((await put({ calendarId: CAL_X, enabled: true, rev: 0 })).json().error).toBe("CAL_TARGET_INVALID");
    expect((await put({ account: "nobody@gmail.com", calendarId: CAL_X, enabled: true, rev: 0 })).statusCode).toBe(400);

    h.db.prepare("UPDATE calendar_targets SET on_since = ?").run(iso(Date.now() - 60_000));
    await push(d, [marker("m1")]);
    const res = await put({ calendarId: CAL_B, enabled: false, rev: 1 });
    expect(res.statusCode).toBe(200);
    expect(row(d.userId, "m1", CAL_B)).toMatchObject({ state: "gone", reason: "target_off" });
    expect(row(d.userId, "m1", CAL_C)!.state).toBe("pending");
  });

  it("a target PUT from a links desktop starts links mode; without links it is refused", async () => {
    const d = await admin();
    await putVault(d, [account("me@gmail.com", [CAL_A, CAL_B], CAL_A)]);
    const body = { provider: "google", account: "me@gmail.com", calendarId: CAL_B, enabled: true, rev: 0 };
    const none = await call(d, "PUT", "/user/calendar-targets", body);
    expect(none.json().error).toBe("CAL_LINKS_NO_COMPUTER");
    await lease(d, LINKS, { declare: true });
    const ok = await call(d, "PUT", "/user/calendar-targets", body);
    expect(ok.json()).toMatchObject({ ok: true, linksMode: true });
    expect(ok.json().targets.map((t: { calendarId: string }) => t.calendarId)).toEqual([CAL_A, CAL_B]);
  });

  it("Outlook is refused", async () => {
    const d = await linksUser();
    const put = await call(d, "PUT", "/user/calendar-targets", { provider: "outlook", account: "x", calendarId: "y", enabled: true, rev: 0 });
    expect(put.json().error).toBe("CAL_TARGET_INVALID");
    const link = await call(d, "POST", "/user/calendar-links/renew", { key: key("m1", "y", "outlook"), claim_token: "t" });
    expect(link.statusCode).toBe(400);
    expect(link.json().error).toBe("CAL_TARGET_INVALID");
  });
});

describe("gates", () => {
  it("link calls need a links device and links mode", async () => {
    const d = await admin();
    await putVault(d, [account("me@gmail.com", [CAL_A], CAL_A)]);
    expect((await call(d, "POST", "/user/calendar-links/claim", {})).statusCode).toBe(403);
    await lease(d, LINKS, { declare: true });
    const res = await call(d, "POST", "/user/calendar-links/claim", {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "CAL_LINKS_MODE", linksMode: false });
  });

  it("/server-info lists calendar_links", async () => {
    const res = await h.app.inject({ method: "GET", url: "/server-info" });
    expect(res.json().features).toEqual(["calendar_links"]);
  });
});

describe("/sync/reset", () => {
  it("deletes link rows, keeps targets and links mode, bumps links_epoch and blocks the no-key fill for an hour", async () => {
    const d = await linksUser([CAL_B]);
    await push(d, [marker("m1")]);
    expect(rows(d.userId)).toHaveLength(2);
    expect((await call(d, "POST", "/sync/reset", {})).statusCode).toBe(200);
    expect(rows(d.userId)).toEqual([]);
    const state = (await call(d, "GET", "/user/calendar-targets")).json();
    expect(state.linksMode).toBe(true);
    expect(state.targets).toHaveLength(2);
    const pull = await call(d, "POST", "/sync/pull", { cursor: null, device_id: "x" });
    expect(pull.json()).toMatchObject({ links_epoch: 1, links_adopted: false });

    const noKey = marker("m1") as Record<string, unknown>;
    delete noKey.created_at;
    await push(d, [noKey]);
    expect(rows(d.userId)).toEqual([]);
    // With created_at the desktop still says when it was made.
    await push(d, [marker("m2")]);
    expect(rows(d.userId, "m2")).toHaveLength(2);
  });
});

describe("tenant isolation", () => {
  it("a push with another user's marker uuid writes no link rows for either user", async () => {
    const victim = await linksUser();
    await push(victim, [marker("shared", { created_at: null })]);
    const attacker = await otherUser(victim);
    await putVault(attacker, [account("att@gmail.com", [CAL_X], CAL_X)]);
    await lease(attacker, LINKS);
    await push(attacker, [marker("shared", { updated_at: later() })]);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sync_marker_links").get()).toEqual({ n: 0 });
  });

  it("link calls, known and the targets routes see only the caller's rows", async () => {
    const victim = await linksUser();
    await push(victim, [marker("vm")]);
    await linkAll(victim, "vm");
    const attacker = await otherUser(victim);
    await putVault(attacker, [account("att@gmail.com", [CAL_A], CAL_A)]);
    await lease(attacker, LINKS);

    expect((await claim(attacker)).rows).toEqual([]);
    const id = fixedGoogleId("vm", CAL_A, 0);
    const k = key("vm", CAL_A);
    for (const [path, body] of [
      ["remote-removed", { key: k, event_id: id }],
      ["ack", { key: k, event_id: id, from_etag: "e0", etag: "evil" }],
      ["resolve", { key: k, choice: "keep" }],
      ["attach", { key: k, event_id: "evil" }],
      ["deleted", { key: k, claim_token: "x" }],
    ] as const) {
      const res = await call(attacker, "POST", `/user/calendar-links/${path}`, body);
      expect(res.json().ok).toBe(false);
    }
    expect(row(victim.userId, "vm", CAL_A)).toMatchObject({ state: "linked", event_id: id });
    expect(rows(attacker.userId)).toEqual([]);
    expect((await call(attacker, "GET", "/user/calendar-links/known?uuid=vm")).json().known).toBe(false);
    const adopt = await call(attacker, "POST", "/user/calendar-links/adopt-local", {
      rows: [{ ...k, role: "copy", state: "linked", reason: "migrated", event_id: id }],
    });
    expect(adopt.json().inserted).toBe(1);
    expect(row(victim.userId, "vm", CAL_A)!.event_id).toBe(id);

    const targets = (await call(attacker, "GET", "/user/calendar-targets")).json();
    expect(targets.accounts.map((a: { account: string }) => a.account)).toEqual(["att@gmail.com"]);
    expect(targets.targets).toHaveLength(1);
    const pull = await call(attacker, "POST", "/sync/pull", { cursor: null, device_id: "x", seq_cursors: { marker_links: 0 } });
    expect((pull.json().marker_links as Array<{ marker_uuid: string }>).map((r) => r.marker_uuid)).toEqual(["vm"]);
    expect(rows(attacker.userId)).toHaveLength(1);
  });
});

describe("fixedGoogleId", () => {
  it("is a valid Google id, stable, and differs per calendar and gen", () => {
    const k = fixedGoogleId("uuid-1", CAL_A, 0);
    expect(k).toMatch(/^vs[0-9a-v]{40}$/);
    expect(fixedGoogleId("uuid-1", CAL_A, 0)).toBe(k);
    expect(fixedGoogleId("uuid-1", CAL_B, 0)).not.toBe(k);
    expect(fixedGoogleId("uuid-1", CAL_A, 1)).not.toBe(k);
  });
});
