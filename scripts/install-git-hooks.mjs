// SPDX-License-Identifier: Apache-2.0
//
// Point `core.hooksPath` at .githooks/ so every clone automatically picks
// up the commit-msg hook that blocks Claude trailers. Runs from `npm
// install` via the `prepare` script; silently skips when we're not
// inside a git checkout (e.g., inside the Docker build image).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

if (!existsSync(resolve(repoRoot, ".git"))) {
  // Not a git checkout (tarball install, Docker build context, etc.)
  process.exit(0);
}

const hookPath = resolve(repoRoot, ".githooks", "commit-msg");
if (existsSync(hookPath)) {
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // chmod can fail on some filesystems (SMB, FAT); the hook will just
    // need `git update-index --chmod=+x` or a re-clone. Non-fatal.
  }
}

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
} catch {
  // If git isn't on PATH during install (CI minimal images), swallow —
  // the hook path is a dev convenience, not a correctness requirement.
}
