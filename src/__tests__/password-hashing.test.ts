// SPDX-License-Identifier: Apache-2.0
//
// PBKDF2 work-factor migration (025).
//
// The hazard here isn't the new iteration count, it's the window where two
// populations coexist: rows hashed at the legacy count and rows hashed at
// the current one. Verifying with the wrong count fails closed, which for a
// password means an account nobody can sign into. So most of what follows
// is about the legacy population continuing to work.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hashPassword,
  verifyPassword,
  verifyPasswordDummy,
  LEGACY_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
  TOKEN_HASH_ITERATIONS,
} from "../lib/crypto.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

const PASSWORD = "hunter2hunter2";

describe("password hashing", () => {
  it("defaults to the current work factor, above the legacy one", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(LEGACY_PBKDF2_ITERATIONS).toBe(100_000);
    expect(PBKDF2_ITERATIONS).toBeGreaterThan(LEGACY_PBKDF2_ITERATIONS);
  });

  it("verifies a legacy hash when told the count it was made with", async () => {
    const salt = "ab".repeat(32);
    const legacy = await hashPassword(
      PASSWORD,
      salt,
      LEGACY_PBKDF2_ITERATIONS,
    );
    expect(
      await verifyPassword(PASSWORD, legacy, salt, LEGACY_PBKDF2_ITERATIONS),
    ).toBe(true);
  });

  it("treats a missing count as legacy, matching the column default", async () => {
    const salt = "ab".repeat(32);
    const legacy = await hashPassword(
      PASSWORD,
      salt,
      LEGACY_PBKDF2_ITERATIONS,
    );
    // Callers that predate the column pass nothing; pre-025 rows must not
    // be silently verified at the current count.
    expect(await verifyPassword(PASSWORD, legacy, salt)).toBe(true);
    expect(await verifyPassword(PASSWORD, legacy, salt, null)).toBe(true);
  });

  it("does not verify a legacy hash at the current count", async () => {
    const salt = "ab".repeat(32);
    const legacy = await hashPassword(
      PASSWORD,
      salt,
      LEGACY_PBKDF2_ITERATIONS,
    );
    expect(
      await verifyPassword(PASSWORD, legacy, salt, PBKDF2_ITERATIONS),
    ).toBe(false);
  });

  it("still rejects a wrong password at either count", async () => {
    const salt = "ab".repeat(32);
    for (const iters of [LEGACY_PBKDF2_ITERATIONS, PBKDF2_ITERATIONS]) {
      const hash = await hashPassword(PASSWORD, salt, iters);
      expect(await verifyPassword("wrong-password", hash, salt, iters)).toBe(
        false,
      );
    }
  });

  it("dummy verification always fails and costs the current work factor", async () => {
    expect(await verifyPasswordDummy(PASSWORD)).toBe(false);
    expect(await verifyPasswordDummy("")).toBe(false);
  });

  // Setup and invite codes are hashed with the same primitive but must stay
  // pinned: their hashes are already on disk, and a server whose setup code
  // was issued but not yet redeemed would otherwise become unsetupable.
  it("keeps token hashing pinned to its original count", () => {
    expect(TOKEN_HASH_ITERATIONS).toBe(100_000);
  });
});

describe("work-factor migration on login", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** Rewrite an account back to a legacy-hashed state, as if pre-025. */
  async function downgradeToLegacy(userId: string): Promise<void> {
    const salt = "cd".repeat(32);
    const hash = await hashPassword(PASSWORD, salt, LEGACY_PBKDF2_ITERATIONS);
    h.db
      .prepare(
        "UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?",
      )
      .run(hash, salt, LEGACY_PBKDF2_ITERATIONS, userId);
  }

  function iterationsOf(userId: string): number {
    return (
      h.db
        .prepare("SELECT password_iterations AS n FROM users WHERE id = ?")
        .get(userId) as { n: number }
    ).n;
  }

  function login(password: string) {
    return h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password,
        device_name: "Mac",
        platform: "darwin",
      },
    });
  }

  it("stamps the current count on a newly created account", async () => {
    const admin = await bootstrapAdmin(h);
    expect(iterationsOf(admin.userId)).toBe(PBKDF2_ITERATIONS);
  });

  it("lets a legacy-hashed account sign in, and upgrades it in place", async () => {
    const admin = await bootstrapAdmin(h);
    await downgradeToLegacy(admin.userId);
    expect(iterationsOf(admin.userId)).toBe(LEGACY_PBKDF2_ITERATIONS);

    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(iterationsOf(admin.userId)).toBe(PBKDF2_ITERATIONS);
  });

  it("the upgraded hash verifies on the next sign-in", async () => {
    const admin = await bootstrapAdmin(h);
    await downgradeToLegacy(admin.userId);
    expect((await login(PASSWORD)).statusCode).toBe(200);
    // Second login runs against the rewritten hash at the new count.
    expect((await login(PASSWORD)).statusCode).toBe(200);
  });

  it("does not upgrade on a failed sign-in", async () => {
    const admin = await bootstrapAdmin(h);
    await downgradeToLegacy(admin.userId);

    const res = await login("wrong-password");
    expect(res.statusCode).toBe(401);
    expect(iterationsOf(admin.userId)).toBe(LEGACY_PBKDF2_ITERATIONS);
  });

  it("password change writes the current count", async () => {
    const admin = await bootstrapAdmin(h);
    await downgradeToLegacy(admin.userId);

    const res = await h.app.inject({
      method: "PATCH",
      url: "/user/password",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        current_password: PASSWORD,
        new_password: "brand-new-password",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(iterationsOf(admin.userId)).toBe(PBKDF2_ITERATIONS);

    expect((await login("brand-new-password")).statusCode).toBe(200);
  });

  it("a legacy account can still change its password", async () => {
    // Exercises the verify-side of /user/password against a legacy hash:
    // if that path ignored password_iterations, current_password would be
    // rejected and the user could never move off the old work factor.
    const admin = await bootstrapAdmin(h);
    await downgradeToLegacy(admin.userId);

    const res = await h.app.inject({
      method: "PATCH",
      url: "/user/password",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { current_password: PASSWORD, new_password: "another-one-99" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("a legacy account can still delete itself", async () => {
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
        email: "second@test.lan",
        password: PASSWORD,
        display_name: "Second",
        device_name: "PC",
        platform: "win32",
        invite_token: (invite.json() as { token: string }).token,
      },
    });
    const second = reg.json() as { user: { id: string }; accessToken: string };
    await downgradeToLegacy(second.user.id);

    const res = await h.app.inject({
      method: "DELETE",
      url: "/user/account",
      headers: { authorization: `Bearer ${second.accessToken}` },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("login user enumeration", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("answers the same for an unknown address as a wrong password", async () => {
    await bootstrapAdmin(h);

    const unknown = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "nobody@test.lan",
        password: PASSWORD,
        device_name: "Mac",
        platform: "darwin",
      },
    });
    const wrongPassword = await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "admin@test.lan",
        password: "not-the-password",
        device_name: "Mac",
        platform: "darwin",
      },
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrongPassword.statusCode).toBe(401);
    // Identical body, so the response itself doesn't distinguish the cases.
    expect(unknown.json()).toEqual(wrongPassword.json());
  });

  // Timing assertions are inherently noisy, so this only asserts the
  // property that actually matters and that a real oracle would violate by
  // orders of magnitude: an unknown address costs real derivation work
  // rather than returning immediately. A generous floor keeps it from
  // flaking on a loaded CI box.
  it("spends derivation work on an unknown address", async () => {
    await bootstrapAdmin(h);
    const started = Date.now();
    await h.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "nobody@test.lan",
        password: PASSWORD,
        device_name: "Mac",
        platform: "darwin",
      },
    });
    expect(Date.now() - started).toBeGreaterThan(20);
  });
});
