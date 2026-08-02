// SPDX-License-Identifier: Apache-2.0
//
// Environment configuration. All VS_* variables are documented in the
// architecture doc (docs/architecture.md §Docker Distribution). This module
// validates and coerces them once at boot; the rest of the codebase reads
// from the returned object, never `process.env` directly.

import { hostname } from "node:os";

export type RegistrationMode = "open" | "invite" | "closed";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly serverName: string;
  readonly jwtSecretOverride: string | null;
  readonly syncDekKek: string | null;
  /**
   * What to tell Fastify about proxies in front of us. `false` (default)
   * means the peer socket address is the client address. Anything else is
   * handed to Fastify's `trustProxy`: `true`, a hop count, or a
   * comma-separated list of trusted addresses/CIDRs.
   */
  readonly trustProxy: boolean | number | string;
  readonly tlsCertPath: string | null;
  readonly tlsKeyPath: string | null;
  readonly maxDevicesPerUser: number;
  readonly registrationMode: RegistrationMode;
  readonly logLevel: LogLevel;
  readonly enableMetrics: boolean;
}

function readString(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

function readOptionalString(name: string): string | null {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : null;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${name}: ${raw!} — must be a positive integer`);
  }
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function readEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid ${name}: ${raw} — must be one of ${allowed.join(", ")}`,
    );
  }
  return raw as T;
}

function readTrustProxy(): boolean | number | string {
  const raw = process.env.VS_TRUST_PROXY;
  if (raw === undefined || raw === "") return false;
  const v = raw.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "yes") return true;
  // A bare integer is a hop count ("trust the Nth address from the right").
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  // Otherwise treat it as an address / CIDR allowlist and let Fastify parse
  // it. A typo here fails closed at boot rather than silently trusting
  // everything, which is the failure direction we want.
  return raw.trim();
}

export function loadConfig(): Config {
  const tlsCertPath = readOptionalString("VS_TLS_CERT");
  const tlsKeyPath = readOptionalString("VS_TLS_KEY");
  if ((tlsCertPath === null) !== (tlsKeyPath === null)) {
    throw new Error(
      "VS_TLS_CERT and VS_TLS_KEY must either both be set or both unset",
    );
  }

  // Whether to believe X-Forwarded-For. This defaults to OFF because the
  // rate limiters key on request.ip: with blind trust and no proxy actually
  // in front of the container, anyone can rotate the header per request and
  // give themselves a fresh bucket every time, which removes the cap on
  // password and setup-code guessing entirely.
  //
  // The cost of the safe default is that a genuinely proxied deployment
  // sees every client as the proxy's address and shares one bucket, so
  // operators behind Caddy/Traefik/nginx should set this. Accepts `true`,
  // a hop count, or a list of trusted addresses/CIDRs when only some
  // upstreams should be believed.
  const trustProxy = readTrustProxy();

  // Optional wrapping key for sync DEKs, decoupling secrets-at-rest from the
  // JWT signing secret. Validated at boot so a malformed value fails the
  // container start rather than the first /user/sync-key/unlock — by which
  // point a user is staring at an unlock error with no idea why.
  const syncDekKek = readOptionalString("VS_SYNC_DEK_KEK");
  if (syncDekKek !== null) {
    const bytes = /^[0-9a-f]{64}$/i.test(syncDekKek)
      ? 32
      : Buffer.from(syncDekKek, "base64").length;
    if (bytes !== 32) {
      throw new Error(
        "Invalid VS_SYNC_DEK_KEK — must be 32 bytes (64 hex chars or base64). " +
          "Generate one with: openssl rand -hex 32",
      );
    }
  }

  return {
    dataDir: readString("VS_DATA_DIR", "/data"),
    port: readInt("VS_PORT", 4437),
    host: readString("VS_HOST", "0.0.0.0"),
    serverName: readString("VS_SERVER_NAME", hostname()),
    jwtSecretOverride: readOptionalString("VS_JWT_SECRET"),
    syncDekKek,
    trustProxy,
    tlsCertPath,
    tlsKeyPath,
    maxDevicesPerUser: readInt("VS_MAX_DEVICES_PER_USER", 10),
    registrationMode: readEnum<RegistrationMode>(
      "VS_ALLOW_REGISTRATION",
      ["open", "invite", "closed"] as const,
      "invite",
    ),
    logLevel: readEnum<LogLevel>(
      "VS_LOG_LEVEL",
      ["debug", "info", "warn", "error"] as const,
      "info",
    ),
    enableMetrics: readBool("VS_ENABLE_METRICS", false),
  };
}
