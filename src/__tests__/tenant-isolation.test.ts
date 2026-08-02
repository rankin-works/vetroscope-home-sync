// SPDX-License-Identifier: Apache-2.0
//
// Tenant-isolation regression suite for /sync/push.
//
// Every sync_* table keyed on a bare `uuid` PRIMARY KEY shares one global
// key space across all users on the server. Without a user guard on the
// conflict clause, a push carrying another user's uuid lands as an UPDATE
// of their row: the row keeps their user_id (so the attacker still can't
// read it back) but its contents — including `deleted` — become
// attacker-controlled.
//
// There is one case per uuid-keyed table, so a newly added sync table shows
// up here as a visible omission rather than silently inheriting the hole.
// Tables keyed on a composite that already contains user_id (sync_icons,
// sync_overrides, sync_settings, sync_reminder_claims) are structurally
// immune and are not covered here.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

// The attacker's push is strictly newer than the victim's, so the
// last-write-wins clause would accept it if the user guard were missing.
// Any failure here is the guard being gone, not a timestamp technicality.
const T_VICTIM = "2026-05-01T00:00:00.000Z";
const T_ATTACKER = "2026-06-01T00:00:00.000Z";

type Marker = string | number;

interface Case {
  /** Key on the /sync/push payload. */
  readonly payloadKey: string;
  readonly table: string;
  /** Column that carries the observable difference between the two pushes. */
  readonly column: string;
  readonly victimMarker: Marker;
  readonly attackerMarker: Marker;
  readonly row: (
    uuid: string,
    updatedAt: string,
    marker: Marker,
    deviceId: string,
  ) => Record<string, unknown>;
}

const CASES: readonly Case[] = [
  {
    payloadKey: "entries",
    table: "sync_entries",
    // Must be a column the conflict clause actually refreshes — `app_name`
    // is deliberately not in the UPDATE set, so asserting on it would pass
    // with or without the guard.
    column: "platform",
    victimMarker: "darwin",
    attackerMarker: "win32",
    row: (uuid, updated_at, marker, device_id) => ({
      uuid,
      device_id,
      timestamp: updated_at,
      app_name: "enc-app",
      window_title: "enc-title",
      project: null,
      is_adobe: 0,
      tag_uuid: null,
      platform: marker,
      updated_at,
    }),
  },
  {
    payloadKey: "tags",
    table: "sync_tags",
    column: "name",
    victimMarker: "enc-victim-tag",
    attackerMarker: "enc-attacker-tag",
    row: (uuid, updated_at, marker) => ({
      uuid,
      name: marker,
      color: "#000000",
      sticky: 0,
      deleted: 0,
      updated_at,
    }),
  },
  {
    payloadKey: "goals",
    table: "sync_goals",
    column: "target_seconds",
    victimMarker: 3600,
    attackerMarker: 99999,
    row: (uuid, updated_at, marker) => ({
      uuid,
      type: "app",
      app_name: "enc-Safari",
      tag_uuid: null,
      target_seconds: marker,
      enabled: 1,
      deleted: 0,
      created_at: updated_at,
      updated_at,
    }),
  },
  {
    payloadKey: "markers",
    table: "sync_markers",
    column: "label",
    victimMarker: "enc-victim-label",
    attackerMarker: "enc-attacker-label",
    row: (uuid, updated_at, marker) => ({
      uuid,
      timestamp: updated_at,
      end_timestamp: null,
      label: marker,
      color: "#ff0000",
      icon: "star",
      deleted: 0,
      updated_at,
    }),
  },
  {
    payloadKey: "tag_sticky_exclusions",
    table: "sync_tag_sticky_exclusions",
    column: "app_name",
    victimMarker: "enc-victim-excl",
    attackerMarker: "enc-attacker-excl",
    row: (uuid, updated_at, marker) => ({
      uuid,
      tag_uuid: "tag-abc",
      app_name: marker,
      project: "enc-project",
      deleted: 0,
      updated_at,
    }),
  },
  {
    payloadKey: "tag_sticky_project_apps",
    table: "sync_tag_sticky_project_apps",
    column: "app_name",
    victimMarker: "enc-victim-spa",
    attackerMarker: "enc-attacker-spa",
    row: (uuid, updated_at, marker) => ({
      uuid,
      tag_uuid: "tag-abc",
      app_name: marker,
      deleted: 0,
      updated_at,
    }),
  },
  {
    payloadKey: "tag_sticky_subproject_scopes",
    table: "sync_tag_sticky_subproject_scopes",
    column: "app_name",
    victimMarker: "enc-victim-sss",
    attackerMarker: "enc-attacker-sss",
    row: (uuid, updated_at, marker) => ({
      uuid,
      tag_uuid: "tag-abc",
      app_name: marker,
      project: "enc-project",
      deleted: 0,
      updated_at,
    }),
  },
  {
    payloadKey: "media_links",
    table: "sync_media_links",
    column: "url",
    victimMarker: "enc-victim-url",
    attackerMarker: "enc-attacker-url",
    row: (uuid, updated_at, marker) => ({
      uuid,
      app_name: "enc-Spotify",
      project: "enc-song",
      sub_project: "",
      url: marker,
      kind: "spotify",
      first_seen: updated_at,
      last_seen: updated_at,
      deleted: 0,
      updated_at,
    }),
  },
  {
    payloadKey: "reminders",
    table: "sync_reminders",
    column: "title",
    victimMarker: "enc-victim-reminder",
    attackerMarker: "enc-attacker-reminder",
    row: (uuid, updated_at, marker) => ({
      uuid,
      title: marker,
      body: "enc-body",
      kind: "tag",
      fire_at: null,
      weekdays: null,
      time_of_day: null,
      end_time_of_day: null,
      start_date: null,
      end_date: null,
      tag_uuid: "tag-abc",
      threshold_seconds: 3600,
      period: "day",
      icon_data_url: null,
      interval_seconds: null,
      app_name: null,
      project: null,
      goal_uuid: null,
      goal_notify_half: 1,
      goal_notify_complete: 1,
      enabled: 1,
      deleted: 0,
      last_fired_at: null,
      updated_at,
    }),
  },
  {
    payloadKey: "reminder_events",
    table: "sync_reminder_events",
    column: "title",
    victimMarker: "enc-victim-event",
    attackerMarker: "enc-attacker-event",
    row: (uuid, updated_at, marker) => ({
      uuid,
      reminder_uuid: "reminder-abc",
      title: marker,
      body: "enc-body",
      icon_data_url: null,
      fired_at: updated_at,
      read_at: null,
      dismissed_at: null,
      deleted: 0,
      updated_at,
    }),
  },
  {
    // Only three columns, so the tombstone flag itself is the marker — which
    // is also the highest-impact field: flipping it hides the victim's entry.
    payloadKey: "entry_dismissals",
    table: "sync_entry_dismissals",
    column: "deleted",
    victimMarker: 0,
    attackerMarker: 1,
    row: (uuid, updated_at, marker) => ({
      uuid,
      deleted: marker,
      updated_at,
    }),
  },
];

interface Account {
  accessToken: string;
  userId: string;
  deviceId: string;
}

async function registerSecondUser(
  h: Harness,
  adminToken: string,
): Promise<Account> {
  const invite = await h.app.inject({
    method: "POST",
    url: "/admin/invites",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {},
  });
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email: "attacker@test.lan",
      password: "hunter2hunter2",
      display_name: "Attacker",
      device_name: "Attacker PC",
      platform: "win32",
      invite_token: (invite.json() as { token: string }).token,
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as {
    user: { id: string };
    device_id: string;
    accessToken: string;
  };
  return {
    accessToken: body.accessToken,
    userId: body.user.id,
    deviceId: body.device_id,
  };
}

function push(h: Harness, token: string, payload: Record<string, unknown>) {
  return h.app.inject({
    method: "POST",
    url: "/sync/push",
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

describe("/sync/push tenant isolation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  for (const c of CASES) {
    it(`${c.table}: a push carrying another user's uuid cannot overwrite it`, async () => {
      const victim = await bootstrapAdmin(h);
      const attacker = await registerSecondUser(h, victim.accessToken);
      const uuid = `shared-${c.table}`;

      const victimPush = await push(h, victim.accessToken, {
        [c.payloadKey]: [
          c.row(uuid, T_VICTIM, c.victimMarker, victim.deviceId),
        ],
      });
      expect(victimPush.statusCode).toBe(200);

      // Strictly newer timestamp: LWW alone would accept this write.
      const attackerPush = await push(h, attacker.accessToken, {
        [c.payloadKey]: [
          c.row(uuid, T_ATTACKER, c.attackerMarker, attacker.deviceId),
        ],
      });
      expect(attackerPush.statusCode).toBe(200);

      const row = h.db
        .prepare(
          `SELECT user_id, ${c.column} AS marker, updated_at FROM ${c.table} WHERE uuid = ?`,
        )
        .get(uuid) as
        | { user_id: string; marker: Marker; updated_at: string }
        | undefined;

      expect(row).toBeDefined();
      expect(row!.user_id).toBe(victim.userId);
      expect(row!.marker).toBe(c.victimMarker);
      expect(row!.updated_at).toBe(T_VICTIM);

      // The row never becomes visible to the attacker either.
      const attackerPull = await h.app.inject({
        method: "POST",
        url: "/sync/pull",
        headers: { authorization: `Bearer ${attacker.accessToken}` },
        payload: { cursor: null, device_id: "other-device" },
      });
      const pulled = (attackerPull.json() as Record<string, unknown>)[
        c.payloadKey
      ] as Array<{ uuid: string }>;
      expect(pulled.find((r) => r.uuid === uuid)).toBeUndefined();
    });
  }

  it("a user's own rows still update under last-write-wins", async () => {
    const victim = await bootstrapAdmin(h);
    const c = CASES[0]!;
    const uuid = "own-row";

    await push(h, victim.accessToken, {
      [c.payloadKey]: [c.row(uuid, T_VICTIM, c.victimMarker, victim.deviceId)],
    });
    await push(h, victim.accessToken, {
      [c.payloadKey]: [
        c.row(uuid, T_ATTACKER, c.attackerMarker, victim.deviceId),
      ],
    });

    const row = h.db
      .prepare(
        `SELECT ${c.column} AS marker, updated_at FROM ${c.table} WHERE uuid = ?`,
      )
      .get(uuid) as { marker: Marker; updated_at: string };
    expect(row.marker).toBe(c.attackerMarker);
    expect(row.updated_at).toBe(T_ATTACKER);
  });

  it("two users pushing distinct uuids both persist", async () => {
    const victim = await bootstrapAdmin(h);
    const attacker = await registerSecondUser(h, victim.accessToken);
    const c = CASES[0]!;

    await push(h, victim.accessToken, {
      [c.payloadKey]: [c.row("row-a", T_VICTIM, "enc-a", victim.deviceId)],
    });
    await push(h, attacker.accessToken, {
      [c.payloadKey]: [c.row("row-b", T_VICTIM, "enc-b", attacker.deviceId)],
    });

    const rows = h.db
      .prepare(
        `SELECT uuid, user_id FROM ${c.table} WHERE uuid IN ('row-a','row-b') ORDER BY uuid`,
      )
      .all() as Array<{ uuid: string; user_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.user_id).toBe(victim.userId);
    expect(rows[1]!.user_id).toBe(attacker.userId);
  });
});

describe("/sync/push device_id integrity", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("rewrites an unknown device_id to the caller's own device", async () => {
    const victim = await bootstrapAdmin(h);
    const c = CASES[0]!;

    const res = await push(h, victim.accessToken, {
      entries: [c.row("e-unknown-device", T_VICTIM, "enc-app", "not-a-device")],
    });
    expect(res.statusCode).toBe(200);

    const row = h.db
      .prepare("SELECT device_id FROM sync_entries WHERE uuid = ?")
      .get("e-unknown-device") as { device_id: string };
    expect(row.device_id).toBe(victim.deviceId);
  });

  it("cannot attribute an entry to another user's device", async () => {
    const victim = await bootstrapAdmin(h);
    const attacker = await registerSecondUser(h, victim.accessToken);
    const c = CASES[0]!;

    await push(h, attacker.accessToken, {
      entries: [c.row("e-crossattr", T_VICTIM, "enc-app", victim.deviceId)],
    });

    const row = h.db
      .prepare("SELECT user_id, device_id FROM sync_entries WHERE uuid = ?")
      .get("e-crossattr") as { user_id: string; device_id: string };
    expect(row.user_id).toBe(attacker.userId);
    expect(row.device_id).toBe(attacker.deviceId);
  });

  it("preserves a legitimate device_id from another device of the same user", async () => {
    const victim = await bootstrapAdmin(h);
    const c = CASES[0]!;

    // Second device on the same account, registered via a normal login.
    const login = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "hunter2hunter2",
        device_name: "Admin iMac",
        platform: "darwin",
      },
    });
    const second = login.json() as { device_id: string };
    expect(second.device_id).not.toBe(victim.deviceId);

    await push(h, victim.accessToken, {
      entries: [c.row("e-otherdevice", T_VICTIM, "enc-app", second.device_id)],
    });

    const row = h.db
      .prepare("SELECT device_id FROM sync_entries WHERE uuid = ?")
      .get("e-otherdevice") as { device_id: string };
    expect(row.device_id).toBe(second.device_id);
  });
});
