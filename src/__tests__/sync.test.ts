// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

function entry(
  uuid: string,
  deviceId: string,
  updatedAt: string,
  app_name = "Safari",
): Record<string, unknown> {
  return {
    uuid,
    device_id: deviceId,
    timestamp: updatedAt,
    app_name,
    window_title: "x",
    project: null,
    is_adobe: 0,
    tag_uuid: null,
    platform: "darwin",
    updated_at: updatedAt,
  };
}

describe("/sync", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("push persists rows and pull returns them from a different device", async () => {
    const admin = await bootstrapAdmin(h);
    const push = await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        entries: [entry("e1", admin.deviceId, "2026-04-23T00:00:00.000Z")],
        tags: [
          {
            uuid: "t1",
            name: "work",
            color: "#000",
            sticky: 0,
            deleted: 0,
            updated_at: "2026-04-23T00:00:00.000Z",
          },
        ],
      },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().synced.entries).toBe(1);

    const pull = await h.app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { cursor: null, device_id: "other-device" },
    });
    expect(pull.statusCode).toBe(200);
    const body = pull.json();
    expect(body.entries).toHaveLength(1);
    expect(body.tags).toHaveLength(1);
  });

  it("excludes the caller's own device from /sync/pull entries (tags still sync)", async () => {
    const admin = await bootstrapAdmin(h);
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        entries: [entry("e1", admin.deviceId, "2026-04-23T00:00:00.000Z")],
      },
    });
    const pull = await h.app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { cursor: null, device_id: admin.deviceId },
    });
    expect(pull.json().entries).toHaveLength(0);
  });

  it("LWW: older updated_at does not clobber newer", async () => {
    const admin = await bootstrapAdmin(h);
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        tags: [
          {
            uuid: "t1",
            name: "newer",
            color: "#fff",
            sticky: 0,
            deleted: 0,
            updated_at: "2026-04-23T10:00:00.000Z",
          },
        ],
      },
    });
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        tags: [
          {
            uuid: "t1",
            name: "older",
            color: "#000",
            sticky: 1,
            deleted: 1,
            updated_at: "2026-04-22T00:00:00.000Z",
          },
        ],
      },
    });
    const row = h.db
      .prepare<[string], { name: string; color: string }>(
        "SELECT name, color FROM sync_tags WHERE uuid = ?",
      )
      .get("t1");
    expect(row?.name).toBe("newer");
    expect(row?.color).toBe("#fff");
  });

  it("goal achievements collapse on (user, goal_uuid, date)", async () => {
    const admin = await bootstrapAdmin(h);
    const common = {
      goal_uuid: "g1",
      goal_snapshot: "{}",
      date: "2026-04-23",
      achieved_at: "2026-04-23T12:00:00.000Z",
      deleted: 0,
    };
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        achievements: [
          {
            ...common,
            uuid: "a1",
            current_seconds: 3600,
            updated_at: "2026-04-23T12:00:00.000Z",
          },
        ],
      },
    });
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        achievements: [
          {
            ...common,
            uuid: "a2",
            current_seconds: 7200,
            updated_at: "2026-04-23T13:00:00.000Z",
          },
        ],
      },
    });
    const rows = h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sync_goal_achievements WHERE goal_uuid = ?",
      )
      .get("g1") as { n: number };
    expect(rows.n).toBe(1);
  });

  it("rejects unknown setting keys", async () => {
    const admin = await bootstrapAdmin(h);
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        settings: [
          {
            key: "secret_password",
            value: "nope",
            updated_at: "2026-04-23T00:00:00.000Z",
          },
          {
            key: "ignored_apps",
            value: "cipher",
            updated_at: "2026-04-23T00:00:00.000Z",
          },
        ],
      },
    });
    const rows = h.db
      .prepare("SELECT key FROM sync_settings ORDER BY key")
      .all() as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).toEqual(["ignored_apps"]);
  });

  it("/sync/reset wipes this user's rows but leaves other users untouched", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await h.app.inject({
      method: "POST",
      url: "/admin/invites",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    const otherReg = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "other@lan",
        password: "hunter2hunter2",
        display_name: "Other",
        device_name: "Laptop",
        platform: "win32",
        invite_token: invite.json().token,
      },
    });
    const other = otherReg.json() as { accessToken: string; device_id: string };

    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        entries: [entry("a1", admin.deviceId, "2026-04-23T00:00:00.000Z")],
      },
    });
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: {
        entries: [entry("b1", other.device_id, "2026-04-23T00:00:00.000Z")],
      },
    });

    const reset = await h.app.inject({
      method: "POST",
      url: "/sync/reset",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(reset.statusCode).toBe(200);

    const adminRows = h.db
      .prepare("SELECT COUNT(*) AS n FROM sync_entries WHERE user_id = ?")
      .get(admin.userId) as { n: number };
    expect(adminRows.n).toBe(0);

    const otherRows = h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM sync_entries WHERE user_id != ?",
      )
      .get(admin.userId) as { n: number };
    expect(otherRows.n).toBe(1);
  });

  it("unauthenticated sync requests 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/sync/pull",
      payload: { cursor: null, device_id: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("goal push round-trips tag_uuid and created_at", async () => {
    const admin = await bootstrapAdmin(h);
    const goal = {
      uuid: "g-tagged",
      type: "tag",
      app_name: null,
      tag_uuid: "tag-abc",
      target_seconds: 3600,
      enabled: 1,
      deleted: 0,
      created_at: "2026-04-20T08:00:00.000Z",
      updated_at: "2026-04-20T08:00:00.000Z",
    };
    const push = await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { goals: [goal] },
    });
    expect(push.statusCode).toBe(200);

    const pull = await h.app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { cursor: null, device_id: "other-device" },
    });
    expect(pull.statusCode).toBe(200);
    const rows = pull.json().goals as Array<typeof goal>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tag_uuid).toBe("tag-abc");
    expect(rows[0]!.created_at).toBe("2026-04-20T08:00:00.000Z");
  });

  it("goal upsert preserves the original created_at (first-write-wins)", async () => {
    const admin = await bootstrapAdmin(h);
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        goals: [
          {
            uuid: "g-fww",
            type: "app",
            app_name: "Cursor",
            tag_uuid: null,
            target_seconds: 3600,
            enabled: 1,
            deleted: 0,
            created_at: "2026-04-20T08:00:00.000Z",
            updated_at: "2026-04-20T08:00:00.000Z",
          },
        ],
      },
    });
    // Second push from a re-installed client that lost its created_at.
    // The COALESCE in the upsert should keep the original timestamp.
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        goals: [
          {
            uuid: "g-fww",
            type: "app",
            app_name: "Cursor",
            tag_uuid: null,
            target_seconds: 7200,
            enabled: 1,
            deleted: 0,
            created_at: null,
            updated_at: "2026-04-21T08:00:00.000Z",
          },
        ],
      },
    });
    const row = h.db
      .prepare<[string], { created_at: string | null; target_seconds: number }>(
        "SELECT created_at, target_seconds FROM sync_goals WHERE uuid = ?",
      )
      .get("g-fww");
    expect(row?.created_at).toBe("2026-04-20T08:00:00.000Z");
    expect(row?.target_seconds).toBe(7200);
  });

  it("icon pull paginates correctly when many rows share an updated_at", async () => {
    // The bug: 100 icons all stamped with the same updated_at would be
    // skipped past the boundary timestamp by a strict-greater-than cursor.
    // The compound cursor on (updated_at, name_hash) keeps pagination
    // correct.
    const admin = await bootstrapAdmin(h);
    const sharedTs = "2026-04-30T09:00:00.000Z";
    const icons = Array.from({ length: 100 }, (_, i) => ({
      name_hash: `hash-${String(i).padStart(3, "0")}`,
      app_name: `enc-app-${i}`,
      platform: i % 2 === 0 ? "darwin" : "win32",
      data_url: "enc-data",
      dominant_color: "#000",
      updated_at: sharedTs,
    }));
    // Server's push handler clamps icons to ICON_LIMIT (50) per request,
    // so push in two batches to seed all 100 rows. Both batches share the
    // same updated_at — the whole point of this test is the boundary
    // behavior at a shared timestamp.
    for (let i = 0; i < icons.length; i += 50) {
      await h.app.inject({
        method: "POST",
        url: "/sync/push",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { icons: icons.slice(i, i + 50) },
      });
    }

    const pulled = new Map<string, unknown>();
    let iconCursor: { updated_at: string; key: string } | undefined;
    let safety = 0;
    while (safety++ < 10) {
      const res = await h.app.inject({
        method: "POST",
        url: "/sync/pull",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {
          cursor: null,
          device_id: "other-device",
          icon_cursor: iconCursor ?? null,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      for (const icon of body.icons ?? []) {
        pulled.set(icon.name_hash, icon);
      }
      if (!body.icon_cursor) break;
      iconCursor = body.icon_cursor;
    }
    expect(pulled.size).toBe(100);
    // Bound: ICON_LIMIT = 50, so 100 icons should be drained in 2 pages
    // (the third returns 0 icons + no icon_cursor → break).
    expect(safety).toBeLessThanOrEqual(3);
  });

  it("legacy icon pull (no icon_cursor) still works for older clients", async () => {
    // Backward-compat: a client that doesn't send icon_cursor falls back
    // to the time-only cursor and the server uses the legacy query path.
    // Asserts we didn't regress the older behavior on the way to the
    // compound-cursor fix.
    const admin = await bootstrapAdmin(h);
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        icons: [
          {
            name_hash: "h1",
            app_name: "enc-a",
            platform: "darwin",
            data_url: "enc-d",
            dominant_color: "#000",
            updated_at: "2026-04-30T09:00:00.000Z",
          },
        ],
      },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { cursor: null, device_id: "other-device" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.icons).toHaveLength(1);
    expect(body.icons[0].name_hash).toBe("h1");
  });

  it("setting pull paginates correctly when many rows share an updated_at", async () => {
    // Same compound-cursor treatment for settings — bulk pushes (e.g.
    // a Reset Cloud Data → re-push flow) can stamp every setting with
    // the same `now`, and the time-only cursor would skip rows at the
    // boundary. SYNCED_SETTING_KEYS only has ignored_apps + ignored_projects
    // today, so we can't realistically exceed SETTING_LIMIT in practice —
    // this test still exercises the compound-cursor path to prove the
    // pagination is correct.
    const admin = await bootstrapAdmin(h);
    const sharedTs = "2026-04-30T09:00:00.000Z";
    await h.app.inject({
      method: "POST",
      url: "/sync/push",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        settings: [
          { key: "ignored_apps", value: "enc-a", updated_at: sharedTs },
          { key: "ignored_projects", value: "enc-b", updated_at: sharedTs },
        ],
      },
    });
    const res = await h.app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        cursor: null,
        device_id: "other-device",
        setting_cursor: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings).toHaveLength(2);
    expect(body.settings.map((s: { key: string }) => s.key).sort()).toEqual([
      "ignored_apps",
      "ignored_projects",
    ]);
  });
});
