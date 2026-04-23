// SPDX-License-Identifier: Apache-2.0
//
// Vetroscope Home Sync server entry point. Responsibilities:
//   1. Load + validate config from env.
//   2. Open the SQLite database and apply migrations.
//   3. Bootstrap server_state on first boot (JWT secret + setup code).
//   4. Build and start the Fastify app.
//
// Deliberately light on logic — the interesting work lives in app.ts and
// the route modules. This file is the seam we'd swap when running under
// a different supervisor (systemd, pm2, etc.).

import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { loadConfig } from "./env.js";
import { runMigrations } from "./lib/migrations.js";
import { bootstrapServerState } from "./lib/server-state.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Pre-logger startup banner — the Fastify logger isn't up yet, and we
  // want these lines to land before any request log noise.
  process.stdout.write(
    `[home-sync] Vetroscope Home Sync v${VERSION}\n` +
      `[home-sync] Data dir: ${config.dataDir}\n`,
  );

  const db = openDatabase({ dataDir: config.dataDir });
  const migrationResult = runMigrations(db);
  if (migrationResult.applied.length > 0) {
    process.stdout.write(
      `[home-sync] Applied migrations: ${migrationResult.applied.join(", ")}\n`,
    );
  }

  const bootstrap = await bootstrapServerState(db, {
    jwtSecretOverride: config.jwtSecretOverride,
  });

  if (bootstrap.firstBoot && bootstrap.setupToken !== null) {
    const bar = "═".repeat(55);
    process.stdout.write(
      `[home-sync] ${bar}\n` +
        `[home-sync]   First boot detected. Set up your server at:\n` +
        `[home-sync]     http://<your-host>:${config.port}/setup\n` +
        `[home-sync]\n` +
        `[home-sync]   Setup code: ${bootstrap.setupToken}\n` +
        `[home-sync]   (One-time. Will not appear in future logs.)\n` +
        `[home-sync] ${bar}\n`,
    );
  }

  const app = await buildApp({
    config,
    db,
    jwtSecret: bootstrap.jwtSecret,
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error({ err }, "failed to start listener");
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      db.close();
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`[home-sync] fatal: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
