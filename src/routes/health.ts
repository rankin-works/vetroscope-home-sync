// SPDX-License-Identifier: Apache-2.0
//
// GET /health — unauthenticated liveness probe used both by the Docker
// HEALTHCHECK and by the client's connection wizard to verify that a
// configured server URL responds with the right shape before attempting
// auth. Keep the response small and cheap; no secrets, no PII.

import { statSync } from "node:fs";
import { join } from "node:path";

import type { FastifyPluginAsync } from "fastify";

import type { Config } from "../env.js";
import { VERSION } from "../version.js";

export function buildHealthRoutes(config: Config): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/health", async () => {
      const dbPath = join(config.dataDir, "sync.db");
      let databaseSizeBytes = 0;
      try {
        databaseSizeBytes = statSync(dbPath).size;
      } catch {
        // Fresh boot before first write — report 0 instead of 500ing.
      }

      const userCount = fastify.db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM users")
        .get()?.n ?? 0;

      return {
        ok: true,
        version: VERSION,
        users: userCount,
        database_size_bytes: databaseSizeBytes,
      };
    });
  };
}
