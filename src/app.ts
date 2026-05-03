// SPDX-License-Identifier: Apache-2.0
//
// Fastify application factory. Isolated from `index.ts` so tests can build
// an app against an in-memory DB without touching the network or the
// filesystem data directory.

import fastifyStatic from "@fastify/static";
import fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import { webRoutes } from "./routes/web.js";

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
  await app.register(webRoutes);
  await app.register(adminRoutes);

  // Bundled web UI. Resolves to `public/` next to this file in dev (tsx
  // runs from src/) and the same path next to the compiled JS in dist/
  // (copy-assets.mjs mirrors the directory). Mounted last so /api routes
  // take precedence over the catch-all index.html fallback.
  const here = dirname(fileURLToPath(import.meta.url));
  const publicRoot = resolve(here, "public");
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/",
    wildcard: false,
  });
  // SPA fallback — anything that didn't match an API route or a static
  // file (e.g. /dashboard, /charts, /activity) falls back to index.html
  // so the client-side router can pick up the path.
  app.setNotFoundHandler((request, reply) => {
    if (
      request.method === "GET" &&
      !request.url.startsWith("/auth/") &&
      !request.url.startsWith("/sync/") &&
      !request.url.startsWith("/user/") &&
      !request.url.startsWith("/web/") &&
      !request.url.startsWith("/admin/") &&
      !request.url.startsWith("/setup") &&
      !request.url.startsWith("/health") &&
      !request.url.startsWith("/server-info")
    ) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.status(404).send({ error: "not_found" });
  });

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
