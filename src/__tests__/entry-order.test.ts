// SPDX-License-Identifier: Apache-2.0
// Entry pulls by save order (032) and moving a desktop's session to the
// device id it uses locally (adoptDeviceId).
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

function entry(deviceId: string, updatedAt = iso()): Record<string, unknown> {
  return {
    uuid: randomUUID(),
    device_id: deviceId,
    timestamp: iso(-60_000),
    app_name: "Safari",
    window_title: null,
    project: null,
    is_adobe: 0,
    tag_uuid: null,
    platform: "darwin",
    updated_at: updatedAt,
  };
}

describe("entry pulls by save order", () => {
  let h: Harness;
  let desktop: Session;
  let laptop: Session;

  const post = (
    url: string,
    payload: Record<string, unknown>,
    token?: string,
  ) =>
    h.app.inject({
      method: "POST",
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload,
    });
  const push = (s: Session, entries: unknown[]) =>
    post("/sync/push", { entries }, s.accessToken);
  const pull = (s: Session, extra: Record<string, unknown> = {}) =>
    post(
      "/sync/pull",
      { cursor: null, device_id: s.deviceId, ...extra },
      s.accessToken,
    );

  /** Pull until caught up, following both cursors; every entry uuid seen. */
  async function pullAll(s: Session, entryCursor: unknown = { after: EPOCH }) {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res = await pull(s, { cursor, entry_cursor: entryCursor });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      seen.push(...body.entries.map((e: { uuid: string }) => e.uuid));
      cursor = body.cursor;
      entryCursor = body.entry_cursor;
      if (!body.has_more) return { seen, cursor, entryCursor };
    }
    throw new Error("pull never caught up");
  }

  beforeEach(async () => {
    h = await createHarness();
    const admin = await bootstrapAdmin(h);
    desktop = admin;
    const res = await post("/auth/login", {
      email: "admin@test.lan",
      password: "hunter2hunter2",
      device_name: "Admin PC",
      device_id: randomUUID(),
      platform: "win32",
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    laptop = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      deviceId: body.device_id,
    };
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("still delivers an entry stamped before another device's caught-up pull", async () => {
    expect((await push(desktop, [entry(desktop.deviceId)])).statusCode).toBe(
      200,
    );
    const first = await pullAll(laptop);
    expect(first.seen).toHaveLength(1);
    expect(first.entryCursor).toEqual({ seq: expect.any(Number) });

    // Stamped by the desktop's clock before the laptop's pull, saved after.
    const late = entry(desktop.deviceId, iso(-5_000));
    expect((await push(desktop, [late])).statusCode).toBe(200);

    const next = (
      await pull(laptop, {
        cursor: first.cursor,
        entry_cursor: first.entryCursor,
      })
    ).json();
    expect(next.entries.map((e: { uuid: string }) => e.uuid)).toEqual([
      late.uuid,
    ]);
    // A client without an entry cursor pages by time and still misses it.
    expect(
      (await pull(laptop, { cursor: first.cursor })).json().entries,
    ).toEqual([]);
  });

  it("pages a full replay across the switch from updated_at to seq without skipping a row", async () => {
    const pushed: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      const rows = Array.from({ length: 250 }, (_, i) =>
        entry(desktop.deviceId, iso(-100_000 + batch * 1000 + i)),
      );
      expect((await push(desktop, rows)).statusCode).toBe(200);
      pushed.push(...rows.map((r) => r.uuid as string));
    }
    // Rows from before 032 have no seq: a replay reaches them by time.
    h.db
      .prepare(
        "UPDATE sync_entries SET seq = NULL WHERE uuid IN (SELECT uuid FROM sync_entries LIMIT 300)",
      )
      .run();

    const first = await pullAll(laptop);
    expect(new Set(first.seen)).toEqual(new Set(pushed));
    const more = Array.from({ length: 520 }, () =>
      entry(desktop.deviceId, iso(-200_000)),
    );
    expect((await push(desktop, more.slice(0, 500))).statusCode).toBe(200);
    expect((await push(desktop, more.slice(500))).statusCode).toBe(200);
    const second = await pullAll(laptop, first.entryCursor);
    expect(new Set(second.seen)).toEqual(
      new Set(more.map((r) => r.uuid as string)),
    );
  });

  it("hands an older client's pull an entry cursor it can ignore", async () => {
    expect((await pull(laptop)).json().entry_cursor).toEqual({ seq: 0 });
  });

  describe("other tables pull by save order", () => {
    const SEQ_TABLES = [
      "tags",
      "goals",
      "markers",
      "notes",
      "note_folders",
      "achievements",
      "icons",
      "tag_sticky_exclusions",
      "tag_sticky_project_apps",
      "tag_sticky_subproject_scopes",
      "media_links",
      "app_categories",
      "reminders",
      "reminder_events",
      "entry_dismissals",
    ];
    const zeroCursors = () => Object.fromEntries(SEQ_TABLES.map((t) => [t, 0]));
    const otherRows = (updatedAt: string) => ({
      tags: [
        {
          uuid: randomUUID(),
          name: "t",
          color: "#111111",
          sticky: 0,
          deleted: 0,
          updated_at: updatedAt,
        },
      ],
      notes: [
        {
          uuid: randomUUID(),
          title: "n",
          body: "b",
          timestamp: null,
          end_timestamp: null,
          marker_uuid: null,
          deleted: 0,
          updated_at: updatedAt,
        },
      ],
      entry_dismissals: [
        { uuid: randomUUID(), deleted: 0, updated_at: updatedAt },
      ],
    });
    const uuidsOf = (
      body: Record<string, Array<{ uuid: string }>>,
      key: string,
    ) => body[key]!.map((r) => r.uuid);

    it("still delivers a dismissal, tag or note stamped before another device's caught-up pull", async () => {
      const first = otherRows(iso());
      expect(
        (await post("/sync/push", first, desktop.accessToken)).statusCode,
      ).toBe(200);
      const caughtUp = (
        await pull(laptop, { seq_cursors: zeroCursors() })
      ).json();
      for (const key of ["tags", "notes", "entry_dismissals"] as const) {
        expect(uuidsOf(caughtUp, key)).toEqual([first[key][0]!.uuid]);
      }
      expect(Object.keys(caughtUp.seq_cursors).sort()).toEqual(
        [...SEQ_TABLES].sort(),
      );

      // Stamped by the desktop's clock before the laptop's pull, saved after.
      const late = otherRows(iso(-5_000));
      expect(
        (await post("/sync/push", late, desktop.accessToken)).statusCode,
      ).toBe(200);
      const next = (
        await pull(laptop, {
          cursor: caughtUp.cursor,
          seq_cursors: caughtUp.seq_cursors,
        })
      ).json();
      for (const key of ["tags", "notes", "entry_dismissals"] as const) {
        expect(uuidsOf(next, key)).toEqual([late[key][0]!.uuid]);
      }
      // Without seq cursors the time cursor is past them.
      const legacy = (await pull(laptop, { cursor: caughtUp.cursor })).json();
      expect(legacy.entry_dismissals).toEqual([]);
      expect(legacy.notes).toEqual([]);
    });

    it("pages a table larger than one pull without skipping a row", async () => {
      const dismissals = Array.from({ length: 700 }, () => ({
        uuid: randomUUID(),
        deleted: 0,
        updated_at: iso(-1_000),
      }));
      expect(
        (
          await post(
            "/sync/push",
            { entry_dismissals: dismissals.slice(0, 500) },
            desktop.accessToken,
          )
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(
            "/sync/push",
            { entry_dismissals: dismissals.slice(500) },
            desktop.accessToken,
          )
        ).statusCode,
      ).toBe(200);
      const seen: string[] = [];
      let seqCursors: unknown = zeroCursors();
      for (let page = 0; page < 5; page++) {
        const body = (await pull(laptop, { seq_cursors: seqCursors })).json();
        seen.push(...uuidsOf(body, "entry_dismissals"));
        seqCursors = body.seq_cursors;
        if (!body.has_more) break;
      }
      expect(seen).toHaveLength(700);
      expect(new Set(seen)).toEqual(new Set(dismissals.map((d) => d.uuid)));
    });
  });

  describe("moving a session to the desktop's own device id", () => {
    const refresh = (s: Session, extra: Record<string, unknown> = {}) =>
      post("/auth/refresh", { refresh_token: s.refreshToken, ...extra });

    it("renames the device and its entries when the id is unused", async () => {
      expect((await push(laptop, [entry(laptop.deviceId)])).statusCode).toBe(
        200,
      );
      const own = randomUUID();
      const res = await refresh(laptop, { canonical_device_id: own });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().device_id).toBe(own);

      const devices = h.db
        .prepare("SELECT id, platform FROM devices ORDER BY platform")
        .all();
      expect(devices).toEqual([
        { id: desktop.deviceId, platform: "darwin" },
        { id: own, platform: "win32" },
      ]);
      expect(
        h.db
          .prepare("SELECT device_id, updated_by_device_id FROM sync_entries")
          .get(),
      ).toEqual({ device_id: own, updated_by_device_id: own });

      const moved = {
        deviceId: own,
        accessToken: res.json().accessToken,
        refreshToken: res.json().refreshToken,
      };
      expect((await pull(moved)).statusCode).toBe(200);
      expect(
        (await refresh(moved, { canonical_device_id: own })).json().device_id,
      ).toBe(own);
      // Other desktops learn where the old id went.
      const profile = await h.app.inject({
        method: "GET",
        url: "/user/profile",
        headers: { authorization: `Bearer ${moved.accessToken}` },
      });
      expect(profile.json().device_aliases).toEqual([
        { old_id: laptop.deviceId, new_id: own },
      ]);
    });

    it("keeps the session's id when the other id belongs to another platform or isn't a uuid", async () => {
      // desktop.deviceId is this user's Mac; the laptop is Windows.
      const res = await refresh(laptop, {
        canonical_device_id: desktop.deviceId,
      });
      expect(res.json().device_id).toBe(laptop.deviceId);
      const next = { ...laptop, refreshToken: res.json().refreshToken };
      expect(
        (await refresh(next, { canonical_device_id: "not-a-uuid" })).json()
          .device_id,
      ).toBe(laptop.deviceId);
    });
  });
});
