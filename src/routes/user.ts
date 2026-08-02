// SPDX-License-Identifier: Apache-2.0
//
// /user/* — profile, password change, device unlink, sync-key
// storage, account deletion. Mirrors the cloud Worker's /user/* shapes
// so the client is agnostic to which backend it's talking to. The
// `has_subscription` field is retained for shape-compat and pinned
// to false on Home Sync.

import type { FastifyPluginAsync } from "fastify";

import { generateSalt, hashPassword, verifyPassword } from "../lib/crypto.js";
import { listDevices } from "../lib/device-service.js";
import { issueTokens, MIN_PASSWORD_LENGTH } from "../lib/auth-service.js";
import { encryptSyncDek, decryptSyncDek } from "../lib/secret-crypto.js";
import { buildRateLimiter } from "../middleware/ratelimit.js";
import type { JWTPayload, UserRow } from "../types.js";

type SyncKeyRow = {
  encrypted_sync_key: string | null;
  sync_key_server_wrap: string | null;
  sync_key_e2ee_wrap: string | null;
  encryption_mode: string | null;
};

function normalizeMode(row: SyncKeyRow): "default" | "e2ee" {
  if (row.encryption_mode === "default" || row.encryption_mode === "e2ee") {
    return row.encryption_mode;
  }
  if (row.encrypted_sync_key || row.sync_key_e2ee_wrap) return "e2ee";
  return "default";
}

function e2eeWrapOf(row: SyncKeyRow): string | null {
  return row.sync_key_e2ee_wrap || row.encrypted_sync_key || null;
}

interface UpdateProfileBody {
  display_name?: string;
}

interface ChangePasswordBody {
  current_password?: string;
  new_password?: string;
}

interface SyncKeyBody {
  encrypted_sync_key?: string;
}

interface DeleteAccountBody {
  password?: string;
}

export const userRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/user/profile", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const user = fastify.db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
      .get(auth.sub);
    if (user === undefined) {
      return reply.status(404).send({ error: "user_not_found" });
    }
    const devices = listDevices(fastify.db, auth.sub);
    const onboardingStatus =
      user.onboarding_status === "completed" ||
      user.onboarding_status === "skipped"
        ? user.onboarding_status
        : null;
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        plan: user.plan,
        role: user.role,
        has_subscription: false,
        created_at: user.created_at,
        onboarding_status: onboardingStatus,
        onboarding_done: onboardingStatus !== null,
      },
      devices: devices.map((d) => ({
        id: d.id,
        device_name: d.device_name,
        platform: d.platform,
        last_sync_at: d.last_sync_at,
        created_at: d.created_at,
        is_current: d.id === auth.device_id,
      })),
    });
  });

  const setOnboardingStatus = (
    userId: string,
    status: "completed" | "skipped",
  ): void => {
    // Always stamp status_at so complete-after-skip (About → Finish)
    // records the latest disposition. Idempotent when re-posted.
    fastify.db
      .prepare<[string, string]>(
        `UPDATE users SET
           onboarding_status = ?,
           onboarding_status_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(status, userId);
  };

  fastify.post("/user/onboarding/complete", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    setOnboardingStatus(auth.sub, "completed");
    return reply.send({
      ok: true,
      onboarding_status: "completed",
      onboarding_done: true,
    });
  });

  fastify.post("/user/onboarding/skip", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    setOnboardingStatus(auth.sub, "skipped");
    return reply.send({
      ok: true,
      onboarding_status: "skipped",
      onboarding_done: true,
    });
  });

  fastify.patch<{ Body: UpdateProfileBody }>(
    "/user/profile",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const body = request.body ?? {};
      const name = body.display_name?.trim();
      if (!name) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "display_name is required.",
        });
      }
      fastify.db
        .prepare<
          [string, string]
        >("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name, auth.sub);
      return reply.send({ ok: true, display_name: name });
    },
  );

  fastify.patch<{ Body: ChangePasswordBody }>(
    "/user/password",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const body = request.body ?? {};
      if (!body.current_password || !body.new_password) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "current_password and new_password are required.",
        });
      }
      if (body.new_password.length < MIN_PASSWORD_LENGTH) {
        return reply.status(400).send({
          error: "weak_password",
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
      }
      const user = fastify.db
        .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
        .get(auth.sub);
      if (user === undefined) {
        return reply.status(404).send({ error: "user_not_found" });
      }
      const valid = await verifyPassword(
        body.current_password,
        user.password_hash,
        user.password_salt,
      );
      if (!valid) {
        return reply.status(401).send({ error: "invalid_password" });
      }
      const salt = generateSalt();
      const hash = await hashPassword(body.new_password, salt);
      const newVersion = (user.token_version ?? 0) + 1;

      // A password change should end every other session, including ones
      // whose access token hasn't expired yet. Deleting refresh_tokens stops
      // renewal; bumping token_version kills the outstanding access tokens.
      // Both in one transaction so a crash can't leave the password changed
      // with the old sessions still live.
      const tx = fastify.db.transaction(() => {
        fastify.db
          .prepare<[string, string, number, string]>(
            `UPDATE users SET
               password_hash = ?,
               password_salt = ?,
               token_version = ?,
               updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(hash, salt, newVersion, auth.sub);
        fastify.db
          .prepare<[string]>("DELETE FROM refresh_tokens WHERE user_id = ?")
          .run(auth.sub);
      });
      tx();

      // Re-issue for the caller's own device so the person who just changed
      // their password isn't signed out by their own action. The client
      // persists these; without them its next request would 401 on the
      // now-stale token_version.
      const tokens = await issueTokens(
        fastify.db,
        fastify.jwtSecret,
        {
          ...user,
          password_hash: hash,
          password_salt: salt,
          token_version: newVersion,
        },
        auth.device_id,
      );
      return reply.send({
        ok: true,
        message: "Signed out on all other devices.",
        ...tokens,
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/user/devices/:id",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const deviceId = request.params.id;
      if (deviceId === auth.device_id) {
        return reply.status(400).send({
          error: "cannot_unlink_current_device",
          message: "Log out of this device instead of unlinking it.",
        });
      }
      const device = fastify.db
        .prepare<
          [string, string],
          { id: string }
        >("SELECT id FROM devices WHERE id = ? AND user_id = ?")
        .get(deviceId, auth.sub);
      if (device === undefined) {
        return reply.status(404).send({ error: "not_found" });
      }
      const tx = fastify.db.transaction(() => {
        fastify.db
          .prepare<
            [string, string]
          >("DELETE FROM refresh_tokens WHERE device_id = ? AND user_id = ?")
          .run(deviceId, auth.sub);
        fastify.db
          .prepare<
            [string, string]
          >("DELETE FROM devices WHERE id = ? AND user_id = ?")
          .run(deviceId, auth.sub);
      });
      tx();
      return reply.send({ ok: true });
    },
  );

  fastify.put<{ Body: SyncKeyBody }>(
    "/user/sync-key",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const body = request.body ?? {};
      if (!body.encrypted_sync_key) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "encrypted_sync_key is required.",
        });
      }
      try {
        fastify.db
          .prepare<[string, string, string]>(
            `UPDATE users SET
               encrypted_sync_key = ?,
               sync_key_e2ee_wrap = ?,
               encryption_mode = 'e2ee',
               updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(body.encrypted_sync_key, body.encrypted_sync_key, auth.sub);
      } catch {
        fastify.db
          .prepare<
            [string, string]
          >("UPDATE users SET encrypted_sync_key = ?, updated_at = datetime('now') WHERE id = ?")
          .run(body.encrypted_sync_key, auth.sub);
      }
      return reply.send({ ok: true });
    },
  );

  fastify.get("/user/sync-key", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    let row: SyncKeyRow | undefined;
    try {
      row = fastify.db
        .prepare<[string], SyncKeyRow>(
          `SELECT encrypted_sync_key, sync_key_server_wrap, sync_key_e2ee_wrap, encryption_mode
           FROM users WHERE id = ?`,
        )
        .get(auth.sub);
    } catch {
      const legacy = fastify.db
        .prepare<
          [string],
          { encrypted_sync_key: string | null }
        >("SELECT encrypted_sync_key FROM users WHERE id = ?")
        .get(auth.sub);
      if (!legacy) {
        return reply.status(404).send({ error: "user_not_found" });
      }
      row = {
        encrypted_sync_key: legacy.encrypted_sync_key,
        sync_key_server_wrap: null,
        sync_key_e2ee_wrap: null,
        encryption_mode: legacy.encrypted_sync_key ? "e2ee" : "default",
      };
    }
    if (row === undefined) {
      return reply.status(404).send({ error: "user_not_found" });
    }
    const mode = normalizeMode(row);
    const e2ee = e2eeWrapOf(row);
    const hasServer = !!row.sync_key_server_wrap;
    const hasE2ee = !!e2ee;
    return reply.send({
      encrypted_sync_key: e2ee,
      has_key: hasServer || hasE2ee,
      mode,
      has_server_wrap: hasServer,
      has_e2ee_wrap: hasE2ee,
    });
  });

  fastify.put<{ Body: { encryption_key?: string } }>(
    "/user/sync-key/server",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const dek = (request.body?.encryption_key ?? "").trim();
      if (!/^[0-9a-f]{64}$/i.test(dek)) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "encryption_key must be 64 hex chars.",
        });
      }
      const row = fastify.db
        .prepare<[string], SyncKeyRow>(
          `SELECT encrypted_sync_key, sync_key_server_wrap, sync_key_e2ee_wrap, encryption_mode
           FROM users WHERE id = ?`,
        )
        .get(auth.sub);
      if (!row) return reply.status(404).send({ error: "user_not_found" });
      if (
        normalizeMode(row) === "e2ee" &&
        e2eeWrapOf(row) &&
        !row.sync_key_server_wrap
      ) {
        return reply.status(409).send({
          error: "e2ee_enabled",
          message:
            "End-to-end encryption is enabled; disable it before using sign-in recovery.",
        });
      }
      const wrap = encryptSyncDek(
        dek,
        fastify.jwtSecret,
        fastify.config.syncDekKek,
      );
      fastify.db
        .prepare<[string, string]>(
          `UPDATE users SET
             sync_key_server_wrap = ?,
             encryption_mode = 'default',
             updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(wrap, auth.sub);
      return reply.send({ ok: true, mode: "default" });
    },
  );

  fastify.put<{ Body: { e2ee_wrap?: string; encrypted_sync_key?: string } }>(
    "/user/sync-key/e2ee",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const wrap = (
        request.body?.e2ee_wrap ||
        request.body?.encrypted_sync_key ||
        ""
      ).trim();
      if (!wrap) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "e2ee_wrap is required.",
        });
      }
      fastify.db
        .prepare<[string, string, string]>(
          `UPDATE users SET
             sync_key_e2ee_wrap = ?,
             encrypted_sync_key = ?,
             updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(wrap, wrap, auth.sub);
      return reply.send({ ok: true });
    },
  );

  fastify.post("/user/sync-key/enable-e2ee", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const row = fastify.db
      .prepare<[string], SyncKeyRow>(
        `SELECT encrypted_sync_key, sync_key_server_wrap, sync_key_e2ee_wrap, encryption_mode
         FROM users WHERE id = ?`,
      )
      .get(auth.sub);
    if (!row) return reply.status(404).send({ error: "user_not_found" });
    const e2ee = e2eeWrapOf(row);
    if (!e2ee) {
      return reply.status(400).send({
        error: "e2ee_wrap_missing",
        message: "Store an E2EE wrap before enabling end-to-end encryption.",
      });
    }
    fastify.db
      .prepare<[string, string, string]>(
        `UPDATE users SET
           encryption_mode = 'e2ee',
           sync_key_e2ee_wrap = ?,
           encrypted_sync_key = ?,
           sync_key_server_wrap = NULL,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(e2ee, e2ee, auth.sub);
    return reply.send({ ok: true, mode: "e2ee" });
  });

  fastify.post<{ Body: { encryption_key?: string; keep_e2ee_wrap?: boolean } }>(
    "/user/sync-key/disable-e2ee",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const dek = (request.body?.encryption_key ?? "").trim();
      if (!/^[0-9a-f]{64}$/i.test(dek)) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "encryption_key must be 64 hex chars.",
        });
      }
      const wrap = encryptSyncDek(
        dek,
        fastify.jwtSecret,
        fastify.config.syncDekKek,
      );
      const keep = request.body?.keep_e2ee_wrap !== false;
      if (keep) {
        fastify.db
          .prepare<[string, string]>(
            `UPDATE users SET
               sync_key_server_wrap = ?,
               encryption_mode = 'default',
               updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(wrap, auth.sub);
      } else {
        fastify.db
          .prepare<[string, string]>(
            `UPDATE users SET
               sync_key_server_wrap = ?,
               encryption_mode = 'default',
               sync_key_e2ee_wrap = NULL,
               encrypted_sync_key = NULL,
               updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(wrap, auth.sub);
      }
      return reply.send({ ok: true, mode: "default" });
    },
  );

  // /user/sync-key/unlock hands back the plaintext data-encryption key, so
  // it's the highest-value authenticated route on the server. A per-IP cap
  // bounds how fast a stolen access token can be turned into the key, and
  // costs a legitimate client nothing — it unlocks once per session.
  const unlockLimiter = buildRateLimiter({ limit: 30, windowMs: 60_000 });

  fastify.post(
    "/user/sync-key/unlock",
    { preHandler: unlockLimiter },
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const row = fastify.db
        .prepare<[string], SyncKeyRow>(
          `SELECT encrypted_sync_key, sync_key_server_wrap, sync_key_e2ee_wrap, encryption_mode
         FROM users WHERE id = ?`,
        )
        .get(auth.sub);
      if (!row) return reply.status(404).send({ error: "user_not_found" });
      if (normalizeMode(row) === "e2ee") {
        return reply.status(403).send({
          error: "e2ee_enabled",
          message: "End-to-end encryption is enabled; use your recovery code.",
        });
      }
      if (!row.sync_key_server_wrap) {
        return reply.status(404).send({
          error: "no_server_wrap",
          message: "No sign-in recovery key on server.",
        });
      }
      try {
        const encryptionKey = decryptSyncDek(
          row.sync_key_server_wrap,
          fastify.jwtSecret,
          fastify.config.syncDekKek,
        );
        return reply.send({ encryption_key: encryptionKey, mode: "default" });
      } catch {
        return reply.status(500).send({ error: "unlock_failed" });
      }
    },
  );

  fastify.delete<{ Body: DeleteAccountBody }>(
    "/user/account",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const body = request.body ?? {};
      if (!body.password) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "password is required.",
        });
      }
      const user = fastify.db
        .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
        .get(auth.sub);
      if (user === undefined) {
        return reply.status(404).send({ error: "user_not_found" });
      }
      const valid = await verifyPassword(
        body.password,
        user.password_hash,
        user.password_salt,
      );
      if (!valid) {
        return reply.status(401).send({ error: "invalid_password" });
      }

      // Refuse to delete the last remaining admin — otherwise the server
      // becomes unadministerable. The user can `docker exec … vhs-cli
      // create-user` a replacement admin first.
      if (user.role === "admin") {
        const adminCount =
          fastify.db
            .prepare<
              [],
              { n: number }
            >("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
            .get()?.n ?? 0;
        if (adminCount <= 1) {
          return reply.status(409).send({
            error: "last_admin",
            message:
              "This account is the last admin on the server. Promote another user to admin before deleting it.",
          });
        }
      }

      // CASCADE covers devices, refresh_tokens, sync_*, password_resets.
      fastify.db
        .prepare<[string]>("DELETE FROM users WHERE id = ?")
        .run(auth.sub);
      return reply.send({ ok: true });
    },
  );
};
