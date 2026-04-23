// SPDX-License-Identifier: Apache-2.0
//
// Simple forward-only migrations runner. Each file in src/migrations/ is
// applied exactly once, ordered lexicographically; apply state lives in
// the `schema_migrations` table. There is deliberately no "down" path —
// rolling back a migration on a user's self-hosted box is their call,
// and we don't ship destructive SQL.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DB } from "../db.js";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export interface MigrationResult {
  readonly applied: string[];
  readonly skipped: string[];
}

export function runMigrations(db: DB): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const alreadyApplied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((row) => row.name),
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  const record = db.prepare<[string]>(
    "INSERT INTO schema_migrations(name) VALUES (?)",
  );

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      record.run(file);
    });
    tx();
    applied.push(file);
  }

  return { applied, skipped };
}
