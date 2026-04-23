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

export function loadConfig(): Config {
  const tlsCertPath = readOptionalString("VS_TLS_CERT");
  const tlsKeyPath = readOptionalString("VS_TLS_KEY");
  if ((tlsCertPath === null) !== (tlsKeyPath === null)) {
    throw new Error(
      "VS_TLS_CERT and VS_TLS_KEY must either both be set or both unset",
    );
  }

  return {
    dataDir: readString("VS_DATA_DIR", "/data"),
    port: readInt("VS_PORT", 4437),
    host: readString("VS_HOST", "0.0.0.0"),
    serverName: readString("VS_SERVER_NAME", hostname()),
    jwtSecretOverride: readOptionalString("VS_JWT_SECRET"),
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
