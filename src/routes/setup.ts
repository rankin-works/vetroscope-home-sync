// SPDX-License-Identifier: Apache-2.0
//
// POST /setup — first-boot admin bootstrap. Validates the one-time code
// printed to the container logs on first boot, creates the initial admin
// user, and issues a token pair. Once setup completes, the route returns
// 410 Gone so a leaked code can't be reused to conjure another admin.

import type { FastifyPluginAsync } from "fastify";

import { hashPassword } from "../lib/crypto.js";
import {
  createUser,
  issueTokens,
  MIN_PASSWORD_LENGTH,
} from "../lib/auth-service.js";
import {
  getState,
  isSetupComplete,
  SERVER_STATE_KEYS,
  setState,
} from "../lib/server-state.js";
import { buildRateLimiter } from "../middleware/ratelimit.js";
import type { Platform } from "../types.js";
import { registerDevice } from "../lib/device-service.js";

interface SetupBody {
  setup_token?: string;
  email?: string;
  password?: string;
  display_name?: string;
  device_name?: string;
  device_id?: string;
  platform?: Platform;
}

export const setupRoutes: FastifyPluginAsync = async (fastify) => {
  const limiter = buildRateLimiter({ limit: 10, windowMs: 60_000 });

  fastify.post<{ Body: SetupBody }>(
    "/setup",
    { preHandler: limiter },
    async (request, reply) => {
      if (isSetupComplete(fastify.db)) {
        return reply
          .status(410)
          .send({ error: "setup_already_completed" });
      }

      const body = request.body ?? {};
      const {
        setup_token,
        email,
        password,
        display_name,
        device_name,
        device_id,
        platform,
      } = body;

      if (!setup_token || !email || !password || !display_name) {
        return reply.status(400).send({
          error: "invalid_request",
          message:
            "setup_token, email, password, and display_name are required.",
        });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return reply.status(400).send({
          error: "weak_password",
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
      }

      const storedHash = getState(fastify.db, SERVER_STATE_KEYS.setupTokenHash);
      const storedSalt = getState(fastify.db, SERVER_STATE_KEYS.setupTokenSalt);
      if (storedHash === null || storedSalt === null) {
        return reply
          .status(500)
          .send({ error: "setup_not_initialized" });
      }

      const candidate = await hashPassword(
        setup_token.trim().toUpperCase(),
        storedSalt,
      );
      if (!constantTimeEquals(candidate, storedHash)) {
        return reply
          .status(401)
          .send({ error: "invalid_setup_token" });
      }

      const user = await createUser(fastify.db, {
        email,
        password,
        displayName: display_name,
        role: "admin",
      });

      // Consume the setup token — the hash is cleared so it can't be
      // replayed even if someone peeks at the DB after bootstrap.
      const tx = fastify.db.transaction(() => {
        setState(
          fastify.db,
          SERVER_STATE_KEYS.setupCompletedAt,
          new Date().toISOString(),
        );
        fastify.db
          .prepare<[string]>("DELETE FROM server_state WHERE key = ?")
          .run(SERVER_STATE_KEYS.setupTokenHash);
        fastify.db
          .prepare<[string]>("DELETE FROM server_state WHERE key = ?")
          .run(SERVER_STATE_KEYS.setupTokenSalt);
      });
      tx();

      if (device_name && platform) {
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

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
