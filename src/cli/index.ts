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
import { generateSalt, hashPassword } from "../lib/crypto.js";
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
  vhs-cli rotate-jwt-secret [--confirm]
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
        db.prepare<[string, string, string]>(
          "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(hash, salt, row.id);
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
      const res = db
        .prepare<[string]>("DELETE FROM refresh_tokens WHERE user_id = ?")
        .run(row.id);
      process.stdout.write(
        `Revoked ${res.changes} refresh token(s) for ${email}.\n`,
      );
      break;
    }

    case "promote":
    case "demote": {
      const email = requireString(flags, "email");
      const nextRole: Role = cmd === "promote" ? "admin" : "user";
      const res = db
        .prepare<[Role, string]>(
          "UPDATE users SET role = ?, updated_at = datetime('now') WHERE email = ?",
        )
        .run(nextRole, email.toLowerCase());
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
      const { setState, SERVER_STATE_KEYS } = await import(
        "../lib/server-state.js"
      );
      const next = generateToken(32);
      setState(db, SERVER_STATE_KEYS.jwtSecret, next);
      db.prepare("DELETE FROM refresh_tokens").run();
      process.stdout.write(
        "JWT secret rotated. All refresh tokens revoked — users must re-authenticate.\n",
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
