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
      // `ok` + `version` are all the Docker HEALTHCHECK and the client's
      // connection wizard look at — the wizard only checks for a 200 here
      // and reads /server-info for anything it displays.
      //
      // Account count and database size are operator metrics, not liveness,
      // and this route is unauthenticated by necessity. On a server exposed
      // to the internet they'd tell a passer-by how many accounts exist and
      // roughly how much data is behind them, so they're behind
      // VS_ENABLE_METRICS (off by default).
      if (!config.enableMetrics) {
        return { ok: true, version: VERSION };
      }

      const dbPath = join(config.dataDir, "sync.db");
      let databaseSizeBytes = 0;
      try {
        databaseSizeBytes = statSync(dbPath).size;
      } catch {
        // Fresh boot before first write — report 0 instead of 500ing.
      }

      const userCount =
        fastify.db
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
