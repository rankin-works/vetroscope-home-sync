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

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

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
    const payload = await verifyJWT<JWTPayload>(
      token,
      request.server.jwtSecret,
    );
    if (payload === null) {
      return reply.status(401).send({ error: "invalid_token" });
    }

    // Confirm the user still exists. Avoids the surprise where a removed
    // admin's still-valid token keeps working until exp.
    const row = request.server.db
      .prepare<
        [string],
        { id: string; token_version: number }
      >("SELECT id, token_version FROM users WHERE id = ?")
      .get(payload.sub);
    if (row === undefined) {
      return reply.status(401).send({ error: "user_not_found" });
    }

    // Access tokens are stateless and live for an hour, so revoking refresh
    // tokens alone can't cut off a session already in flight. A bumped
    // token_version (password change) invalidates every outstanding access
    // token for the user on the next request. Tokens minted before 024 carry
    // no claim and read as 0, matching the column default.
    const claimVersion =
      typeof payload.token_version === "number" ? payload.token_version : 0;
    if (row.token_version !== claimVersion) {
      return reply.status(401).send({ error: "token_revoked" });
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
