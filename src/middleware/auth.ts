// SPDX-License-Identifier: Apache-2.0
//
// Authentication preHandler. Verifies `Authorization: Bearer <jwt>`,
// rejects missing/invalid/expired tokens, and attaches the decoded
// payload to `request.authUser` for downstream handlers to use.
//
// We also revalidate that the user row referenced by the JWT still
// exists — this catches the "admin deleted the account but the token
// is still technically signed" edge case without adding a second
// round-trip per request. Cheap: single indexed lookup by id.

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import { verifyJWT } from "../lib/crypto.js";
import type { JWTPayload, Role } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: JWTPayload;
  }
}

export function buildAuthenticate(): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "missing_token" });
    }

    const token = header.slice("Bearer ".length).trim();
    const payload = await verifyJWT<JWTPayload>(token, request.server.jwtSecret);
    if (payload === null) {
      return reply.status(401).send({ error: "invalid_token" });
    }

    // Confirm the user still exists. Avoids the surprise where a removed
    // admin's still-valid token keeps working until exp.
    const exists = request.server.db
      .prepare<[string], { id: string }>("SELECT id FROM users WHERE id = ?")
      .get(payload.sub);
    if (exists === undefined) {
      return reply.status(401).send({ error: "user_not_found" });
    }

    request.authUser = payload;
    return undefined;
  };
}

export function requireRole(role: Role): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser === undefined) {
      return reply.status(401).send({ error: "missing_token" });
    }
    if (request.authUser.role !== role && request.authUser.role !== "admin") {
      return reply.status(403).send({ error: "forbidden" });
    }
    return undefined;
  };
}
