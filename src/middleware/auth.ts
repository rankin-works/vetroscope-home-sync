// SPDX-License-Identifier: Apache-2.0
//
// Authentication preHandler. Verifies `Authorization: Bearer <jwt>`,
// rejects missing/invalid/expired tokens, and attaches the decoded
// payload to `request.authUser` for downstream handlers to use.
//
// We also revalidate that the user row referenced by the JWT still
// exists — this catches the "admin deleted the account but the token
// is still technically signed" edge case without adding a second
// round-trip per request. Cheap: single indexed lookup by id. The same
// goes for the token's device, which must still be one of the user's.

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from "fastify";

import type { DB } from "../db.js";
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

    // Removing a device deletes its row and refresh tokens, but its access
    // token is stateless and would otherwise keep working for up to an hour
    // on every signed-in route: the password, the sync key, calendar
    // accounts, removing the owner's other devices, sync. Refuse it once
    // the row is gone. A device moved to a new id (adoptDeviceId) passes
    // through device_aliases, so a request in flight during the move isn't
    // refused. token_version isn't bumped on removal, since that would sign
    // out every other device too.
    if (!deviceStillLinked(request.server.db, payload.sub, payload.device_id)) {
      return reply.status(403).send({ error: "DEVICE_UNKNOWN" });
    }

    request.authUser = payload;
    return undefined;
  };
}

/** Whether a device is still one of the user's: its own row, or the row it
 *  was moved to (device_aliases). */
export function deviceStillLinked(
  db: DB,
  userId: string,
  deviceId: unknown,
): boolean {
  if (typeof deviceId !== "string" || deviceId === "") return false;
  const row = db
    .prepare<[string, string, string, string], { one: number }>(
      `SELECT 1 AS one FROM devices WHERE user_id = ? AND (id = ?
         OR id IN (SELECT new_id FROM device_aliases WHERE user_id = ? AND old_id = ?))
       LIMIT 1`,
    )
    .get(userId, deviceId, userId, deviceId);
  return row !== undefined;
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
