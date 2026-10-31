// SPDX-License-Identifier: Apache-2.0
//
// vhs-cli — in-container admin surface. Invoked via
//   docker exec <container> node dist/cli/index.js <subcommand>
// The Dockerfile exposes a `vhs-cli` shim on PATH so the command is
// short and discoverable (`docker exec … vhs-cli reset-password`).
//
// Each subcommand opens the same SQLite DB the server uses, performs
// a single mutation, and exits. The server doesn't need to be stopped
// — SQLite's WAL mode plus a 5s busy_timeout means admin writes and
// live traffic coexist cleanly for the kinds of one-off operations
// this CLI handles.

import { readFileSync } from "node:fs";

import { openDatabase } from "../db.js";
import { loadConfig } from "../env.js";
import { createUser } from "../lib/auth-service.js";
import {
  generateSalt,
  hashPassword,
  PBKDF2_ITERATIONS,
} from "../lib/crypto.js";
import { runMigrations } from "../lib/migrations.js";
import type { Role, UserRow } from "../types.js";
import { VERSION } from "../version.js";

type Subcommand =
  | "create-user"
  | "reset-password"
  | "list-users"
  | "revoke-tokens"
  | "promote"
  | "demote"
  | "rotate-jwt-secret"
  | "version"
  | "help";

const USAGE = `vhs-cli ${VERSION}

Usage:
  vhs-cli create-user   --email <e> --password <p> --display-name <n> [--role admin|user]
  vhs-cli reset-password --email <e> --password <p>
  vhs-cli list-users
  vhs-cli revoke-tokens --email <e>
  vhs-cli promote --email <e>
  vhs-cli demote  --email <e>
  vhs-cli rotate-jwt-secret --confirm [--secret <s>|-] [--allow-unreadable]
  vhs-cli version
  vhs-cli help

--password reads from stdin if the value is "-".
`;

interface Flags {
  [key: string]: string | boolean;
}

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function requireString(flags: Flags, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || v.length === 0) {
    die(`Missing required flag: --${key}`);
  }
  return v;
}

function resolvePassword(raw: string): string {
  if (raw === "-") {
    const input = readFileSync(0, "utf8").trim();
    if (input.length === 0) die("Password read from stdin was empty.");
    return input;
  }
  return raw;
}

function die(msg: string): never {
  process.stderr.write(`vhs-cli: ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;
  const cmd = (sub ?? "help") as Subcommand;

  if (cmd === "help" || cmd === "version") {
    process.stdout.write(cmd === "version" ? `${VERSION}\n` : USAGE);
    return;
  }

  const flags = parseFlags(rest);
  const config = loadConfig();
  const db = openDatabase({ dataDir: config.dataDir });
  runMigrations(db);

  switch (cmd) {
    case "create-user": {
      const email = requireString(flags, "email");
      const password = resolvePassword(requireString(flags, "password"));
      const displayName = requireString(flags, "display-name");
      const role = (flags.role === "admin" ? "admin" : "user") as Role;
      const user = await createUser(db, {
        email,
        password,
        displayName,
        role,
      });
      process.stdout.write(
        `Created ${role} ${user.email} (id=${user.id})\n`,
      );
      break;
    }

    case "reset-password": {
      const email = requireString(flags, "email");
      const password = resolvePassword(requireString(flags, "password"));
      const row = db
        .prepare<[string], { id: string }>(
          "SELECT id FROM users WHERE email = ?",
        )
        .get(email.toLowerCase());
      if (row === undefined) die(`No user with email ${email}`);
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      const tx = db.transaction(() => {
        // token_version bump matches the /user/password route: an admin
        // resetting a password should also kill sessions whose access token
        // hasn't expired, not just the refresh tokens.
        db.prepare<[string, string, number, string]>(
          `UPDATE users SET
             password_hash = ?,
             password_salt = ?,
             password_iterations = ?,
             token_version = token_version + 1,
             updated_at = datetime('now')
           WHERE id = ?`,
        ).run(hash, salt, PBKDF2_ITERATIONS, row.id);
        db.prepare<[string]>(
          "DELETE FROM refresh_tokens WHERE user_id = ?",
        ).run(row.id);
      });
      tx();
      process.stdout.write(
        `Password reset for ${email}. All existing sessions revoked.\n`,
      );
      break;
    }

    case "list-users": {
      const rows = db
        .prepare<
          [],
          Pick<UserRow, "id" | "email" | "display_name" | "role" | "created_at">
        >(
          "SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at ASC",
        )
        .all();
      if (rows.length === 0) {
        process.stdout.write("No users yet.\n");
        break;
      }
      for (const r of rows) {
        process.stdout.write(
          `${r.id}  ${r.role.padEnd(5)}  ${r.email}  (${r.display_name})\n`,
        );
      }
      break;
    }

    case "revoke-tokens": {
      const email = requireString(flags, "email");
      const row = db
        .prepare<[string], { id: string }>(
          "SELECT id FROM users WHERE email = ?",
        )
        .get(email.toLowerCase());
      if (row === undefined) die(`No user with email ${email}`);
      // Deleting the refresh tokens stops renewals; the token_version bump
      // also stops the access tokens already handed out, which are
      // otherwise good for up to an hour.
      const res = db.transaction(() => {
        db.prepare<[string]>(
          "UPDATE users SET token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?",
        ).run(row.id);
        return db
          .prepare<[string]>("DELETE FROM refresh_tokens WHERE user_id = ?")
          .run(row.id);
      })();
      process.stdout.write(
        `Revoked ${res.changes} refresh token(s) for ${email}.\n`,
      );
      break;
    }

    case "promote":
    case "demote": {
      const email = requireString(flags, "email");
      const nextRole: Role = cmd === "promote" ? "admin" : "user";
      // A demotion also bumps token_version, so the access tokens that still
      // say admin stop working now rather than when they expire. Sessions
      // renew with the new role on their next refresh.
      const res = db
        .prepare<[Role, number, string]>(
          `UPDATE users SET role = ?, token_version = token_version + ?,
             updated_at = datetime('now') WHERE email = ?`,
        )
        .run(nextRole, cmd === "demote" ? 1 : 0, email.toLowerCase());
      if (res.changes === 0) die(`No user with email ${email}`);
      process.stdout.write(`${email} is now ${nextRole}.\n`);
      break;
    }

    case "rotate-jwt-secret": {
      if (flags.confirm !== true) {
        process.stderr.write(
          "Rotating the JWT secret invalidates every active session. Pass --confirm to proceed.\n",
        );
        process.exit(2);
      }
      const { generateToken } = await import("../lib/crypto.js");
      const { rotateJwtSecret } = await import("../lib/server-state.js");
      // --secret sets a chosen value (from stdin with "-"), for installs that
      // pin it with VS_JWT_SECRET: set the variable to the same value before
      // the server next starts, since a different one is refused once keys
      // are wrapped with it.
      let next: string;
      if (flags.secret === undefined) {
        // A random secret can't match a pinned VS_JWT_SECRET, and the server
        // refuses to start while they differ with keys wrapped.
        if (config.jwtSecretOverride !== null) {
          die(
            "VS_JWT_SECRET is set, so a random secret would stop the server from starting. " +
              "Rotate to a value you choose with --secret - (read from stdin), then set " +
              "VS_JWT_SECRET to it. See docs/troubleshooting.md.",
          );
        }
        next = generateToken(32);
      } else {
        const raw = typeof flags.secret === "string" ? flags.secret : "";
        next = resolvePassword(raw);
        if (next.length < 32) die("--secret must be at least 32 characters.");
      }
      // The old secret opens the stored wraps, and they're re-wrapped with
      // the new one in the same transaction (rotateJwtSecret).
      const result = rotateJwtSecret(db, next, {
        syncDekKek: config.syncDekKek,
        allowUnreadable: flags["allow-unreadable"] === true,
      });
      process.stdout.write(
        `JWT secret rotated. Re-wrapped ${result.syncKeys} encryption key(s) and ` +
          `${result.calendarAccounts} calendar connection(s)` +
          (result.unreadable > 0
            ? `; left ${result.unreadable} unreadable one(s) as they were`
            : "") +
          ".\nAll refresh tokens revoked — users must re-authenticate.\n" +
          "A running server uses the new secret from now on.\n" +
          (config.jwtSecretOverride !== null
            ? "Set VS_JWT_SECRET to the new value before the server next starts.\n"
            : ""),
      );
      break;
    }

    default:
      die(`Unknown subcommand: ${cmd}\n\n${USAGE}`);
  }

  db.close();
}

main().catch((err) => {
  process.stderr.write(
    `vhs-cli: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
