// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./harness.js";

describe("/setup", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("bootstraps an admin on first boot", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/setup",
      payload: {
        setup_token: h.setupToken,
        email: "admin@lan",
        password: "hunter2pw",
        display_name: "Admin",
        device_name: "Mac",
        platform: "darwin",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.role).toBe("admin");
    expect(body.user.plan).toBe("home");
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
  });

  it("rejects an invalid setup token", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/setup",
      payload: {
        setup_token: "NOPE-NOPE-NOPE",
        email: "admin@lan",
        password: "hunter2pw",
        display_name: "Admin",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 410 on replay after setup completes", async () => {
    await h.app.inject({
      method: "POST",
      url: "/setup",
      payload: {
        setup_token: h.setupToken,
        email: "admin@lan",
        password: "hunter2pw",
        display_name: "Admin",
      },
    });
    const replay = await h.app.inject({
      method: "POST",
      url: "/setup",
      payload: {
        setup_token: h.setupToken,
        email: "other@lan",
        password: "hunter2pw",
        display_name: "Other",
      },
    });
    expect(replay.statusCode).toBe(410);
  });

  it("/server-info flips setup_required after setup", async () => {
    const before = await h.app.inject({ method: "GET", url: "/server-info" });
    expect(before.json().setup_required).toBe(true);
    await h.app.inject({
      method: "POST",
      url: "/setup",
      payload: {
        setup_token: h.setupToken,
        email: "admin@lan",
        password: "hunter2pw",
        display_name: "Admin",
      },
    });
    const after = await h.app.inject({ method: "GET", url: "/server-info" });
    expect(after.json().setup_required).toBe(false);
  });

  it("/server-info advertises min_client_version", async () => {
    // The client reads this on every cycle's first refresh and gates
    // its own runtime against it. Format must be a semver-shaped string
    // so the client's compareSemver can use it directly.
    const res = await h.app.inject({ method: "GET", url: "/server-info" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.min_client_version).toBe("string");
    expect(body.min_client_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("/server-info advertises the package.json version", async () => {
    // version.ts is a hand-maintained mirror of package.json (kept in code
    // so a commit-pinned build has a deterministic version). It has been
    // forgotten on release before — leaving the server advertising a stale
    // version to clients. Fail the build if the two ever drift again.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const res = await h.app.inject({ method: "GET", url: "/server-info" });
    expect(res.json().version).toBe(pkg.version);
  });
});
