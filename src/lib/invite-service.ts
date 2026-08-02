// SPDX-License-Identifier: Apache-2.0
//
// Invite token helpers. Codes are displayed once to the admin (same
// Crockford-base32 shape as the setup code) and stored hashed with a
// per-row salt so a compromised DB doesn't yield usable codes.

import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import type { InviteRow, Role } from "../types.js";
import {
  generateHumanCode,
  generateToken,
  hashPassword,
  sha256,
  TOKEN_HASH_ITERATIONS,
} from "./crypto.js";

const DEFAULT_TTL_HOURS = 24;

export interface IssuedInvite {
  id: string;
  token: string; // cleartext — shown once
  expires_at: string;
  role: Role;
}

export async function createInvite(
  db: DB,
  createdBy: string,
  opts: { role?: Role; ttlHours?: number } = {},
): Promise<IssuedInvite> {
  const role = opts.role ?? "user";
  const ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
  const id = randomUUID();
  const token = generateHumanCode(3, 4);
  const salt = generateToken(16);
  // token_hash carries its own salt inline (salt + ':' + hash) so the row is
  // self-describing without an extra column. That salt is per-row, which is
  // why finding a row by code needs the separate locator below.
  const hash = await hashPassword(
    token.toUpperCase(),
    salt,
    TOKEN_HASH_ITERATIONS,
  );
  // Fast indexed locator (026). Selects the candidate row only — token_hash
  // is still what authorizes it.
  const lookup = await sha256(token.toUpperCase());
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

  db.prepare<[string, string, string, string, Role, string]>(
    `INSERT INTO invites (id, token_hash, token_lookup, created_by, role, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `${salt}:${hash}`, lookup, createdBy, role, expiresAt);

  return { id, token, expires_at: expiresAt, role };
}

export async function consumeInvite(
  db: DB,
  token: string,
): Promise<InviteRow | null> {
  const now = new Date().toISOString();
  const normalized = token.toUpperCase();

  // Fast path (026): find the one candidate row by its indexed digest, then
  // verify it properly. Bounds the work for a registration attempt at a
  // single key derivation regardless of how many invites are outstanding —
  // without this, an unauthenticated caller could spend O(open invites)
  // derivations per request.
  const lookup = await sha256(normalized);
  const direct = db
    .prepare<[string, string], InviteRow>(
      `SELECT * FROM invites
         WHERE token_lookup = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .get(lookup, now);

  // Slow path: rows created before 026 have no locator and can't be given
  // one (the stored hash is salted and one-way), so they still need the
  // scan. Bounded by the 30-day TTL — the set drains on its own.
  const rows = direct
    ? [direct]
    : db
        .prepare<[string], InviteRow>(
          `SELECT * FROM invites
             WHERE token_lookup IS NULL AND used_at IS NULL AND expires_at > ?`,
        )
        .all(now);

  for (const row of rows) {
    const [salt, hash] = row.token_hash.split(":", 2) as [string, string];
    if (salt === undefined || hash === undefined) continue;
    const candidate = await hashPassword(
      token.toUpperCase(),
      salt,
      TOKEN_HASH_ITERATIONS,
    );
    if (timingSafeEqual(candidate, hash)) {
      const res = db
        .prepare<[string, string]>(
          "UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL",
        )
        .run(now, row.id);
      if (res.changes === 0) return null; // lost race, treat as invalid
      return { ...row, used_at: now };
    }
  }
  return null;
}

export function revokeInvite(db: DB, id: string): boolean {
  const res = db
    .prepare<[string]>("DELETE FROM invites WHERE id = ?")
    .run(id);
  return res.changes > 0;
}

export function listInvites(db: DB): Array<
  Pick<InviteRow, "id" | "created_by" | "role" | "expires_at" | "used_at" | "created_at">
> {
  return db
    .prepare<
      [],
      Pick<InviteRow, "id" | "created_by" | "role" | "expires_at" | "used_at" | "created_at">
    >(
      `SELECT id, created_by, role, expires_at, used_at, created_at
       FROM invites
       ORDER BY created_at DESC`,
    )
    .all();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
