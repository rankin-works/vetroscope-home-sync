// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

describe("POST /sync/reminder-claim", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("lets the first device claim and the second lose", async () => {
    const admin = await bootstrapAdmin(h);
    const loginB = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "hunter2hunter2",
        device_name: "Second Mac",
        platform: "darwin",
      },
    });
    expect(loginB.statusCode).toBe(200);
    const deviceB = loginB.json() as { accessToken: string };

    const key = "rem-uuid:goal:half:2026-07-20";
    const first = await h.app.inject({
      method: "POST",
      url: "/sync/reminder-claim",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { occurrence_key: key },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ claimed: true, repeat: false });

    const second = await h.app.inject({
      method: "POST",
      url: "/sync/reminder-claim",
      headers: { authorization: `Bearer ${deviceB.accessToken}` },
      payload: { occurrence_key: key },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ claimed: false, repeat: false });

    // The winner asking again (its local ack was lost) is told it already
    // showed this occurrence, so it acks instead of notifying again.
    const again = await h.app.inject({
      method: "POST",
      url: "/sync/reminder-claim",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { occurrence_key: key },
    });
    expect(again.json()).toEqual({ claimed: true, repeat: true });
  });
});
