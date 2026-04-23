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
import { MIN_PASSWORD_LENGTH } from "../lib/auth-service.js";
import type { JWTPayload, UserRow } from "../types.js";

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
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        plan: user.plan,
        role: user.role,
        has_subscription: false,
        created_at: user.created_at,
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
        .prepare<[string, string]>(
          "UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
        )
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
      fastify.db
        .prepare<[string, string, string]>(
          "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(hash, salt, auth.sub);
      return reply.send({ ok: true });
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
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM devices WHERE id = ? AND user_id = ?",
        )
        .get(deviceId, auth.sub);
      if (device === undefined) {
        return reply.status(404).send({ error: "not_found" });
      }
      const tx = fastify.db.transaction(() => {
        fastify.db
          .prepare<[string, string]>(
            "DELETE FROM refresh_tokens WHERE device_id = ? AND user_id = ?",
          )
          .run(deviceId, auth.sub);
        fastify.db
          .prepare<[string, string]>(
            "DELETE FROM devices WHERE id = ? AND user_id = ?",
          )
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
      fastify.db
        .prepare<[string, string]>(
          "UPDATE users SET encrypted_sync_key = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .run(body.encrypted_sync_key, auth.sub);
      return reply.send({ ok: true });
    },
  );

  fastify.get("/user/sync-key", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    const row = fastify.db
      .prepare<[string], { encrypted_sync_key: string | null }>(
        "SELECT encrypted_sync_key FROM users WHERE id = ?",
      )
      .get(auth.sub);
    if (row === undefined) {
      return reply.status(404).send({ error: "user_not_found" });
    }
    return reply.send({
      encrypted_sync_key: row.encrypted_sync_key,
      has_key: row.encrypted_sync_key !== null,
    });
  });

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
        const adminCount = fastify.db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'admin'",
          )
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
      fastify.db.prepare<[string]>("DELETE FROM users WHERE id = ?").run(auth.sub);
      return reply.send({ ok: true });
    },
  );
};
