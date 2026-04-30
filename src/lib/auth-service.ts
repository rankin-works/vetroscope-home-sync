// SPDX-License-Identifier: Apache-2.0
//
// Auth state mutations. Centralized here so the /auth routes stay
// focused on HTTP shape and the CLI scripts can call the same primitives
// without going through a mock request.

import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import type { JWTPayload, Plan, Role, UserRow } from "../types.js";
import {
  generateSalt,
  generateToken,
  hashPassword,
  sha256,
  signJWT,
} from "./crypto.js";

export const ACCESS_TOKEN_EXPIRY_SECONDS = 60 * 60; // 1h
export const REFRESH_TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30d
export const MIN_PASSWORD_LENGTH = 8;
export const HOME_PLAN: Plan = "home";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  // ISO timestamp of when the refresh token expires. Multi-target sync
  // clients cache this on each target descriptor (Phase C of the
  // multi-target rollout) so the per-target refresh logic doesn't drift
  // off a stale value. Snake-case to match the rest of the auth payload's
  // *_at fields and to mirror what the cloud server returns.
  refresh_expires_at: string;
}

export async function issueTokens(
  db: DB,
  jwtSecret: string,
  user: UserRow,
  deviceId: string,
): Promise<IssuedTokens> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: user.id,
    email: user.email,
    plan: user.plan,
    role: user.role,
    device_id: deviceId,
    iat: now,
    exp: now + ACCESS_TOKEN_EXPIRY_SECONDS,
  };

  const accessToken = await signJWT(
    payload as unknown as Record<string, unknown>,
    jwtSecret,
  );

  const refreshToken = generateToken();
  const tokenHash = await sha256(refreshToken);
  const expiresAt = new Date(
    (now + REFRESH_TOKEN_EXPIRY_SECONDS) * 1000,
  ).toISOString();

  const tx = db.transaction(() => {
    db.prepare<[string, string]>(
      "DELETE FROM refresh_tokens WHERE user_id = ? AND device_id = ?",
    ).run(user.id, deviceId);

    db.prepare<[string, string, string, string, string]>(
      `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), user.id, deviceId, tokenHash, expiresAt);
  });
  tx();

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    refresh_expires_at: expiresAt,
  };
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role: Role;
}

export async function createUser(
  db: DB,
  input: CreateUserInput,
): Promise<UserRow> {
  const id = randomUUID();
  const salt = generateSalt();
  const hash = await hashPassword(input.password, salt);
  const email = input.email.toLowerCase();
  const now = new Date().toISOString();

  db.prepare<
    [string, string, string, string, string, Plan, Role, string, string]
  >(
    `INSERT INTO users
      (id, email, display_name, password_hash, password_salt, plan, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, email, input.displayName, hash, salt, HOME_PLAN, input.role, now, now);

  return {
    id,
    email,
    display_name: input.displayName,
    password_hash: hash,
    password_salt: salt,
    plan: HOME_PLAN,
    role: input.role,
    encrypted_sync_key: null,
    created_at: now,
    updated_at: now,
  };
}

export function findUserByEmail(db: DB, email: string): UserRow | undefined {
  return db
    .prepare<[string], UserRow>(
      "SELECT * FROM users WHERE email = ?",
    )
    .get(email.toLowerCase());
}

export function findUserById(db: DB, id: string): UserRow | undefined {
  return db
    .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
    .get(id);
}

export function countUsers(db: DB): number {
  return db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM users")
    .get()?.n ?? 0;
}
