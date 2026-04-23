// SPDX-License-Identifier: Apache-2.0
//
// GET /server-info — unauthenticated descriptor the client reads during
// onboarding so it can show a friendly server name, detect whether setup
// has completed, and version-gate against incompatible server versions.

import type { FastifyPluginAsync } from "fastify";

import type { Config } from "../env.js";
import { isSetupComplete } from "../lib/server-state.js";
import { VERSION } from "../version.js";

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
      };
    });
  };
}
