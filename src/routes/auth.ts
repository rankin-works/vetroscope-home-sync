// SPDX-License-Identifier: Apache-2.0
//
// /auth/* — register, login, refresh, logout.
//
// Home Sync owns its own accounts — it has no knowledge of any other
// Vetroscope account system, and credentials here are separate. Notable
// properties:
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
import {
  generateSalt,
  hashPassword,
  sha256,
  verifyPassword,
  verifyPasswordDummy,
  LEGACY_PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS,
} from "../lib/crypto.js";
import {
  assertDeviceCapacity,
  DeviceLimitReachedError,
  findDevice,
  recordDeviceAppVersion,
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
  // Vetroscope app version (e.g. "0.2.22"). Stored on the device row
  // so the server can gate too-old clients on /sync/*. Optional on
  // the wire so pre-006 clients still work — they just stay NULL.
  app_version?: string;
}

interface LoginBody {
  email?: string;
  password?: string;
  device_name?: string;
  device_id?: string;
  platform?: Platform;
  app_version?: string;
}

interface RefreshBody {
  refresh_token?: string;
  // Vetroscope app version (e.g. "0.2.22"). Updates devices.app_version
  // on each refresh so the server's view of "what version is this
  // device on?" stays current even between explicit logins.
  app_version?: string;
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
          appVersion: body.app_version ?? null,
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
        // Spend the same work as a real verification before answering, so
        // the response time doesn't reveal whether the address has an
        // account on this server.
        await verifyPasswordDummy(password);
        return reply.status(401).send({ error: "invalid_credentials" });
      }
      const valid = await verifyPassword(
        password,
        user.password_hash,
        user.password_salt,
        user.password_iterations,
      );
      if (!valid) {
        return reply.status(401).send({ error: "invalid_credentials" });
      }

      // Opportunistic work-factor upgrade: this is the one moment we hold
      // the plaintext and know it's correct, so accounts migrate as their
      // owners sign in rather than in a sweep. A failure here must not fail
      // the login — the stored hash is still valid at its recorded count,
      // so a missed upgrade just retries on the next sign-in.
      const storedIterations =
        user.password_iterations ?? LEGACY_PBKDF2_ITERATIONS;
      if (storedIterations < PBKDF2_ITERATIONS) {
        try {
          const upgradedSalt = generateSalt();
          const upgradedHash = await hashPassword(password, upgradedSalt);
          fastify.db
            .prepare<[string, string, number, string, number]>(
              `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?
               WHERE id = ? AND password_iterations = ?`,
            )
            .run(
              upgradedHash,
              upgradedSalt,
              PBKDF2_ITERATIONS,
              user.id,
              storedIterations,
            );
        } catch (err) {
          request.log.warn({ err }, "password rehash failed; will retry");
        }
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
          appVersion: body.app_version ?? null,
        });
      } else {
        // Existing device — record the current app version on the row so
        // a returning client's version is always up-to-date in the
        // devices table without forcing a re-register.
        recordDeviceAppVersion(fastify.db, user.id, resolvedDeviceId, body.app_version);
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

      recordDeviceAppVersion(fastify.db, stored.id, stored.device_id, body.app_version);
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
