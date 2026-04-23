// SPDX-License-Identifier: Apache-2.0
//
// Copy non-TypeScript assets (SQL migrations) next to compiled JS so the
// runtime path resolution in src/lib/migrations.ts points at the same
// relative location in both tsx-dev and node-dist modes.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const from = resolve(repoRoot, "src", "migrations");
const to = resolve(repoRoot, "dist", "migrations");

if (!existsSync(from)) {
  console.error(`[copy-assets] source missing: ${from}`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`[copy-assets] ${from} → ${to}`);
