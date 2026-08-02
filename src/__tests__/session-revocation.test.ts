// SPDX-License-Identifier: Apache-2.0
//
// Session revocation on password change (024).
//
// Access tokens are stateless HS256 JWTs valid for an hour, so deleting
// refresh_tokens only stops renewal — a token already issued keeps working
// until it expires. `token_version` closes that window. These tests cover
// both directions: sessions that must die, and the caller's own session
// plus pre-024 tokens, which must not.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signJWT } from "../lib/crypto.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

const PASSWORD = "hunter2hunter2";

/** Signs in the same account on a second device, as a real client would. */
async function secondDevice(
  h: Harness,
): Promise<{ accessToken: string; refreshToken: string; deviceId: string }> {
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "admin@test.lan",
      password: PASSWORD,
      device_name: "Second Mac",
      platform: "darwin",
    },
  });
  const body = res.json() as {
    accessToken: string;
    refreshToken: string;
    device_id: string;
  };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    deviceId: body.device_id,
  };
}

function profile(h: Harness, token: string) {
  return h.app.inject({
    method: "GET",
    url: "/user/profile",
    headers: { authorization: `Bearer ${token}` },
  });
}

function changePassword(h: Harness, token: string, next: string) {
  return h.app.inject({
    method: "PATCH",
    url: "/user/password",
    headers: { authorization: `Bearer ${token}` },
    payload: { current_password: PASSWORD, new_password: next },
  });
}

describe("password change session revocation", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("kills another device's access token immediately", async () => {
    const admin = await bootstrapAdmin(h);
    const other = await secondDevice(h);
    expect((await profile(h, other.accessToken)).statusCode).toBe(200);

    const res = await changePassword(h, admin.accessToken, "newpassword123");
    expect(res.statusCode).toBe(200);

    const after = await profile(h, other.accessToken);
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("token_revoked");
  });

  it("kills another device's refresh token", async () => {
    const admin = await bootstrapAdmin(h);
    const other = await secondDevice(h);

    await changePassword(h, admin.accessToken, "newpassword123");

    const refreshed = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: other.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
  });

  it("returns a working token pair for the caller's own device", async () => {
    const admin = await bootstrapAdmin(h);
    const res = await changePassword(h, admin.accessToken, "newpassword123");
    const body = res.json() as { accessToken?: string; refreshToken?: string };

    expect(body.accessToken).toBeTypeOf("string");
    expect(body.refreshToken).toBeTypeOf("string");
    // The pre-change token is dead...
    expect((await profile(h, admin.accessToken)).statusCode).toBe(401);
    // ...and the one handed back in its place works.
    expect((await profile(h, body.accessToken!)).statusCode).toBe(200);

    const refreshed = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: body.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
  });

  it("leaves other accounts' sessions alone", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await h.app.inject({
      method: "POST",
      url: "/admin/invites",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    const reg = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "other@test.lan",
        password: PASSWORD,
        display_name: "Other",
        device_name: "Other PC",
        platform: "win32",
        invite_token: (invite.json() as { token: string }).token,
      },
    });
    const other = reg.json() as { accessToken: string };

    await changePassword(h, admin.accessToken, "newpassword123");

    expect((await profile(h, other.accessToken)).statusCode).toBe(200);
  });

  it("accepts a pre-024 token that carries no token_version claim", async () => {
    // Tokens minted before the column existed are still in flight for up to
    // an hour after an upgrade. A missing claim reads as 0, which matches the
    // column default, so these must keep working rather than mass-logout
    // every user at deploy time.
    const admin = await bootstrapAdmin(h);
    const now = Math.floor(Date.now() / 1000);
    const legacy = await signJWT(
      {
        sub: admin.userId,
        email: "admin@test.lan",
        plan: "home",
        role: "admin",
        device_id: admin.deviceId,
        iat: now,
        exp: now + 3600,
      },
      h.jwtSecret,
    );

    expect((await profile(h, legacy)).statusCode).toBe(200);
  });

  it("revokes a pre-024 token once the password changes", async () => {
    const admin = await bootstrapAdmin(h);
    const now = Math.floor(Date.now() / 1000);
    const legacy = await signJWT(
      {
        sub: admin.userId,
        email: "admin@test.lan",
        plan: "home",
        role: "admin",
        device_id: admin.deviceId,
        iat: now,
        exp: now + 3600,
      },
      h.jwtSecret,
    );

    await changePassword(h, admin.accessToken, "newpassword123");

    const after = await profile(h, legacy);
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("token_revoked");
  });

  it("lets the user sign in with the new password afterwards", async () => {
    const admin = await bootstrapAdmin(h);
    await changePassword(h, admin.accessToken, "newpassword123");

    const login = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "newpassword123",
        device_name: "Fresh Mac",
        platform: "darwin",
      },
    });
    expect(login.statusCode).toBe(200);
    expect((await profile(h, login.json().accessToken)).statusCode).toBe(200);
  });
});

describe("/user/sync-key/unlock rate limit", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("caps unlock attempts per window without blocking normal use", async () => {
    const admin = await bootstrapAdmin(h);
    const dek = "0123456789abcdef".repeat(4);

    const stored = await h.app.inject({
      method: "PUT",
      url: "/user/sync-key/server",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { encryption_key: dek },
    });
    expect(stored.statusCode).toBe(200);

    const unlock = () =>
      h.app.inject({
        method: "POST",
        url: "/user/sync-key/unlock",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });

    // A real client unlocks once per session; the cap sits far above that.
    const first = await unlock();
    expect(first.statusCode).toBe(200);
    expect(first.json().encryption_key).toBe(dek);

    for (let i = 1; i < 30; i++) {
      expect((await unlock()).statusCode).toBe(200);
    }
    const limited = await unlock();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });
});
