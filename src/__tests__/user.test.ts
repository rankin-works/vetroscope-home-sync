// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

describe("/user", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("profile returns the caller's user + devices with is_current on the right row", async () => {
    const admin = await bootstrapAdmin(h);
    const res = await h.app.inject({
      method: "GET",
      url: "/user/profile",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.id).toBe(admin.userId);
    expect(body.devices[0].is_current).toBe(true);
    expect(body.user.onboarding_status).toBeNull();
    expect(body.user.onboarding_done).toBe(false);
  });

  it("onboarding complete + skip update profile disposition", async () => {
    const admin = await bootstrapAdmin(h);

    const complete = await h.app.inject({
      method: "POST",
      url: "/user/onboarding/complete",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      ok: true,
      onboarding_status: "completed",
      onboarding_done: true,
    });

    let profile = await h.app.inject({
      method: "GET",
      url: "/user/profile",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(profile.json().user.onboarding_status).toBe("completed");
    expect(profile.json().user.onboarding_done).toBe(true);

    const skip = await h.app.inject({
      method: "POST",
      url: "/user/onboarding/skip",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(skip.statusCode).toBe(200);
    expect(skip.json().onboarding_status).toBe("skipped");

    profile = await h.app.inject({
      method: "GET",
      url: "/user/profile",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(profile.json().user.onboarding_status).toBe("skipped");
    expect(profile.json().user.onboarding_done).toBe(true);
  });

  it("password change invalidates old password and accepts new", async () => {
    const admin = await bootstrapAdmin(h);
    const change = await h.app.inject({
      method: "PATCH",
      url: "/user/password",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        current_password: "hunter2hunter2",
        new_password: "correct-horse-battery",
      },
    });
    expect(change.statusCode).toBe(200);

    const oldLogin = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "hunter2hunter2",
        device_name: "x",
        platform: "darwin",
      },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "correct-horse-battery",
        device_name: "x",
        platform: "darwin",
      },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("sync-key put + get round-trips an opaque blob", async () => {
    const admin = await bootstrapAdmin(h);
    const put = await h.app.inject({
      method: "PUT",
      url: "/user/sync-key",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { encrypted_sync_key: "deadbeef:cipher" },
    });
    expect(put.statusCode).toBe(200);
    const get = await h.app.inject({
      method: "GET",
      url: "/user/sync-key",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get.json().has_key).toBe(true);
    expect(get.json().encrypted_sync_key).toBe("deadbeef:cipher");
  });

  it("cannot unlink the current device", async () => {
    const admin = await bootstrapAdmin(h);
    const res = await h.app.inject({
      method: "DELETE",
      url: `/user/devices/${admin.deviceId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("last-admin cannot delete their own account", async () => {
    const admin = await bootstrapAdmin(h);
    const res = await h.app.inject({
      method: "DELETE",
      url: "/user/account",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { password: "hunter2hunter2" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last_admin");
  });
});
