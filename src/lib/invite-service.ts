// SPDX-License-Identifier: Apache-2.0
//
// Invite token helpers. Codes are displayed once to the admin (same
// Crockford-base32 shape as the setup code) and stored hashed with a
// per-row salt so a compromised DB doesn't yield usable codes.

import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import type { InviteRow, Role } from "../types.js";
import { generateHumanCode, generateToken, hashPassword } from "./crypto.js";

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
  // The id acts as the salt-bearing locator: token_hash = PBKDF2(token, salt),
  // and we keep the salt on the row so verifyInvite can recompute. We store
  // salt alongside by prefixing it on the hash column (salt + ':' + hash) to
  // avoid an additional schema column.
  const hash = await hashPassword(token.toUpperCase(), salt);
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();

  db.prepare<[string, string, string, Role, string]>(
    `INSERT INTO invites (id, token_hash, created_by, role, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, `${salt}:${hash}`, createdBy, role, expiresAt);

  return { id, token, expires_at: expiresAt, role };
}

export async function consumeInvite(
  db: DB,
  token: string,
): Promise<InviteRow | null> {
  const now = new Date().toISOString();
  const rows = db
    .prepare<[string], InviteRow>(
      `SELECT * FROM invites
         WHERE used_at IS NULL AND expires_at > ?`,
    )
    .all(now);

  for (const row of rows) {
    const [salt, hash] = row.token_hash.split(":", 2) as [string, string];
    if (salt === undefined || hash === undefined) continue;
    const candidate = await hashPassword(token.toUpperCase(), salt);
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
