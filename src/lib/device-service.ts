// SPDX-License-Identifier: Apache-2.0
//
// Device registration helpers. Isolated so /auth/register, /auth/login,
// and /setup all share the same device-limit check and row-shape.

import { randomUUID } from "node:crypto";

import type { DB } from "../db.js";
import type { DeviceRow } from "../types.js";

export class DeviceLimitReachedError extends Error {
  readonly code = "DEVICE_LIMIT";
  readonly maxDevices: number;
  constructor(maxDevices: number) {
    super(`Device limit of ${maxDevices} reached for this user.`);
    this.maxDevices = maxDevices;
  }
}

export interface RegisterDeviceInput {
  id: string | null;
  deviceName: string;
  platform: string;
  // Vetroscope app version (e.g. "0.2.22"). Optional on the wire so
  // pre-006 clients still work; stored alongside the device row for
  // the version-mismatch gate on /sync/* and admin diagnostics.
  appVersion?: string | null;
}

export function registerDevice(
  db: DB,
  userId: string,
  input: RegisterDeviceInput,
): string {
  const id = input.id ?? randomUUID();
  db.prepare<[string, string, string, string, string | null]>(
    "INSERT INTO devices (id, user_id, device_name, platform, app_version) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, input.deviceName, input.platform, input.appVersion ?? null);
  return id;
}

// Update devices.app_version for an existing device. Called on every
// token-issuing path so the server's view of "what version is this
// device on?" stays current. No-op when appVersion is undefined.
export function recordDeviceAppVersion(
  db: DB,
  userId: string,
  deviceId: string,
  appVersion: string | null | undefined,
): void {
  if (appVersion === undefined) return;
  db.prepare<[string | null, string, string]>(
    "UPDATE devices SET app_version = ? WHERE id = ? AND user_id = ?",
  ).run(appVersion ?? null, deviceId, userId);
}

// A device name the client encrypted with the user's sync key: "enc1:" +
// hex of iv (12 bytes) | auth tag (16 bytes) | ciphertext.
const ENCRYPTED_DEVICE_NAME_RE = /^enc1:[0-9a-f]{56,1200}$/i;

// Replace an existing device's stored name with the encrypted one the client
// sent. A device registers before it has a key, so its row starts with the
// plaintext name; later logins and refreshes carry ciphertext. Plaintext is
// never written here, so a row only ever moves to ciphertext.
export function recordEncryptedDeviceName(
  db: DB,
  userId: string,
  deviceId: string,
  deviceName: unknown,
): void {
  if (typeof deviceName !== "string" || !ENCRYPTED_DEVICE_NAME_RE.test(deviceName)) return;
  db.prepare<[string, string, string, string]>(
    "UPDATE devices SET device_name = ? WHERE id = ? AND user_id = ? AND device_name IS NOT ?",
  ).run(deviceName, deviceId, userId, deviceName);
}

export function findDevice(
  db: DB,
  userId: string,
  deviceId: string,
): DeviceRow | undefined {
  return db
    .prepare<[string, string], DeviceRow>(
      "SELECT * FROM devices WHERE id = ? AND user_id = ?",
    )
    .get(deviceId, userId);
}

export function countDevices(db: DB, userId: string): number {
  return db
    .prepare<[string], { n: number }>(
      "SELECT COUNT(*) AS n FROM devices WHERE user_id = ?",
    )
    .get(userId)?.n ?? 0;
}

export function assertDeviceCapacity(
  db: DB,
  userId: string,
  maxDevices: number,
): void {
  if (countDevices(db, userId) >= maxDevices) {
    throw new DeviceLimitReachedError(maxDevices);
  }
}

export function listDevices(db: DB, userId: string): DeviceRow[] {
  return db
    .prepare<[string], DeviceRow>(
      "SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC",
    )
    .all(userId);
}

const DEVICE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Move a desktop's session from the device id this server gave it
// (`fromId`) to the id the desktop itself uses (`toId`), so every server it
// syncs with knows the machine by one id. Without this, a server that
// registered the machine under a different id rewrites the id on its
// entries, and the user's other desktops show an extra, unnamed device.
//
// Only within one user: `toId` must be unused, or already one of this
// user's devices on the same platform (a stale row for the same machine,
// which the session is merged into). Web sessions have no device row and
// are left alone. Returns the id the session now uses.
export function adoptDeviceId(
  db: DB,
  userId: string,
  fromId: string,
  toId: string,
): string {
  if (fromId === toId || !DEVICE_UUID_RE.test(toId)) return fromId;
  const source = findDevice(db, userId, fromId);
  if (source === undefined) return fromId;
  const existing = db
    .prepare<[string], { user_id: string; platform: string }>(
      "SELECT user_id, platform FROM devices WHERE id = ?",
    )
    .get(toId);
  if (
    existing !== undefined &&
    (existing.user_id !== userId || existing.platform !== source.platform)
  ) {
    return fromId;
  }

  const move = (sql: string) =>
    db.prepare<[string, string, string]>(sql).run(toId, userId, fromId);
  db.transaction(() => {
    if (existing === undefined) {
      db.prepare<[string, string, string]>(
        `INSERT INTO devices (id, user_id, device_name, platform, last_sync_at, created_at, app_version)
         SELECT ?, user_id, device_name, platform, last_sync_at, created_at, app_version
           FROM devices WHERE user_id = ? AND id = ?`,
      ).run(toId, userId, fromId);
    }
    move("UPDATE refresh_tokens SET device_id = ? WHERE user_id = ? AND device_id = ?");
    move("UPDATE sync_entries SET device_id = ? WHERE user_id = ? AND device_id = ?");
    move("UPDATE sync_entries SET updated_by_device_id = ? WHERE user_id = ? AND updated_by_device_id = ?");
    move("UPDATE OR IGNORE sync_reminder_claims SET device_id = ? WHERE user_id = ? AND device_id = ?");
    move("UPDATE google_calendar_leader SET device_id = ? WHERE user_id = ? AND device_id = ?");
    // Record the move for the user's other desktops (033), and point
    // earlier moves to this id at the new one.
    move("UPDATE device_aliases SET new_id = ? WHERE user_id = ? AND new_id = ?");
    db.prepare<[string, string]>("DELETE FROM device_aliases WHERE user_id = ? AND old_id = ?").run(userId, toId);
    db.prepare<[string, string, string]>(
      "INSERT OR REPLACE INTO device_aliases (user_id, old_id, new_id) VALUES (?, ?, ?)",
    ).run(userId, fromId, toId);
    db.prepare<[string, string]>("DELETE FROM devices WHERE user_id = ? AND id = ?").run(userId, fromId);
  })();
  return toId;
}

// Ids this user's desktops were moved off, and where to (see adoptDeviceId).
export function listDeviceAliases(
  db: DB,
  userId: string,
): Array<{ old_id: string; new_id: string }> {
  return db
    .prepare<[string], { old_id: string; new_id: string }>(
      "SELECT old_id, new_id FROM device_aliases WHERE user_id = ?",
    )
    .all(userId);
}
