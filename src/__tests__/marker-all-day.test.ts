// SPDX-License-Identifier: Apache-2.0
//
// An all-day event's dates on sync_markers (040): a push with them stores
// them, a push without the keys (or with null) keeps them unless it moves
// the event, "" clears both, an invalid value keeps both, both pulls return them, and a push carrying
// another user's uuid changes nothing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allDayFields } from "../routes/sync.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

interface Device {
  token: string;
  userId: string;
}

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.cleanup();
});

function call(d: Device, url: string, payload: Record<string, unknown>) {
  return h.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${d.token}` },
    payload,
  });
}

async function admin(): Promise<Device> {
  const a = await bootstrapAdmin(h);
  return { token: a.accessToken, userId: a.userId };
}

async function otherUser(adminDev: Device): Promise<Device> {
  const invite = await call(adminDev, "/admin/invites", {});
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
  const body = res.json() as { accessToken: string; user: { id: string } };
  return { token: body.accessToken, userId: body.user.id };
}

// A New York computer's import of an all-day event on 2026-11-26.
let tick = 0;
function marker(uuid: string, over: Record<string, unknown> = {}) {
  tick++;
  return {
    uuid,
    timestamp: "2026-11-26T05:00:00.000Z",
    end_timestamp: null,
    label: "enc-label",
    color: "#f59e0b",
    icon: "flag",
    deleted: 0,
    origin: "google",
    updated_at: new Date(Date.UTC(2026, 9, 1) + tick * 1000).toISOString(),
    ...over,
  };
}

async function push(d: Device, markers: unknown[]) {
  const res = await call(d, "/sync/push", { markers });
  expect(res.statusCode).toBe(200);
}

function stored(uuid: string) {
  return h.db
    .prepare<
      [string],
      {
        all_day_start: string | null;
        all_day_end: string | null;
        label: string;
      }
    >("SELECT all_day_start, all_day_end, label FROM sync_markers WHERE uuid = ?")
    .get(uuid);
}

async function pulled(d: Device, bySeq: boolean, uuid: string) {
  const res = await call(d, "/sync/pull", {
    cursor: null,
    device_id: "x",
    ...(bySeq ? { seq_cursors: { markers: 0 } } : {}),
  });
  expect(res.statusCode).toBe(200);
  return (res.json().markers as Array<Record<string, unknown>>).find(
    (m) => m.uuid === uuid,
  );
}

describe("all-day dates on a marker push", () => {
  it("stores a one-day event's date and keeps it when a later push has no key", async () => {
    const d = await admin();
    await push(d, [
      marker("m1", { all_day_start: "2026-11-26", all_day_end: null }),
    ]);
    expect(stored("m1")).toMatchObject({
      all_day_start: "2026-11-26",
      all_day_end: null,
    });

    // An older client edits the label and knows nothing of the dates.
    await push(d, [marker("m1", { label: "enc-renamed" })]);
    expect(stored("m1")).toEqual({
      all_day_start: "2026-11-26",
      all_day_end: null,
      label: "enc-renamed",
    });
  });

  it("clears the dates when a push without the keys moves the event", async () => {
    const d = await admin();
    // Auckland (UTC+13): Nov 26 starts at 2026-11-25T11:00Z. An older
    // computer moves it to Nov 27, which is still within a day of the
    // stored date, so only the stored times can tell it moved.
    await push(d, [
      marker("m1", {
        timestamp: "2026-11-25T11:00:00.000Z",
        all_day_start: "2026-11-26",
      }),
    ]);
    await push(d, [marker("m1", { timestamp: "2026-11-26T11:00:00.000Z" })]);
    expect(stored("m1")).toMatchObject({ all_day_start: "", all_day_end: null });

    // A range's end stretched by a day, with null keys.
    await push(d, [
      marker("m2", {
        end_timestamp: "2026-12-27T05:00:00.000Z",
        all_day_start: "2026-12-24",
        all_day_end: "2026-12-27",
      }),
    ]);
    await push(d, [
      marker("m2", {
        end_timestamp: "2026-12-28T05:00:00.000Z",
        all_day_start: null,
        all_day_end: null,
      }),
    ]);
    expect(stored("m2")).toMatchObject({ all_day_start: "", all_day_end: null });

    // A row that never had dates stays NULL.
    await push(d, [marker("m3")]);
    await push(d, [marker("m3", { timestamp: "2026-11-27T05:00:00.000Z" })]);
    expect(stored("m3")).toMatchObject({ all_day_start: null, all_day_end: null });
  });

  it("keeps the dates when the same time is spelled another way", async () => {
    const d = await admin();
    await push(d, [marker("m1", { all_day_start: "2026-11-26" })]);
    await push(d, [
      marker("m1", { timestamp: "2026-11-26T05:00:00Z", label: "enc-renamed" }),
    ]);
    expect(stored("m1")).toMatchObject({
      all_day_start: "2026-11-26",
      all_day_end: null,
    });
  });

  it("stores a range and keeps it on null", async () => {
    const d = await admin();
    await push(d, [
      marker("m1", {
        end_timestamp: "2026-12-27T05:00:00.000Z",
        all_day_start: "2026-12-24",
        all_day_end: "2026-12-27",
      }),
    ]);
    expect(stored("m1")).toMatchObject({
      all_day_start: "2026-12-24",
      all_day_end: "2026-12-27",
    });
    await push(d, [
      marker("m1", {
        end_timestamp: "2026-12-27T05:00:00.000Z",
        all_day_start: null,
        all_day_end: null,
      }),
    ]);
    expect(stored("m1")).toMatchObject({
      all_day_start: "2026-12-24",
      all_day_end: "2026-12-27",
    });
  });

  it('clears both on ""', async () => {
    const d = await admin();
    await push(d, [
      marker("m1", { all_day_start: "2026-12-24", all_day_end: "2026-12-27" }),
    ]);
    await push(d, [
      marker("m1", {
        timestamp: "2026-12-24T15:00:00.000Z",
        all_day_start: "",
        all_day_end: null,
      }),
    ]);
    expect(stored("m1")).toMatchObject({
      all_day_start: "",
      all_day_end: null,
    });
  });

  it("keeps both on an invalid date or an end that isn't after the start", async () => {
    const d = await admin();
    await push(d, [
      marker("m1", { all_day_start: "2026-12-24", all_day_end: "2026-12-27" }),
    ]);
    for (const bad of [
      { all_day_start: "2026-02-30", all_day_end: null },
      { all_day_start: "26-11-2026", all_day_end: null },
      { all_day_start: 20261126, all_day_end: null },
      { all_day_start: "2026-12-24", all_day_end: "2026-12-24" },
      { all_day_start: "2026-12-24", all_day_end: "2026-12-20" },
      { all_day_start: "2026-12-24", all_day_end: "2026-13-01" },
      { all_day_start: "2026-12-24", all_day_end: "2040-01-01" },
    ]) {
      await push(d, [marker("m1", bad)]);
      expect(stored("m1")).toMatchObject({
        all_day_start: "2026-12-24",
        all_day_end: "2026-12-27",
      });
    }
  });

  it("stores NULL for a new row pushed without the keys", async () => {
    const d = await admin();
    await push(d, [marker("m1", { origin: "vetroscope" })]);
    expect(stored("m1")).toMatchObject({
      all_day_start: null,
      all_day_end: null,
    });
  });

  it("returns the dates from the pull by seq and the pull by time", async () => {
    const d = await admin();
    await push(d, [
      marker("m1", { all_day_start: "2026-12-24", all_day_end: "2026-12-27" }),
    ]);
    for (const bySeq of [true, false]) {
      const m = await pulled(d, bySeq, "m1");
      expect(m).toMatchObject({
        all_day_start: "2026-12-24",
        all_day_end: "2026-12-27",
      });
    }
  });

  it("changes nothing for a push carrying another user's uuid", async () => {
    const victim = await admin();
    const attacker = await otherUser(victim);
    await push(victim, [marker("m1", { all_day_start: "2026-11-26" })]);
    await push(attacker, [
      marker("m1", {
        label: "enc-attacker",
        all_day_start: "2027-01-01",
        updated_at: "2030-01-01T00:00:00.000Z",
      }),
    ]);
    expect(stored("m1")).toEqual({
      all_day_start: "2026-11-26",
      all_day_end: null,
      label: "enc-label",
    });
    expect(await pulled(attacker, true, "m1")).toBeUndefined();
  });
});

describe("allDayFields", () => {
  it("follows the keep / clear / set rule", () => {
    expect(allDayFields({})).toEqual({ set: 0, start: null, end: null });
    expect(allDayFields({ all_day_start: null })).toEqual({
      set: 0,
      start: null,
      end: null,
    });
    expect(
      allDayFields({ all_day_start: "", all_day_end: "2026-01-02" }),
    ).toEqual({ set: 1, start: "", end: null });
    expect(
      allDayFields({ all_day_start: "2026-01-01", all_day_end: "" }),
    ).toEqual({ set: 1, start: "2026-01-01", end: null });
    expect(
      allDayFields({ all_day_start: "2026-01-01", all_day_end: "2026-01-03" }),
    ).toEqual({
      set: 1,
      start: "2026-01-01",
      end: "2026-01-03",
    });
    expect(allDayFields({ all_day_start: "2024-02-29" })).toEqual({
      set: 1,
      start: "2024-02-29",
      end: null,
    });
    expect(allDayFields({ all_day_start: "2026-02-29" })).toEqual({
      set: 0,
      start: null,
      end: null,
    });
    // The longest allowed span is 3660 days.
    expect(
      allDayFields({ all_day_start: "2026-01-01", all_day_end: "2036-01-09" })
        .set,
    ).toBe(1);
    expect(
      allDayFields({ all_day_start: "2026-01-01", all_day_end: "2036-01-10" })
        .set,
    ).toBe(0);
  });
});
