// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

describe("auth flow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("login returns a token pair for a bootstrapped admin", async () => {
    await bootstrapAdmin(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "hunter2hunter2",
        device_id: "irrelevant-will-be-replaced",
        device_name: "Web",
        platform: "darwin",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.email).toBe("admin@test.lan");
  });

  it("login rejects bad password", async () => {
    await bootstrapAdmin(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "wrongwrong",
        device_name: "Web",
        platform: "darwin",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });

  it("refresh rotates the token and invalidates the old one", async () => {
    const admin = await bootstrapAdmin(h);
    const first = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: admin.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const second = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: admin.refreshToken },
    });
    expect(second.statusCode).toBe(401);
  });

  it("logout revokes the refresh token for the current device", async () => {
    const admin = await bootstrapAdmin(h);
    const out = await h.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(out.statusCode).toBe(200);
    const replay = await h.app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: admin.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("first-user /auth/register is blocked in favor of /setup", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "anyone@lan",
        password: "hunter2pw",
        display_name: "Any",
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("setup_required");
  });
});

describe("invite flow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("admin-issued invite lets a new user register exactly once", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await h.app.inject({
      method: "POST",
      url: "/admin/invites",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { role: "user", ttl_hours: 24 },
    });
    expect(invite.statusCode).toBe(201);
    const token = invite.json().token as string;

    const register = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "jane@lan",
        password: "hunter2hunter2",
        display_name: "Jane",
        device_name: "Laptop",
        platform: "win32",
        invite_token: token,
      },
    });
    expect(register.statusCode).toBe(200);
    expect(register.json().user.role).toBe("user");

    const replay = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "dup@lan",
        password: "hunter2hunter2",
        display_name: "Dup",
        device_name: "DUP",
        platform: "win32",
        invite_token: token,
      },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("closed registration mode blocks invite-less and invited signups", async () => {
    await h.cleanup();
    h = await createHarness({ VS_ALLOW_REGISTRATION: "closed" });
    const admin = await bootstrapAdmin(h);
    const invite = await h.app.inject({
      method: "POST",
      url: "/admin/invites",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    const token = invite.json().token as string;
    const res = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "blocked@lan",
        password: "hunter2hunter2",
        display_name: "Blocked",
        invite_token: token,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("non-admins cannot mint invites", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await h.app.inject({
      method: "POST",
      url: "/admin/invites",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });
    const token = invite.json().token as string;

    const regular = await h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "user@lan",
        password: "hunter2hunter2",
        display_name: "User",
        device_name: "Laptop",
        platform: "win32",
        invite_token: token,
      },
    });
    const userAccess = regular.json().accessToken as string;

    const attempt = await h.app.inject({
      method: "POST",
      url: "/admin/invites",
      headers: { authorization: `Bearer ${userAccess}` },
      payload: {},
    });
    expect(attempt.statusCode).toBe(403);
  });
});
