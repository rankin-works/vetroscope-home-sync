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
import { googleCalendarRoutes } from "./routes/google-calendar.js";

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
    // Off unless the operator says otherwise — see VS_TRUST_PROXY. The rate
    // limiters key on request.ip, so trusting a forwarded header we can't
    // verify would let a client mint a fresh bucket per request.
    trustProxy: config.trustProxy,
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024, // 10 MB — icons payloads can be chunky
  });

  // The Vetroscope client POSTs to body-less endpoints like /sync/reset with
  // Content-Type: application/json and no payload. Fastify's default parser
  // rejects that before the route runs; treat an empty body as {} instead.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      if (body === "" || body === null || body === undefined) {
        done(null, {});
        return;
      }
      defaultJsonParser(request, body as string, done);
    },
  );

  // Upgrading to a build that stopped trusting X-Forwarded-For by default is
  // invisible from the outside: nothing errors, the rate limiters just start
  // bucketing every client behind a proxy together. Say so once, the first
  // time we see a forwarded header we've been told to ignore, so the fix is
  // discoverable from the logs instead of from a mystery 429.
  if (config.trustProxy === false) {
    let warned = false;
    app.addHook("onRequest", async (request) => {
      if (warned) return;
      if (request.headers["x-forwarded-for"] === undefined) return;
      warned = true;
      request.log.warn(
        "Saw X-Forwarded-For but VS_TRUST_PROXY is off, so rate limits are " +
          "keyed on the proxy's address and shared across all clients. If a " +
          "reverse proxy is in front of this server, set VS_TRUST_PROXY=true " +
          "(or to the proxy's address/CIDR). Leave it off if the server is " +
          "reachable directly — the header is trivially spoofed.",
      );
    });
  }

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
  await app.register(googleCalendarRoutes);
  await app.register(syncRoutes);
  await app.register(adminRoutes);

  app.setNotFoundHandler((_request, reply) => {
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
