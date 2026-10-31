// SPDX-License-Identifier: Apache-2.0
// Seq numbers never drop below one already handed out (038), the entry
// replay's (updated_at, uuid, until) cursor, settings the server doesn't
// sync, alerts' note, and old reminder claims.
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLAIM_RETENTION_DAYS, parseEntryCursor } from "../routes/sync.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

interface Session {
  accessToken: string;
  deviceId: string;
}

function entry(deviceId: string, updatedAt: string): Record<string, unknown> {
  return {
    uuid: randomUUID(),
    device_id: deviceId,
    timestamp: "2026-09-01T10:00:00.000Z",
    app_name: "enc-Premiere",
    window_title: null,
    project: null,
    is_adobe: 1,
    tag_uuid: "tag-1",
    platform: "darwin",
    updated_at: updatedAt,
  };
}

function tag(name: string, updatedAt: string): Record<string, unknown> {
  return {
    uuid: randomUUID(),
    name,
    color: "#fff",
    sticky: 0,
    deleted: 0,
    updated_at: updatedAt,
  };
}

function reminder(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    uuid: "rem-1",
    title: "enc-Title",
    body: null,
    kind: "once",
    fire_at: "2026-11-01T09:00:00.000Z",
    weekdays: null,
    time_of_day: null,
    start_date: null,
    end_date: null,
    enabled: 1,
    deleted: 0,
    ...extra,
  };
}

describe("seq floor, entry replay, settings, alerts and claims", () => {
  let h: Harness;
  let desktop: Session;
  let laptop: Session;

  const post = (url: string, payload: Record<string, unknown>, token: string) =>
    h.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  const push = (s: Session, payload: Record<string, unknown>) =>
    post("/sync/push", payload, s.accessToken);
  const pull = (s: Session, extra: Record<string, unknown> = {}) =>
    post("/sync/pull", { cursor: null, device_id: s.deviceId, ...extra }, s.accessToken);

  /** Pages entries until caught up from `entryCursor`; every uuid seen. */
  async function replay(s: Session, entryCursor: unknown = { after: EPOCH }) {
    const seen: string[] = [];
    const cursors: unknown[] = [];
    for (let page = 0; page < 20; page++) {
      const res = await pull(s, { entry_cursor: entryCursor });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      seen.push(...body.entries.map((e: { uuid: string }) => e.uuid));
      entryCursor = body.entry_cursor;
      cursors.push(entryCursor);
      if (!body.has_more) return { seen, entryCursor, cursors };
    }
    throw new Error("pull never caught up");
  }

  beforeEach(async () => {
    h = await createHarness();
    const admin = await bootstrapAdmin(h);
    desktop = admin;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "hunter2hunter2",
        device_name: "Laptop",
        device_id: randomUUID(),
        platform: "win32",
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    laptop = { accessToken: res.json().accessToken, deviceId: res.json().device_id };
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("keeps seq numbers above the other desktops' cursors after a reset", async () => {
    const before = Array.from({ length: 5 }, () => entry(desktop.deviceId, "2026-09-01T10:00:00.000Z"));
    expect((await push(desktop, { entries: before, tags: [tag("enc-A", "2026-09-01T10:00:00.000Z")] })).statusCode).toBe(200);
    const caught = (await pull(laptop, { entry_cursor: { seq: 0 }, seq_cursors: { tags: 0 } })).json();
    expect(caught.entries).toHaveLength(5);
    expect(caught.tags).toHaveLength(1);
    const entryCursor = caught.entry_cursor as { seq: number };
    const tagCursor = caught.seq_cursors.tags as number;

    expect((await post("/sync/reset", {}, desktop.accessToken)).statusCode).toBe(200);
    // The desktop that reset pushes its rows again plus a new one.
    const fresh = entry(desktop.deviceId, "2026-09-02T10:00:00.000Z");
    const freshTag = tag("enc-B", "2026-09-02T10:00:00.000Z");
    expect((await push(desktop, { entries: [...before, fresh], tags: [freshTag] })).statusCode).toBe(200);

    // The laptop kept its cursors and still gets every row pushed since.
    const next = (await pull(laptop, { entry_cursor: entryCursor, seq_cursors: { tags: tagCursor } })).json();
    expect(next.entries.map((e: { uuid: string }) => e.uuid)).toContain(fresh.uuid);
    expect(next.entries).toHaveLength(6);
    expect(next.tags.map((t: { uuid: string }) => t.uuid)).toEqual([freshTag.uuid]);
    for (const e of next.entries) expect(e.seq).toBeGreaterThan(entryCursor.seq);
  });

  it("keeps the icon counter up when the highest icon is removed", async () => {
    const icon = (n: string, at: string) => ({
      name_hash: n.repeat(64),
      app_name: "enc-App",
      platform: "darwin",
      data_url: "enc-data",
      dominant_color: "#000",
      updated_at: at,
    });
    await push(desktop, { icons: [icon("a", "2026-09-01T10:00:00.000Z"), icon("b", "2026-09-01T10:00:01.000Z")] });
    const caught = (await pull(laptop, { seq_cursors: { icons: 0 } })).json();
    const cursor = caught.seq_cursors.icons as number;
    expect(caught.icons).toHaveLength(2);

    // b had the highest number; removing it must not hand that number out again.
    expect((await push(desktop, { icons_remove: ["b".repeat(64)] })).statusCode).toBe(200);
    await push(desktop, { icons: [icon("c", "2026-09-01T10:00:02.000Z")] });
    const next = (await pull(laptop, { seq_cursors: { icons: cursor } })).json();
    expect(next.icons.map((i: { name_hash: string }) => i.name_hash)).toEqual(["c".repeat(64)]);
  });

  it("raises the floors before an account is deleted", async () => {
    await push(desktop, { entries: [entry(desktop.deviceId, "2026-09-01T10:00:00.000Z")] });
    const max = h.db.prepare("SELECT MAX(seq) AS s FROM sync_entries").get() as { s: number };
    // A second admin, so the first may delete its account.
    h.db
      .prepare(
        `INSERT INTO users (id, email, display_name, password_hash, password_salt, role)
         VALUES ('other', 'other@test.lan', 'Other', 'x', 'x', 'admin')`,
      )
      .run();
    const del = await h.app.inject({
      method: "DELETE",
      url: "/user/account",
      headers: { authorization: `Bearer ${desktop.accessToken}` },
      payload: { password: "hunter2hunter2" },
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM sync_entries").get()).toEqual({ n: 0 });
    const floor = h.db.prepare("SELECT seq FROM sync_seq_floor WHERE tbl = 'sync_entries'").get() as { seq: number };
    expect(floor.seq).toBe(max.s);
  });

  it("doesn't skip entries that share the page boundary's updated_at", async () => {
    // One bulk retag stamps every row alike; 600 rows straddle the 500 page.
    const at = "2026-09-01T10:00:00.000Z";
    const rows = Array.from({ length: 600 }, () => entry(desktop.deviceId, at));
    expect((await push(desktop, { entries: rows.slice(0, 500) })).statusCode).toBe(200);
    expect((await push(desktop, { entries: rows.slice(500) })).statusCode).toBe(200);

    const { seen, cursors } = await replay(laptop);
    expect(new Set(seen).size).toBe(600);
    expect(cursors[0]).toEqual({ after: at, uuid: expect.any(String), until: expect.any(Number) });
  });

  it("picks up rows pushed during a replay with older edit times", async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      entry(desktop.deviceId, new Date(Date.parse("2026-09-10T00:00:00.000Z") + i * 1000).toISOString()),
    );
    await push(desktop, { entries: rows.slice(0, 500) });
    await push(desktop, { entries: rows.slice(500) });

    const first = (await pull(laptop, { entry_cursor: { after: EPOCH } })).json();
    expect(first.entries).toHaveLength(500);
    const until = first.entry_cursor.until as number;

    // Another computer's offline backlog, edited before the replay's position.
    const late = entry(desktop.deviceId, "2026-09-01T00:00:00.000Z");
    await push(desktop, { entries: [late] });

    const last = (await pull(laptop, { entry_cursor: first.entry_cursor })).json();
    expect(last.has_more).toBe(false);
    expect(last.entry_cursor).toEqual({ seq: until });
    const bySeq = (await pull(laptop, { entry_cursor: last.entry_cursor })).json();
    expect(bySeq.entries.map((e: { uuid: string }) => e.uuid)).toContain(late.uuid);
  });

  it("keeps an entry cursor's extras only when they are well-formed", () => {
    expect(parseEntryCursor({ after: EPOCH, uuid: "u", until: 7 })).toEqual({ after: EPOCH, uuid: "u", until: 7 });
    expect(parseEntryCursor({ after: EPOCH, uuid: 3, until: "7" })).toEqual({ after: EPOCH });
    expect(parseEntryCursor({ after: EPOCH, uuid: "", until: -1 })).toEqual({ after: EPOCH });
    expect(parseEntryCursor({ seq: 4, uuid: "u" })).toEqual({ seq: 4 });
  });

  it("syncs ignored_all_breakdowns and names unknown setting keys", async () => {
    const res = await push(desktop, {
      settings: [
        { key: "ignored_all_breakdowns", value: "enc-[]", updated_at: "2026-09-01T10:00:00.000Z" },
        { key: "not_a_synced_key", value: "x", updated_at: "2026-09-01T10:00:00.000Z" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected_settings).toEqual(["not_a_synced_key"]);
    const pulled = (await pull(laptop)).json();
    expect(pulled.settings.map((s: { key: string }) => s.key)).toEqual(["ignored_all_breakdowns"]);

    const clean = await push(desktop, {
      settings: [{ key: "ignored_apps", value: "enc-[]", updated_at: "2026-09-01T10:00:00.000Z" }],
    });
    expect(clean.json()).not.toHaveProperty("rejected_settings");
  });

  it("keeps an alert's note when a push leaves it out", async () => {
    await push(desktop, { reminders: [reminder({ note_uuid: "note-1", updated_at: "2026-09-01T10:00:00.000Z" })] });
    const noteOf = async () =>
      (await pull(laptop, { seq_cursors: { reminders: 0 } })).json().reminders[0].note_uuid;
    expect(await noteOf()).toBe("note-1");

    // An older client that doesn't know the field.
    await push(desktop, { reminders: [reminder({ updated_at: "2026-09-01T11:00:00.000Z" })] });
    expect(await noteOf()).toBe("note-1");

    // "" takes the alert off its note.
    await push(desktop, { reminders: [reminder({ note_uuid: "", updated_at: "2026-09-01T12:00:00.000Z" })] });
    expect(await noteOf()).toBe("");

    // The time-cursor pull returns it too.
    const legacy = (await pull(laptop)).json();
    expect(legacy.reminders[0].note_uuid).toBe("");
  });

  it("drops old dated reminder claims and keeps one-time ones", async () => {
    const old = new Date(Date.now() - (CLAIM_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const add = h.db.prepare(
      "INSERT INTO sync_reminder_claims (user_id, occurrence_key, device_id, claimed_at) VALUES (?, ?, ?, ?)",
    );
    const userId = (h.db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string }).id;
    add.run(userId, "r1:interval:2026-01-01T09:00", desktop.deviceId, old);
    add.run(userId, "r2:once", desktop.deviceId, old);
    add.run(userId, "r3:repeat:2026-10-30", desktop.deviceId, recent);

    const res = await post("/sync/reminder-claim", { occurrence_key: "r4:repeat:2026-10-31" }, desktop.accessToken);
    expect(res.json()).toEqual({ claimed: true, repeat: false });
    const keys = (
      h.db.prepare("SELECT occurrence_key FROM sync_reminder_claims ORDER BY occurrence_key").all() as Array<{ occurrence_key: string }>
    ).map((r) => r.occurrence_key);
    expect(keys).toEqual(["r2:once", "r3:repeat:2026-10-30", "r4:repeat:2026-10-31"]);
  });
});
