// SPDX-License-Identifier: Apache-2.0
//
// Account-scoped Google Calendar credential vault + sync leader lease.
// Refresh tokens are sealed with AES-256-GCM before they touch the DB;
// the leader lease keeps multiple devices on one account from running the
// calendar sync loop simultaneously.
//
// Calendar links (lib/calendar-links.ts) hook in here twice. The vault PUT
// is the only place accounts change on this server, so a disconnect is
// settled in its transaction. The lease records what each desktop declares
// and, once a user is in links mode, only lets desktops that run calendar
// links lead, since older ones delete copies they don't know about.

import type { FastifyPluginAsync } from "fastify";

import type { DB } from "../db.js";
import {
  declaresLinks,
  disconnectKeep,
  enterLinksMode,
  ensureRefs,
  inLinksMode,
  parseProviders,
  readVault,
  recordProviders,
} from "../lib/calendar-links.js";
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

  fastify.put<{ Body: { accounts?: unknown; disconnected?: unknown; links?: unknown } }>(
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

      const disconnected = parseDisconnected(body.disconnected);
      const tx = fastify.db.transaction(() => {
        // A desktop that runs calendar links connecting an account starts
        // links mode first, from the accounts there were before this PUT,
        // so a new account starts with every switch off.
        if (body.links === true) {
          enterLinksMode(
            fastify.db,
            auth.sub,
            auth.device_id,
            readVault(fastify.db, auth.sub, fastify.jwtSecret),
            now,
          );
        }
        const linksMode = inLinksMode(fastify.db, auth.sub);
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
        if (linksMode) {
          settleLinksModePut(
            fastify.db,
            auth.sub,
            auth.device_id,
            parsed,
            disconnected,
            now,
            fastify.jwtSecret,
          );
          return;
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

  fastify.post<{ Body: { steal?: unknown; providers?: unknown; declare?: unknown } }>(
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
      const providers = parseProviders(request.body?.providers);
      const links = providers.includes("links");
      const db = fastify.db;

      // Every claim records what the device can do. `declare` records only
      // that, without touching the lease, and never starts links mode: a
      // desktop declares at launch even with no calendar account.
      recordProviders(db, auth.sub, auth.device_id, providers, nowIso);
      if (request.body?.declare === true) {
        return reply.send({
          ok: true,
          declared: true,
          links_mode: inLinksMode(db, auth.sub),
        });
      }

      // The first claim from a desktop that runs calendar links, once the
      // user has a calendar account, starts links mode.
      if (links && !inLinksMode(db, auth.sub)) {
        db.transaction(() => {
          const vault = readVault(db, auth.sub, fastify.jwtSecret);
          if (vault.length > 0) {
            enterLinksMode(db, auth.sub, auth.device_id, vault, nowIso);
          }
        })();
      }
      const linksMode = inLinksMode(db, auth.sub);
      // An older desktop can't lead in links mode. This is a 200 on
      // purpose: older desktops lead anyway on any other answer.
      if (linksMode && !links) {
        return reply.send({
          claimed: false,
          reason: "update_required",
          links_mode: true,
        });
      }

      const existing = fastify.db
        .prepare<
          [string],
          { device_id: string; lease_until: string }
        >(
          `SELECT device_id, lease_until FROM google_calendar_leader WHERE user_id = ?`,
        )
        .get(auth.sub);

      // In links mode a lease held by a desktop without calendar links
      // counts as expired.
      const expired =
        !existing ||
        new Date(existing.lease_until).getTime() <= now ||
        (linksMode && !declaresLinks(db, auth.sub, existing.device_id));
      const mine = existing?.device_id === auth.device_id;

      if (!expired && !mine && !steal) {
        return reply.send({
          claimed: false,
          device_id: existing!.device_id,
          lease_until: existing!.lease_until,
          links_mode: linksMode,
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
        links_mode: linksMode,
      });
    },
  );
};

/** `disconnected: [{email, at}]`: accounts a desktop disconnected, and when. */
function parseDisconnected(raw: unknown): Array<{ email: string; at: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ email: string; at: number }> = [];
  for (const d of raw.slice(0, MAX_ACCOUNTS)) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const email =
      typeof r.email === "string" ? r.email.trim().toLowerCase() : "";
    const at =
      typeof r.at === "string"
        ? Date.parse(r.at)
        : typeof r.at === "number"
          ? r.at
          : NaN;
    if (email && Number.isFinite(at)) out.push({ email, at });
  }
  return out;
}

/** A vault PUT for a user in links mode. The PUT is an upsert: an account a
 *  desktop leaves out (its copy of the vault may be stale) is kept, so it
 *  can't remove an account another desktop just connected. Only an account
 *  named in `disconnected` after its last upsert here is removed, and that
 *  is a real disconnect: its copies are released, its pending rows
 *  cancelled and its switches turned off. */
function settleLinksModePut(
  db: DB,
  userId: string,
  deviceId: string,
  parsed: VaultAccount[],
  disconnected: Array<{ email: string; at: number }>,
  now: string,
  secret: string,
): void {
  const named = new Set(parsed.map((a) => a.email));
  const stored = db
    .prepare<[string], { email: string; updated_at: string }>(
      `SELECT email, updated_at FROM google_calendar_accounts
        WHERE user_id = ? AND deleted = 0`,
    )
    .all(userId);
  const removed = stored.filter((row) =>
    disconnected.some(
      (d) =>
        d.email === row.email &&
        !named.has(row.email) &&
        d.at > Date.parse(row.updated_at),
    ),
  );
  for (const row of removed) {
    db.prepare(
      `UPDATE google_calendar_accounts SET deleted = 1, updated_at = ?
        WHERE user_id = ? AND email = ?`,
    ).run(now, userId, row.email);
  }
  const vault = readVault(db, userId, secret);
  const refs = ensureRefs(db, userId, [
    ...vault.map((a) => a.email),
    ...removed.map((r) => r.email),
  ]);
  for (const row of removed) {
    disconnectKeep(db, userId, refs.get(row.email)!, row.email, vault, deviceId, now);
  }
}
