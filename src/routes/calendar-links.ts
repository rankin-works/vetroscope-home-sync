// SPDX-License-Identifier: Apache-2.0
//
// /user/calendar-links/* and /user/calendar-targets: the calls desktops use
// to create, edit and delete the copies of an event in each Google calendar
// that gets new Vetroscope events, and the per-calendar switches.
// The rules are at the top of lib/calendar-links.ts.
//
// Every link call needs a desktop token, a device that declared `links` on
// the lease route, and a user in links mode. Each runs in one transaction,
// changes at most one row (except adopt-local) and gives every changed row
// its own seq. Nothing here logs an event id, calendar id, title or email:
// `drop` logs counters only.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import type { DB } from "../db.js";
import {
  CLAIM_MS,
  CREATED_BY,
  LINKS_DEVICE_SEEN_MS,
  PROVIDER,
  REASONS,
  RELEASE_ABSENT_MS,
  STATES,
  accountForRef,
  calendarContext,
  cancelPending,
  claimRows,
  clearClaim,
  declaresLinks,
  disconnectStart,
  enterLinksMode,
  ensureRefs,
  fixedGoogleId,
  getLink,
  holderOf,
  inLinksMode,
  insertLink,
  linksDeviceSeenSince,
  linksState,
  moveLink,
  publicLink,
  readTargets,
  readVault,
  refMap,
  renewClaim,
  targetValid,
  unclaim,
  type LinkKey,
  type LinkRow,
} from "../lib/calendar-links.js";
import { buildRateLimiter } from "../middleware/ratelimit.js";
import type { JWTPayload } from "../types.js";

const MAX_ID = 1024;
const CLAIM_LIMIT_DEFAULT = 25;
const CLAIM_LIMIT_MAX = 100;
const ADOPT_MAX = 500;
const STRAY_REASONS = new Set(["cancelled", "target_off", "expired", "disconnected", "stray"]);

const perUser = (request: FastifyRequest) =>
  (request.authUser as JWTPayload | undefined)?.sub ?? request.ip;
const MINUTE = 60 * 1000;

function str(raw: unknown, max = MAX_ID): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= max ? raw : null;
}

function optStr(raw: unknown, max = MAX_ID): string | null {
  return typeof raw === "string" && raw.length <= max ? raw : null;
}

/** `raw` when it is one of this user's account refs, else null: a ref from
 *  another server (after a switch of sign-in server) or a stale one never
 *  gets stored, so a row keeps the ref it has or stays open to a fill. */
function userRef(db: DB, userId: string, raw: unknown): string | null {
  const ref = optStr(raw, 64);
  return ref && accountForRef(db, userId, ref) !== undefined ? ref : null;
}

type ParsedKey = LinkKey | "bad" | "provider";

function parseKey(raw: unknown): ParsedKey {
  if (!raw || typeof raw !== "object") return "bad";
  const k = raw as Record<string, unknown>;
  const marker = str(k.marker_uuid, 128);
  const provider = str(k.provider, 32);
  const calendar = str(k.calendar_id);
  if (!marker || !provider || !calendar) return "bad";
  if (provider !== PROVIDER) return "provider";
  return { marker_uuid: marker, provider, calendar_id: calendar };
}

/** Collects a transactional handler's answer, sent once the transaction has
 *  committed: nothing leaves before the commit, and a Fastify reply is
 *  thenable, which a better-sqlite3 transaction refuses to return. */
class Answer {
  code = 200;
  body: unknown = undefined;
  status(code: number): this {
    this.code = code;
    return this;
  }
  send(body: unknown): void {
    this.body = body;
  }
}

function badKey(reply: Answer, k: "bad" | "provider") {
  return k === "provider"
    ? reply.status(400).send({ error: "CAL_TARGET_INVALID", message: "Only Google calendars sync through this server." })
    : reply.status(400).send({ error: "invalid_request", message: "key {marker_uuid, provider, calendar_id} required." });
}

interface Ctx {
  userId: string;
  deviceId: string;
}

/** The checks every link call shares; null when it already answered. */
function guard(db: DB, request: FastifyRequest, reply: FastifyReply): Ctx | null {
  const auth = request.authUser as JWTPayload;
  if (!auth.device_id) {
    void reply.status(403).send({ error: "DESKTOP_REQUIRED" });
    return null;
  }
  if (!declaresLinks(db, auth.sub, auth.device_id)) {
    void reply.status(403).send({ error: "CAL_LINKS_CLIENT", message: "This device hasn't declared calendar links." });
    return null;
  }
  if (!inLinksMode(db, auth.sub)) {
    void reply.status(409).send({ error: "CAL_LINKS_MODE", linksMode: false });
    return null;
  }
  return { userId: auth.sub, deviceId: auth.device_id };
}

function miss(row: LinkRow | undefined) {
  return { ok: false, row: row ? publicLink(row) : null };
}

function hit(row: LinkRow | undefined, extra: Record<string, unknown> = {}) {
  return { ok: true, ...extra, row: row ? publicLink(row) : null };
}

/** GET / PUT answer: links mode, the accounts (so a desktop maps refs to
 *  its own accounts) and every switch with its validity, computed now. */
function targetsState(db: DB, userId: string, deviceId: string, secret: string) {
  const vault = readVault(db, userId, secret);
  const refs = ensureRefs(db, userId, vault.map((a) => a.email));
  const ctx = calendarContext(db, userId, secret);
  const linksMode = inLinksMode(db, userId);
  return {
    linksMode,
    accounts: vault.map((a) => ({ provider: PROVIDER, account: a.email, ref: refs.get(a.email)! })),
    targets: readTargets(db, userId).map((t) => {
      const v = targetValid(ctx, t);
      return {
        provider: PROVIDER,
        accountRef: t.account_ref,
        calendarId: t.calendar_id,
        enabled: t.enabled === 1,
        onSince: t.on_since,
        rev: t.rev,
        valid: v.valid,
        invalidReason: v.reason,
        legacySend: t.legacy_send === 1,
      };
    }),
    needsUpdate: linksMode && !declaresLinks(db, userId, deviceId),
  };
}

export const calendarLinksRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", fastify.authenticate);
  const db = fastify.db;
  const secret = () => fastify.jwtSecret;

  const linkLimit = buildRateLimiter({ limit: 600, windowMs: MINUTE, keyOf: perUser });
  const dropLimit = buildRateLimiter({ limit: 60, windowMs: MINUTE, keyOf: perUser });
  const adoptLimit = buildRateLimiter({ limit: 10, windowMs: MINUTE, keyOf: perUser });
  const targetLimit = buildRateLimiter({ limit: 30, windowMs: MINUTE, keyOf: perUser });

  type Body = Record<string, unknown>;
  const post = (
    path: string,
    limiter: ReturnType<typeof buildRateLimiter>,
    handler: (ctx: Ctx, body: Body, request: FastifyRequest, reply: Answer) => void,
  ) =>
    fastify.post<{ Body: Body }>(
      `/user/calendar-links/${path}`,
      { preHandler: limiter },
      async (request, reply) => {
        const ctx = guard(db, request, reply);
        if (ctx === null) return reply;
        const body = (request.body ?? {}) as Body;
        const answer = new Answer();
        db.transaction(() => handler(ctx, body, request, answer))();
        return reply.status(answer.code).send(answer.body);
      },
    );

  // Picks rows to create or delete and claims them for five minutes.
  post("claim", linkLimit, ({ userId, deviceId }, body, _req, reply) => {
    let keys: LinkKey[] | null = null;
    if (body.keys !== undefined) {
      if (!Array.isArray(body.keys) || body.keys.length > CLAIM_LIMIT_MAX) {
        return reply.status(400).send({ error: "invalid_request", message: "keys must be an array." });
      }
      keys = [];
      for (const raw of body.keys) {
        const k = parseKey(raw);
        if (typeof k === "string") return badKey(reply, k);
        keys.push(k);
      }
    }
    const limit =
      typeof body.limit === "number" && Number.isInteger(body.limit) && body.limit > 0
        ? Math.min(body.limit, CLAIM_LIMIT_MAX)
        : CLAIM_LIMIT_DEFAULT;
    const nowMs = Date.now();
    const rows = claimRows(db, userId, deviceId, calendarContext(db, userId, secret()), { keys, limit }, nowMs);
    return reply.send({ rows, serverNow: new Date(nowMs).toISOString(), claimMs: CLAIM_MS });
  });

  post("renew", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const token = str(body.claim_token, 64);
    const nowMs = Date.now();
    const until = token ? renewClaim(db, userId, key, token, nowMs) : null;
    if (until === null) return reply.send(miss(getLink(db, userId, key)));
    return reply.send({ ok: true, claim_until: until, serverNow: new Date(nowMs).toISOString() });
  });

  post("unclaim", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const token = str(body.claim_token, 64);
    if (!token || !unclaim(db, userId, key, token, Date.now())) return reply.send(miss(getLink(db, userId, key)));
    return reply.send({ ok: true });
  });

  // The create answered (or the lookup found the copy). Valid past
  // claim_until while the token still matches: a new claim always replaces
  // the token, so a match means nobody else took the row.
  post("complete", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const token = str(body.claim_token, 64);
    const eventId = str(body.event_id);
    const gen = typeof body.gen === "number" && Number.isInteger(body.gen) && body.gen >= 0 ? body.gen : null;
    if (!token || !eventId || gen === null) {
      return reply.status(400).send({ error: "invalid_request", message: "claim_token, gen and event_id required." });
    }
    const row = getLink(db, userId, key);
    if (!row || row.claim_token !== token || (row.state !== "pending" && row.state !== "deleting")) {
      return reply.send(miss(row));
    }
    const now = new Date().toISOString();
    const nextGen = Math.max(gen, row.gen);
    const accountRef = userRef(db, userId, body.account_ref) ?? row.account_ref;
    const facts = {
      gen: nextGen,
      etag: optStr(body.etag),
      remote_updated_at: optStr(body.remote_updated_at, 64),
      pushed_hash: optStr(body.pushed_hash, 128),
      account_ref: accountRef,
    };
    const marker = db
      .prepare<[string, string], { deleted: number }>(
        "SELECT deleted FROM sync_markers WHERE uuid = ? AND user_id = ?",
      )
      .get(key.marker_uuid, userId);

    // The event was deleted (or the row cancelled) meanwhile: record what
    // was made so it can be deleted, and keep the claim for that DELETE.
    if (row.state === "deleting" || !marker || marker.deleted === 1) {
      const holder = holderOf(db, userId, key.calendar_id, eventId, ["linked", "deleting", "removed_remote"]);
      const patch =
        row.state === "deleting"
          ? row.event_id === null && (!holder || holder.marker_uuid === key.marker_uuid)
            ? { ...facts, event_id: eventId }
            : { gen: nextGen }
          : { ...facts, state: "deleting", reason: "cancelled", event_id: holder ? null : eventId };
      return reply.send(hit(moveLink(db, userId, key, patch, now), { then: "delete" }));
    }
    if (body.found_cancelled === true) {
      // Removed in the calendar before it was recorded: never sent there again.
      const done = moveLink(db, userId, key, { ...facts, state: "detached", reason: "cancelled", event_id: eventId }, now);
      clearClaim(db, userId, key);
      return reply.send(hit(done, { state: "detached" }));
    }
    const holder = holderOf(db, userId, key.calendar_id, eventId, ["linked", "deleting", "removed_remote"]);
    if (holder && holder.marker_uuid !== key.marker_uuid) return reply.send(miss(row));
    const vault = readVault(db, userId, secret());
    const account = accountRef ? accountForRef(db, userId, accountRef) : undefined;
    if (accountRef && !vault.some((a) => a.email === account)) {
      const done = moveLink(db, userId, key, { ...facts, state: "released", reason: "disconnected", event_id: eventId }, now);
      clearClaim(db, userId, key);
      return reply.send(hit(done, { state: "released" }));
    }
    const done = moveLink(db, userId, key, { ...facts, state: "linked", event_id: eventId, linked_at: now }, now);
    clearClaim(db, userId, key);
    return reply.send(hit(done, { state: "linked" }));
  });

  // The DELETE ran (or found nothing). A row a restore moved meanwhile is
  // left alone: the late call changes nothing.
  post("deleted", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const token = str(body.claim_token, 64);
    const row = getLink(db, userId, key);
    if (!row || !token || row.state !== "deleting" || row.claim_token !== token) return reply.send(miss(row));
    const done = moveLink(db, userId, key, { state: "gone" }, new Date().toISOString());
    clearClaim(db, userId, key);
    return reply.send(hit(done));
  });

  // An import or sweep found our event in a calendar with no live row for it.
  post("attach", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const eventId = str(body.event_id);
    const role = body.role === "source" ? "source" : body.role === "copy" || body.role === undefined ? "copy" : null;
    if (!eventId || role === null) {
      return reply.status(400).send({ error: "invalid_request", message: "event_id and role required." });
    }
    const now = new Date().toISOString();
    const marker = db
      .prepare<[string, string], { deleted: number }>(
        "SELECT deleted FROM sync_markers WHERE uuid = ? AND user_id = ?",
      )
      .get(key.marker_uuid, userId);
    if (!marker) return reply.send(miss(getLink(db, userId, key)));

    // Google keeps an event's id when it moves to another calendar: the
    // same marker's live row for that id elsewhere is the old place.
    const moved = db
      .prepare<[string, string, string, string, string], LinkRow>(
        `SELECT * FROM sync_marker_links
          WHERE user_id = ? AND marker_uuid = ? AND provider = ? AND event_id = ? AND calendar_id != ?
            AND state IN ('linked','removed_remote')`,
      )
      .all(userId, key.marker_uuid, PROVIDER, eventId, key.calendar_id);
    // A row keeps its ref unless one of this user's is sent.
    const ref = userRef(db, userId, body.account_ref);
    const facts = {
      role,
      event_id: eventId,
      etag: optStr(body.etag),
      remote_updated_at: optStr(body.remote_updated_at, 64),
      ...(ref !== null ? { account_ref: ref } : {}),
    };
    // An import of a deleted event is the person's own event: let go, never
    // deleted.
    const nextState = marker.deleted === 0
      ? { state: "linked", reason: "adopted", linked_at: now }
      : role === "source"
        ? { state: "released", reason: "deleted" }
        : { state: "deleting", reason: "deleted" };

    const row = getLink(db, userId, key);
    const ctx = calendarContext(db, userId, secret());
    const target = ctx.targets.get(key.calendar_id);
    // Vetroscope's own copy whose create landed after its row was given up
    // (its fixed id says so), in a calendar that is on: take it back. A row
    // the person kept, or one gone for any other reason, is never changed.
    const lateOwn =
      row?.state === "gone" &&
      STRAY_REASONS.has(row.reason) &&
      eventId === fixedGoogleId(key.marker_uuid, key.calendar_id, row.gen) &&
      marker.deleted === 0 &&
      target?.enabled === 1 &&
      targetValid(ctx, target).valid;

    const claimLive = (row?.claim_until ?? null) !== null && row!.claim_until! > now;
    const canTake = row === undefined || (row.state === "pending" && !claimLive) || lateOwn;
    if (!canTake) return reply.send(miss(row));
    const held = holderOf(db, userId, key.calendar_id, eventId);
    if (held && held.marker_uuid !== key.marker_uuid) return reply.send(miss(row));

    for (const old of moved) {
      moveLink(db, userId, old, { state: "released", reason: "moved", event_id: null }, now);
    }
    let done: LinkRow | undefined;
    if (row === undefined) {
      insertLink(
        db,
        userId,
        { ...key, ...facts, ...nextState, created_by: role === "source" ? "import" : "desktop" },
        now,
      );
      done = getLink(db, userId, key);
    } else {
      done = moveLink(db, userId, key, { ...facts, ...nextState }, now);
      clearClaim(db, userId, key);
    }
    return reply.send(hit(done, { moved: moved.length }));
  });

  // A PATCH landed, or an edit made in the calendar was applied. Only the
  // etag the PATCH started from matches, so a late ack for an older edit
  // misses. Only the keys sent change: etag and remote_updated_at when
  // present, pushed_hash when not null, and account_ref fills a row that
  // has none (the leader's fill for rows uploaded without one).
  post("ack", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const eventId = str(body.event_id);
    if (!eventId) return reply.status(400).send({ error: "invalid_request", message: "event_id required." });
    const fromEtag = optStr(body.from_etag);
    const row = getLink(db, userId, key);
    if (!row || row.state !== "linked" || row.event_id !== eventId || row.etag !== fromEtag) {
      return reply.send(miss(row));
    }
    const patch: Record<string, unknown> = {};
    if ("etag" in body) patch.etag = optStr(body.etag);
    if ("remote_updated_at" in body) patch.remote_updated_at = optStr(body.remote_updated_at, 64);
    const hash = optStr(body.pushed_hash, 128);
    if (hash !== null) patch.pushed_hash = hash;
    const ref = userRef(db, userId, body.account_ref);
    if (ref !== null && row.account_ref === null) patch.account_ref = ref;
    if (Object.keys(patch).length === 0) return reply.send(hit(row));
    return reply.send(hit(moveLink(db, userId, key, patch, new Date().toISOString())));
  });

  // The copy was removed in its calendar; the person is asked what to do.
  post("remote-removed", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const eventId = str(body.event_id);
    const row = getLink(db, userId, key);
    if (!row || !eventId || row.state !== "linked" || row.event_id !== eventId) return reply.send(miss(row));
    return reply.send(hit(moveLink(db, userId, key, { state: "removed_remote" }, new Date().toISOString())));
  });

  // The person's answer to a removal. "Delete everywhere" is an ordinary
  // delete of the event.
  post("resolve", linkLimit, ({ userId }, body, _req, reply) => {
    const key = parseKey(body.key);
    if (typeof key === "string") return badKey(reply, key);
    const choice = body.choice;
    if (choice !== "keep" && choice !== "remove_here" && choice !== "put_back") {
      return reply.status(400).send({ error: "invalid_request", message: "choice must be keep, remove_here or put_back." });
    }
    const row = getLink(db, userId, key);
    if (!row || row.state !== "removed_remote") return reply.send(miss(row));
    const now = new Date().toISOString();
    if (choice === "put_back") {
      // Only Vetroscope's own copies are ever created.
      if (row.role !== "copy") return reply.send(miss(row));
      const done = moveLink(db, userId, key, {
        state: "pending", reason: "undo", gen: row.gen + 1, event_id: null, etag: null,
        remote_updated_at: null, pushed_hash: null, linked_at: null, ever_claimed: 0,
      }, now);
      clearClaim(db, userId, key);
      return reply.send(hit(done));
    }
    return reply.send(hit(moveLink(db, userId, key, { state: "detached", reason: "kept" }, now)));
  });

  // Asks before a device deletes an event in a calendar. The device deletes
  // only on ok, and never an event a row holds.
  post("drop", dropLimit, ({ userId }, body, request, reply) => {
    const provider = str(body.provider, 32);
    if (provider !== null && provider !== PROVIDER) return badKey(reply, "provider");
    const calendarId = str(body.calendar_id);
    const eventId = str(body.event_id);
    const uuid = str(body.marker_uuid, 128);
    const why = body.why;
    if (!provider || !calendarId || !eventId || !uuid || (why !== "duplicate" && why !== "own" && why !== "stray")) {
      return reply.status(400).send({ error: "invalid_request" });
    }
    const now = new Date().toISOString();
    const key = { marker_uuid: uuid, provider, calendar_id: calendarId };
    const answer = (ok: boolean) => {
      request.log.info({ calendarDrop: why, ok }, "calendar drop");
      return reply.send({ ok });
    };
    if (holderOf(db, userId, calendarId, eventId)) return answer(false);
    const row = getLink(db, userId, key);
    const elsewhere =
      row !== undefined &&
      ((row.state === "linked" && row.event_id !== eventId) || row.state === "deleting" || row.state === "gone");
    if (why === "duplicate") return answer(elsewhere);
    if (why === "own") {
      // Our own copy that no row holds; while another device holds a claim
      // on the row its lookup may still adopt this copy, so wait.
      const otherClaim = row?.state === "pending" && row.claim_until !== null && row.claim_until > now;
      return answer(elsewhere || !otherClaim);
    }
    // A stray: an older desktop made it after links mode started, in a
    // calendar nobody switched on, or again after the person removed it.
    const state = linksState(db, userId)!;
    const marker = db
      .prepare<[string, string], { created_at: string | null }>(
        "SELECT created_at FROM sync_markers WHERE uuid = ? AND user_id = ?",
      )
      .get(uuid, userId);
    const createdRaw = typeof body.created === "string" ? Date.parse(body.created) : NaN;
    const created = Number.isNaN(createdRaw) ? NaN : Math.min(createdRaw, Date.parse(now));
    const modeAt = Date.parse(state.links_mode_at);
    const after =
      marker !== undefined &&
      marker.created_at !== null &&
      Date.parse(marker.created_at) > modeAt &&
      created > modeAt;
    if (!after) return answer(false);
    if (row === undefined) {
      const target = readTargets(db, userId).find((t) => t.calendar_id === calendarId);
      if (target?.enabled === 1) return answer(false);
      insertLink(
        db,
        userId,
        { ...key, role: "copy", state: "gone", reason: "stray", event_id: eventId, created_by: "server" },
        now,
      );
      return answer(true);
    }
    return answer(row.state === "removed_remote" || (row.state === "gone" && row.reason === "stray"));
  });

  // Before a Disconnect with Remove events (see disconnectStart). Answers
  // {ok, claim_token, claim_until, rows}: one token holds every row, and a
  // repeat with nothing left to hold answers rows: [] with a fresh token.
  post("disconnect-start", linkLimit, ({ userId, deviceId }, body, _req, reply) => {
    const ref = str(body.account_ref, 64);
    if (!ref || body.mode !== "remove") {
      return reply.status(400).send({ error: "invalid_request", message: "account_ref and mode: \"remove\" required." });
    }
    const email = accountForRef(db, userId, ref);
    if (email === undefined) return reply.status(404).send({ error: "not_found" });
    const vault = readVault(db, userId, secret()).filter((a) => a.email !== email);
    const held = disconnectStart(db, userId, ref, email, vault, deviceId, Date.now());
    return reply.send({ ok: true, claim_token: held.token, claim_until: held.until, rows: held.rows });
  });

  // The leader's check for copies whose calendar no account can see. On
  // this server the vault PUT is an upsert, so an account is only absent
  // after a real disconnect, which already released its rows; refuse unless
  // the account has been gone from this server's own vault for 24 hours.
  post("release", linkLimit, ({ userId }, body, _req, reply) => {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let rows: LinkRow[];
    let ref: string | null;
    if (body.key !== undefined) {
      const key = parseKey(body.key);
      if (typeof key === "string") return badKey(reply, key);
      const row = getLink(db, userId, key);
      if (!row) return reply.send(miss(row));
      rows = [row];
      ref = row.account_ref;
    } else {
      ref = str(body.account_ref, 64);
      if (!ref) return reply.status(400).send({ error: "invalid_request", message: "key or account_ref required." });
      rows = db
        .prepare<[string, string], LinkRow>(
          "SELECT * FROM sync_marker_links WHERE user_id = ? AND account_ref = ? AND state IN ('linked','pending')",
        )
        .all(userId, ref);
    }
    if (!absentLongEnough(db, userId, ref, rows, nowMs, secret())) {
      return reply.status(409).send({ error: "CAL_RELEASE_REFUSED", message: "That account is still connected on this server." });
    }
    let released = 0;
    for (const row of rows) {
      if (row.state === "linked") {
        moveLink(db, userId, row, { state: "released", reason: "disconnected" }, now);
      } else if (row.state === "pending") {
        cancelPending(db, userId, row, "disconnected", now);
      } else {
        continue;
      }
      released += 1;
    }
    return reply.send({ ok: true, released });
  });

  // Uploads a desktop's own rows once (entering links mode, after a reset,
  // after a switch of sign-in server). Never overwrites: a row is written
  // only when its key and its event are both free. A ref that isn't one of
  // this user's (another server's) is stored as none. A source row is never
  // stored as work: an import deleted in Vetroscope arrives as `released`.
  post("adopt-local", adoptLimit, ({ userId }, body, _req, reply) => {
    if (!Array.isArray(body.rows) || body.rows.length > ADOPT_MAX) {
      return reply.status(400).send({ error: "invalid_request", message: `rows: an array of at most ${ADOPT_MAX}.` });
    }
    const now = new Date().toISOString();
    const refs = new Set(refMap(db, userId).values());
    let inserted = 0;
    let skipped = 0;
    for (const raw of body.rows) {
      const key = parseKey(raw);
      const r = (raw ?? {}) as Record<string, unknown>;
      const role = r.role === "source" ? "source" : "copy";
      let state = typeof r.state === "string" && STATES.has(r.state) ? r.state : null;
      let reason = typeof r.reason === "string" && REASONS.has(r.reason) ? r.reason : "migrated";
      if (typeof key === "string" || state === null || (role === "source" && state === "pending")) {
        skipped += 1;
        continue;
      }
      if (role === "source" && state === "deleting") {
        state = "released";
        reason = "deleted";
      }
      const ref = optStr(r.account_ref, 64);
      const eventId = optStr(r.event_id);
      if (eventId) {
        const taken = db
          .prepare<[string, string, string, string], { one: number }>(
            `SELECT 1 AS one FROM sync_marker_links
              WHERE user_id = ? AND provider = ? AND calendar_id = ? AND event_id = ? LIMIT 1`,
          )
          .get(userId, PROVIDER, key.calendar_id, eventId);
        if (taken) {
          skipped += 1;
          continue;
        }
      }
      const ok = insertLink(
        db,
        userId,
        {
          ...key,
          role,
          state,
          reason,
          gen: typeof r.gen === "number" && Number.isInteger(r.gen) && r.gen >= 0 ? r.gen : 0,
          account_ref: ref !== null && refs.has(ref) ? ref : null,
          event_id: eventId,
          etag: optStr(r.etag),
          remote_updated_at: optStr(r.remote_updated_at, 64),
          pushed_hash: optStr(r.pushed_hash, 128),
          created_by: typeof r.created_by === "string" && CREATED_BY.has(r.created_by) ? r.created_by : "desktop",
          created_at: optStr(r.created_at, 64) ?? now,
          linked_at: optStr(r.linked_at, 64),
        },
        now,
      );
      if (ok) inserted += 1;
      else skipped += 1;
    }
    if (body.last === true) {
      db.prepare("UPDATE calendar_links_state SET epoch_adopted = 1 WHERE user_id = ?").run(userId);
    }
    return reply.send({ ok: true, inserted, skipped });
  });

  // Whether this server has (or had) an event, so a desktop can tell its
  // own stamp from another person's. Link rows outlive a /sync/reset's
  // re-upload, so they count too.
  fastify.get<{ Querystring: { uuid?: string } }>(
    "/user/calendar-links/known",
    { preHandler: linkLimit },
    async (request, reply) => {
      const ctx = guard(db, request, reply);
      if (ctx === null) return reply;
      const uuid = str(request.query.uuid, 128);
      if (!uuid) return reply.status(400).send({ error: "invalid_request", message: "uuid required." });
      const known =
        db.prepare("SELECT 1 FROM sync_markers WHERE uuid = ? AND user_id = ?").get(uuid, ctx.userId) !== undefined ||
        db.prepare("SELECT 1 FROM sync_marker_links WHERE marker_uuid = ? AND user_id = ? LIMIT 1").get(uuid, ctx.userId) !== undefined;
      return reply.send({ known });
    },
  );

  // ── switches ────────────────────────────────────────────────────────

  fastify.get("/user/calendar-targets", async (request, reply) => {
    const auth = request.authUser as JWTPayload;
    if (!auth.device_id) return reply.status(403).send({ error: "DESKTOP_REQUIRED" });
    return reply.send(targetsState(db, auth.sub, auth.device_id, secret()));
  });

  fastify.put<{ Body: Body }>(
    "/user/calendar-targets",
    { preHandler: targetLimit },
    async (request, reply) => {
      const auth = request.authUser as JWTPayload;
      if (!auth.device_id) return reply.status(403).send({ error: "DESKTOP_REQUIRED" });
      const userId = auth.sub;
      const deviceId = auth.device_id;
      const body = (request.body ?? {}) as Body;
      if (body.provider !== PROVIDER) {
        return reply.status(400).send({ error: "CAL_TARGET_INVALID", message: "Only Google calendars sync through this server." });
      }
      const account = typeof body.account === "string" ? body.account.trim().toLowerCase() : "";
      const calendarId = str(body.calendarId);
      const rev = body.rev === undefined ? 0 : body.rev;
      if (!account || !calendarId || typeof body.enabled !== "boolean" || typeof rev !== "number") {
        return reply.status(400).send({ error: "invalid_request", message: "account, calendarId, enabled and rev required." });
      }
      if (!declaresLinks(db, userId, deviceId)) {
        const seen = linksDeviceSeenSince(db, userId, new Date(Date.now() - LINKS_DEVICE_SEEN_MS).toISOString());
        return !inLinksMode(db, userId) && !seen
          ? reply.status(409).send({ error: "CAL_LINKS_NO_COMPUTER" })
          : reply.status(403).send({ error: "CAL_LINKS_CLIENT", message: "This device hasn't declared calendar links." });
      }

      const answer = new Answer();
      db.transaction((reply: Answer) => {
        const now = new Date().toISOString();
        const vault = readVault(db, userId, secret());
        // A PUT from a links desktop starts links mode first.
        enterLinksMode(db, userId, deviceId, vault, now);
        const refs = ensureRefs(db, userId, vault.map((a) => a.email));
        const existing = readTargets(db, userId).find((t) => t.calendar_id === calendarId);
        if ((existing?.rev ?? 0) !== rev) {
          return reply.status(409).send({ error: "CAL_TARGET_CHANGED", ...targetsState(db, userId, deviceId, secret()) });
        }
        const entry = vault.find((a) => a.email === account);
        const ref = refs.get(account) ?? existing?.account_ref;
        if (body.enabled) {
          // The person's own change clears legacy_send, so it must be ticked.
          if (!entry || entry.direction === "import" || !entry.calendarIds.includes(calendarId)) {
            return reply.status(400).send({ error: "CAL_TARGET_INVALID" });
          }
        } else if (ref === undefined) {
          return reply.status(400).send({ error: "CAL_TARGET_INVALID" });
        }
        const accountRef = body.enabled ? refs.get(account)! : ref!;
        db.prepare(
          `INSERT INTO calendar_targets
             (user_id, provider, calendar_id, account_ref, enabled, legacy_send, on_since, rev, changed_at, changed_by)
           VALUES (@user, @provider, @calendar, @ref, @enabled, 0, @onSince, 1, @now, @device)
           ON CONFLICT(user_id, provider, calendar_id) DO UPDATE SET
             account_ref = excluded.account_ref,
             enabled = excluded.enabled,
             legacy_send = 0,
             on_since = CASE WHEN excluded.enabled = 1 THEN excluded.on_since ELSE calendar_targets.on_since END,
             rev = calendar_targets.rev + 1,
             changed_at = excluded.changed_at,
             changed_by = excluded.changed_by`,
        ).run({
          user: userId,
          provider: PROVIDER,
          calendar: calendarId,
          ref: accountRef,
          enabled: body.enabled ? 1 : 0,
          onSince: body.enabled ? now : null,
          now,
          device: deviceId,
        });
        if (!body.enabled) {
          // Only future events: copies already there keep getting edits.
          const pending = db
            .prepare<[string, string, string], LinkRow>(
              "SELECT * FROM sync_marker_links WHERE user_id = ? AND provider = ? AND calendar_id = ? AND state = 'pending'",
            )
            .all(userId, PROVIDER, calendarId);
          for (const row of pending) cancelPending(db, userId, row, "target_off", now);
        }
        return reply.send({ ok: true, ...targetsState(db, userId, deviceId, secret()) });
      })(answer);
      return reply.status(answer.code).send(answer.body);
    },
  );
};

/** Whether `release` may give up rows of `ref`: the account has been gone
 *  from this server's vault for 24 hours. With no ref (rows converted from
 *  a desktop that didn't know the account), no live account may list any
 *  of the calendars, and the vault must not have changed for 24 hours. */
function absentLongEnough(
  db: DB,
  userId: string,
  ref: string | null,
  rows: LinkRow[],
  nowMs: number,
  secret: string,
): boolean {
  const cutoff = new Date(nowMs - RELEASE_ABSENT_MS).toISOString();
  if (ref !== null) {
    const email = accountForRef(db, userId, ref);
    if (email === undefined) return true;
    const acct = db
      .prepare<[string, string], { deleted: number; updated_at: string }>(
        "SELECT deleted, updated_at FROM google_calendar_accounts WHERE user_id = ? AND email = ?",
      )
      .get(userId, email);
    return acct === undefined || (acct.deleted === 1 && acct.updated_at < cutoff);
  }
  const vault = readVault(db, userId, secret);
  if (rows.some((r) => vault.some((a) => a.calendarIds.includes(r.calendar_id) || a.exportCalendarId === r.calendar_id))) {
    return false;
  }
  const last = db
    .prepare<[string], { t: string | null }>(
      "SELECT MAX(updated_at) AS t FROM google_calendar_accounts WHERE user_id = ?",
    )
    .get(userId)?.t;
  return (last ?? null) === null || last! < cutoff;
}
