// SPDX-License-Identifier: Apache-2.0
//
// /admin/* — administrative endpoints reserved for role=admin. Today
// this is just invite management; Phase 6 will likely add a user list
// and per-user device revocation.

import type { FastifyPluginAsync } from "fastify";

import {
  createInvite,
  listInvites,
  revokeInvite,
} from "../lib/invite-service.js";
import type { JWTPayload, Role } from "../types.js";

interface CreateInviteBody {
  role?: Role;
  ttl_hours?: number;
}

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);
  fastify.addHook("preHandler", fastify.requireAdmin);

  fastify.post<{ Body: CreateInviteBody }>(
    "/admin/invites",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      const body = request.body ?? {};
      const ttl = typeof body.ttl_hours === "number" ? body.ttl_hours : undefined;
      if (ttl !== undefined && (ttl <= 0 || ttl > 24 * 30)) {
        return reply.status(400).send({
          error: "invalid_request",
          message: "ttl_hours must be between 1 and 720.",
        });
      }
      const opts: { role?: Role; ttlHours?: number } = {};
      if (body.role !== undefined) opts.role = body.role;
      if (ttl !== undefined) opts.ttlHours = ttl;
      const invite = await createInvite(fastify.db, auth.sub, opts);
      return reply.status(201).send(invite);
    },
  );

  fastify.get("/admin/invites", async (_request, reply) => {
    return reply.send({ invites: listInvites(fastify.db) });
  });

  fastify.delete<{ Params: { id: string } }>(
    "/admin/invites/:id",
    async (request, reply) => {
      const ok = revokeInvite(fastify.db, request.params.id);
      if (!ok) return reply.status(404).send({ error: "not_found" });
      return reply.send({ ok: true });
    },
  );
};
