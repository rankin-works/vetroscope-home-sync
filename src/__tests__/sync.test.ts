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
});
