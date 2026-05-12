// SPDX-License-Identifier: Apache-2.0
//
// Minimal semver comparator. The full `semver` npm package is overkill
// for what we need — we only ever compare two version strings of the
// form `MAJOR.MINOR.PATCH[-PRERELEASE]` (e.g. "0.2.22", "0.1.0-beta.9").
// This implementation handles the cases Vetroscope actually ships:
//
//   - Numeric prefix segments compared numerically
//   - Optional `-prerelease` suffix where any prerelease sorts BEFORE
//     the same numeric prefix without a prerelease (so "1.0.0-beta.1"
//     < "1.0.0")
//   - Prerelease segments split on `.` and compared piece-by-piece;
//     numeric pieces compared numerically, alpha pieces lexicographically
//
// Returns: -1 if a < b, 0 if equal, 1 if a > b.
//
// Inputs are assumed well-formed; malformed strings fall back to plain
// string comparison rather than throwing, since this runs inside hot
// request paths and the version gate is best-effort safety, not
// correctness-critical input validation.

export function compareSemver(a: string, b: string): number {
  if (a === b) return 0;

  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      prerelease: m[4] ?? null,
    };
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) {
    // Malformed — fall back to lexicographic. Better than throwing
    // inside a request handler.
    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  // Patch-level equal. A prerelease is always less than its same-
  // prefixed stable release.
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1; // a is stable, b is prerelease
  if (pb.prerelease === null) return -1;

  // Both prerelease — compare segment-wise.
  const segA = pa.prerelease.split(".");
  const segB = pb.prerelease.split(".");
  const len = Math.max(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    const sa = segA[i];
    const sb = segB[i];
    if (sa === undefined) return -1; // shorter prerelease < longer when equal so far
    if (sb === undefined) return 1;
    const na = Number(sa);
    const nb = Number(sb);
    const aIsNum = !Number.isNaN(na);
    const bIsNum = !Number.isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (aIsNum !== bIsNum) {
      // Numeric segments sort lower than alpha segments per semver spec.
      return aIsNum ? -1 : 1;
    } else {
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}
