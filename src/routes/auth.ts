// SPDX-License-Identifier: Apache-2.0
//
// /auth/* — register, login, refresh, logout.
//
// Shapes mirror the Vetroscope Cloud Worker's /auth endpoints so the
// client code path is shared. Home Sync only pins are:
//   - `plan` is always "home" (no trial → licensed → pro progression)
//   - `role` rides on the JWT so /admin/* routes can gate on it
//   - registration is env-gated: open / invite / closed
//   - device limit defaults to 10 and is configurable via env

import type { FastifyPluginAsync } from "fastify";

import {
  countUsers,
  findUserByEmail,
  issueTokens,
  MIN_PASSWORD_LENGTH,
} from "../lib/auth-service.js";
import { createUser } from "../lib/auth-service.js";
import { sha256, verifyPassword } from "../lib/crypto.js";
import {
  assertDeviceCapacity,
  DeviceLimitReachedError,
  findDevice,
  registerDevice,
} from "../lib/device-service.js";
import { consumeInvite } from "../lib/invite-service.js";
import { buildRateLimiter } from "../middleware/ratelimit.js";
import type { JWTPayload, Platform, UserRow } from "../types.js";

interface RegisterBody {
  email?: string;
  password?: string;
  display_name?: string;
  device_name?: string;
  device_id?: string;
  platform?: Platform;
  invite_token?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
  device_name?: string;
  device_id?: string;
  platform?: Platform;
}

interface RefreshBody {
  refresh_token?: string;
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const limiter = buildRateLimiter({ limit: 10, windowMs: 60_000 });

  fastify.post<{ Body: RegisterBody }>(
    "/auth/register",
    { preHandler: limiter },
    async (request, reply) => {
      const body = request.body ?? {};
      const { email, password, display_name, device_name, device_id, platform } =
        body;

      if (!email || !password || !display_name) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "email, password, and display_name are required.",
        });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply.status(400).send({
          error: "weak_password",
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
      }

      const mode = fastify.config.registrationMode;
      const isFirstUser = countUsers(fastify.db) === 0;

      // Registration gate. First-user signup goes through /setup — if an
      // admin exists, we enforce the configured mode.
      if (!isFirstUser) {
        if (mode === "closed") {
          return reply.status(403).send({ error: "registration_closed" });
        }
        if (mode === "invite") {
          if (!body.invite_token) {
            return reply
              .status(403)
              .send({ error: "invite_required" });
          }
          const invite = await consumeInvite(fastify.db, body.invite_token);
          if (invite === null) {
            return reply
              .status(401)
              .send({ error: "invalid_invite" });
          }
        }
      } else {
        // First-user registration must go through /setup — the setup-token
        // gate is more secure than open registration.
        return reply.status(409).send({
          error: "setup_required",
          message: "Run /setup to bootstrap the first admin account.",
        });
      }

      if (findUserByEmail(fastify.db, email) !== undefined) {
        return reply.status(409).send({ error: "email_taken" });
      }

      const user = await createUser(fastify.db, {
        email,
        password,
        displayName: display_name,
        role: "user",
      });

      if (device_name && platform) {
        try {
          assertDeviceCapacity(
            fastify.db,
            user.id,
            fastify.config.maxDevicesPerUser,
          );
        } catch (err) {
          if (err instanceof DeviceLimitReachedError) {
            return reply.status(403).send({
              error: "device_limit",
              max_devices: err.maxDevices,
            });
          }
          throw err;
        }
        const deviceId = registerDevice(fastify.db, user.id, {
          id: device_id ?? null,
          deviceName: device_name,
          platform,
        });
        const tokens = await issueTokens(
          fastify.db,
          fastify.jwtSecret,
          user,
          deviceId,
        );
        return reply.send({
          user: publicUser(user),
          device_id: deviceId,
          ...tokens,
        });
      }

      return reply.status(201).send({ user: publicUser(user) });
    },
  );

  fastify.post<{ Body: LoginBody }>(
    "/auth/login",
    { preHandler: limiter },
    async (request, reply) => {
      const body = request.body ?? {};
      const { email, password, device_name, device_id, platform } = body;

      if (!email || !password) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "email and password are required.",
        });
      }

      const user = findUserByEmail(fastify.db, email);
      if (user === undefined) {
        return reply.status(401).send({ error: "invalid_credentials" });
      }
      const valid = await verifyPassword(
        password,
        user.password_hash,
        user.password_salt,
      );
      if (!valid) {
        return reply.status(401).send({ error: "invalid_credentials" });
      }

      let resolvedDeviceId = device_id;
      if (resolvedDeviceId !== undefined) {
        const existing = findDevice(fastify.db, user.id, resolvedDeviceId);
        if (existing === undefined) resolvedDeviceId = undefined;
      }

      if (resolvedDeviceId === undefined) {
        if (!device_name || !platform) {
          return reply.status(400).send({
            error: "invalid_request",
            message:
              "device_name and platform are required to register a new device.",
          });
        }
        try {
          assertDeviceCapacity(
            fastify.db,
            user.id,
            fastify.config.maxDevicesPerUser,
          );
        } catch (err) {
          if (err instanceof DeviceLimitReachedError) {
            return reply.status(403).send({
              error: "device_limit",
              max_devices: err.maxDevices,
            });
          }
          throw err;
        }
        resolvedDeviceId = registerDevice(fastify.db, user.id, {
          id: device_id ?? null,
          deviceName: device_name,
          platform,
        });
      }

      const tokens = await issueTokens(
        fastify.db,
        fastify.jwtSecret,
        user,
        resolvedDeviceId,
      );
      return reply.send({
        user: publicUser(user),
        device_id: resolvedDeviceId,
        ...tokens,
      });
    },
  );

  fastify.post<{ Body: RefreshBody }>(
    "/auth/refresh",
    { preHandler: limiter },
    async (request, reply) => {
      const body = request.body ?? {};
      if (!body.refresh_token) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "refresh_token is required.",
        });
      }

      const tokenHash = await sha256(body.refresh_token);
      const stored = fastify.db
        .prepare<
          [string],
          UserRow & { device_id: string; expires_at: string }
        >(
          `SELECT u.*, rt.device_id, rt.expires_at
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
           WHERE rt.token_hash = ?`,
        )
        .get(tokenHash);

      if (stored === undefined) {
        return reply.status(401).send({ error: "invalid_refresh_token" });
      }

      if (new Date(stored.expires_at) < new Date()) {
        fastify.db
          .prepare<[string]>(
            "DELETE FROM refresh_tokens WHERE token_hash = ?",
          )
          .run(tokenHash);
        return reply.status(401).send({ error: "refresh_token_expired" });
      }

      // Single-use rotation: drop the row we just consumed before issuing.
      fastify.db
        .prepare<[string]>("DELETE FROM refresh_tokens WHERE token_hash = ?")
        .run(tokenHash);

      const tokens = await issueTokens(
        fastify.db,
        fastify.jwtSecret,
        stored,
        stored.device_id,
      );
      return reply.send({
        user: publicUser(stored),
        device_id: stored.device_id,
        ...tokens,
      });
    },
  );

  fastify.post(
    "/auth/logout",
    { preHandler: [limiter, fastify.authenticate] },
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      fastify.db
        .prepare<[string, string]>(
          "DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ?",
        )
        .run(auth.sub, auth.device_id);
      return reply.send({ ok: true });
    },
  );
};

function publicUser(u: {
  id: string;
  email: string;
  display_name: string;
  plan: string;
  role: string;
}): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    plan: u.plan,
    role: u.role,
  };
}
