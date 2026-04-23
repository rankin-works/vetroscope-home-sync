// SPDX-License-Identifier: Apache-2.0
//
// SQLite database bootstrap. `better-sqlite3` is synchronous — the
// trade-off vs the cloud Worker's async D1 binding is that every handler
// calls into db.prepare(...).run()/get()/all() directly, without awaits,
// and concurrency is serialized by the single writer. WAL mode lets
// readers proceed alongside a writer, which is enough headroom for a
// home-scale deployment (architecture §Concurrent client bug surface).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type DB = Database.Database;

export interface OpenDbOptions {
  readonly dataDir: string;
  readonly filename?: string;
}

export function openDatabase({
  dataDir,
  filename = "sync.db",
}: OpenDbOptions): DB {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, filename);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
