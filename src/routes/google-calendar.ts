// SPDX-License-Identifier: Apache-2.0
//
// Account-scoped Google Calendar credential vault + sync leader lease.
// Refresh tokens are sealed with AES-256-GCM before they touch the DB;
// the leader lease keeps multiple devices on one account from running the
// calendar sync loop simultaneously.

import type { FastifyPluginAsync } from "fastify";

import { decryptSecret, encryptSecret } from "../lib/secret-crypto.js";
import type { JWTPayload } from "../types.js";

const LEASE_MS = 5 * 60 * 1000;
const MAX_ACCOUNTS = 20;

interface VaultAccount {
  email: string;
  refresh_token: string;
  access_token?: string | null;
  expiry?: number | null;
  calendarIds: string[];
  exportCalendarId: string | null;
  direction: "both" | "import" | "export";
  calendarColors: Record<string, string>;
  lastSyncedAt: string | null;
  updated_at?: string;
}

function normalizeDirection(d: unknown): "both" | "import" | "export" {
  return d === "import" || d === "export" || d === "both" ? d : "both";
}

function normalizeColors(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && /^#[0-9a-fA-F]{6}$/i.test(v)) {
      out[k] = v;
    }
  }
  return out;
}

function parseIncomingAccount(raw: unknown): VaultAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const email = typeof a.email === "string" ? a.email.trim().toLowerCase() : "";
  const refresh =
    typeof a.refresh_token === "string" ? a.refresh_token.trim() : "";
  if (!email || !email.includes("@") || email.length > 320) return null;
  if (!refresh || refresh.length > 4096) return null;
  let calendarIds: string[] = [];
  if (Array.isArray(a.calendarIds)) {
    calendarIds = a.calendarIds
      .filter((x): x is string => typeof x === "string")
      .slice(0, 50);
  }
  return {
    email,
    refresh_token: refresh,
    access_token: typeof a.access_token === "string" ? a.access_token : null,
    expiry: typeof a.expiry === "number" && Number.isFinite(a.expiry) ? a.expiry : null,
    calendarIds,
    exportCalendarId:
      typeof a.exportCalendarId === "string" ? a.exportCalendarId : null,
    direction: normalizeDirection(a.direction),
    calendarColors: normalizeColors(a.calendarColors),
    lastSyncedAt: typeof a.lastSyncedAt === "string" ? a.lastSyncedAt : null,
  };
}

export const googleCalendarRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);

  fastify.get("/user/google-calendar-accounts", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    if (!auth.device_id) {
      return reply.status(403).send({ error: "DESKTOP_REQUIRED" });
    }
    const rows = fastify.db
      .prepare<
        [string],
        { email: string; payload_enc: string; updated_at: string }
      >(
        `SELECT email, payload_enc, updated_at FROM google_calendar_accounts
          WHERE user_id = ? AND deleted = 0 ORDER BY email ASC`,
      )
      .all(auth.sub);

    const accounts: VaultAccount[] = [];
    for (const row of rows) {
      try {
        const raw = JSON.parse(
          decryptSecret(row.payload_enc, fastify.jwtSecret),
        ) as Record<string, unknown>;
        const refresh =
          typeof raw.refresh_token === "string" ? raw.refresh_token : "";
        if (!refresh) continue;
        accounts.push({
          email: row.email,
          refresh_token: refresh,
          access_token:
            typeof raw.access_token === "string" ? raw.access_token : null,
          expiry: typeof raw.expiry === "number" ? raw.expiry : null,
          calendarIds: Array.isArray(raw.calendarIds)
            ? raw.calendarIds.filter((x): x is string => typeof x === "string")
            : [],
          exportCalendarId:
            typeof raw.exportCalendarId === "string"
              ? raw.exportCalendarId
              : null,
          direction: normalizeDirection(raw.direction),
          calendarColors: normalizeColors(raw.calendarColors),
          lastSyncedAt:
            typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null,
          updated_at: row.updated_at,
        });
      } catch {
        /* skip corrupt row */
      }
    }
    return reply.send({ accounts });
  });

  fastify.put<{ Body: { accounts?: unknown } }>(
    "/user/google-calendar-accounts",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      if (!auth.device_id) {
        return reply.status(403).send({ error: "DESKTOP_REQUIRED" });
      }
      const body = request.body ?? {};
      if (!Array.isArray(body.accounts)) {
        return reply
          .status(400)
          .send({ error: "accounts array required" });
      }
      if (body.accounts.length > MAX_ACCOUNTS) {
        return reply
          .status(400)
          .send({ error: `At most ${MAX_ACCOUNTS} accounts` });
      }

      const parsed: VaultAccount[] = [];
      const seen = new Set<string>();
      for (const raw of body.accounts) {
        const a = parseIncomingAccount(raw);
        if (!a) {
          return reply.status(400).send({ error: "Invalid account payload" });
        }
        if (seen.has(a.email)) continue;
        seen.add(a.email);
        parsed.push(a);
      }

      const now = new Date().toISOString();
      const upsert = fastify.db.prepare(
        `INSERT INTO google_calendar_accounts (user_id, email, payload_enc, updated_at, deleted)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(user_id, email) DO UPDATE SET
           payload_enc = excluded.payload_enc,
           updated_at = excluded.updated_at,
           deleted = 0`,
      );

      const tx = fastify.db.transaction(() => {
        for (const a of parsed) {
          const sealed = encryptSecret(
            JSON.stringify({
              refresh_token: a.refresh_token,
              access_token: a.access_token ?? null,
              expiry: a.expiry ?? null,
              calendarIds: a.calendarIds,
              exportCalendarId: a.exportCalendarId,
              direction: a.direction,
              calendarColors: a.calendarColors,
              lastSyncedAt: a.lastSyncedAt,
            }),
            fastify.jwtSecret,
          );
          upsert.run(auth.sub, a.email, sealed, now);
        }
        if (parsed.length === 0) {
          fastify.db
            .prepare(
              `UPDATE google_calendar_accounts SET deleted = 1, updated_at = ?
                WHERE user_id = ? AND deleted = 0`,
            )
            .run(now, auth.sub);
        } else {
          const placeholders = parsed.map(() => "?").join(",");
          fastify.db
            .prepare(
              `UPDATE google_calendar_accounts SET deleted = 1, updated_at = ?
                WHERE user_id = ? AND deleted = 0 AND email NOT IN (${placeholders})`,
            )
            .run(now, auth.sub, ...parsed.map((a) => a.email));
        }
      });
      tx();
      return reply.send({ ok: true, count: parsed.length });
    },
  );

  fastify.post<{ Body: { steal?: unknown } }>(
    "/user/google-calendar-leader",
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      if (!auth.device_id) {
        return reply.status(403).send({ error: "DESKTOP_REQUIRED" });
      }
      const steal = request.body?.steal === true;
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const leaseUntil = new Date(now + LEASE_MS).toISOString();

      const existing = fastify.db
        .prepare<
          [string],
          { device_id: string; lease_until: string }
        >(
          `SELECT device_id, lease_until FROM google_calendar_leader WHERE user_id = ?`,
        )
        .get(auth.sub);

      const expired =
        !existing || new Date(existing.lease_until).getTime() <= now;
      const mine = existing?.device_id === auth.device_id;

      if (!expired && !mine && !steal) {
        return reply.send({
          claimed: false,
          device_id: existing!.device_id,
          lease_until: existing!.lease_until,
        });
      }

      fastify.db
        .prepare(
          `INSERT INTO google_calendar_leader (user_id, device_id, lease_until)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             device_id = excluded.device_id,
             lease_until = excluded.lease_until`,
        )
        .run(auth.sub, auth.device_id, leaseUntil);

      return reply.send({
        claimed: true,
        device_id: auth.device_id,
        lease_until: leaseUntil,
        renewed_at: nowIso,
      });
    },
  );
};
