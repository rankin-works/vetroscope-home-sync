// SPDX-License-Identifier: Apache-2.0
//
// Fastify application factory. Isolated from `index.ts` so tests can build
// an app against an in-memory DB without touching the network or the
// filesystem data directory.

import fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";

import type { DB } from "./db.js";
import type { Config } from "./env.js";
import { buildAuthenticate, requireRole } from "./middleware/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { buildHealthRoutes } from "./routes/health.js";
import { buildServerInfoRoutes } from "./routes/server-info.js";
import { setupRoutes } from "./routes/setup.js";
import { syncRoutes } from "./routes/sync.js";
import { userRoutes } from "./routes/user.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DB;
    config: Config;
    jwtSecret: string;
    authenticate: preHandlerHookHandler;
    requireAdmin: preHandlerHookHandler;
  }
}

export interface BuildAppOptions {
  readonly config: Config;
  readonly db: DB;
  readonly jwtSecret: string;
}

export async function buildApp({
  config,
  db,
  jwtSecret,
}: BuildAppOptions): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: config.logLevel,
      // Redact anything that smells like a credential — JWTs travel in
      // Authorization, setup codes in request bodies. Never log these.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.setup_token',
          'req.body.invite_token',
          'req.body.refresh_token',
        ],
        remove: true,
      },
    },
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024, // 10 MB — icons payloads can be chunky
  });

  app.decorate("db", db);
  app.decorate("config", config);
  app.decorate("jwtSecret", jwtSecret);
  app.decorate("authenticate", buildAuthenticate());
  app.decorate("requireAdmin", requireRole("admin"));

  await app.register(buildHealthRoutes(config));
  await app.register(buildServerInfoRoutes(config));
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(syncRoutes);
  await app.register(adminRoutes);

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const status = error.statusCode ?? 500;
    void reply.status(status).send({
      error: status >= 500 ? "internal_error" : (error.code ?? "error"),
      message: status >= 500 ? "An internal error occurred." : error.message,
    });
  });

  return app;
}
