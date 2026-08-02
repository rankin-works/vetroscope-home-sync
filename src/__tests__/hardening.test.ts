// SPDX-License-Identifier: Apache-2.0
//
// Deployment-surface hardening: proxy trust, invite lookup, /health
// disclosure, and malformed-token handling.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInvite } from "../lib/invite-service.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

describe("proxy trust", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  // The rate limiters key on request.ip. If a forwarded header we can't
  // verify sets that, an attacker rotates it per request and gets a fresh
  // bucket every time — which removes the cap on password and setup-code
  // guessing entirely. Off by default, so the header is ignored.
  it("ignores X-Forwarded-For by default, so the limiter still bites", async () => {
    h = await createHarness();
    await bootstrapAdmin(h);

    const attempt = (forwardedFor: string) =>
      h.app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": forwardedFor },
        payload: {
          email: "admin@test.lan",
          password: "wrong-password",
          device_name: "Mac",
          platform: "darwin",
        },
      });

    // A different spoofed source per request. With the header trusted these
    // would be 11 separate buckets and all would pass.
    let sawRateLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await attempt(`203.0.113.${i}`);
      if (res.statusCode === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });

  it("honours the header when the operator opts in", async () => {
    h = await createHarness({ VS_TRUST_PROXY: "true" });
    await bootstrapAdmin(h);

    // Same traffic, but now each spoofed source is its own bucket. This is
    // correct *behind a real proxy*, which is why it takes an explicit flag.
    for (let i = 0; i < 12; i++) {
      const res = await h.app.inject({
        method: "POST",
        url: "/auth/login",
        headers: { "x-forwarded-for": `203.0.113.${i}` },
        payload: {
          email: "admin@test.lan",
          password: "wrong-password",
          device_name: "Mac",
          platform: "darwin",
        },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("/health disclosure", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("reports liveness without account counts by default", async () => {
    h = await createHarness();
    await bootstrapAdmin(h);

    const res = await h.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Still enough for the Docker HEALTHCHECK and the client's wizard.
    expect(body.ok).toBe(true);
    expect(body.version).toBeTypeOf("string");
    // But nothing about who or how much is on this server.
    expect(body).not.toHaveProperty("users");
    expect(body).not.toHaveProperty("database_size_bytes");
  });

  it("includes operator metrics when explicitly enabled", async () => {
    h = await createHarness({ VS_ENABLE_METRICS: "true" });
    await bootstrapAdmin(h);

    const body = (
      await h.app.inject({ method: "GET", url: "/health" })
    ).json() as Record<string, unknown>;
    expect(body.users).toBe(1);
    expect(body.database_size_bytes).toBeTypeOf("number");
  });
});

describe("malformed bearer tokens", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  // Garbage in the Authorization header is unauthenticated input. Decoding
  // it can throw, and an uncaught throw here would answer 500 with a logged
  // stack instead of the 401 the request deserves.
  it("answers 401 rather than 500 for undecodable tokens", async () => {
    const tokens = [
      "not.a.jwt",
      "a.b.!!!!",
      "...",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.@@@@@@",
      `${"A".repeat(50)}.${"B".repeat(50)}.${"%".repeat(10)}`,
      "Zm9v.YmFy.YmF6",
    ];
    for (const token of tokens) {
      const res = await h.app.inject({
        method: "GET",
        url: "/user/profile",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `token: ${token}`).toBe(401);
    }
  });

  it("rejects a token signed with the wrong secret", async () => {
    const { signJWT } = await import("../lib/crypto.js");
    const now = Math.floor(Date.now() / 1000);
    const forged = await signJWT(
      {
        sub: "someone",
        email: "x@y.z",
        plan: "home",
        role: "admin",
        device_id: "d",
        iat: now,
        exp: now + 3600,
      },
      "not-the-server-secret",
    );
    const res = await h.app.inject({
      method: "GET",
      url: "/user/profile",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });
});

describe("invite consumption", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  function register(email: string, inviteToken: string) {
    return h.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email,
        password: "hunter2hunter2",
        display_name: "New",
        device_name: "PC",
        platform: "win32",
        invite_token: inviteToken,
      },
    });
  }

  it("accepts a valid invite exactly once", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await createInvite(h.db, admin.userId);

    expect((await register("first@test.lan", invite.token)).statusCode).toBe(
      200,
    );
    // Single-use: the second attempt finds it consumed.
    expect((await register("second@test.lan", invite.token)).statusCode).toBe(
      401,
    );
  });

  it("rejects an unknown code", async () => {
    await bootstrapAdmin(h);
    const res = await register("nobody@test.lan", "ZZZZ-ZZZZ-ZZZZ");
    expect(res.statusCode).toBe(401);
  });

  it("is case-insensitive, as the printed code implies", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await createInvite(h.db, admin.userId);
    const res = await register("lower@test.lan", invite.token.toLowerCase());
    expect(res.statusCode).toBe(200);
  });

  it("picks the right invite out of many without scanning them all", async () => {
    const admin = await bootstrapAdmin(h);
    const invites = [];
    for (let i = 0; i < 20; i++) {
      invites.push(await createInvite(h.db, admin.userId));
    }
    // The locator column means this costs one derivation, not twenty.
    const target = invites[13]!;
    expect((await register("target@test.lan", target.token)).statusCode).toBe(
      200,
    );

    const used = h.db
      .prepare("SELECT used_at FROM invites WHERE id = ?")
      .get(target.id) as { used_at: string | null };
    expect(used.used_at).not.toBeNull();

    // Every other invite is untouched.
    const remaining = h.db
      .prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL")
      .get() as { n: number };
    expect(remaining.n).toBe(19);
  });

  it("still honours invites issued before the locator existed", async () => {
    const admin = await bootstrapAdmin(h);
    const invite = await createInvite(h.db, admin.userId);
    // Simulate a row created before migration 026: the salted hash is
    // one-way, so those rows could never be backfilled and must keep
    // working through the scan path.
    h.db
      .prepare("UPDATE invites SET token_lookup = NULL WHERE id = ?")
      .run(invite.id);

    expect((await register("legacy@test.lan", invite.token)).statusCode).toBe(
      200,
    );
  });
});
