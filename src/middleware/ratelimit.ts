// SPDX-License-Identifier: Apache-2.0
//
// In-memory per-IP token bucket. Used for /auth/* and /setup so an
// attacker can't brute-force the setup code, a password, or a refresh
// token at full CPU speed. Deliberately simple:
//   - process-local state (no Redis dep — single-process server anyway)
//   - fixed window per route group
//   - best-effort peer-ip extraction (Fastify's trustProxy picks up
//     X-Forwarded-For when we're behind a reverse proxy)
//
// We cap the keyed map so a flood of spoofed IPs can't OOM the server.

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

interface Bucket {
  count: number;
  resetAt: number;
}

interface LimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys?: number;
}

export function buildRateLimiter(opts: LimiterOptions): preHandlerHookHandler {
  const { limit, windowMs } = opts;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, Bucket>();

  function evictIfNeeded(): void {
    if (buckets.size < maxKeys) return;
    const now = Date.now();
    // Prune expired first; if still over, drop the oldest-resetting entries.
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
      if (buckets.size < maxKeys) return;
    }
    const sorted = [...buckets.entries()].sort(
      (a, b) => a[1].resetAt - b[1].resetAt,
    );
    for (let i = 0; i < sorted.length && buckets.size >= maxKeys; i++) {
      buckets.delete(sorted[i]![0]);
    }
  }

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const key = request.ip || "unknown";
    const now = Date.now();
    let bucket = buckets.get(key);

    if (bucket === undefined || bucket.resetAt <= now) {
      evictIfNeeded();
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      void reply.header("Retry-After", retryAfterSec);
      return reply.status(429).send({
        error: "rate_limited",
        message: "Too many requests. Please slow down.",
      });
    }
    return undefined;
  };
}
