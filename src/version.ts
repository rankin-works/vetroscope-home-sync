// SPDX-License-Identifier: Apache-2.0
//
// Single source of truth for the runtime-advertised version string. Kept in
// code (not read from package.json) so builds pinned to a particular commit
// always have a deterministic version even if the package.json bump is
// missed. Bump here AND in package.json when cutting a release.

export const VERSION = "0.1.0-beta.4";
