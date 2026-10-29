// SPDX-License-Identifier: Apache-2.0
//
// Calendar copies: the server side of sending one Vetroscope event to every
// Google calendar the person switched on ("Send new Vetroscope events here").
//
// The rules, which the desktop depends on:
//   - This server owns the state of every copy (sync_marker_links). Desktops
//     never push link rows; they change them only through the calls in
//     routes/calendar-links.ts, each of which checks the current row first.
//     Pulls page by seq and the server's row always wins.
//   - The server decides where a new event goes, once: the first time it
//     stores the event, it writes a `pending` row for each switched-on,
//     valid calendar. Older events never get rows, so nothing is back-filled.
//   - Creating a copy takes a claim, held by one device at a time for five
//     minutes. Claims change only the claim columns, which are never pulled,
//     so they take no seq.
//   - A `pending` row that was ever claimed never goes straight to `gone`: a
//     create may have landed after the claim ran out, so it goes to
//     `deleting` with no event id and the next claimer looks the copy up.
//   - Every changed row takes its own seq, so a `seq > ?` pull never skips
//     one. better-sqlite3 transactions are serialized, so a read followed by
//     a write inside one is a compare-and-swap.
//   - Only `copy` rows are ever created or deleted in a calendar. A `source`
//     row is the calendar event an import came from, the person's own (or
//     someone else's, in a shared calendar): deleting the import in
//     Vetroscope lets the row go (`released`), never deletes the event.
//   - A row a device gives back (unclaim) loses its turn on that device for
//     a while and comes after the rest for every device, so rows nobody can
//     work never crowd out newer ones.
//   - Links mode starts the first time a desktop that runs calendar links
//     claims the lease, puts a target or connects an account, and is never
//     undone. Before it, older desktops keep today's one-calendar rule.
//
// Google only: Outlook needs Vetroscope Cloud and is refused here.

import { createHash, randomBytes } from "node:crypto";

import type { DB } from "../db.js";
import { decryptSecret } from "./secret-crypto.js";

export const PROVIDER = "google";
export const CLAIM_MS = 5 * 60 * 1000;
/** A Disconnect with Remove events holds its copies this long (renewable). */
export const DISCONNECT_CLAIM_MS = 24 * 60 * 60 * 1000;
/** Fill age limit and pending expiry. */
export const FILL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** An event made this recently counts as made now (clock skew). */
export const SKEW_MS = 10 * 60 * 1000;
/** Older clients send no created_at: only events changed this recently. */
export const NO_KEY_WINDOW_MS = 48 * 60 * 60 * 1000;
/** No-key fill is off this long after a /sync/reset (a re-upload). */
export const EPOCH_QUIET_MS = 60 * 60 * 1000;
/** `release` needs the account gone from this server's vault this long. */
export const RELEASE_ABSENT_MS = 24 * 60 * 60 * 1000;
/** A target PUT needs a `links` desktop seen this recently. */
export const LINKS_DEVICE_SEEN_MS = 30 * 24 * 60 * 60 * 1000;
/** A row given back waits this long before a claim picks it again, doubled
 *  on every give-back up to GIVE_BACK_MAX_MS. */
export const GIVE_BACK_MS = 60 * 1000;
export const GIVE_BACK_MAX_MS = 60 * 60 * 1000;

export const STATES = new Set([
  "pending",
  "linked",
  "deleting",
  "gone",
  "removed_remote",
  "detached",
  "released",
]);
export const REASONS = new Set([
  "target",
  "adopted",
  "migrated",
  "restore",
  "undo",
  "moved",
  "expired",
  "cancelled",
  "deleted",
  "disconnected",
  "target_off",
  "kept",
  "stray",
]);
export const CREATED_BY = new Set([
  "desktop",
  "web",
  "mcp",
  "server",
  "import",
  "migration",
]);
/** States in which a row holds its event (the unique event index). */
const HOLDING = ["linked", "deleting", "removed_remote"];
const KNOWN_PROVIDERS = new Set(["google", "outlook", "links"]);

const NEXT_SEQ = "(SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_marker_links)";

/** Columns a desktop pulls (and every call answers with), in pull order. */
export const LINK_COLUMNS =
  "marker_uuid, provider, calendar_id, role, state, reason, gen, account_ref, event_id, etag, remote_updated_at, pushed_hash, created_by, created_at, linked_at, updated_at";

export interface LinkKey {
  marker_uuid: string;
  provider: string;
  calendar_id: string;
}

export interface LinkRow extends LinkKey {
  user_id: string;
  role: string;
  state: string;
  reason: string;
  gen: number;
  account_ref: string | null;
  event_id: string | null;
  etag: string | null;
  remote_updated_at: string | null;
  pushed_hash: string | null;
  created_by: string;
  claim_device: string | null;
  claim_token: string | null;
  claim_until: string | null;
  ever_claimed: number;
  retry_at: string | null;
  retry_device: string | null;
  give_backs: number;
  created_at: string;
  linked_at: string | null;
  updated_at: string;
  seq: number;
}

/** A row as a desktop sees it: no user, no claim columns. */
export type PublicLink = Omit<
  LinkRow,
  | "user_id"
  | "claim_device"
  | "claim_token"
  | "claim_until"
  | "ever_claimed"
  | "retry_at"
  | "retry_device"
  | "give_backs"
>;

export function publicLink(row: LinkRow): PublicLink {
  const {
    user_id: _u,
    claim_device: _d,
    claim_token: _t,
    claim_until: _c,
    ever_claimed: _e,
    retry_at: _r,
    retry_device: _rd,
    give_backs: _g,
    ...rest
  } = row;
  return rest;
}

// ── fixed ids ───────────────────────────────────────────────────────────

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

function base32hex(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32HEX[(value << (5 - bits)) & 31];
  return out;
}

/** The Google event id every desktop gives copy (uuid, calendar, gen), so a
 *  second create of the same copy gets a 409 instead of a duplicate:
 *  "vs" + base32hex(sha256(uuid|calendar|gen)), first 40 characters. */
export function fixedGoogleId(
  uuid: string,
  calendarId: string,
  gen: number,
): string {
  const digest = createHash("sha256")
    .update(`${uuid}|${calendarId}|${gen}`)
    .digest();
  return "vs" + base32hex(digest).slice(0, 40);
}

// ── devices ─────────────────────────────────────────────────────────────

/** The capability tokens a lease body declares, known ones only. */
export function parseProviders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const p of raw) {
    if (typeof p === "string" && KNOWN_PROVIDERS.has(p)) out.add(p);
  }
  return [...out].sort();
}

export function recordProviders(
  db: DB,
  userId: string,
  deviceId: string,
  providers: string[],
  now: string,
): void {
  db.prepare(
    `INSERT INTO calendar_devices (user_id, device_id, providers, seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       providers = excluded.providers, seen_at = excluded.seen_at`,
  ).run(userId, deviceId, providers.join(","), now);
}

export function declaresLinks(
  db: DB,
  userId: string,
  deviceId: string | null | undefined,
): boolean {
  if (!deviceId) return false;
  const row = db
    .prepare<[string, string], { providers: string }>(
      "SELECT providers FROM calendar_devices WHERE user_id = ? AND device_id = ?",
    )
    .get(userId, deviceId);
  return row !== undefined && row.providers.split(",").includes("links");
}

export function linksDeviceSeenSince(
  db: DB,
  userId: string,
  since: string,
): boolean {
  const rows = db
    .prepare<[string, string], { providers: string }>(
      `SELECT providers FROM calendar_devices
        WHERE user_id = ? AND seen_at >= ?
          AND device_id IN (SELECT id FROM devices WHERE user_id = calendar_devices.user_id)`,
    )
    .all(userId, since);
  return rows.some((r) => r.providers.split(",").includes("links"));
}

/** SQL: whether the claim on row `l` is live. A claim held by a device that
 *  is no longer one of the user's devices counts as expired. */
function liveClaim(l: string): string {
  return `(${l}.claim_until IS NOT NULL AND ${l}.claim_until > @now
    AND ${l}.claim_device IN (SELECT id FROM devices WHERE user_id = ${l}.user_id))`;
}

// ── links mode ──────────────────────────────────────────────────────────

export interface LinksState {
  links_mode_at: string;
  converted_at: string | null;
  links_epoch: number;
  epoch_at: string | null;
  epoch_adopted: number;
}

export function linksState(db: DB, userId: string): LinksState | undefined {
  return db
    .prepare<[string], LinksState>(
      `SELECT links_mode_at, converted_at, links_epoch, epoch_at, epoch_adopted
         FROM calendar_links_state WHERE user_id = ?`,
    )
    .get(userId);
}

export function inLinksMode(db: DB, userId: string): boolean {
  return (linksState(db, userId)?.converted_at ?? null) !== null;
}

// ── the vault ───────────────────────────────────────────────────────────

export interface VaultEntry {
  email: string;
  calendarIds: string[];
  exportCalendarId: string | null;
  direction: "both" | "import" | "export";
  updated_at: string;
}

/** The user's live Google accounts, unsealed, ordered by email. */
export function readVault(
  db: DB,
  userId: string,
  secret: string,
): VaultEntry[] {
  const rows = db
    .prepare<[string], { email: string; payload_enc: string; updated_at: string }>(
      `SELECT email, payload_enc, updated_at FROM google_calendar_accounts
        WHERE user_id = ? AND deleted = 0 ORDER BY email ASC`,
    )
    .all(userId);
  const out: VaultEntry[] = [];
  for (const row of rows) {
    try {
      const raw = JSON.parse(decryptSecret(row.payload_enc, secret)) as Record<
        string,
        unknown
      >;
      const d = raw.direction;
      out.push({
        email: row.email,
        calendarIds: Array.isArray(raw.calendarIds)
          ? raw.calendarIds.filter((x): x is string => typeof x === "string")
          : [],
        exportCalendarId:
          typeof raw.exportCalendarId === "string" ? raw.exportCalendarId : null,
        direction: d === "import" || d === "export" ? d : "both",
        updated_at: row.updated_at,
      });
    } catch {
      /* skip a corrupt row, as the vault GET does */
    }
  }
  return out;
}

/** The ref for each account, writing one where it is missing. */
export function ensureRefs(
  db: DB,
  userId: string,
  emails: string[],
): Map<string, string> {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO calendar_account_refs (user_id, provider, account, ref)
     VALUES (?, ?, ?, ?)`,
  );
  for (const email of emails) {
    insert.run(userId, PROVIDER, email, randomBytes(8).toString("hex"));
  }
  return refMap(db, userId);
}

/** account email -> ref, for every account that ever had one. */
export function refMap(db: DB, userId: string): Map<string, string> {
  const rows = db
    .prepare<[string, string], { account: string; ref: string }>(
      "SELECT account, ref FROM calendar_account_refs WHERE user_id = ? AND provider = ?",
    )
    .all(userId, PROVIDER);
  return new Map(rows.map((r) => [r.account, r.ref]));
}

export function accountForRef(
  db: DB,
  userId: string,
  ref: string,
): string | undefined {
  return db
    .prepare<[string, string, string], { account: string }>(
      "SELECT account FROM calendar_account_refs WHERE user_id = ? AND provider = ? AND ref = ?",
    )
    .get(userId, PROVIDER, ref)?.account;
}

export interface TargetRow {
  calendar_id: string;
  account_ref: string;
  enabled: number;
  legacy_send: number;
  on_since: string | null;
  rev: number;
  changed_at: string;
  changed_by: string;
}

export function readTargets(db: DB, userId: string): TargetRow[] {
  return db
    .prepare<[string, string], TargetRow>(
      `SELECT calendar_id, account_ref, enabled, legacy_send, on_since, rev, changed_at, changed_by
         FROM calendar_targets WHERE user_id = ? AND provider = ? ORDER BY calendar_id`,
    )
    .all(userId, PROVIDER);
}

export type InvalidReason = "account_gone" | "import_only" | "unticked";

/** Whether `account` can take new events in `calendarId`, computed from the
 *  vault now (this server doesn't store validity): the account is live, not
 *  import-only, and reads the calendar. A starting target with legacy_send
 *  is valid while unticked, as an export-only calendar. */
export function calendarValidity(
  vault: VaultEntry[],
  account: string | undefined,
  calendarId: string,
  legacySend: boolean,
): { valid: boolean; reason: InvalidReason | null } {
  const entry =
    account === undefined ? undefined : vault.find((a) => a.email === account);
  if (!entry) return { valid: false, reason: "account_gone" };
  if (entry.direction === "import") return { valid: false, reason: "import_only" };
  if (!legacySend && !entry.calendarIds.includes(calendarId)) {
    return { valid: false, reason: "unticked" };
  }
  return { valid: true, reason: null };
}

/** Context for validity checks, read once per request. */
export interface CalendarContext {
  vault: VaultEntry[];
  refs: Map<string, string>;
  byRef: Map<string, string>;
  targets: Map<string, TargetRow>;
}

export function calendarContext(
  db: DB,
  userId: string,
  secret: string,
): CalendarContext {
  const vault = readVault(db, userId, secret);
  const refs = refMap(db, userId);
  const byRef = new Map([...refs].map(([email, ref]) => [ref, email]));
  const targets = new Map(readTargets(db, userId).map((t) => [t.calendar_id, t]));
  return { vault, refs, byRef, targets };
}

export function targetValid(ctx: CalendarContext, t: TargetRow) {
  return calendarValidity(
    ctx.vault,
    ctx.byRef.get(t.account_ref),
    t.calendar_id,
    t.legacy_send === 1,
  );
}

/** Whether a pending row can still be created: its account (or, with no
 *  ref, any account) can send to the calendar. */
function pendingSendable(ctx: CalendarContext, row: LinkRow): boolean {
  const legacy = ctx.targets.get(row.calendar_id)?.legacy_send === 1;
  if (row.account_ref !== null) {
    return calendarValidity(ctx.vault, ctx.byRef.get(row.account_ref), row.calendar_id, legacy).valid;
  }
  return ctx.vault.some(
    (a) => calendarValidity(ctx.vault, a.email, row.calendar_id, legacy).valid,
  );
}

/** Another live account that can write to `calendarId` and lists it, so a
 *  copy there survives this account's disconnect. Google calendar ids are
 *  global, so a shared calendar is one copy. */
function otherWriter(
  vault: VaultEntry[],
  exceptEmail: string,
  calendarId: string,
): string | undefined {
  return vault.find(
    (a) =>
      a.email !== exceptEmail &&
      a.direction !== "import" &&
      a.calendarIds.includes(calendarId),
  )?.email;
}

// ── rows ────────────────────────────────────────────────────────────────

const PATCHABLE = new Set([
  "role",
  "state",
  "reason",
  "gen",
  "account_ref",
  "event_id",
  "etag",
  "remote_updated_at",
  "pushed_hash",
  "linked_at",
  "ever_claimed",
  "claim_device",
  "claim_token",
  "claim_until",
]);

export type LinkPatch = Partial<
  Pick<
    LinkRow,
    | "role"
    | "state"
    | "reason"
    | "gen"
    | "account_ref"
    | "event_id"
    | "etag"
    | "remote_updated_at"
    | "pushed_hash"
    | "linked_at"
    | "ever_claimed"
    | "claim_device"
    | "claim_token"
    | "claim_until"
  >
>;

export function getLink(
  db: DB,
  userId: string,
  key: LinkKey,
): LinkRow | undefined {
  return db
    .prepare<[string, string, string, string], LinkRow>(
      `SELECT * FROM sync_marker_links
        WHERE user_id = ? AND marker_uuid = ? AND provider = ? AND calendar_id = ?`,
    )
    .get(userId, key.marker_uuid, key.provider, key.calendar_id);
}

/** Changes a row's pulled state: a new seq and updated_at. Any change is
 *  new work, so a give-back's wait ends. */
export function moveLink(
  db: DB,
  userId: string,
  key: LinkKey,
  patch: LinkPatch,
  now: string,
): LinkRow | undefined {
  const cols = Object.keys(patch).filter((k) => PATCHABLE.has(k));
  const sets = cols.map((c) => `${c} = @${c}`);
  db.prepare(
    `UPDATE sync_marker_links
        SET ${[...sets, "retry_at = NULL", "retry_device = NULL", "give_backs = 0", `seq = ${NEXT_SEQ}`, "updated_at = @now"].join(", ")}
      WHERE user_id = @user AND marker_uuid = @marker AND provider = @provider AND calendar_id = @calendar`,
  ).run({
    ...patch,
    now,
    user: userId,
    marker: key.marker_uuid,
    provider: key.provider,
    calendar: key.calendar_id,
  });
  return getLink(db, userId, key);
}

/** Changes only the claim columns: never pulled, so no seq. */
function setClaim(
  db: DB,
  userId: string,
  key: LinkKey,
  claim: {
    claim_device: string | null;
    claim_token: string | null;
    claim_until: string | null;
    ever_claimed?: number;
  },
): void {
  db.prepare(
    `UPDATE sync_marker_links
        SET claim_device = @claim_device, claim_token = @claim_token, claim_until = @claim_until,
            ever_claimed = COALESCE(@ever_claimed, ever_claimed)
      WHERE user_id = @user AND marker_uuid = @marker AND provider = @provider AND calendar_id = @calendar`,
  ).run({
    ever_claimed: null,
    ...claim,
    user: userId,
    marker: key.marker_uuid,
    provider: key.provider,
    calendar: key.calendar_id,
  });
}

export interface NewLink extends LinkKey {
  role: string;
  state: string;
  reason: string;
  gen?: number;
  account_ref?: string | null;
  event_id?: string | null;
  etag?: string | null;
  remote_updated_at?: string | null;
  pushed_hash?: string | null;
  created_by: string;
  created_at?: string;
  linked_at?: string | null;
}

/** Inserts a row unless its key is taken; true when it was written. */
export function insertLink(
  db: DB,
  userId: string,
  row: NewLink,
  now: string,
): boolean {
  const res = db
    .prepare(
      `INSERT INTO sync_marker_links (
         user_id, marker_uuid, provider, calendar_id, role, state, reason, gen,
         account_ref, event_id, etag, remote_updated_at, pushed_hash, created_by,
         created_at, linked_at, updated_at, seq)
       VALUES (@user, @marker_uuid, @provider, @calendar_id, @role, @state, @reason, @gen,
         @account_ref, @event_id, @etag, @remote_updated_at, @pushed_hash, @created_by,
         @created_at, @linked_at, @now, ${NEXT_SEQ})
       ON CONFLICT DO NOTHING`,
    )
    .run({
      user: userId,
      marker_uuid: row.marker_uuid,
      provider: row.provider,
      calendar_id: row.calendar_id,
      role: row.role,
      state: row.state,
      reason: row.reason,
      gen: row.gen ?? 0,
      account_ref: row.account_ref ?? null,
      event_id: row.event_id ?? null,
      etag: row.etag ?? null,
      remote_updated_at: row.remote_updated_at ?? null,
      pushed_hash: row.pushed_hash ?? null,
      created_by: row.created_by,
      created_at: row.created_at ?? now,
      linked_at: row.linked_at ?? null,
      now,
    });
  return res.changes > 0;
}

/** A row of this user's that holds `eventId` in `calendarId`, in any state
 *  that keeps the event: live (linked, deleting, removed_remote) or the
 *  person's own (detached, released). */
export function holderOf(
  db: DB,
  userId: string,
  calendarId: string,
  eventId: string,
  states: string[] = [...HOLDING, "detached", "released"],
): LinkRow | undefined {
  return db
    .prepare<unknown[], LinkRow>(
      `SELECT * FROM sync_marker_links
        WHERE user_id = ? AND provider = ? AND calendar_id = ? AND event_id = ?
          AND state IN (${states.map(() => "?").join(",")})
        LIMIT 1`,
    )
    .get(userId, PROVIDER, calendarId, eventId, ...states);
}

/** A pending row that won't be created any more: `gone/<reason>`, or, if it
 *  was ever claimed (a create may have landed), `deleting/<reason>` with no
 *  event id so the next claimer looks the copy up. */
export function cancelPending(
  db: DB,
  userId: string,
  row: LinkRow,
  reason: string,
  now: string,
): void {
  moveLink(
    db,
    userId,
    row,
    row.ever_claimed === 1
      ? { state: "deleting", reason, event_id: null }
      : { state: "gone", reason },
    now,
  );
}

function rowsOfMarker(db: DB, userId: string, uuid: string): LinkRow[] {
  return db
    .prepare<[string, string], LinkRow>(
      `SELECT * FROM sync_marker_links WHERE user_id = ? AND marker_uuid = ?
        ORDER BY provider, calendar_id`,
    )
    .all(userId, uuid);
}

const NO_CLAIM = { claim_device: null, claim_token: null, claim_until: null };

/** A source row whose import was deleted in Vetroscope: the calendar event
 *  is the person's and stays; the row only stops following it. */
const LET_SOURCE_GO: LinkPatch = { state: "released", reason: "deleted", ...NO_CLAIM };

/** The event was deleted in Vetroscope (0 -> 1). Copies the person kept
 *  (detached, released) are theirs and stay. */
export function tombstoneMoves(
  db: DB,
  userId: string,
  uuid: string,
  now: string,
): number {
  let moved = 0;
  for (const row of rowsOfMarker(db, userId, uuid)) {
    if (row.role === "source" && ["linked", "pending", "deleting"].includes(row.state)) {
      moveLink(db, userId, row, LET_SOURCE_GO, now);
    } else if (row.state === "linked") {
      // ever_claimed restarts here: a restore before any claimer sent the
      // DELETE can put the row back to linked.
      moveLink(db, userId, row, { state: "deleting", reason: "deleted", ever_claimed: 0, ...NO_CLAIM }, now);
    } else if (row.state === "pending") {
      cancelPending(db, userId, row, "cancelled", now);
    } else if (row.state === "removed_remote") {
      moveLink(db, userId, row, { state: "gone", reason: "deleted" }, now);
    } else {
      continue;
    }
    moved += 1;
  }
  return moved;
}

/** Whether `calendarId` is a switched-on target that can take events now. */
function targetOn(ctx: CalendarContext, calendarId: string): boolean {
  const t = ctx.targets.get(calendarId);
  return t !== undefined && t.enabled === 1 && targetValid(ctx, t).valid;
}

/** The event was restored (1 -> 0), e.g. an Undo. A DELETE that was
 *  claimed may already have run, so those rows start again with gen + 1,
 *  in the same calendars only, and only while that calendar is still a
 *  switched-on, valid target: a calendar switched off since gets nothing
 *  new. A source row follows its event again. */
export function restoreMoves(
  db: DB,
  userId: string,
  uuid: string,
  ctx: CalendarContext,
  now: string,
): number {
  let moved = 0;
  const fresh = (row: LinkRow): LinkPatch => ({
    state: "pending",
    reason: "restore",
    gen: row.gen + 1,
    event_id: null,
    etag: null,
    remote_updated_at: null,
    pushed_hash: null,
    linked_at: null,
    ever_claimed: 0,
    ...NO_CLAIM,
  });
  for (const row of rowsOfMarker(db, userId, uuid)) {
    const fromDelete = row.reason === "deleted" || row.reason === "cancelled";
    if (row.role === "source") {
      // Never created anywhere: only linked again if no other row took the
      // event meanwhile.
      if (row.state !== "released" || row.reason !== "deleted" || row.event_id === null) continue;
      const holder = holderOf(db, userId, row.calendar_id, row.event_id, HOLDING);
      if (holder) continue;
      moveLink(db, userId, row, { state: "linked", reason: "restore" }, now);
    } else if (row.state === "deleting" && fromDelete) {
      if (row.reason === "deleted" && row.ever_claimed === 0 && row.event_id !== null) {
        // Nothing was sent: the copy is still there. ever_claimed survives
        // an unclaim, so a DELETE whose answer was lost doesn't count.
        moveLink(db, userId, row, { state: "linked", reason: "restore", ...NO_CLAIM }, now);
      } else if (targetOn(ctx, row.calendar_id)) {
        moveLink(db, userId, row, fresh(row), now);
      } else {
        continue; // the delete goes on
      }
    } else if (row.state === "gone" && fromDelete && targetOn(ctx, row.calendar_id)) {
      moveLink(db, userId, row, fresh(row), now);
    } else {
      continue;
    }
    moved += 1;
  }
  return moved;
}

// ── first store ─────────────────────────────────────────────────────────

export interface MarkerForFill {
  uuid: string;
  origin: unknown;
  repeat_rule: unknown;
  deleted: unknown;
  updated_at: unknown;
  /** undefined = the key was absent (an older client). */
  created_at: unknown;
  has_created_at: boolean;
  /** An older client's push carrying a calendar id: already on a calendar. */
  has_event_id: boolean;
}

/** created_at to store on a first insert, and the creation time the fill
 *  uses (null = this event never fans out). */
export function creationTime(
  m: MarkerForFill,
  nowMs: number,
  epochAt: string | null,
): number | null {
  if (m.has_created_at) {
    if (typeof m.created_at !== "string") return null;
    const t = Date.parse(m.created_at);
    if (Number.isNaN(t)) return null;
    const c = Math.min(t, nowMs);
    return nowMs - c < SKEW_MS ? nowMs : c;
  }
  // An older client: new only when changed in the last 48 hours, not
  // already on a calendar, and not part of a re-upload after a reset.
  const updated = typeof m.updated_at === "string" ? Date.parse(m.updated_at) : NaN;
  if (Number.isNaN(updated) || Math.abs(nowMs - updated) > NO_KEY_WINDOW_MS) return null;
  if (m.has_event_id) return null;
  if (epochAt !== null && nowMs - Date.parse(epochAt) < EPOCH_QUIET_MS) return null;
  return nowMs;
}

/** Whether a marker this server is storing for the first time can get link
 *  rows at all (checked before any target is read). */
export function canFanOut(m: MarkerForFill, c: number | null, nowMs: number): boolean {
  if (c === null || c < nowMs - FILL_AGE_MS) return false;
  if (m.origin !== "vetroscope") return false;
  if (Number(m.deleted) !== 0) return false;
  if (typeof m.repeat_rule === "string" && m.repeat_rule !== "") return false;
  return true;
}

/** Writes a `pending` row for each switched-on, valid calendar that was on
 *  when the event was made. */
export function fillNewMarker(
  db: DB,
  userId: string,
  ctx: CalendarContext,
  uuid: string,
  createdMs: number,
  createdBy: string,
  now: string,
): number {
  let written = 0;
  for (const t of ctx.targets.values()) {
    if (t.enabled !== 1 || t.on_since === null) continue;
    if (Date.parse(t.on_since) > createdMs) continue;
    if (!targetValid(ctx, t).valid) continue;
    if (
      insertLink(
        db,
        userId,
        {
          marker_uuid: uuid,
          provider: PROVIDER,
          calendar_id: t.calendar_id,
          role: "copy",
          state: "pending",
          reason: "target",
          account_ref: t.account_ref,
          created_by: createdBy,
        },
        now,
      )
    ) {
      written += 1;
    }
  }
  return written;
}

// ── entering links mode ─────────────────────────────────────────────────

/** The calendar an older desktop sends new events to: the first account by
 *  email that sends and has calendars, and its exportCalendarId as stored
 *  (ticked or not), else its first ticked calendar. */
export function legacyStartingTarget(
  vault: VaultEntry[],
): { email: string; calendarId: string; legacySend: boolean } | null {
  const sorted = [...vault].sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  for (const a of sorted) {
    if (a.direction === "import" || a.calendarIds.length === 0) continue;
    const calendarId = a.exportCalendarId ?? a.calendarIds[0]!;
    return { email: a.email, calendarId, legacySend: !a.calendarIds.includes(calendarId) };
  }
  return null;
}

/** Starts links mode for a user, once: account refs, the starting target
 *  (exactly the calendar older desktops send to today), and `pending` rows
 *  for recent events they hadn't sent yet. `vault` is the accounts as they
 *  were before the request that triggered it, so an account connected by
 *  that request starts with every switch off. Call inside a transaction.
 *  Returns true when this call started it. */
export function enterLinksMode(
  db: DB,
  userId: string,
  deviceId: string,
  vault: VaultEntry[],
  now: string,
): boolean {
  if (inLinksMode(db, userId)) return false;
  db.prepare(
    `INSERT INTO calendar_links_state (user_id, links_mode_at, converted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET converted_at = excluded.converted_at
     WHERE calendar_links_state.converted_at IS NULL`,
  ).run(userId, now, now);

  const refs = ensureRefs(db, userId, vault.map((a) => a.email));
  const start = legacyStartingTarget(vault);
  if (start === null) return true;
  const ref = refs.get(start.email)!;
  db.prepare(
    `INSERT OR IGNORE INTO calendar_targets
       (user_id, provider, calendar_id, account_ref, enabled, legacy_send, on_since, rev, changed_at, changed_by)
     VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
  ).run(userId, PROVIDER, start.calendarId, ref, start.legacySend ? 1 : 0, now, now, deviceId);

  // Events older desktops would still have sent: recent, live, one-time
  // Vetroscope events with no row yet. The create's lookup adopts any copy
  // that already exists.
  const cutoff = new Date(Date.parse(now) - FILL_AGE_MS).toISOString();
  const unsent = db
    .prepare<[string, string], { uuid: string }>(
      `SELECT uuid FROM sync_markers m
        WHERE m.user_id = ? AND m.origin = 'vetroscope' AND m.deleted = 0
          AND COALESCE(m.repeat_rule, '') = ''
          AND COALESCE(m.created_at, m.updated_at) >= ?
          AND NOT EXISTS (SELECT 1 FROM sync_marker_links l
                           WHERE l.user_id = m.user_id AND l.marker_uuid = m.uuid)
        ORDER BY m.uuid`,
    )
    .all(userId, cutoff);
  for (const m of unsent) {
    insertLink(
      db,
      userId,
      {
        marker_uuid: m.uuid,
        provider: PROVIDER,
        calendar_id: start.calendarId,
        role: "copy",
        state: "pending",
        reason: "migrated",
        account_ref: ref,
        created_by: "migration",
      },
      now,
    );
  }
  return true;
}

// ── claims ──────────────────────────────────────────────────────────────

export interface ClaimedLink extends PublicLink {
  claim_token: string;
  claim_until: string;
}

function claimed(row: LinkRow): ClaimedLink {
  return {
    ...publicLink(row),
    claim_token: row.claim_token!,
    claim_until: row.claim_until!,
  };
}

/** POST /user/calendar-links/claim. Call inside a transaction. */
export function claimRows(
  db: DB,
  userId: string,
  deviceId: string,
  ctx: CalendarContext,
  opts: { keys: LinkKey[] | null; limit: number },
  nowMs: number,
): ClaimedLink[] {
  const now = new Date(nowMs).toISOString();
  const until = new Date(nowMs + CLAIM_MS).toISOString();
  const cutoff = new Date(nowMs - FILL_AGE_MS).toISOString();

  // Pending rows for events made (or restored) more than 7 days ago expire,
  // so a late fan-out can't wake a stale event.
  const stale = db
    .prepare<{ user: string; cutoff: string }, LinkRow>(
      `SELECT l.* FROM sync_marker_links l
         LEFT JOIN sync_markers m ON m.uuid = l.marker_uuid AND m.user_id = l.user_id
        WHERE l.user_id = @user AND l.state = 'pending'
          AND MAX(COALESCE(m.created_at, l.created_at), l.updated_at) < @cutoff`,
    )
    .all({ user: userId, cutoff });
  for (const row of stale) cancelPending(db, userId, row, "expired", now);

  // Backstop: a row still linked to an event that is deleted.
  const orphaned = db
    .prepare<[string], LinkRow>(
      `SELECT l.* FROM sync_marker_links l
         JOIN sync_markers m ON m.uuid = l.marker_uuid AND m.user_id = l.user_id
        WHERE l.user_id = ? AND l.state = 'linked' AND m.deleted = 1`,
    )
    .all(userId);
  for (const row of orphaned) {
    moveLink(
      db,
      userId,
      row,
      row.role === "source"
        ? LET_SOURCE_GO
        : { state: "deleting", reason: "deleted", ever_claimed: 0, ...NO_CLAIM },
      now,
    );
  }
  endOrphanDeletes(db, userId, ctx.vault, now);

  const wanted = opts.keys
    ? new Set(opts.keys.map((k) => `${k.marker_uuid}\n${k.provider}\n${k.calendar_id}`))
    : null;
  const inKeys = (r: LinkRow) =>
    wanted === null || wanted.has(`${r.marker_uuid}\n${r.provider}\n${r.calendar_id}`);

  // This device's own live claims come back first, so a lost answer
  // doesn't hold a row for five minutes.
  const own = db
    .prepare<{ user: string; device: string; now: string }, LinkRow>(
      `SELECT * FROM sync_marker_links l
        WHERE l.user_id = @user AND l.state IN ('pending','deleting')
          AND l.claim_device = @device AND ${liveClaim("l")}
        ORDER BY l.seq`,
    )
    .all({ user: userId, device: deviceId, now })
    .filter(inKeys);

  // A row this device gave back waits out its back-off, unless asked for by
  // key (the creating desktop's immediate export); given-back rows come
  // after the rest.
  const out = own.map(claimed);
  const free = db
    .prepare<{ user: string; device: string; now: string; keyed: number }, LinkRow>(
      `SELECT l.* FROM sync_marker_links l
        WHERE l.user_id = @user AND l.role = 'copy' AND l.state IN ('pending','deleting')
          AND NOT ${liveClaim("l")}
          AND (@keyed = 1 OR l.retry_at IS NULL OR l.retry_at <= @now OR l.retry_device IS NOT @device)
          AND EXISTS (SELECT 1 FROM sync_markers m WHERE m.uuid = l.marker_uuid AND m.user_id = l.user_id)
        ORDER BY l.retry_at IS NOT NULL, l.seq`,
    )
    .all({ user: userId, device: deviceId, now, keyed: wanted === null ? 0 : 1 })
    .filter(inKeys)
    .filter((r) => r.state === "deleting" || pendingSendable(ctx, r));

  for (const row of free) {
    if (out.length >= opts.limit) break;
    const token = randomBytes(16).toString("hex");
    setClaim(db, userId, row, {
      claim_device: deviceId,
      claim_token: token,
      claim_until: until,
      ever_claimed: 1,
    });
    out.push(claimed({ ...row, claim_device: deviceId, claim_token: token, claim_until: until }));
  }
  return out;
}

/** Extends a claim; a miss (another device holds it now) returns null. */
export function renewClaim(
  db: DB,
  userId: string,
  key: LinkKey,
  token: string,
  nowMs: number,
): string | null {
  const row = getLink(db, userId, key);
  if (!row || row.claim_token !== token) return null;
  const extended = new Date(nowMs + CLAIM_MS).toISOString();
  const until = row.claim_until !== null && row.claim_until > extended ? row.claim_until : extended;
  setClaim(db, userId, key, {
    claim_device: row.claim_device,
    claim_token: token,
    claim_until: until,
  });
  return until;
}

/** Gives a row back at once (a failed lookup or DELETE, an event the
 *  device hasn't pulled, no account to work it). Another device may take it
 *  now; the device that gave it back waits before its claims without keys
 *  pick it again, twice as long each time. */
export function unclaim(
  db: DB,
  userId: string,
  key: LinkKey,
  token: string,
  nowMs: number,
): boolean {
  const row = getLink(db, userId, key);
  if (!row || row.claim_token !== token) return false;
  const device = row.claim_device;
  setClaim(db, userId, key, NO_CLAIM);
  const wait = Math.min(GIVE_BACK_MS * 2 ** Math.min(row.give_backs, 20), GIVE_BACK_MAX_MS);
  db.prepare(
    `UPDATE sync_marker_links SET retry_at = ?, retry_device = ?, give_backs = give_backs + 1
      WHERE user_id = ? AND marker_uuid = ? AND provider = ? AND calendar_id = ?`,
  ).run(new Date(nowMs + wait).toISOString(), device, userId, key.marker_uuid, key.provider, key.calendar_id);
  return true;
}

export function clearClaim(db: DB, userId: string, key: LinkKey): void {
  setClaim(db, userId, key, NO_CLAIM);
}

/** Claims a row under a given token without the usual pick
 *  (disconnect-start, which holds all of an account's copies under one). */
export function claimFor(
  db: DB,
  userId: string,
  key: LinkKey,
  deviceId: string,
  token: string,
  until: string,
): void {
  setClaim(db, userId, key, {
    claim_device: deviceId,
    claim_token: token,
    claim_until: until,
    ever_claimed: 1,
  });
}

// ── accounts leaving ────────────────────────────────────────────────────

/** A real disconnect with the events kept: the account's copies stay in
 *  their calendars, unmanaged (`released/kept`), unless another live
 *  account still writes to that calendar, which then takes them over. Its
 *  pending rows are cancelled and its switches turned off, so connecting it
 *  again starts with none on. `vault` is the accounts left after it.
 *  Call inside a transaction. */
export function disconnectKeep(
  db: DB,
  userId: string,
  ref: string,
  email: string,
  vault: VaultEntry[],
  deviceId: string,
  now: string,
): void {
  const refs = ensureRefs(db, userId, vault.map((a) => a.email));
  const rows = db
    .prepare<[string, string], LinkRow>(
      `SELECT * FROM sync_marker_links WHERE user_id = ? AND account_ref = ?
        AND state IN ('linked','pending') ORDER BY marker_uuid, calendar_id`,
    )
    .all(userId, ref);
  for (const row of rows) {
    if (row.state === "pending") {
      cancelPending(db, userId, row, "disconnected", now);
      continue;
    }
    const other = otherWriter(vault, email, row.calendar_id);
    if (other !== undefined) {
      moveLink(db, userId, row, { account_ref: refs.get(other)! }, now);
    } else {
      moveLink(db, userId, row, { state: "released", reason: "kept", ...NO_CLAIM }, now);
    }
  }
  switchOffAccount(db, userId, ref, deviceId, now);
  endOrphanDeletes(db, userId, vault, now);
}

/** Whether the account behind `ref` is gone from this server: no such ref,
 *  or its vault row was removed. */
function accountGone(db: DB, userId: string, ref: string): boolean {
  const email = accountForRef(db, userId, ref);
  if (email === undefined) return true;
  const acct = db
    .prepare<[string, string], { deleted: number }>(
      "SELECT deleted FROM google_calendar_accounts WHERE user_id = ? AND email = ?",
    )
    .get(userId, email);
  return acct === undefined || acct.deleted === 1;
}

/** `deleting` rows whose account is gone and that nobody holds: another
 *  live account that writes the calendar takes the delete over; otherwise
 *  nobody can delete the copy any more, so the row ends as
 *  `gone/disconnected`, keeping the event id so a sweep after a reconnect
 *  can still drop it. Without this such rows would stay `deleting` for
 *  good. `vault` is the live accounts. */
export function endOrphanDeletes(
  db: DB,
  userId: string,
  vault: VaultEntry[],
  now: string,
): number {
  const rows = db
    .prepare<{ user: string; now: string }, LinkRow>(
      `SELECT * FROM sync_marker_links l
        WHERE l.user_id = @user AND l.state = 'deleting' AND l.account_ref IS NOT NULL
          AND NOT ${liveClaim("l")}`,
    )
    .all({ user: userId, now });
  let ended = 0;
  for (const row of rows) {
    if (!accountGone(db, userId, row.account_ref!)) continue;
    const email = accountForRef(db, userId, row.account_ref!) ?? "";
    const other = otherWriter(vault, email, row.calendar_id);
    if (other !== undefined) {
      moveLink(db, userId, row, { account_ref: ensureRefs(db, userId, [other]).get(other)! }, now);
    } else {
      moveLink(db, userId, row, { state: "gone", reason: "disconnected", ...NO_CLAIM }, now);
      ended += 1;
    }
  }
  return ended;
}

export function switchOffAccount(
  db: DB,
  userId: string,
  ref: string,
  deviceId: string,
  now: string,
): void {
  db.prepare(
    `UPDATE calendar_targets SET enabled = 0, legacy_send = 0, rev = rev + 1,
            changed_at = ?, changed_by = ?
      WHERE user_id = ? AND provider = ? AND account_ref = ? AND enabled = 1`,
  ).run(now, deviceId, userId, PROVIDER, ref);
}

/** Before a Disconnect with Remove events: switches off, pending rows
 *  cancelled, and the account's linked copies moved to
 *  `deleting/disconnected` under the caller's claim for 24 hours, all under
 *  one token, so other desktops' imports see the cancellations against a
 *  non-linked row and raise no prompt. Copies another account still writes
 *  to switch to that account and stay. Source rows (the events the account
 *  imported) are never deleted: the disconnect itself lets them go.
 *  Returns the token and the rows the caller now holds. */
export function disconnectStart(
  db: DB,
  userId: string,
  ref: string,
  email: string,
  vault: VaultEntry[],
  deviceId: string,
  nowMs: number,
): { token: string; until: string; rows: ClaimedLink[] } {
  const now = new Date(nowMs).toISOString();
  const token = randomBytes(16).toString("hex");
  const until = new Date(nowMs + DISCONNECT_CLAIM_MS).toISOString();
  const refs = ensureRefs(db, userId, vault.map((a) => a.email));
  switchOffAccount(db, userId, ref, deviceId, now);
  const rows = db
    .prepare<[string, string], LinkRow>(
      `SELECT * FROM sync_marker_links WHERE user_id = ? AND account_ref = ? AND role = 'copy'
        AND state IN ('linked','pending') ORDER BY marker_uuid, calendar_id`,
    )
    .all(userId, ref);
  const held: ClaimedLink[] = [];
  for (const row of rows) {
    if (row.state === "pending") {
      cancelPending(db, userId, row, "disconnected", now);
      continue;
    }
    const other = otherWriter(vault, email, row.calendar_id);
    if (other !== undefined) {
      moveLink(db, userId, row, { account_ref: refs.get(other)! }, now);
      continue;
    }
    moveLink(db, userId, row, { state: "deleting", reason: "disconnected" }, now);
    claimFor(db, userId, row, deviceId, token, until);
    held.push(claimed(getLink(db, userId, row)!));
  }
  return { token, until, rows: held };
}

// ── reset ───────────────────────────────────────────────────────────────

/** /sync/reset: link rows go with the rest of the synced data; targets,
 *  refs, links mode and declared devices are settings and stay. The epoch
 *  tells the other desktops to drop their local rows and pull again. */
export function resetLinks(db: DB, userId: string, now: string): void {
  db.prepare("DELETE FROM sync_marker_links WHERE user_id = ?").run(userId);
  db.prepare(
    `UPDATE calendar_links_state
        SET links_epoch = links_epoch + 1, epoch_at = ?, epoch_adopted = 0
      WHERE user_id = ?`,
  ).run(now, userId);
}
