// SPDX-License-Identifier: Apache-2.0
//
// Shared test harness. Spins up a Fastify instance against a tmp-dir
// SQLite DB so each test gets a clean state without touching the
// network or the host's /data volume.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { buildApp } from "../app.js";
import type { DB } from "../db.js";
import { openDatabase } from "../db.js";
import { loadConfig } from "../env.js";
import { generateToken } from "../lib/crypto.js";
import { runMigrations } from "../lib/migrations.js";
import { bootstrapServerState } from "../lib/server-state.js";

export interface Harness {
  app: FastifyInstance;
  db: DB;
  dataDir: string;
  setupToken: string;
  jwtSecret: string;
  cleanup: () => Promise<void>;
}

export async function createHarness(
  env: Record<string, string> = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "vhs-test-"));
  const original: Record<string, string | undefined> = {};
  const applied = {
    VS_DATA_DIR: dataDir,
    VS_LOG_LEVEL: "error",
    VS_ALLOW_REGISTRATION: "invite",
    ...env,
  };
  for (const [k, v] of Object.entries(applied)) {
    original[k] = process.env[k];
    process.env[k] = v;
  }

  const config = loadConfig();
  const db = openDatabase({ dataDir });
  runMigrations(db);
  const bootstrap = await bootstrapServerState(db, {
    jwtSecretOverride: generateToken(32),
  });
  if (bootstrap.setupToken === null) {
    throw new Error("bootstrap did not return a setup token");
  }

  const app = await buildApp({
    config,
    db,
    jwtSecret: bootstrap.jwtSecret,
  });
  await app.ready();

  return {
    app,
    db,
    dataDir,
    setupToken: bootstrap.setupToken,
    jwtSecret: bootstrap.jwtSecret,
    async cleanup() {
      await app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export async function bootstrapAdmin(h: Harness): Promise<{
  accessToken: string;
  refreshToken: string;
  userId: string;
  deviceId: string;
}> {
  const res = await h.app.inject({
    method: "POST",
    url: "/setup",
    payload: {
      setup_token: h.setupToken,
      email: "admin@test.lan",
      password: "hunter2hunter2",
      display_name: "Admin",
      device_name: "Admin MBP",
      platform: "darwin",
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as {
    user: { id: string };
    device_id: string;
    accessToken: string;
    refreshToken: string;
  };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    deviceId: body.device_id,
  };
}
