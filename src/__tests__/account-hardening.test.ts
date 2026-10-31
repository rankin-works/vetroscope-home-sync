// SPDX-License-Identifier: Apache-2.0
//
// The stored sync key is replaced only on purpose, device ids never collide
// across accounts, demoted admins and revoked users lose their access
// tokens at once, and changing the JWT secret never strands the keys
// wrapped with it.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, decryptSyncDek, encryptSecret } from "../lib/secret-crypto.js";
import {
  bootstrapServerState,
  countUnreadableWraps,
  getState,
  rotateJwtSecret,
  SERVER_STATE_KEYS,
} from "../lib/server-state.js";
import { bootstrapAdmin, createHarness, type Harness } from "./harness.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

async function inviteUser(
  h: Harness,
  adminAccess: string,
  email: string,
  deviceId?: string,
) {
  const invite = await h.app.inject({
    method: "POST",
    url: "/admin/invites",
    headers: { authorization: `Bearer ${adminAccess}` },
    payload: { role: "user", ttl_hours: 24 },
  });
  return h.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      email,
      password: "hunter2hunter2",
      display_name: "User",
      device_name: "Laptop",
      platform: "win32",
      invite_token: invite.json().token,
      ...(deviceId ? { device_id: deviceId } : {}),
    },
  });
}

function runCli(h: Harness, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(
    process.execPath,
    [join("node_modules", "tsx", "dist", "cli.mjs"), join("src", "cli", "index.ts"), ...args],
    { env: { ...process.env, VS_DATA_DIR: h.dataDir, ...env }, encoding: "utf8", stdio: "pipe" },
  );
}

describe("account hardening", () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof bootstrapAdmin>>;
  const put = (url: string, payload: Record<string, unknown>) =>
    h.app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });

  beforeEach(async () => {
    h = await createHarness();
    admin = await bootstrapAdmin(h);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  describe("sync key overwrite", () => {
    // Desktops send `rekey` from 1.3.7 on; older ones are let through on
    // the recovery-wrap route (see below).
    const setAppVersion = (v: string | null) =>
      h.db.prepare("UPDATE devices SET app_version = ? WHERE user_id = ?").run(v, admin.userId);
    beforeEach(() => {
      setAppVersion("1.3.7");
    });

    it("refuses a different server key unless rekey, and accepts the same key again", async () => {
      expect((await put("/user/sync-key/server", { encryption_key: KEY_A })).statusCode).toBe(200);
      expect((await put("/user/sync-key/server", { encryption_key: KEY_A })).statusCode).toBe(200);

      const clash = await put("/user/sync-key/server", { encryption_key: KEY_B });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().error).toBe("sync_key_mismatch");

      const unlock = () =>
        h.app.inject({
          method: "POST",
          url: "/user/sync-key/unlock",
          headers: { authorization: `Bearer ${admin.accessToken}` },
        });
      expect((await unlock()).json().encryption_key).toBe(KEY_A);

      expect((await put("/user/sync-key/server", { encryption_key: KEY_B, rekey: true })).statusCode).toBe(200);
      expect((await unlock()).json().encryption_key).toBe(KEY_B);
    });

    it("lets a computer that has the key replace a stored wrap the server can't open", async () => {
      h.db
        .prepare("UPDATE users SET sync_key_server_wrap = ?, encryption_mode = 'default' WHERE id = ?")
        .run("bm90:YQ==", admin.userId);
      // Unlock fails for everyone, so storing the key again is the repair.
      expect((await put("/user/sync-key/server", { encryption_key: KEY_A })).statusCode).toBe(200);
      const unlock = await h.app.inject({
        method: "POST",
        url: "/user/sync-key/unlock",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(unlock.json().encryption_key).toBe(KEY_A);
      // Readable again, so a different key is refused once more.
      expect((await put("/user/sync-key/server", { encryption_key: KEY_B })).statusCode).toBe(409);
    });

    it("refuses a different recovery wrap only when told rekey: false", async () => {
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-one" })).statusCode).toBe(200);
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-one", rekey: false })).statusCode).toBe(200);
      const clash = await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-two", rekey: false });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().code).toBe("sync_key_mismatch");
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-two", rekey: true })).statusCode).toBe(200);
      const row = h.db
        .prepare<[string], { w: string }>("SELECT sync_key_e2ee_wrap AS w FROM users WHERE id = ?")
        .get(admin.userId);
      expect(row?.w).toBe("wrap-two");
    });

    it("lets desktops that don't send rekey replace the recovery wrap, as before", async () => {
      // Released desktops change the recovery code and turn end-to-end
      // encryption back on with a plain PUT.
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-one" })).statusCode).toBe(200);
      for (const v of ["1.3.6", null, "1.3.7"]) {
        setAppVersion(v);
        expect((await put("/user/sync-key/e2ee", { e2ee_wrap: `wrap-${v}` })).statusCode).toBe(200);
      }
    });

    it("the old recovery-wrap route isn't checked: only old desktops use it", async () => {
      expect((await put("/user/sync-key", { encrypted_sync_key: "wrap-one" })).statusCode).toBe(200);
      expect((await put("/user/sync-key", { encrypted_sync_key: "wrap-two" })).statusCode).toBe(200);
    });

    it("a recovery wrap left from before end-to-end encryption was turned off can be replaced", async () => {
      const post = (url: string, payload?: Record<string, unknown>) =>
        h.app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${admin.accessToken}` },
          ...(payload ? { payload } : {}),
        });
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-one" })).statusCode).toBe(200);
      expect((await post("/user/sync-key/disable-e2ee", { encryption_key: KEY_A })).statusCode).toBe(200);
      // Sign-in recovery mode unlocks through the server wrap, so the
      // leftover recovery wrap isn't how any computer gets the key.
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-two", rekey: false })).statusCode).toBe(200);
      expect((await post("/user/sync-key/enable-e2ee")).statusCode).toBe(200);
      // Back in end-to-end mode it's the unlock path again.
      expect((await put("/user/sync-key/e2ee", { e2ee_wrap: "wrap-three", rekey: false })).statusCode).toBe(409);
    });

    it("turning end-to-end encryption off refuses a key that differs from the stored server wrap", async () => {
      await put("/user/sync-key/server", { encryption_key: KEY_A });
      const off = (encryption_key: string) =>
        h.app.inject({
          method: "POST",
          url: "/user/sync-key/disable-e2ee",
          headers: { authorization: `Bearer ${admin.accessToken}` },
          payload: { encryption_key },
        });
      expect((await off(KEY_B)).statusCode).toBe(409);
      expect((await off(KEY_A)).statusCode).toBe(200);
    });
  });

  describe("device ids", () => {
    it("a device id another account already uses gets a fresh one on login and register", async () => {
      // Same machine, second account: register sends the id the admin's
      // device already has.
      const reg = await inviteUser(h, admin.accessToken, "two@lan", admin.deviceId);
      expect(reg.statusCode).toBe(200);
      const regId = reg.json().device_id as string;
      expect(regId).not.toBe(admin.deviceId);
      expect(regId).toMatch(/^[0-9a-f-]{36}$/);

      const login = await h.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "two@lan",
          password: "hunter2hunter2",
          device_id: admin.deviceId,
          device_name: "Laptop 2",
          platform: "darwin",
        },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().device_id).not.toBe(admin.deviceId);

      // The admin's own row is untouched.
      const owner = h.db
        .prepare<[string], { user_id: string }>("SELECT user_id FROM devices WHERE id = ?")
        .get(admin.deviceId);
      expect(owner?.user_id).toBe(admin.userId);
    });

    it("an unused client id is kept, so the desktop's own id carries over", async () => {
      const mine = "12345678-1234-4234-8234-123456789abc";
      const reg = await inviteUser(h, admin.accessToken, "three@lan", mine);
      expect(reg.json().device_id).toBe(mine);
    });
  });

  describe("roles and revocation", () => {
    it("a demoted admin's access token can no longer mint invites", async () => {
      h.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(admin.userId);
      const res = await h.app.inject({
        method: "POST",
        url: "/admin/invites",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it("demote and revoke-tokens stop the access tokens already handed out", async () => {
      const profile = (token: string) =>
        h.app.inject({
          method: "GET",
          url: "/user/profile",
          headers: { authorization: `Bearer ${token}` },
        });
      expect((await profile(admin.accessToken)).statusCode).toBe(200);
      runCli(h, ["demote", "--email", "admin@test.lan"]);
      expect((await profile(admin.accessToken)).statusCode).toBe(401);

      const user = await inviteUser(h, (await freshAdmin(h)).accessToken, "four@lan");
      const userAccess = user.json().accessToken as string;
      expect((await profile(userAccess)).statusCode).toBe(200);
      runCli(h, ["revoke-tokens", "--email", "four@lan"]);
      expect((await profile(userAccess)).statusCode).toBe(401);
    }, 60_000);
  });

  describe("JWT secret rotation", () => {
    function seedVault() {
      h.db
        .prepare(
          `INSERT INTO google_calendar_accounts (user_id, email, payload_enc, updated_at)
           VALUES (?, 'me@gmail.com', ?, datetime('now'))`,
        )
        .run(admin.userId, encryptSecret('{"refresh_token":"r"}', h.jwtSecret));
    }

    it("re-wraps the sign-in recovery wraps and calendar accounts with the new secret", async () => {
      await put("/user/sync-key/server", { encryption_key: KEY_A });
      seedVault();
      const result = rotateJwtSecret(h.db, "n".repeat(64), { syncDekKek: null });
      expect(result).toEqual({ syncKeys: 1, calendarAccounts: 1, unreadable: 0 });
      const row = h.db
        .prepare<[string], { w: string }>("SELECT sync_key_server_wrap AS w FROM users WHERE id = ?")
        .get(admin.userId)!;
      expect(decryptSyncDek(row.w, "n".repeat(64))).toBe(KEY_A);
      const vault = h.db
        .prepare<[], { p: string }>("SELECT payload_enc AS p FROM google_calendar_accounts")
        .get()!;
      expect(decryptSecret(vault.p, "n".repeat(64))).toBe('{"refresh_token":"r"}');
      expect(getState(h.db, SERVER_STATE_KEYS.jwtSecret)).toBe("n".repeat(64));
      const tokens = h.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM refresh_tokens").get()!;
      expect(tokens.n).toBe(0);
    });

    it("changes nothing when a wrap can't be opened, unless told to leave it", async () => {
      await put("/user/sync-key/server", { encryption_key: KEY_A });
      h.db
        .prepare(
          `INSERT INTO google_calendar_accounts (user_id, email, payload_enc, updated_at)
           VALUES (?, 'lost@gmail.com', 'bm90:YQ==', datetime('now'))`,
        )
        .run(admin.userId);
      const before = getState(h.db, SERVER_STATE_KEYS.jwtSecret);
      expect(() => rotateJwtSecret(h.db, "n".repeat(64), { syncDekKek: null })).toThrow(/Nothing was changed/);
      expect(getState(h.db, SERVER_STATE_KEYS.jwtSecret)).toBe(before);
      const row = h.db
        .prepare<[string], { w: string }>("SELECT sync_key_server_wrap AS w FROM users WHERE id = ?")
        .get(admin.userId)!;
      expect(decryptSyncDek(row.w, before!)).toBe(KEY_A);

      const result = rotateJwtSecret(h.db, "n".repeat(64), { syncDekKek: null, allowUnreadable: true });
      expect(result.unreadable).toBe(1);
      expect(result.syncKeys).toBe(1);
    });

    it("a running server seals with the new secret straight after a rotation", async () => {
      rotateJwtSecret(h.db, "n".repeat(64), { syncDekKek: null });
      // Old sessions end with the old secret; a new sign-in works at once.
      expect((await put("/user/sync-key/server", { encryption_key: KEY_A })).statusCode).toBe(401);
      const login = await h.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "admin@test.lan",
          password: "hunter2hunter2",
          device_name: "Admin MBP",
          platform: "darwin",
        },
      });
      expect(login.statusCode).toBe(200);
      const res = await h.app.inject({
        method: "PUT",
        url: "/user/sync-key/server",
        headers: { authorization: `Bearer ${login.json().accessToken}` },
        payload: { encryption_key: KEY_A },
      });
      expect(res.statusCode).toBe(200);
      const row = h.db
        .prepare<[string], { w: string }>("SELECT sync_key_server_wrap AS w FROM users WHERE id = ?")
        .get(admin.userId)!;
      expect(decryptSyncDek(row.w, "n".repeat(64))).toBe(KEY_A);
      expect(countUnreadableWraps(h.db, "n".repeat(64), null)).toBe(0);
      expect(countUnreadableWraps(h.db, h.jwtSecret, null)).toBe(1);
    });

    it("the CLI won't rotate to a random secret while VS_JWT_SECRET is pinned", () => {
      const before = getState(h.db, SERVER_STATE_KEYS.jwtSecret)!;
      expect(() => runCli(h, ["rotate-jwt-secret", "--confirm"], { VS_JWT_SECRET: before })).toThrow(
        /--secret -/,
      );
      expect(getState(h.db, SERVER_STATE_KEYS.jwtSecret)).toBe(before);
    }, 60_000);

    it("VS_JWT_SECRET can't change the secret at boot once wraps depend on it", async () => {
      const current = h.jwtSecret;
      // Same value: fine.
      await expect(bootstrapServerState(h.db, { jwtSecretOverride: current })).resolves.toMatchObject({
        jwtSecret: current,
      });
      // Nothing wrapped yet: a new value is still taken, as before.
      const next = "x".repeat(64);
      await expect(bootstrapServerState(h.db, { jwtSecretOverride: next })).resolves.toMatchObject({
        jwtSecret: next,
      });
      h.jwtSecret = next;
      // Once a wrap depends on it, a different value is refused and the
      // stored secret is kept.
      seedVault();
      await expect(
        bootstrapServerState(h.db, { jwtSecretOverride: "y".repeat(64) }),
      ).rejects.toThrow(/rotate-jwt-secret/);
      expect(getState(h.db, SERVER_STATE_KEYS.jwtSecret)).toBe(next);
    });
  });
});

// A second admin to invite with, after the first was demoted.
async function freshAdmin(h: Harness) {
  h.db.prepare("UPDATE users SET role = 'admin' WHERE email = 'admin@test.lan'").run();
  const res = await h.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "admin@test.lan",
      password: "hunter2hunter2",
      device_name: "Admin MBP 2",
      platform: "darwin",
    },
  });
  return { accessToken: res.json().accessToken as string };
}
