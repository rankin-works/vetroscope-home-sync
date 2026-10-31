// SPDX-License-Identifier: Apache-2.0
//
// Helpers for the `server_state` singleton kv: JWT secret, setup token
// hash, schema version, installation id. First-boot bootstrap populates
// these exactly once; steady-state reads hit a small whitelist of keys.

import type { DB } from "../db.js";
import {
  generateHumanCode,
  generateToken,
  hashPassword,
  TOKEN_HASH_ITERATIONS,
} from "./crypto.js";
import {
  decryptSecret,
  decryptSyncDek,
  encryptSecret,
  encryptSyncDek,
  isJwtSecretBound,
} from "./secret-crypto.js";

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
    // VS_JWT_SECRET can still change the secret at boot, but only while
    // nothing is wrapped with a key derived from it: the sign-in recovery
    // wraps (without VS_SYNC_DEK_KEK) and the Google Calendar accounts.
    // Swapping it under them made every user's key and calendar connection
    // unreadable, with no error until a new computer tried to unlock. Once
    // they exist, `vhs-cli rotate-jwt-secret` re-wraps them as it changes
    // the secret. Persist the override so handlers always read from
    // server_state.
    const stored = getState(db, SERVER_STATE_KEYS.jwtSecret);
    if (
      options.jwtSecretOverride !== null &&
      options.jwtSecretOverride !== stored
    ) {
      const bound = countJwtSecretBoundWraps(db);
      if (stored !== null && bound > 0) {
        throw new Error(
          `VS_JWT_SECRET differs from the JWT secret this server already uses, and ${bound} ` +
            "encryption key(s) or calendar connection(s) are wrapped with a key derived from it. " +
            "Changing it here would make them unreadable. Put the previous value back (or unset " +
            "VS_JWT_SECRET), then change the secret with `vhs-cli rotate-jwt-secret --confirm " +
            "--secret -`, which re-wraps them. See docs/troubleshooting.md.",
        );
      }
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
  const setupHash = await hashPassword(
    setupToken,
    setupSalt,
    TOKEN_HASH_ITERATIONS,
  );

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

/** How many stored blobs are wrapped with a key derived from the JWT secret:
 *  v1 sign-in recovery wraps and Google Calendar accounts (which are always
 *  v1). A new JWT secret can't read them. */
export function countJwtSecretBoundWraps(db: DB): number {
  const wraps = db
    .prepare<[], { w: string }>(
      "SELECT sync_key_server_wrap AS w FROM users WHERE sync_key_server_wrap IS NOT NULL",
    )
    .all()
    .filter((r) => isJwtSecretBound(r.w)).length;
  const vault = db
    .prepare<[], { n: number }>(
      "SELECT COUNT(*) AS n FROM google_calendar_accounts",
    )
    .get()!.n;
  return wraps + vault;
}

/** How many stored sign-in recovery wraps and Google Calendar accounts
 *  this server can't open with its current secrets. Checked at boot, so an
 *  install whose keys were lost (a secret changed some other way) says so
 *  in its log instead of only when a computer next tries to unlock. */
export function countUnreadableWraps(
  db: DB,
  jwtSecret: string,
  syncDekKek: string | null,
): number {
  let unreadable = 0;
  const wraps = db
    .prepare<[], { w: string }>(
      "SELECT sync_key_server_wrap AS w FROM users WHERE sync_key_server_wrap IS NOT NULL",
    )
    .all();
  for (const { w } of wraps) {
    try {
      decryptSyncDek(w, jwtSecret, syncDekKek);
    } catch {
      unreadable++;
    }
  }
  const accounts = db
    .prepare<[], { p: string }>("SELECT payload_enc AS p FROM google_calendar_accounts")
    .all();
  for (const { p } of accounts) {
    try {
      decryptSecret(p, jwtSecret);
    } catch {
      unreadable++;
    }
  }
  return unreadable;
}

export interface RotateJwtSecretResult {
  readonly syncKeys: number;
  readonly calendarAccounts: number;
  /** Blobs the old secret couldn't open either, left as they were. */
  readonly unreadable: number;
}

/**
 * Change the JWT secret, re-wrapping everything wrapped with a key derived
 * from the old one (see countJwtSecretBoundWraps), and sign everyone out.
 * One transaction: if a blob the old secret should open doesn't, nothing
 * changes and this throws, unless `allowUnreadable` (those blobs were
 * already lost, and are left as they were). Wraps under VS_SYNC_DEK_KEK
 * (v2) don't depend on the JWT secret and aren't touched.
 */
export function rotateJwtSecret(
  db: DB,
  newSecret: string,
  options: {
    readonly syncDekKek: string | null;
    readonly allowUnreadable?: boolean;
  },
): RotateJwtSecretResult {
  const oldSecret = getState(db, SERVER_STATE_KEYS.jwtSecret);
  if (oldSecret === null) throw new Error("No JWT secret to rotate.");
  let syncKeys = 0;
  let calendarAccounts = 0;
  let unreadable = 0;

  db.transaction(() => {
    const users = db
      .prepare<[], { id: string; w: string }>(
        "SELECT id, sync_key_server_wrap AS w FROM users WHERE sync_key_server_wrap IS NOT NULL",
      )
      .all();
    const setWrap = db.prepare<[string, string]>(
      "UPDATE users SET sync_key_server_wrap = ? WHERE id = ?",
    );
    for (const u of users) {
      if (!isJwtSecretBound(u.w)) continue;
      let dek: string;
      try {
        dek = decryptSyncDek(u.w, oldSecret, options.syncDekKek);
      } catch {
        unreadable++;
        continue;
      }
      setWrap.run(encryptSyncDek(dek, newSecret, options.syncDekKek), u.id);
      syncKeys++;
    }

    const accounts = db
      .prepare<[], { rid: number; p: string }>(
        "SELECT rowid AS rid, payload_enc AS p FROM google_calendar_accounts",
      )
      .all();
    const setPayload = db.prepare<[string, number]>(
      "UPDATE google_calendar_accounts SET payload_enc = ? WHERE rowid = ?",
    );
    for (const a of accounts) {
      let plain: string;
      try {
        plain = decryptSecret(a.p, oldSecret);
      } catch {
        unreadable++;
        continue;
      }
      setPayload.run(encryptSecret(plain, newSecret), a.rid);
      calendarAccounts++;
    }

    if (unreadable > 0 && options.allowUnreadable !== true) {
      throw new Error(
        `${unreadable} stored key(s) or calendar connection(s) can't be opened with the current ` +
          "JWT secret, so they can't be re-wrapped. Nothing was changed. Pass --allow-unreadable " +
          "to rotate anyway and leave them as they are (they're already unreadable).",
      );
    }

    setState(db, SERVER_STATE_KEYS.jwtSecret, newSecret);
    db.prepare("DELETE FROM refresh_tokens").run();
  })();

  return { syncKeys, calendarAccounts, unreadable };
}
