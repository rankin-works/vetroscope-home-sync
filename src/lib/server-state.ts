// SPDX-License-Identifier: Apache-2.0
//
// Helpers for the `server_state` singleton kv: JWT secret, setup token
// hash, schema version, installation id. First-boot bootstrap populates
// these exactly once; steady-state reads hit a small whitelist of keys.

import type { DB } from "../db.js";
import { generateHumanCode, generateToken, hashPassword } from "./crypto.js";

export const SERVER_STATE_KEYS = {
  jwtSecret: "jwt_secret",
  setupTokenHash: "setup_token_hash",
  setupTokenSalt: "setup_token_salt",
  installationId: "installation_id",
  createdAt: "created_at",
  setupCompletedAt: "setup_completed_at",
} as const;

type StateKey = (typeof SERVER_STATE_KEYS)[keyof typeof SERVER_STATE_KEYS];

export function getState(db: DB, key: StateKey): string | null {
  const row = db
    .prepare<[string], { value: string }>(
      "SELECT value FROM server_state WHERE key = ?",
    )
    .get(key);
  return row?.value ?? null;
}

export function setState(db: DB, key: StateKey, value: string): void {
  db.prepare<[string, string]>(
    `INSERT INTO server_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    updated_at = datetime('now')`,
  ).run(key, value);
}

export interface BootstrapResult {
  readonly firstBoot: boolean;
  readonly setupToken: string | null; // only non-null on first boot
  readonly installationId: string;
  readonly jwtSecret: string;
}

/**
 * Idempotent first-boot bootstrap. On a fresh database:
 *   1. Generates a JWT secret (unless overridden via VS_JWT_SECRET).
 *   2. Generates a one-time setup code, hashes it, stores the hash.
 *   3. Stamps installation_id and created_at.
 * Returns the cleartext setup code exactly once — callers MUST log it
 * and drop the reference, because the cleartext is never persisted.
 *
 * On subsequent boots, returns { firstBoot: false, setupToken: null }.
 */
export async function bootstrapServerState(
  db: DB,
  options: { readonly jwtSecretOverride: string | null },
): Promise<BootstrapResult> {
  const existing = getState(db, SERVER_STATE_KEYS.installationId);

  if (existing !== null) {
    // Allow env-var override to rotate the JWT secret at boot. Persist the
    // override so handlers always read from server_state.
    if (options.jwtSecretOverride !== null) {
      setState(
        db,
        SERVER_STATE_KEYS.jwtSecret,
        options.jwtSecretOverride,
      );
    }
    const jwt = getState(db, SERVER_STATE_KEYS.jwtSecret);
    if (jwt === null) {
      throw new Error(
        "server_state.installation_id is set but jwt_secret is missing — database is in an inconsistent state",
      );
    }
    return {
      firstBoot: false,
      setupToken: null,
      installationId: existing,
      jwtSecret: jwt,
    };
  }

  const installationId = generateToken(16);
  const jwtSecret = options.jwtSecretOverride ?? generateToken(32);
  const setupToken = generateHumanCode(3, 4);
  const setupSalt = generateToken(16);
  const setupHash = await hashPassword(setupToken, setupSalt);

  const tx = db.transaction(() => {
    setState(db, SERVER_STATE_KEYS.jwtSecret, jwtSecret);
    setState(db, SERVER_STATE_KEYS.setupTokenHash, setupHash);
    setState(db, SERVER_STATE_KEYS.setupTokenSalt, setupSalt);
    setState(db, SERVER_STATE_KEYS.installationId, installationId);
    setState(db, SERVER_STATE_KEYS.createdAt, new Date().toISOString());
  });
  tx();

  return { firstBoot: true, setupToken, installationId, jwtSecret };
}

export function isSetupComplete(db: DB): boolean {
  return getState(db, SERVER_STATE_KEYS.setupCompletedAt) !== null;
}
