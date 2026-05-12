// SPDX-License-Identifier: Apache-2.0
//
// GET /server-info — unauthenticated descriptor the client reads during
// onboarding so it can show a friendly server name, detect whether setup
// has completed, and version-gate against incompatible server versions.

import type { FastifyPluginAsync } from "fastify";

import type { Config } from "../env.js";
import { isSetupComplete } from "../lib/server-state.js";
import { VERSION } from "../version.js";

// Minimum Vetroscope desktop-app version this server will accept on
// /sync/push and /sync/pull. Bump when shipping a server change that
// depends on a newer client payload shape (e.g. when sync_tags gained
// parent_uuid in beta.9 the client started sending it; pre-0.2.22
// clients still work but don't populate that field). Exposed on
// /server-info so clients can pre-check before pushing and surface
// "your Vetroscope app is out of date" without a 426 round-trip.
const MIN_CLIENT_VERSION = "0.2.22";

export function buildServerInfoRoutes(config: Config): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get("/server-info", async () => {
      return {
        name: config.serverName,
        version: VERSION,
        flavor: "home-sync",
        setup_required: !isSetupComplete(fastify.db),
        registration_mode: config.registrationMode,
        max_devices_per_user: config.maxDevicesPerUser,
        min_client_version: MIN_CLIENT_VERSION,
      };
    });
  };
}

// Export so /sync/push and /sync/pull can use the same constant for the
// 426 Upgrade Required gate. Keeping a single source of truth means the
// /server-info advertisement and the actual gate can never drift.
export const SERVER_MIN_CLIENT_VERSION = MIN_CLIENT_VERSION;
